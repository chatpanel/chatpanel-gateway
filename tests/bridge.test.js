// Bridge backend integration: stand up a FAKE bridge (the /chat SSE contract),
// point the gateway at it in backend:'bridge' mode, and prove the privacy loop:
//   opencode → gateway (redact) → bridge → "codex" → gateway (restore) → opencode
// The fake bridge asserts it received REDACTED text and that the bearer token was
// presented; it echoes a placeholder back so we can prove restoration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGateway } from '../src/server.js';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

// A fake bridge: handles POST /chat, captures the body + auth, streams SSE deltas
// that echo the redacted email placeholder back as the "model" reply.
async function fakeBridge() {
  let seen = null;
  let auth = null;
  const s = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = Buffer.concat(chunks).toString('utf8');
      auth = req.headers.authorization || null;
      const body = JSON.parse(seen);
      const token = (body.messages.map((m) => m.content).join(' ').match(/\[\[EMAIL_1\]\]/) || [])[0];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const mid = Math.floor(token.length / 2);
      res.write(`data: ${JSON.stringify({ type: 'status', text: 'Codex working' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'delta', text: `reply to ${token.slice(0, mid)}` })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'delta', text: `${token.slice(mid)} now` })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });
  });
  const port = await listen(s);
  return { port, close: () => s.close(), get body() { return seen; }, get auth() { return auth; } };
}

const bridgeCfg = (bridgeUrl) => ({
  host: '127.0.0.1', port: 0, backend: 'bridge',
  bridge: { url: bridgeUrl, agent: 'codex', token: 'test-token-123' },
  upstreams: { openai: {}, anthropic: {} },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true },
  ner: { autostart: false },
  logRequests: false,
});

test('bridge backend non-stream: redacted to bridge, restored to client, token sent', async () => {
  const br = await fakeBridge();
  const gw = createGateway(bridgeCfg(`http://127.0.0.1:${br.port}`));
  const port = await listen(gw);

  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'codex', messages: [{ role: 'user', content: 'mail alex@example.com' }] }),
  });
  const json = await r.json();

  assert.doesNotMatch(br.body, /alex@example\.com/, 'bridge (→codex) must see only the placeholder');
  assert.match(br.body, /\[\[EMAIL_1\]\]/);
  assert.equal(br.auth, 'Bearer test-token-123', 'gateway must present the bridge token');
  assert.match(json.choices[0].message.content, /alex@example\.com/, 'client gets the real value restored');
  assert.equal(json.object, 'chat.completion');
  gw.close(); br.close();
});

test('bridge backend streaming: SSE chunks restored (token split across deltas)', async () => {
  const br = await fakeBridge();
  const gw = createGateway(bridgeCfg(`http://127.0.0.1:${br.port}`));
  const port = await listen(gw);

  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: true, model: 'codex', messages: [{ role: 'user', content: 'mail alex@example.com' }] }),
  });
  const text = await r.text();
  assert.match(text, /alex@example\.com/);
  assert.doesNotMatch(text, /\[\[EMAIL_1\]\]/);
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /data: \[DONE\]/);
  gw.close(); br.close();
});

test('bridge backend /v1/models lists the agents', async () => {
  const br = await fakeBridge();
  const gw = createGateway(bridgeCfg(`http://127.0.0.1:${br.port}`));
  const port = await listen(gw);
  const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
  const json = await r.json();
  assert.equal(json.object, 'list');
  assert.ok(json.data.some((m) => m.id === 'codex'));
  gw.close(); br.close();
});
