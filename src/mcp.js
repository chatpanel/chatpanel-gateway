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

const PROTOCOL_VERSION = '2024-11-05';
const SERVER = { name: 'chatpanel-history', version: '1.0.0' };

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
    name: 'search_history',
    description: 'Full-text search the user\'s ChatPanel history — past chats, meeting transcripts, and notes — by keyword relevance. This is a LOCAL WARM COPY that syncs from ChatPanel; very recent items (a meeting from the last few hours) may not be here yet — every result reports how current the index is. If the user is sure something exists and it is not found, it likely has not synced; say so rather than concluding it does not exist. Meeting titles are often generic ("Zoom Meeting"), so search by CONTENT (topics, names, decisions), not the meeting title.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language / keyword query.' },
        limit: { type: 'number', description: 'Max results (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_record',
    description: 'Fetch one full history record (its complete text) by id, e.g. chat:<id>, meeting:<id>, or note:<id> returned by search_history.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Record id such as chat:abc, meeting:imp_123, or note:xyz.' } },
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
async function callTool(name, args = {}) {
  if (name === 'search_history') {
    const data = await gatewayJson('/v1/history/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: String(args.query || ''), limit: Number(args.limit) || 10 }),
    });
    const rows = data.results || [];
    const horizon = horizonLine(data.newest, data.size);
    if (!rows.length) return `No match for "${args.query}".\n${horizon}\nIf you expected a recent item, it may not have synced yet — check ChatPanel directly, or try broader content keywords (titles are often generic).`;
    return [horizon, '', `${rows.length} result(s) for "${args.query}":`, ...rows.map((r, i) => `${i + 1}. [${r.id}] ${r.title || '(untitled)'} · ${r.type}${r.date ? ' · ' + new Date(r.date).toISOString().slice(0, 10) : ''} · score ${r.score?.toFixed?.(3) ?? r.score}`)].join('\n') + '\n\nUse get_record with an id for the full text.';
  }
  if (name === 'get_record') {
    const data = await gatewayJson(`/v1/history/get?id=${encodeURIComponent(String(args.id || ''))}`);
    const r = data.record;
    return `[${r.id}] ${r.title || '(untitled)'} · ${r.type}${r.date ? ' · ' + new Date(r.date).toISOString().slice(0, 10) : ''}\n\n${r.text || '(empty)'}`;
  }
  if (name === 'list_history') {
    const q = new URLSearchParams({ limit: String(Number(args.limit) || 50), offset: String(Number(args.offset) || 0) });
    const data = await gatewayJson(`/v1/history/list?${q}`);
    const items = data.items || [];
    if (!items.length) return 'History is empty (or the gateway has not been seeded yet — open ChatPanel with warm sync enabled).';
    const newest = items[0]?.date || null;
    return [horizonLine(newest, data.total), '', `${items.length} of ${data.total} records:`, ...items.map((it) => `[${it.id}] ${it.title || '(untitled)'} · ${it.type}${it.date ? ' · ' + new Date(it.date).toISOString().slice(0, 10) : ''} · ${it.chars} chars`)].join('\n');
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
        return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER });
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
