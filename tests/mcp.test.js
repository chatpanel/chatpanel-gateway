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

test('tools/list returns the history tools with schemas', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['find_related', 'get_record', 'list_history', 'list_skills', 'open_skill', 'read_skill_file', 'search_history']);
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
