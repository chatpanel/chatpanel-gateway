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

test('one skill comes back WITH its prompt — the list only carries a character count', async () => {
  // /skills answers promptChars because ninety-five prompt bodies is a megabyte nobody asked
  // for. Scoping a task to a skill needs the body, and without this route the only way to get
  // it is straight at the bridge — the habit the /skills route exists to prevent.
  let asked = '';
  const s = createServer((req, res) => {
    asked = req.url;
    if (req.url === '/skills/graphify') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, skill: { id: 'graphify', name: 'graphify', prompt: 'Turn the input into a graph.' } }));
    }
    res.writeHead(404); res.end('{}');
  });
  const port = await listen(s);
  const gw = createGateway(cfg(port));
  const gwPort = await listen(gw);
  try {
    const body = await (await fetch(`http://127.0.0.1:${gwPort}/skills/graphify`)).json();
    assert.equal(body.skill.prompt, 'Turn the input into a graph.');
    assert.equal(asked, '/skills/graphify');
  } finally { gw.close(); s.close(); }
});

test('a skill id is a FILE NAME on the user’s disk, so a traversal never reaches the bridge', async () => {
  let reached = false;
  const s = createServer((req, res) => { reached = true; res.writeHead(200); res.end('{}'); });
  const port = await listen(s);
  const gw = createGateway(cfg(port));
  const gwPort = await listen(gw);
  try {
    // Encoded so it arrives as ONE path segment and matches the route, rather than being
    // rejected by the pattern — which is exactly the case the id check has to catch.
    const r = await fetch(`http://127.0.0.1:${gwPort}/skills/${encodeURIComponent('../../etc/passwd')}`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.type, 'invalid_request');
    assert.equal(reached, false, 'the bridge was never asked to open it');
    // A bare `..` never reaches the route at all: URL parsing resolves the segment away, so
    // the path stops being a /skills one. Safe by a different mechanism, and worth knowing —
    // it is why the id check cannot be the only thing looked at when reading this route.
    assert.equal(reached, false);
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

// ---------------------------------------------------------------------------
// An agent is not one model
// ---------------------------------------------------------------------------

test('agent/model parses, and a bare agent id still means its default', async () => {
  const { parseAgentModel } = await import('../src/server.js');
  const cfg = { bridge: { agent: 'codex' } };
  assert.deepEqual(parseAgentModel('claude', cfg), { agent: 'claude', agentModel: '' });
  assert.deepEqual(parseAgentModel('claude/opus', cfg), { agent: 'claude', agentModel: 'opus' });
  assert.deepEqual(parseAgentModel('claude/claude-opus-4-8', cfg), { agent: 'claude', agentModel: 'claude-opus-4-8' });
  // A hosted model id with a slash in it must NOT be read as an agent.
  assert.deepEqual(parseAgentModel('openai/gpt-oss-20b', cfg), { agent: 'codex', agentModel: '' });
  assert.deepEqual(parseAgentModel('', cfg), { agent: 'codex', agentModel: '' });
});

test('an installed agent lists its OWN models, beside the bare id', async () => {
  const s = createServer((req, res) => {
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, agents: [{ id: 'claude', available: true }, { id: 'kiro', available: false }] }));
    }
    if (req.url.startsWith('/list-models')) {
      const c = [];
      req.on('data', (x) => c.push(x));
      return req.on('end', () => {
        const { agent } = JSON.parse(Buffer.concat(c).toString());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: agent === 'claude' ? ['opus', 'sonnet', 'haiku'] : [] }));
      });
    }
    res.writeHead(404); res.end('{}');
  });
  const port = await listen(s);
  const gw = createGateway({
    ...cfg(port),
    destinations: [{ id: 'claude', type: 'agent', models: ['claude'] }, { id: 'kiro', type: 'agent', models: ['kiro'] }],
  });
  const gwPort = await listen(gw);
  try {
    const body = await (await fetch(`http://127.0.0.1:${gwPort}/v1/models`)).json();
    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes('claude'), 'the bare id survives — it means the agent default');
    assert.ok(ids.includes('claude/opus'), 'and each model is offered');
    assert.ok(ids.includes('claude/haiku'));

    // They group under the agent without anyone parsing an id.
    const opus = body.data.find((m) => m.id === 'claude/opus');
    assert.equal(opus.provider, 'claude');
    assert.equal(opus.provider_type, 'agent');
    assert.equal(opus.model, 'opus');

    // An agent that is NOT installed is not enumerated — a subprocess per agent to describe
    // something unusable is not a cost worth paying.
    assert.equal(ids.some((id) => id.startsWith('kiro/')), false);
  } finally { gw.close(); s.close(); }
});

