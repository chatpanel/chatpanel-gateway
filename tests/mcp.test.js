// MCP stdio server: JSON-RPC dispatch + the three warm-history tools (proxied to
// the gateway HTTP, mocked here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRpc } from '../src/mcp.js';

const realFetch = globalThis.fetch;
function mockGateway(routes) {
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const key = `${init?.method || 'GET'} ${u.pathname}`;
    const body = routes[key];
    if (!body) return { ok: false, status: 404, json: async () => ({ error: { message: 'no route' } }) };
    return { ok: true, status: 200, json: async () => body };
  };
}

// The gateway MCP server is the SUPERSET: it also exposes the bridge's skills, proxied.
// The mock keys off pathname, so a bridge route (/skills…) is caught the same way.
test('the gateway MCP exposes the bridge skills as a superset', async () => {
  mockGateway({
    'GET /skills': { ok: true, skills: [{ id: 'foundry', command: 'microsoft-foundry', description: 'Deploy Foundry agents', origin: { source: 'codex' } }] },
    'GET /skills/microsoft-foundry': { ok: true, skill: { prompt: 'FULL FOUNDRY INSTRUCTIONS' } },
    'GET /skills/microsoft-foundry/file/references/auth.md': { ok: true, text: 'auth doc' },
  });
  try {
    const list = await handleRpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_skills', arguments: {} } });
    assert.match(list.result.content[0].text, /microsoft-foundry: Deploy Foundry agents \(from codex\)/);
    const open = await handleRpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'open_skill', arguments: { name: 'microsoft-foundry' } } });
    assert.match(open.result.content[0].text, /FULL FOUNDRY INSTRUCTIONS/);
    const read = await handleRpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'read_skill_file', arguments: { name: 'microsoft-foundry', path: 'references/auth.md' } } });
    assert.match(read.result.content[0].text, /auth doc/);
  } finally { globalThis.fetch = realFetch; }
});

test('skill tools degrade gracefully when the bridge is down', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const list = await handleRpc({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'list_skills', arguments: {} } });
    // A tool RESULT explaining the bridge is unreachable — not a failed connect.
    assert.match(list.result.content[0].text, /bridge is not running/i);
    assert.match(list.result.content[0].text, /install\.sh \| bash/, 'and tells the user how to fix it');
    assert.ok(!list.error, 'the RPC itself must not error — the connect stays clean');
  } finally { globalThis.fetch = realFetch; }
});

test('initialize advertises tools capability', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(r.result.serverInfo.name, 'chatpanel-history');
  assert.ok(r.result.capabilities.tools);
  assert.ok(r.result.protocolVersion);
});

test('initialize returns instructions that steer history questions to the tools', async () => {
  // This is what makes an agent reach for ChatPanel without being told: the server
  // instructions claim the meetings/notes/chats domain and say NOT to grep local files.
  const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const ins = r.result.instructions || '';
  assert.ok(ins.length > 100, 'instructions present');
  assert.match(ins, /meeting/i);
  assert.match(ins, /search_history/);
  assert.match(ins, /in addition|additionally/i); // additive steering — never "don't use your other tools"
});

test('tools/list returns the history, memory and skill tools with schemas', async () => {
  // One server, three things a local agent gets from ChatPanel: the user's HISTORY (what was
  // said), their MEMORY (what is durably true of them), and the skills on this machine.
  const r = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['find_related', 'forget', 'get_record', 'list_history', 'list_skills', 'open_skill', 'read_skill_file', 'recall', 'remember', 'search_history', 'smart_search']);
  for (const t of r.result.tools) assert.equal(t.inputSchema.type, 'object');
});

