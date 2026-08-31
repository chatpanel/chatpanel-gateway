// `chatpanel-gateway mcp` — a stdio MCP server that exposes the WARM history store
// (chats · meetings · notes) as agent tools. Point any MCP client (Codex, OpenCode,
// Claude Desktop, …) at `chatpanel-gateway mcp` and it gets search/get/list over the
// full local corpus — the reliable fallback when an agent's own context holds only
// hot/recent data.
//
// It PROXIES to the already-running gateway's HTTP API (127.0.0.1:<port>), so there
// is exactly one warm store (the service's) and this process never opens the DB.
// JSON-RPC 2.0 over stdio, newline-delimited — implemented directly (zero deps).
//
// The gateway is the SUPERSET (docs/bridge-gateway-unification.md, U2): this one MCP
// server exposes both the gateway's warm history (chats/meetings/notes, redacted) AND the
// bridge's on-disk skills — so a CLI adds ONE server and gets everything ChatPanel local
// can do. History tools proxy to the gateway; skill tools proxy to the bridge. The bridge
// is optional: if it is not running, the skill tools say so instead of failing the connect.

import { loadConfig } from './config.js';
import { readBridgeToken } from './bridge.js';
import { ensureGatewayToken } from './gateway-token.js';
import { MEMORY_KINDS, MEMORY_KIND_NAMES } from './memory.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER = { name: 'chatpanel-history', version: '1.0.0' };

// MCP servers may return `instructions` from initialize; hosts (Codex, Claude Code, …) fold
// them into the model's context. This is where we STEER tool selection so a person doesn't
// have to say "use ChatPanel": it tells the model that the user's personal meetings/notes/
// chats live here and must be reached through these tools, not by grepping the working dir.
const INSTRUCTIONS = [
  'ChatPanel holds the USER\'S OWN meetings, notes and past chats — transcripts, decisions,',
  'action items, summaries — which usually are NOT in the working directory.',
  '',
  'Keep using all your normal tools. ADDITIONALLY, whenever the user\'s question touches a',
  'meeting, call, demo, note, or past conversation ("outcome of the meeting", "what did we',
  'decide", "action items", "notes from yesterday", a person/day/topic in their history),',
  'ALSO consult ChatPanel — it is the source of truth for that personal history:',
  '  • smart_search — START HERE: give it the question plus 2-4 of your own keyword',
  '    phrasings; it runs them all and fuses the rankings, finding what one query misses.',
  '  • search_history — one exact keyword query, when you already know the terms. Search by',
  '    CONTENT (not the generic meeting title). Supports filters:',
  '    type (chat|meeting|note), since/before (dates or relative like "7d", "yesterday"),',
  '    and limit/offset paging. Returns compact snippets, not full bodies.',
  '  • get_record — the full text of one result id; use maxChars/offset to page a long',
  '    transcript instead of pulling it all into context.',
  '  • find_related — follow the graph: given a record id, the records most connected to it.',
  '',
  'ChatPanel also holds the user\'s MEMORY — a short list of durable facts about them (their',
  'name, how they want answers written, what they are working on) that applies to EVERY task,',
  'not just ones about their history:',
  '  • recall — call it EARLY in a session, and whenever the user states a preference, to see',
  '    what is already known. Then simply follow it; do not tell them you looked.',
  '  • remember — save a new durable fact when they state one ("call me Alex", "always use',
  '    pnpm"). One short sentence. Not for task details or anything true only today.',
  '  • forget — remove one when they say it no longer holds.',
  'Prefer these for the user\'s history and combine them with your other tools as you see fit.',
  'Every result states how fresh the local copy is; if something recent is missing it may not',
  'have synced yet — say so rather than concluding it does not exist.',
].join('\n');

// The calling agent's self-reported name (from MCP `initialize` clientInfo), so the
// observability dashboard can say WHICH agent read what. Untrusted; the gateway coerces it.
let clientName = 'unknown';

