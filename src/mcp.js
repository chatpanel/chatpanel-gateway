// `chatpanel-gateway mcp` — a stdio MCP server that exposes the WARM history store
// (chats · meetings · notes) as agent tools. Point any MCP client (Codex, OpenCode,
// Claude Desktop, …) at `chatpanel-gateway mcp` and it gets search/get/list over the
// full local corpus — the reliable fallback when an agent's own context holds only
// hot/recent data.
//
// It PROXIES to the already-running gateway's HTTP API (127.0.0.1:<port>), so there
// is exactly one warm store (the service's) and this process never opens the DB.
// JSON-RPC 2.0 over stdio, newline-delimited — implemented directly (zero deps).

import { loadConfig } from './config.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER = { name: 'chatpanel-history', version: '1.0.0' };

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

const TOOLS = [
  {
    name: 'search_history',
    description: 'Full-text search the user\'s ChatPanel history — past chats, meeting transcripts, and notes — by keyword relevance. Use this to recall what was discussed or written when the current context does not already contain it.',
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
    description: 'List history records (newest first) with their id, title, type and date — no bodies. Use to browse or page the corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max items (default 50).' },
        offset: { type: 'number', description: 'Skip N items for paging (default 0).' },
      },
    },
  },
];

async function gatewayJson(path, init) {
  const res = await fetch(baseUrl() + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `gateway ${res.status}`);
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
    if (!rows.length) return `No matching history for: ${args.query}`;
    return [`${rows.length} result(s) for "${args.query}" (of ${data.size} indexed):`, ...rows.map((r, i) => `${i + 1}. [${r.id}] ${r.title || '(untitled)'} · ${r.type}${r.date ? ' · ' + new Date(r.date).toISOString().slice(0, 10) : ''} · score ${r.score?.toFixed?.(3) ?? r.score}`)].join('\n') + '\n\nUse get_record with an id for the full text.';
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
    if (!items.length) return 'History is empty (or the gateway has not been seeded yet).';
    return [`${items.length} of ${data.total} records:`, ...items.map((it) => `[${it.id}] ${it.title || '(untitled)'} · ${it.type}${it.date ? ' · ' + new Date(it.date).toISOString().slice(0, 10) : ''} · ${it.chars} chars`)].join('\n');
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
        return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER });
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        const text = await callTool(params?.name, params?.arguments || {});
        return ok({ content: [{ type: 'text', text }] });
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
