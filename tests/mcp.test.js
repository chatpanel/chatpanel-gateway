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

test('initialize advertises tools capability', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(r.result.serverInfo.name, 'chatpanel-history');
  assert.ok(r.result.capabilities.tools);
  assert.ok(r.result.protocolVersion);
});

test('tools/list returns the three history tools with schemas', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_record', 'list_history', 'search_history']);
  for (const t of r.result.tools) assert.equal(t.inputSchema.type, 'object');
});

test('tools/call search_history formats gateway results', async () => {
  mockGateway({ 'POST /v1/history/search': { ok: true, size: 12, results: [{ id: 'meeting:2', title: 'Budget', type: 'meeting', date: 0, score: 1.23 }] } });
  const r = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_history', arguments: { query: 'budget' } } });
  assert.equal(r.result.isError, undefined);
  assert.match(r.result.content[0].text, /meeting:2/);
  assert.match(r.result.content[0].text, /Budget/);
});

test('tools/call get_record returns full text', async () => {
  mockGateway({ 'GET /v1/history/get': { ok: true, record: { id: 'chat:1', title: 'Roadmap', type: 'chat', date: 0, text: 'the full body' } } });
  const r = await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_record', arguments: { id: 'chat:1' } } });
  assert.match(r.result.content[0].text, /the full body/);
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