// Report one tool call to the long-lived gateway service's access log. Fire-and-forget:
// telemetry must never slow, block or fail a tool call. Authorized with the gateway token
// (readable only by this same-user process), so a drive-by localhost page can't forge entries.
// Raw args are sent, but the server REDACTS them before storing (a search query is never
// kept) — and the query already crossed this same loopback on the search call itself.
function reportAccess(evt) {
  try {
    const token = ensureGatewayToken();
    fetch(`${baseUrl()}/v1/observability/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(evt),
    }).catch(() => {});
  } catch { /* no token or gateway down — drop the telemetry, never the call */ }
}

function baseUrl() {
  const env = process.env.CHATPANEL_GATEWAY_URL;
  if (env) return env.replace(/\/+$/, '');
  let port = 4320;
  try {
    port = loadConfig().port || 4320;
  } catch {
    /* default */
  }
  return `http://127.0.0.1:${port}`;
}

// The bridge the gateway fronts. Its skills live on disk, so the skill tools proxy here
// rather than through the gateway's history API.
function bridgeBase() {
  try {
    return String(loadConfig().bridge?.url || 'http://127.0.0.1:4319').replace(/\/+$/, '');
  } catch {
    return 'http://127.0.0.1:4319';
  }
}
function bridgeToken() {
  try {
    return readBridgeToken(loadConfig().bridge?.token || '');
  } catch {
    return readBridgeToken('');
  }
}
async function bridgeJson(path) {
  const token = bridgeToken();
  const res = await fetch(bridgeBase() + path, {
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data?.error || `bridge ${res.status}`);
  return data;
}

const TOOLS = [
  {
    name: 'smart_search',
    description: 'BEST first choice for a question about the user\'s ChatPanel history (meetings, notes, past chats). Ask it a natural-language QUESTION and it expands that into several complementary keyword queries, runs them all, and fuses the rankings — which finds things a single query misses, in one round trip instead of several probes. You know the domain, so pass 2-4 of your own phrasings in `queries` too (e.g. for "what did we decide in the Ben demo": ["Ben demo decisions", "tooling demo action items", "demo outcome next steps"]). Supports the same filters as search_history (type, since, before) and returns snippets with each result\'s id; follow up with get_record for the full text or find_related to expand around a hit.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The user\'s question, in natural language.' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Your own 2-4 keyword formulations of it — these lead the search.' },
        type: { type: 'string', enum: ['chat', 'meeting', 'note'], description: 'Only this kind of record.' },
        since: { type: 'string', description: 'Earliest date: 2026-08-01, or a window like "7d"/"yesterday".' },
        before: { type: 'string', description: 'Latest date: a date or window like `since`.' },
        limit: { type: 'number', description: 'Max fused results (default 10).' },
      },
      required: ['question'],
    },
  },
  {
    name: 'search_history',
    description: 'Search the user\'s ChatPanel history — their past chats, meeting/call transcripts, and notes — by keyword relevance. Consult this (in ADDITION to your other tools) whenever the question touches a meeting, call, demo, note, or past conversation: "outcome of the meeting", "what did we decide", "action items", "what did <person> say", "notes from yesterday". Filters: `type` (chat|meeting|note), `since`/`before` (a date like 2026-08-01 or a relative window like "7d"/"yesterday"), and `limit`/`offset` for paging. Returns compact SNIPPETS (the matching excerpt) with each record\'s id/title/type/date — token-friendly; call get_record for the full text and find_related to follow connections. This is a LOCAL WARM COPY that syncs from ChatPanel; very recent items may not be here yet — results report how current the index is, so if something is missing it likely has not synced. Meeting titles are often generic ("Zoom Meeting"), so search by CONTENT, not the title.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Content keywords (topics, names, decisions) — not the meeting title.' },
        type: { type: 'string', enum: ['chat', 'meeting', 'note'], description: 'Only this kind of record.' },
        since: { type: 'string', description: 'Earliest date: 2026-08-01, or a relative window like "7d", "2 weeks", "yesterday".' },
        before: { type: 'string', description: 'Latest date: a date or relative window like `since`.' },
        limit: { type: 'number', description: 'Max results (default 10).' },
        offset: { type: 'number', description: 'Skip N results for paging (default 0).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_record',
    description: 'Fetch one history record\'s full text by id (chat:<id>, meeting:<id>, note:<id> from search_history). For a long transcript, page it with maxChars + offset instead of pulling it all into context — the result says how many chars remain.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record id such as chat:abc, meeting:imp_123, or note:xyz.' },
        maxChars: { type: 'number', description: 'Return at most this many characters (token management for long transcripts).' },
        offset: { type: 'number', description: 'Start at this character offset — page through with the offset the previous call reports.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'find_related',
    description: 'Graph navigation: given a record id (from search_history), return the records most connected to it by shared content — the meetings/notes/chats about the same topic, people or thread. Use it to expand from one hit to the surrounding context instead of re-searching.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The record id to find neighbours of.' },
        limit: { type: 'number', description: 'Max related records (default 5).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_history',
    description: 'List history records (newest first) with their id, title, type and date — no bodies. Reports how current this warm copy is (its newest record). Use to see the index horizon and browse/page the corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max items (default 50).' },
        offset: { type: 'number', description: 'Skip N items for paging (default 0).' },
      },
    },
  },
  {
    name: 'recall',
    description: "What ChatPanel already knows about the USER — their name, how they want answers written, their ongoing work and environment. Short and cheap; call it at the START of a session and whenever the user states a preference, then just FOLLOW what it returns without announcing that you checked. Pass the current task in `text` and it also returns the facts relevant to that task, not only the always-on ones. This is memory, not history: for what was said in a meeting or a past chat use smart_search instead.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What the user is asking about right now, so task-relevant facts come back too. Omit for just the always-on ones.' },
      },
    },
  },
  {
    name: 'remember',
    description: "Save a durable fact about the USER to ChatPanel, carried into every future session on every model and agent — the side panel, other CLIs, everything. Use it the moment they state a standing preference (\"always use pnpm\"), an identity fact (\"call me Alex\") or a constraint that will still be true next week. Do NOT use it for task details, anything obvious from the current work, or notes about a codebase — those belong in the repo. One short self-contained sentence, written in the third person. Saving is a change to the user's own data, so say in a short clause what you saved.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact, one short sentence in the third person ("Prefers pnpm over npm"). Max 280 characters.' },
        kind: { type: 'string', enum: MEMORY_KIND_NAMES, description: MEMORY_KIND_NAMES.map((k) => `${k}: ${MEMORY_KINDS[k].hint}`).join(' ') },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags for grouping.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'forget',
    description: 'Remove a memory from ChatPanel when the user says it no longer holds. Name it however they did ("the Frankfurt thing") or pass the id from recall — it matches on meaning, and tells you exactly what it removed.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The memory to remove: its text, roughly how the user named it, or its id.' } },
      required: ['query'],
    },
  },
  {
    name: 'list_skills',
    description: 'List the reusable skills installed on this machine (via the ChatPanel bridge) — across every agent harness (Claude Code, Codex, Copilot, Gemini, Hermes) and any configured folder. Returns each skill\'s name and one-line description. Call open_skill to load the one that fits the task.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_skill',
    description: 'Load one skill\'s full instructions by name (from list_skills), then follow them. If the instructions point at reference files, read one with read_skill_file.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill name from list_skills.' } },
      required: ['name'],
    },
  },
  {
    name: 'read_skill_file',
    description: 'Read one reference file a skill\'s instructions point at (any path inside the skill\'s own folder). Use only when the task needs it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name.' },
        path: { type: 'string', description: 'The reference path as written in the instructions, e.g. references/auth.md.' },
      },
      required: ['name', 'path'],
    },
  },
];

