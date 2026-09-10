// AN AGENT SPENDS ITS FIRST TEN SECONDS WORKING, AND THE CLIENT SHOULD SEE IT.
//
// The bridge reports what a coding agent is doing — the directory it opened, the files it
// read, "working" — and the gateway dropped every one of those events with a comment calling
// them local side effects. They are; they are also the only thing that happens before the
// agent speaks. A client routed through this gateway showed a dead spinner while one talking
// to the bridge DIRECTLY showed the work, and a protocol gap that rewards going around the
// redacting proxy is a security problem wearing a UI problem's clothes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGateway } from '../src/server.js';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

/** A bridge that emits the event sequence a real agent turn produces. */
async function fakeBridge(events) {
  const s = createServer((req, res) => {
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version: '0.11.8', agents: [{ id: 'codex', available: true }] }));
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  return { port: await listen(s), close: () => s.close() };
}

const cfg = (bridgePort) => ({
  host: '127.0.0.1', port: 0, backend: 'bridge',
  bridge: { url: `http://127.0.0.1:${bridgePort}` },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true },
  logRequests: false,
});

/** Read the SSE stream into frames a client would see. */
async function collect(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try { out.push(JSON.parse(p)); } catch { /* not ours */ }
  }
  return out;
}

test('the agent’s status and tool events reach the client', async () => {
  const br = await fakeBridge([
    { type: 'run', id: 'run_1' },
    { type: 'status', text: 'Codex working' },
    { type: 'tool', name: 'read_file', path: '/tmp/notes.md' },
    { type: 'delta', text: 'done.' },
    { type: 'done', text: '' },
  ]);
  const gw = createGateway(cfg(br.port));
  const port = await listen(gw);
  try {
    const frames = await collect(port, { model: 'codex', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const activity = frames.filter((f) => f.chatpanel?.kind === 'activity').map((f) => f.chatpanel.event);
    assert.ok(activity.some((e) => e.type === 'status' && e.text === 'Codex working'), 'status came through');
    assert.ok(activity.some((e) => e.type === 'tool' && e.name === 'read_file'), 'the tool call came through');
    // ...and the assistant's text still arrives as ordinary content.
    const said = frames.map((f) => f.choices?.[0]?.delta?.content).filter(Boolean).join('');
    assert.equal(said, 'done.');
  } finally { gw.close(); br.close(); }
});

test('an activity frame carries an EMPTY delta, so a strict OpenAI client ignores it', async () => {
  const br = await fakeBridge([
    { type: 'status', text: 'Codex working' },
    { type: 'delta', text: 'hello' },
    { type: 'done', text: '' },
  ]);
  const gw = createGateway(cfg(br.port));
  const port = await listen(gw);
  try {
    const frames = await collect(port, { model: 'codex', messages: [{ role: 'user', content: 'hi' }], stream: true });
    for (const f of frames.filter((x) => x.chatpanel)) {
      assert.equal(f.object, 'chat.completion.chunk', 'it is a well-formed chunk');
      assert.deepEqual(f.choices[0].delta, {}, 'with nothing in the delta to misread');
      assert.equal(f.choices[0].finish_reason, null, 'and it does not end the turn');
    }
    // The concatenated content is exactly the answer, with no activity text spliced in.
    const said = frames.map((f) => f.choices?.[0]?.delta?.content).filter(Boolean).join('');
    assert.equal(said, 'hello');
  } finally { gw.close(); br.close(); }
});

test('ACTIVITY IS RESTORED — a status line must not read [[PERSON_1]] to the person it names', async () => {
  // The agent was handed placeholders, so what it echoes in a status line contains them.
  const br = await fakeBridge([
    { type: 'status', text: 'reading notes about alex@example.com' },
    { type: 'delta', text: 'ok' },
    { type: 'done', text: '' },
  ]);
  const gw = createGateway(cfg(br.port));
  const port = await listen(gw);
  try {
    const frames = await collect(port, {
      model: 'codex',
      messages: [{ role: 'user', content: 'look at alex@example.com' }],
      stream: true,
    });
    const status = frames.find((f) => f.chatpanel?.event?.type === 'status')?.chatpanel.event.text || '';
    assert.doesNotMatch(status, /\[\[EMAIL_\d+\]\]/, 'no placeholder survived into the UI');
  } finally { gw.close(); br.close(); }
});

test('a non-streaming request is unaffected — activity is a streaming concern', async () => {
  const br = await fakeBridge([
    { type: 'status', text: 'Codex working' },
    { type: 'delta', text: 'the answer' },
    { type: 'done', text: '' },
  ]);
  const gw = createGateway(cfg(br.port));
  const port = await listen(gw);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await res.json();
    assert.equal(body.choices[0].message.content, 'the answer');
  } finally { gw.close(); br.close(); }
});

// ---------------------------------------------------------------------------
// One address for everything — models, agent availability and skills
// ---------------------------------------------------------------------------

test('/v1/models says which AGENTS are actually installed, so a picker can', async () => {
  // The routing table names every agent the gateway would route to, installed or not. A
  // fresh machine otherwise offers a list where each choice fails on first use.
  const br = await fakeBridge([]);
  const gw = createGateway({
    ...cfg(br.port),
    destinations: [{ id: 'codex', type: 'agent', models: ['codex'] }, { id: 'claude', type: 'agent', models: ['claude'] }],
  });
  const port = await listen(gw);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    const codex = body.data.find((m) => m.id === 'codex');
    const claude = body.data.find((m) => m.id === 'claude');
    assert.equal(codex?.available, true, 'the bridge said codex is there');
    assert.equal(claude?.available, false, 'and that claude is not');
  } finally { gw.close(); br.close(); }
});