test('tools/call search_history formats gateway results, with the freshness horizon', async () => {
  const newest = new Date(2026, 7, 28, 4, 18).getTime(); // local 2026-08-28 04:18
  mockGateway({ 'POST /v1/history/search': { ok: true, size: 12, newest, results: [{ id: 'meeting:2', title: 'Budget', type: 'meeting', date: 0, score: 1.23 }] } });
  const r = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_history', arguments: { query: 'budget' } } });
  assert.equal(r.result.isError, undefined);
  assert.match(r.result.content[0].text, /meeting:2/);
  assert.match(r.result.content[0].text, /Budget/);
  // the horizon is stated so the model can reason about staleness
  assert.match(r.result.content[0].text, /current through 2026-08-28 04:18/, 'the index horizon (local time) is shown');
  assert.match(r.result.content[0].text, /may not have synced/i);
});

test('an empty search steers the model to "not synced yet", not "does not exist"', async () => {
  mockGateway({ 'POST /v1/history/search': { ok: true, size: 12, newest: Date.now(), results: [] } });
  const r = await handleRpc({ jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'search_history', arguments: { query: 'nope' } } });
  assert.match(r.result.content[0].text, /may not have synced/i, 'it must not imply the item does not exist');
  assert.match(r.result.content[0].text, /check ChatPanel directly/i);
});

test('the search tool description warns the index is a warm copy that can lag', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 34, method: 'tools/list' });
  const search = r.result.tools.find((t) => t.name === 'search_history');
  assert.match(search.description, /warm copy|not.*synced|may not be here yet/i);
  assert.match(search.description, /search by CONTENT|generic/i, 'and warns that titles are generic');
});

test('tools/call get_record returns full text', async () => {
  mockGateway({ 'GET /v1/history/get': { ok: true, record: { id: 'chat:1', title: 'Roadmap', type: 'chat', date: 0, text: 'the full body' } } });
  const r = await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_record', arguments: { id: 'chat:1' } } });
  assert.match(r.result.content[0].text, /the full body/);
});

test('tool descriptions advertise notes as a source type, not just chats/meetings', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 8, method: 'tools/list' });
  const search = r.result.tools.find((t) => t.name === 'search_history');
  const get = r.result.tools.find((t) => t.name === 'get_record');
  assert.match(search.description, /notes/i); // notes are a unified source type now
  assert.match(get.description, /note:/); // get_record's id example includes note:<id>
});

test('get_record surfaces a note record by note:<id>', async () => {
  mockGateway({ 'GET /v1/history/get': { ok: true, record: { id: 'note:xyz', title: 'Draft', type: 'note', date: 0, text: 'note body text' } } });
  const r = await handleRpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_record', arguments: { id: 'note:xyz' } } });
  assert.match(r.result.content[0].text, /note:xyz/);
  assert.match(r.result.content[0].text, /note body text/);
});

test('tool errors surface as isError content, not a protocol error', async () => {
  mockGateway({}); // every route 404s
  const r = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search_history', arguments: { query: 'x' } } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Error:/);
});

test('notifications get no reply; unknown method is -32601', async () => {
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const r = await handleRpc({ jsonrpc: '2.0', id: 7, method: 'nope' });
  assert.equal(r.error.code, -32601);
});

test.after(() => { globalThis.fetch = realFetch; });

// --- MEMORY over MCP: the point of the whole module ---------------------------------------
// A CLI agent gets the user's standing facts through the same contract the side panel uses,
// so "call me Alex, never open with a preamble" holds in the terminal too.

test('recall hands back the SHARED rendering, not a second one', async () => {
  // The gateway returns memoryBlock()'s output verbatim. If this proxy reformatted it, a CLI
  // agent and the side panel would be told subtly different things and nobody would notice.
  mockGateway({
    'POST /v1/memory/recall': {
      ok: true, size: 2,
      memories: [{ id: 'a', kind: 'identity', text: 'Goes by Alex' }],
      block: '## What you already know about this user\n- (identity) Goes by Alex',
    },
  });
  try {
    const r = await handleRpc({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'recall', arguments: { text: 'rename this' } } });
    assert.equal(r.result.content[0].text, '## What you already know about this user\n- (identity) Goes by Alex');
  } finally { globalThis.fetch = realFetch; }
});