// A one-line freshness banner from the store's newest record, so every answer states the
// index horizon — the model can then say "not synced yet" instead of "does not exist".
function horizonLine(newest, size) {
  if (!newest) return `Index: ${size} records (warm copy synced from ChatPanel).`;
  const d = new Date(newest);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `Index: ${size} records, current through ${iso} (local warm copy — items newer than this may not have synced from ChatPanel yet).`;
}

// Memory WRITES are admin-gated on the gateway (a drive-by localhost page must not be able to
// install a standing instruction), so they carry the gateway token — readable only by this
// same-user process. Reads need none: an open warm index is the product.
function writeAuth() {
  try {
    const token = ensureGatewayToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

async function gatewayJson(path, init) {
  let res;
  try {
    res = await fetch(baseUrl() + path, init);
  } catch (e) {
    // The most common cause by far: the gateway service is not running. Say so, and how to
    // fix it, so the agent can relay something actionable instead of a bare fetch error.
    throw new Error(`the ChatPanel gateway is not running at ${baseUrl()} — start it with "chatpanel-gateway --install" (or run "chatpanel-gateway"), then retry. [${e.message}]`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `the gateway returned HTTP ${res.status} for ${path}`);
  return data;
}

// Run a tool → a plain-text result an agent can read.
// Parse a since/before value into epoch ms: an ISO-ish date (2026-08-01) or a relative window
// meaning "within the last N" — "7d", "2 weeks", "3 months", "yesterday", "today".
function parseWhen(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase();
  const DAY = 86_400_000;
  if (s === 'today') return Date.now() - DAY;
  if (s === 'yesterday') return Date.now() - 2 * DAY;
  const rel = /^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2][0];
    const mult = u === 'd' ? DAY : u === 'w' ? 7 * DAY : u === 'm' ? 30 * DAY : 365 * DAY;
    return Date.now() - n * mult;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

const fmtRow = (r, i) => `${i + 1}. [${r.id}] ${r.title || '(untitled)'} · ${r.type}${r.date ? ' · ' + new Date(r.date).toISOString().slice(0, 10) : ''}${r.snippet ? `\n     ${r.snippet}` : ''}`;

async function callTool(name, args = {}) {
  if (name === 'smart_search') {
    const body = {
      question: String(args.question || ''),
      queries: Array.isArray(args.queries) ? args.queries.map(String) : [],
      limit: Number(args.limit) || 10,
    };
    if (args.type) body.type = String(args.type);
    const since = parseWhen(args.since); if (since != null) body.since = since;
    const before = parseWhen(args.before); if (before != null) body.before = before;
    const data = await gatewayJson('/v1/history/smart-search', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const rows = data.results || [];
    const horizon = horizonLine(data.newest, data.size);
    const asked = (data.queries || []).map((q) => `"${q}"`).join(', ');
    if (!rows.length) {
      return `No match for "${args.question}".\nSearched ${data.queries?.length || 0} way(s): ${asked}.\n${horizon}\nIf you expected a recent item it may not have synced yet — check ChatPanel directly, or try different keywords (meeting titles are often generic).`;
    }
    return [
      horizon, '',
      `${rows.length} result(s) for "${args.question}" — searched ${data.queries.length} way(s): ${asked}`,
      ...rows.map((r, i) => `${fmtRow(r, i)}${r.foundBy?.length > 1 ? `\n     (matched ${r.foundBy.length} of the queries)` : ''}`),
    ].join('\n') + '\n\nget_record <id> for full text (maxChars/offset to page) · find_related <id> to follow connections.';
  }
  if (name === 'search_history') {
    const body = { query: String(args.query || ''), limit: Number(args.limit) || 10, offset: Math.max(0, Number(args.offset) || 0) };
    if (args.type) body.type = String(args.type);
    const since = parseWhen(args.since); if (since != null) body.since = since;
    const before = parseWhen(args.before); if (before != null) body.before = before;
    const data = await gatewayJson('/v1/history/search', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const rows = data.results || [];
    const horizon = horizonLine(data.newest, data.size);
    const filt = [args.type && `type=${args.type}`, args.since && `since=${args.since}`, args.before && `before=${args.before}`].filter(Boolean).join(', ');
    const tag = filt ? ` (${filt})` : '';
    if (!rows.length) return `No match for "${args.query}"${tag}.\n${horizon}\nIf you expected a recent item, it may not have synced yet — check ChatPanel directly, or broaden the query (titles are often generic; try content keywords, or drop a filter).`;
    return [horizon, '', `${rows.length} result(s) for "${args.query}"${tag}:`, ...rows.map(fmtRow)].join('\n')
      + '\n\nget_record <id> for full text (maxChars/offset to page) · find_related <id> to follow connections.';
  }
  if (name === 'get_record') {
    const q = new URLSearchParams({ id: String(args.id || '') });
    if (args.maxChars != null) q.set('maxChars', String(Math.max(1, Number(args.maxChars) || 0)));
    if (args.offset != null) q.set('offset', String(Math.max(0, Number(args.offset) || 0)));
    const data = await gatewayJson(`/v1/history/get?${q}`);
    const r = data.record;
    const head = `[${r.id}] ${r.title || '(untitled)'} · ${r.type}${r.date ? ' · ' + new Date(r.date).toISOString().slice(0, 10) : ''}`;
    const more = r.truncated
      ? `\n\n[showing ${r.text.length} of ${r.totalChars} chars (from offset ${r.offset}). For the next part call get_record again with offset=${r.offset + r.text.length}.]`
      : '';
    return `${head}\n\n${r.text || '(empty)'}${more}`;
  }
  if (name === 'find_related') {
    const data = await gatewayJson(`/v1/history/related?id=${encodeURIComponent(String(args.id || ''))}&limit=${Number(args.limit) || 5}`);
    const rows = data.results || [];
    if (!rows.length) return `Nothing related to ${args.id} found (or that id isn't in the warm index — run search_history first to get a valid id).`;
    return [`Records related to ${args.id}:`, ...rows.map(fmtRow)].join('\n') + '\n\nget_record <id> for full text.';
  }
  if (name === 'list_history') {
    const q = new URLSearchParams({ limit: String(Number(args.limit) || 50), offset: String(Number(args.offset) || 0) });
    const data = await gatewayJson(`/v1/history/list?${q}`);
    const items = data.items || [];
    if (!items.length) return 'History is empty (or the gateway has not been seeded yet — open ChatPanel with warm sync enabled).';
    const newest = items[0]?.date || null;
    return [horizonLine(newest, data.total), '', `${items.length} of ${data.total} records:`, ...items.map((it) => `[${it.id}] ${it.title || '(untitled)'} · ${it.type}${it.date ? ' · ' + new Date(it.date).toISOString().slice(0, 10) : ''} · ${it.chars} chars`)].join('\n');
  }
  if (name === 'recall') {
    const data = await gatewayJson('/v1/memory/recall', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: String(args.text || '') }),
    });
    if (!data.memories?.length) {
      return data.size
        ? 'Nothing in ChatPanel memory applies here.'
        : 'ChatPanel memory is empty — nothing is known about this user yet. Use `remember` when they state something durable about themselves or how they want to work.';
    }
    // The SHARED rendering, straight from the gateway, so a CLI agent is told exactly what
    // the side panel's models are told. Two renderings would drift, invisibly.
    return data.block;
  }
  if (name === 'remember') {
    const text = String(args.text || '').trim();
    if (!text) return 'remember needs `text` — one short sentence about the user.';
    const data = await gatewayJson('/v1/memory/remember', {
      method: 'POST', headers: { 'content-type': 'application/json', ...writeAuth() },
      body: JSON.stringify({
        text,
        kind: args.kind ? String(args.kind) : 'fact',
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        // Attribution is the accountability here. A CLI has no confirm dialog to show, so
        // instead every memory an agent writes is stamped with WHICH agent wrote it and
        // shows up that way in the extension's Memory page, where the user can correct or
        // delete it. Silent and anonymous would be the unacceptable combination.
        source: { via: 'mcp', surface: 'mcp', agent: clientName },
      }),
    });
    if (data.action === 'duplicate') return `Already known: "${data.record.text}" — nothing changed.`;
    if (data.action === 'update') return `Updated memory to "${data.record.text}" (was "${data.replaced?.text}"). It applies to every future session.`;
    return `Remembered: "${data.record.text}". It applies to every future ChatPanel session, on every model.`;
  }
  if (name === 'forget') {
    const query = String(args.query || '').trim();
    if (!query) return 'forget needs `query` — the memory to remove.';
    const data = await gatewayJson('/v1/memory/forget', {
      method: 'POST', headers: { 'content-type': 'application/json', ...writeAuth() }, body: JSON.stringify({ query }),
    });
    if (!data.removed?.length) return `No memory matches "${query}". Call recall to see what is stored.`;
    return `Forgot: ${data.removed.map((m) => `"${m.text}"`).join(', ')}.`;
  }
  if (name === 'list_skills') {
    let data;
    try { data = await bridgeJson('/skills'); }
    catch (e) { return `Installed skills are unavailable because the ChatPanel bridge is not running at ${bridgeBase()}. Install/start it with:\n    curl -fsSL https://dl.chatpanel.net/bridge/install.sh | bash\nThen retry. History tools work without the bridge. [${e.message}]`; }
    const rows = data.skills || [];
    if (!rows.length) return 'No skills installed on this machine yet.';
    return [`${rows.length} skill(s) installed:`, ...rows.map((r) => `- ${r.command || r.id}: ${r.description || r.name}${r.origin?.source ? ` (from ${r.origin.source})` : ''}`)].join('\n') + '\n\nUse open_skill with a name to load its instructions.';
  }
  if (name === 'open_skill') {
    let data;
    try { data = await bridgeJson(`/skills/${encodeURIComponent(String(args.name || '').trim())}`); }
    catch (e) { return `Could not open "${args.name}": ${e.message}. If the bridge isn't running, start it: curl -fsSL https://dl.chatpanel.net/bridge/install.sh | bash`; }
    return data.skill?.prompt || '(this skill has no extra instructions — just apply it.)';
  }
  if (name === 'read_skill_file') {
    const skill = encodeURIComponent(String(args.name || '').trim());
    const path = String(args.path || '').trim().split('/').map(encodeURIComponent).join('/');
    let data;
    try { data = await bridgeJson(`/skills/${skill}/file/${path}`); }
    catch (e) { return `Could not read ${args.path}: ${e.message}. If the bridge isn't running, start it: curl -fsSL https://dl.chatpanel.net/bridge/install.sh | bash`; }
    return data.text || '(empty)';
  }
  throw new Error(`unknown tool: ${name}`);
}

// Dispatch a JSON-RPC request → a response object (or null for a notification).
export async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    switch (method) {
      case 'initialize':
        clientName = params?.clientInfo?.name || clientName;
        return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER, instructions: INSTRUCTIONS });
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        const started = Date.now();
        try {
          const text = await callTool(params?.name, params?.arguments || {});
          reportAccess({ client: clientName, tool: params?.name, ok: true, ms: Date.now() - started, args: params?.arguments || {} });
          return ok({ content: [{ type: 'text', text }] });
        } catch (e) {
          reportAccess({ client: clientName, tool: params?.name, ok: false, ms: Date.now() - started, args: params?.arguments || {}, error: e.message });
          throw e;
        }
      }
      case 'ping':
        return ok({});
      default:
        if (typeof method === 'string' && method.startsWith('notifications/')) return null; // notification: no reply
        if (id === undefined) return null; // other notification
        return err(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    // Tool failures come back as a tool result with isError so the agent can react.
    if (method === 'tools/call') return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    return err(-32603, e.message);
  }
}

// Read newline-delimited JSON-RPC from stdin, write responses to stdout.
export async function runMcpServer() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  for await (const chunk of process.stdin) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore malformed lines
      }
      const reply = await handleRpc(msg);
      if (reply) write(reply);
    }
  }
}