test('the chosen agent model reaches the bridge as an option', async () => {
  let seenOptions = null;
  const s = createServer((req, res) => {
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, agents: [{ id: 'claude', available: true }] }));
    }
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(c).toString());
      if (req.url.startsWith('/chat')) {
        seenOptions = body.options;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'delta', text: 'ok' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', text: '' })}\n\n`);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
    });
  });
  const port = await listen(s);
  const gw = createGateway(cfg(port));
  const gwPort = await listen(gw);
  try {
    await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude/opus', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(seenOptions?.model, 'opus', 'the CLI is told which model to run');

    // ...and a bare agent id sends NO model, leaving the CLI on its own default.
    seenOptions = null;
    await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(seenOptions?.model, undefined);
  } finally { gw.close(); s.close(); }
});

// ---------------------------------------------------------------------------
// A routing table is not a list of models that work
// ---------------------------------------------------------------------------

test('a provider with no key marks its models unconfigured, with the reason', async () => {
  // The list names every model the gateway would FORWARD to. A provider configured with no
  // key contributes hundreds of ids that answer `Missing Authentication header` — and the
  // user finds out at 08:00, from a scheduled job, quoting undici about a destination they
  // never knowingly chose.
  const br = await fakeBridge([]);
  const gw = createGateway({
    ...cfg(br.port),
    backend: 'api',
    destinations: [
      { id: 'OpenRouter', type: 'api', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['or/free'] },
      { id: 'Keyed', type: 'api', protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', models: ['keyed-1'] },
    ],
  });
  const port = await listen(gw);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    const free = body.data.find((m) => m.id === 'or/free');
    assert.equal(free.configured, false);
    assert.match(free.reason, /no API key is saved for OpenRouter/);

    const keyed = body.data.find((m) => m.id === 'keyed-1');
    assert.equal('configured' in keyed, false, 'a working provider says nothing — absent is fine');
  } finally { gw.close(); br.close(); }
});

test('a LOCAL endpoint is never marked unconfigured — it needs no key', async () => {
  // llama.cpp, Ollama and LM Studio take no credential. Greying them out would hide the one
  // setup that requires nothing at all.
  const br = await fakeBridge([]);
  const gw = createGateway({
    ...cfg(br.port),
    backend: 'api',
    destinations: [
      { id: 'llama', type: 'api', protocol: 'openai', baseUrl: 'http://localhost:8080', models: ['local-1'] },
      { id: 'lan', type: 'api', protocol: 'openai', baseUrl: 'http://studio.local:1234/v1', models: ['local-2'] },
    ],
  });
  const port = await listen(gw);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    assert.equal('configured' in body.data.find((m) => m.id === 'local-1'), false);
    assert.equal('configured' in body.data.find((m) => m.id === 'local-2'), false);
  } finally { gw.close(); br.close(); }
});

test('a destination with no URL at all says so rather than being offered', async () => {
  const br = await fakeBridge([]);
  const gw = createGateway({
    ...cfg(br.port),
    backend: 'api',
    destinations: [{ id: 'half-done', type: 'api', protocol: 'openai', models: ['x-1'] }],
  });
  const port = await listen(gw);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    const m = body.data.find((x) => x.id === 'x-1');
    assert.equal(m.configured, false);
    assert.match(m.reason, /no endpoint URL/);
  } finally { gw.close(); br.close(); }
});

test('an AGENT is never judged on credentials — it has none', async () => {
  const br = await fakeBridge([]);
  const gw = createGateway({ ...cfg(br.port), destinations: [{ id: 'codex', type: 'agent', models: ['codex'] }] });
  const port = await listen(gw);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    assert.equal('configured' in body.data.find((m) => m.id === 'codex'), false);
  } finally { gw.close(); br.close(); }
});