test('an empty memory tells the agent how to fill it, rather than just saying no', async () => {
  mockGateway({ 'POST /v1/memory/recall': { ok: true, size: 0, memories: [], block: '' } });
  try {
    const r = await handleRpc({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'recall', arguments: {} } });
    assert.match(r.result.content[0].text, /empty/i);
    assert.match(r.result.content[0].text, /`remember`/, 'and names the tool that fixes it');
  } finally { globalThis.fetch = realFetch; }
});

test('a memory written by an agent is stamped with WHICH agent wrote it', async () => {
  // There is no confirm dialog on a CLI, so attribution plus an inspectable list in the
  // extension IS the accountability. Silent AND anonymous would be the bad combination.
  let sent = null;
  globalThis.fetch = async (url, init) => {
    // Every tool call also reports to the access log, so key on the route we mean.
    if (new URL(url).pathname === '/v1/memory/remember') sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, action: 'create', record: { text: 'Prefers pnpm over npm' } }) };
  };
  try {
    await handleRpc({ jsonrpc: '2.0', id: 22, method: 'initialize', params: { clientInfo: { name: 'codex' } } });
    const r = await handleRpc({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'remember', arguments: { text: 'Prefers pnpm over npm', kind: 'preference' } } });
    assert.equal(sent.source.via, 'mcp');
    assert.equal(sent.source.agent, 'codex', 'the calling agent is recorded');
    assert.match(r.result.content[0].text, /every future ChatPanel session/, 'and the agent is told the write is durable, so it says so');
  } finally { globalThis.fetch = realFetch; }
});

test('a correction reads as a correction, and a restatement changes nothing', async () => {
  mockGateway({ 'POST /v1/memory/remember': { ok: true, action: 'update', record: { text: 'Goes by Sam' }, replaced: { text: 'Goes by Alex' } } });
  try {
    const r = await handleRpc({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'remember', arguments: { text: 'Goes by Sam', kind: 'identity' } } });
    assert.match(r.result.content[0].text, /was "Goes by Alex"/);
  } finally { globalThis.fetch = realFetch; }
  mockGateway({ 'POST /v1/memory/remember': { ok: true, action: 'duplicate', record: { text: 'Goes by Sam' } } });
  try {
    const r = await handleRpc({ jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'remember', arguments: { text: 'Goes by Sam' } } });
    assert.match(r.result.content[0].text, /Already known/);
  } finally { globalThis.fetch = realFetch; }
});

test('forget says exactly what went, and a miss is not silent', async () => {
  mockGateway({ 'POST /v1/memory/forget': { ok: true, removed: [{ text: 'Runs Postgres in Frankfurt' }] } });
  try {
    const r = await handleRpc({ jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'forget', arguments: { query: 'the Frankfurt thing' } } });
    assert.match(r.result.content[0].text, /Forgot: "Runs Postgres in Frankfurt"/);
  } finally { globalThis.fetch = realFetch; }
  mockGateway({ 'POST /v1/memory/forget': { ok: true, removed: [] } });
  try {
    const r = await handleRpc({ jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'forget', arguments: { query: 'nothing' } } });
    assert.match(r.result.content[0].text, /No memory matches/);
    assert.match(r.result.content[0].text, /recall/, 'and points at how to look');
  } finally { globalThis.fetch = realFetch; }
});

test('the memory tools are advertised, and the instructions steer a model to them', async () => {
  const list = await handleRpc({ jsonrpc: '2.0', id: 28, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['recall', 'remember', 'forget']) assert.ok(names.includes(n), `${n} is exposed`);

  const init = await handleRpc({ jsonrpc: '2.0', id: 29, method: 'initialize', params: {} });
  assert.match(init.result.instructions, /MEMORY/, 'the host is told memory exists');
  assert.match(init.result.instructions, /call it EARLY/, 'and when to reach for it');
});
