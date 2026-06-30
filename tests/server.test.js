// Live HTTP integration: start the real gateway pointed at a fake upstream, and
// assert (a) the upstream receives REDACTED text, (b) the client gets the reply
// with placeholders RESTORED. Covers non-streaming + streaming + the Responses
// (Codex) shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGateway } from '../src/server.js';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}
async function fakeUpstream(handler) {
  const s = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(Buffer.concat(chunks).toString('utf8'), req, res));
  });
  return { port: await listen(s), close: () => s.close() };
}

const cfg = (openaiBase) => ({
  host: '127.0.0.1', port: 0, backend: 'api',
  upstreams: { openai: { baseUrl: openaiBase }, anthropic: { baseUrl: openaiBase } },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true },
  logRequests: false,
});

test('chat/completions: upstream sees redacted, client gets restored (non-stream)', async () => {
  let seenBody = null;
  const up = await fakeUpstream((body, req, res) => {
    seenBody = body;
    res.writeHead(200, { 'content-type': 'application/json' });
    // Echo a placeholder back as if the model repeated it.
    const token = JSON.parse(body).messages[0].content.match(/\[\[EMAIL_1\]\]/)[0];
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `mail to ${token}` } }] }));
  });
  const gw = createGateway(cfg(`http://127.0.0.1:${up.port}`));
  const port = await listen(gw);

  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'write alex@example.com' }] }),
  });
  const json = await r.json();

  assert.doesNotMatch(seenBody, /alex@example\.com/, 'upstream must NOT see the email');
  assert.match(seenBody, /\[\[EMAIL_1\]\]/);
  assert.match(json.choices[0].message.content, /alex@example\.com/, 'client must see it restored');
  gw.close(); up.close();
});

test('streaming SSE restores tokens (even split across chunks)', async () => {
  const up = await fakeUpstream((body, req, res) => {
    const token = JSON.parse(body).messages[0].content.match(/\[\[EMAIL_1\]\]/)[0];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const mid = Math.floor(token.length / 2);
    res.write(`data: {"choices":[{"delta":{"content":"to ${token.slice(0, mid)}`);
    res.write(`${token.slice(mid)}"}}]}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const gw = createGateway(cfg(`http://127.0.0.1:${up.port}`));
  const port = await listen(gw);

  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'mail alex@example.com' }] }),
  });
  const text = await r.text();
  assert.match(text, /alex@example\.com/);
  assert.doesNotMatch(text, /\[\[EMAIL_1\]\]/);
  gw.close(); up.close();
});

test('api: tool-call args get the REAL value (pseudonym undone), visible text keeps the pseudonym', async () => {
  let seen = null;
  const up = await fakeUpstream((body, req, res) => {
    seen = body; // upstream sees the pseudonymized prompt
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'You are Twinkle.',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: JSON.stringify({ q: 'president Twinkle' }) } }] }, finish_reason: 'tool_calls' }] }));
  });
  const gw = createGateway({
    host: '127.0.0.1', port: 0, backend: 'api',
    upstreams: { openai: { baseUrl: `http://127.0.0.1:${up.port}` }, anthropic: {} },
    redaction: { tier: 'basic', dictionary: [{ value: 'John', alias: 'Twinkle' }], detection: { backend: 'off' }, redactSystem: true },
    ner: { autostart: false }, allowedOrigins: [], maxBodyBytes: 1 << 20, logRequests: false,
  });
  const port = await listen(gw);
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'I am John' }] }),
  });
  const j = await r.json();
  assert.doesNotMatch(seen, /John/, 'upstream model only sees the pseudonym');
  assert.match(j.choices[0].message.content, /Twinkle/, 'visible text keeps the pseudonym');
  const args = j.choices[0].message.tool_calls[0].function.arguments;
  assert.match(args, /John/, 'tool args get the REAL value');
  assert.doesNotMatch(args, /Twinkle/);
  gw.close(); up.close();
});

test('auto-narrow: trims MCP tools to top-k by relevance, never drops the client\'s core tools', async () => {
  let seen = null;
  const up = await fakeUpstream((body, req, res) => {
    seen = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  const fn = (name, description) => ({ type: 'function', function: { name, description } });
  const tools = [
    fn('bash', 'run a shell command'), fn('read', 'read a file'), // core (non-mcp) — must survive
    fn('mcp_wikipedia__search', 'search wikipedia articles'),
    fn('mcp_hackernews__search', 'search hacker news'),
    fn('mcp_github__search', 'search github repos'),
    fn('mcp_jira__search', 'search jira issues'),
    fn('mcp_slack__search', 'search slack messages'),
  ];
  const gw = createGateway({
    host: '127.0.0.1', port: 0, backend: 'api',
    upstreams: { openai: { baseUrl: `http://127.0.0.1:${up.port}` }, anthropic: {} },
    redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' } },
    tools: { autoNarrow: true, maxPerTurn: 2 },
    ner: { autostart: false }, allowedOrigins: [], maxBodyBytes: 1 << 20, logRequests: false,
  });
  const port = await listen(gw);
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', tools, messages: [{ role: 'user', content: 'use the wiki search to find a president' }] }),
  });
  const names = seen.tools.map((t) => t.function.name);
  assert.ok(names.includes('bash') && names.includes('read'), 'core tools must always be kept');
  assert.ok(names.includes('mcp_wikipedia__search'), 'the relevant MCP tool must be kept');
  assert.equal(names.filter((n) => n.startsWith('mcp_')).length, 2, 'MCP tools narrowed to the cap (2)');
  gw.close(); up.close();
});

