import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMcpCli, formatToolsList, oneLiner } from '../src/mcp-cli.js';

const TOOLS = [
  { name: 'recall', description: 'Recall the user\'s durable facts. Call it early in a session.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_record', description: 'Fetch one history record\'s full text by id (chat:<id>, meeting:<id>, note:<id> from search_history). For a long transcript, page it.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];
const fakeRpc = (calls, { answer } = {}) => async (msg) => {
  calls.push(msg);
  if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
  if (msg.method === 'tools/call') return answer ? answer(msg.params) : { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `ran ${msg.params.name} ${JSON.stringify(msg.params.arguments)}` }] } };
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } };
};
const run = async (argv, opts = {}) => {
  const out = []; const err = []; const calls = [];
  const code = await runMcpCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s), rpc: fakeRpc(calls, opts) });
  return { code, out: out.join(''), err: err.join(''), calls };
};

test('tools list prints names, required fields and one-liners — no schemas', async () => {
  const r = await run(['tools', 'list']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^recall\s+\(\)\s+Recall the user's durable facts\.$/m);
  assert.match(r.out, /^get_record\s+\(id\)\s+Fetch one history record's full text by id/m);
  assert.doesNotMatch(r.out, /properties/, 'no schema on the cheap path');
  assert.deepEqual(r.calls.map((c) => c.method), ['tools/list']);
});

test('tools schema prints exactly one tool\'s schema, and names the miss', async () => {
  const ok = await run(['tools', 'schema', 'get_record']);
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.out).inputSchema.required, ['id']);
  const miss = await run(['tools', 'schema', 'nope']);
  assert.equal(miss.code, 2);
  assert.match(miss.err, /no tool named "nope"/);
  assert.equal((await run(['tools', 'schema'])).code, 2);
});

test('call runs a tool with JSON arguments and exits 0', async () => {
  const r = await run(['call', 'get_record', '{"id":"note:1"}']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'ran get_record {"id":"note:1"}\n');
  assert.equal(r.calls[0].params.name, 'get_record');
  const none = await run(['call', 'recall']);
  assert.equal(none.code, 0, 'no arguments means {}');
  assert.deepEqual(none.calls[0].params.arguments, {});
});

test('call distinguishes a tool error (1) from a usage or transport failure (2)', async () => {
  const bad = await run(['call', 'get_record', '{not json']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /must be a JSON object/);
  assert.equal((await run(['call', 'get_record', '[1]'])).code, 2);
  assert.equal((await run(['call'])).code, 2);
  const toolErr = await run(['call', 'get_record', '{"id":"x"}'], { answer: () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Error: no record x' }], isError: true } }) });
  assert.equal(toolErr.code, 1);
  assert.match(toolErr.err, /no record x/);
  const down = await run(['call', 'recall'], { answer: () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Error: fetch failed (ECONNREFUSED 127.0.0.1:4320)' }], isError: true } }) });
  assert.equal(down.code, 2, 'the gateway being down is transport, not a tool answer');
});

test('an unknown verb prints usage and exits 2', async () => {
  const r = await run(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Usage:/);
  assert.equal(oneLiner('One. Two three four five six seven eight.'), 'One. Two three four five six seven eight.', 'a short first "sentence" is not a boundary');
  assert.equal(formatToolsList([{ name: 'a', description: 'd' }]).trim(), 'a     ()                     d');
});