test('an unreachable bridge leaves availability UNSTATED, never false', async () => {
  // Absent means "we did not find out". Greying out every agent because one health check
  // timed out is worse than saying nothing about them.
  const gw = createGateway({
    ...cfg(1),
    destinations: [{ id: 'codex', type: 'agent', models: ['codex'] }],
  });
  const port = await listen(gw);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    const codex = body.data.find((m) => m.id === 'codex');
    assert.ok(codex, 'the agent is still listed');
    assert.equal('available' in codex, false, 'but nothing is claimed about it');
  } finally { gw.close(); }
});

test('/skills is served by the gateway, so a client needs one address and one token', async () => {
  const s = createServer((req, res) => {
    if (req.url.startsWith('/skills')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, skills: [{ id: 'graphify', name: 'graphify', description: 'to a graph' }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  const port = await listen(s);
  const gw = createGateway(cfg(port));
  const gwPort = await listen(gw);
  try {
    const body = await (await fetch(`http://127.0.0.1:${gwPort}/skills`)).json();
    assert.equal(body.skills.length, 1);
    assert.equal(body.skills[0].id, 'graphify');
  } finally { gw.close(); s.close(); }
});

test('a route this gateway does not have 404s with the REASON, not the model proxy’s error', async () => {
  // /redact reaching an older gateway fell through to the model proxy and came back as
  // "upstream fetch failed" — a missing feature reported as the user's endpoint being down.
  const br = await fakeBridge([]);
  const gw = createGateway(cfg(br.port));
  const port = await listen(gw);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/redact/nope`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.type, 'unknown_endpoint');
    assert.match(body.error.message, /update it/);
  } finally { gw.close(); br.close(); }
});

test('every model says HOW to call it, not only who owns it', async () => {
  // owned_by is a routing fact. A client building a request needs the calling convention,
  // and guessing it from the id is how `claude` the local CLI gets called as if it were
  // Anthropic's hosted API.
  const br = await fakeBridge([]);
  const gw = createGateway({
    ...cfg(br.port),
    backend: 'api',
    destinations: [
      { id: 'codex', type: 'agent', models: ['codex'] },
      { id: 'anthropic', type: 'api', protocol: 'anthropic', baseUrl: 'http://127.0.0.1:1', models: ['claude-sonnet-5'] },
      { id: 'local', type: 'api', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', models: ['qwen3'] },
    ],
  });
  const port = await listen(gw);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    const by = (id) => body.data.find((m) => m.id === id);

    assert.equal(by('codex').provider_type, 'agent');
    assert.deepEqual(by('codex').endpoints, ['/v1/chat/completions'], 'an agent answers only there');

    assert.equal(by('claude-sonnet-5').provider_type, 'anthropic');
    assert.deepEqual(by('claude-sonnet-5').endpoints, ['/v1/messages'], 'Messages API, not chat/completions');

    assert.equal(by('qwen3').provider_type, 'openai');
    assert.ok(by('qwen3').endpoints.includes('/v1/responses'));

    // Grouping a picker by provider is now a field read, not a guess about the id.
    assert.equal(by('qwen3').provider, 'local');
  } finally { gw.close(); br.close(); }
});