test('redact-remote: gateway harness keeps the redacted token for remote MCP tool args, real for non-MCP', async () => {
  const up = await fakeUpstream((body, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'mcp_wiki__search', arguments: JSON.stringify({ q: 'Twinkle' }) } },
      { id: 'b', type: 'function', function: { name: 'calc', arguments: JSON.stringify({ q: 'Twinkle' }) } },
    ] }, finish_reason: 'tool_calls' }] }));
  });
  const gw = createGateway({
    host: '127.0.0.1', port: 0, backend: 'api',
    upstreams: { openai: { baseUrl: `http://127.0.0.1:${up.port}` }, anthropic: {} },
    redaction: { tier: 'basic', dictionary: [{ value: 'John', alias: 'Twinkle' }], detection: { backend: 'off' } },
    tools: { toolData: 'redactRemote' },
    ner: { autostart: false }, allowedOrigins: [], maxBodyBytes: 1 << 20, logRequests: false,
  });
  const port = await listen(gw);
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'I am John' }] }),
  });
  const tcs = (await r.json()).choices[0].message.tool_calls;
  const wiki = tcs.find((t) => t.function.name === 'mcp_wiki__search').function.arguments;
  const calc = tcs.find((t) => t.function.name === 'calc').function.arguments;
  assert.match(wiki, /Twinkle/, 'remote MCP tool keeps the redacted token (PII off the server)');
  assert.doesNotMatch(wiki, /John/);
  assert.match(calc, /John/, 'non-MCP (local) tool gets the real value');
  gw.close(); up.close();
});

test('loop guard: refuses to forward to a destination that is the gateway itself', async () => {
  const gw = createGateway({
    host: '127.0.0.1', port: 4320, // self port; destination below points here
    destinations: [{ id: 'loop', type: 'api', protocol: 'openai', baseUrl: 'http://127.0.0.1:4320/v1', models: ['loopmodel'] }],
    redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' } },
    ner: { autostart: false }, allowedOrigins: [], maxBodyBytes: 1 << 20, logRequests: false,
  });
  const port = await listen(gw);
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'loopmodel', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 508);
  assert.match((await r.text()), /loop/i);
  gw.close();
});

test('responses (Codex) shape: input + instructions redacted, output restored', async () => {
  let seenBody = null;
  const up = await fakeUpstream((body, req, res) => {
    seenBody = body;
    const token = JSON.parse(body).input.match(/\[\[EMAIL_1\]\]/)[0];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: `ok ${token}` }] }] }));
  });
  const gw = createGateway(cfg(`http://127.0.0.1:${up.port}`));
  const port = await listen(gw);

  const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5-codex', input: 'send to alex@example.com', instructions: 'be brief' }),
  });
  const json = await r.json();
  assert.doesNotMatch(seenBody, /alex@example\.com/);
  assert.match(json.output[0].content[0].text, /alex@example\.com/);
  gw.close(); up.close();
});

// Helper: send one chat request, then read back the newest /logs entry.
async function sendAndGetLog(extra) {
  const up = await fakeUpstream((body, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  const gw = createGateway({ ...cfg(`http://127.0.0.1:${up.port}`), logRequests: true, ...extra });
  const port = await listen(gw);
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'mail alex@example.com' }] }),
  });
  const logs = await (await fetch(`http://127.0.0.1:${port}/logs`)).json();
  gw.close(); up.close();
  return logs.entries[0];
}

test('/logs detail (values): captures the real → placeholder mapping', async () => {
  const e = await sendAndGetLog({ logDetail: 'values' });
  assert.equal(e.redacted, 1);
  assert.ok(Array.isArray(e.detail) && e.detail.length === 1);
  const [d] = e.detail;
  assert.equal(d.type, 'EMAIL');
  assert.equal(d.token, 'EMAIL_1');
  assert.equal(d.value, 'alex@example.com', 'values mode records the real PII');
});

test('/logs detail (types): records the entity type + token but NEVER the value', async () => {
  const e = await sendAndGetLog({ logDetail: 'types' });
  const [d] = e.detail;
  assert.equal(d.type, 'EMAIL');
  assert.equal(d.token, 'EMAIL_1');
  assert.ok(!('value' in d), 'types mode must not leak the real value');
  // Belt-and-suspenders: the raw email must not appear anywhere in the payload.
  assert.doesNotMatch(JSON.stringify(e), /alex@example\.com/);
});

test('/logs detail: off by default — counts only, no breakdown', async () => {
  const e = await sendAndGetLog({}); // logDetail omitted → redactionDetail() returns undefined
  assert.equal(e.redacted, 1);
  assert.equal(e.detail, undefined, 'no detail captured when logDetail is off');
});

test('streaming: timing splits into model (time-to-first-token) + stream (generation)', async () => {
  const up = await fakeUpstream((body, req, res) => {
    const token = JSON.parse(body).messages[0].content.match(/\[\[EMAIL_1\]\]/)[0];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: {"choices":[{"delta":{"content":"to ${token}"}}]}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const gw = createGateway({ ...cfg(`http://127.0.0.1:${up.port}`), logRequests: true });
  const port = await listen(gw);
  await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'mail alex@example.com' }] }),
  })).text();
  const logs = await (await fetch(`http://127.0.0.1:${port}/logs`)).json();
  const e = logs.entries[0];
  for (const stage of ['redact', 'upstream', 'stream', 'total']) {
    assert.equal(typeof e.timings?.[stage], 'number', `streamed request times the ${stage} leg`);
  }
  gw.close(); up.close();
});

test('logging OFF: no /logs entries and no timing work (zero added latency)', async () => {
  const up = await fakeUpstream((body, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  const gw = createGateway({ ...cfg(`http://127.0.0.1:${up.port}`), logRequests: false });
  const port = await listen(gw);
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'mail alex@example.com' }] }),
  });
  const logs = await (await fetch(`http://127.0.0.1:${port}/logs`)).json();
  assert.deepEqual(logs.entries, [], 'logRequests:false → nothing recorded, no trace built');
  gw.close(); up.close();
});

// The whole privacy round-trip, including the optional tool branch, walked stage
// by stage — and proof that each leg is timed in the log. In the API model a tool
// round-trip is two requests:
//   ① prompt → harness[redact] → model input → model output(tool_call)
//      → harness[restore] → tool input (REAL values the client executes)
//   ② tool output → harness[redact] → model input → model output
//      → harness[restore] → user response
test('full flow: redact → model → restore tool args → re-redact tool result → restore reply, each leg timed', async () => {
  let turn = 0;
  const seen = [];
  const up = await fakeUpstream((body, req, res) => {
    const j = JSON.parse(body); seen.push(j);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (turn++ === 0) {
      // ① model echoes the redacted email placeholder back inside a tool call.
      const tok = JSON.stringify(j).match(/\[\[EMAIL_1\]\]/)[0];
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'looking up',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ addr: tok }) } }] } }] }));
    } else {
      // ② after the client runs the tool, the model replies referencing the
      //    (re-redacted) tool-result email. The fresh vault assigns EMAIL_1 to the
      //    original prompt's address and EMAIL_2 to the tool result — echo EMAIL_2.
      const tok = JSON.stringify(j).match(/\[\[EMAIL_2\]\]/)[0];
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `done: ${tok}` } }] }));
    }
  });
  const gw = createGateway({ ...cfg(`http://127.0.0.1:${up.port}`), logRequests: true });
  const port = await listen(gw);

  // ① prompt with PII → tool call with the REAL email restored for the client.
  const r1 = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'email alex@example.com please' }] }),
  })).json();
  assert.doesNotMatch(JSON.stringify(seen[0]), /alex@example\.com/, '① model input is redacted');
  const args = JSON.parse(r1.choices[0].message.tool_calls[0].function.arguments);
  assert.equal(args.addr, 'alex@example.com', '① tool input gets the REAL value (harness restore)');

  // ② client runs the tool; its OUTPUT carries a fresh PII value that must be
  //    re-redacted before the model sees it, then restored in the final reply.
  const r2 = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [
      { role: 'user', content: 'email alex@example.com please' },
      { role: 'assistant', content: 'looking up', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'contact: support@acme.com' },
    ] }),
  })).json();
  assert.doesNotMatch(JSON.stringify(seen[1]), /support@acme\.com/, '② tool output is re-redacted before the model');
  assert.match(r2.choices[0].message.content, /support@acme\.com/, '② final reply is restored for the user');

  // Each leg is timed in the log (async commit already flushed by now).
  const logs = await (await fetch(`http://127.0.0.1:${port}/logs`)).json();
  assert.equal(logs.entries.length, 2, 'both turns logged');
  for (const e of logs.entries) {
    for (const stage of ['redact', 'upstream', 'restore', 'total']) {
      assert.equal(typeof e.timings?.[stage], 'number', `each turn times the ${stage} stage`);
    }
    assert.ok(e.timings.total >= e.timings.upstream, 'total spans the model hop');
  }
  gw.close(); up.close();
});
