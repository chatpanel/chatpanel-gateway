// The /redact preview: what a client can promise the user before they hit send.
//
// The point of these tests is that the preview cannot drift from the real thing. So the
// last one sends the SAME text through a real chat request and asserts the upstream saw
// exactly the string the preview showed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HERMETIC BY CONSTRUCTION. /redact now starts the bundled detector on demand when its
// weights are on disk, so on a developer's own machine these tests would quietly pick up
// whatever model that person happens to have installed — and "patterns only" would pass or
// fail depending on the box. An empty model dir means no engine can start here, which is
// the state this file is about. Set before the server module loads.
process.env.CHATPANEL_MODELS_DIR = mkdtempSync(join(tmpdir(), 'cp-no-models-'));

const { createGateway } = await import('../src/server.js');

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

const cfg = (openaiBase = 'http://127.0.0.1:1') => ({
  host: '127.0.0.1', port: 0, backend: 'api',
  upstreams: { openai: { baseUrl: openaiBase }, anthropic: { baseUrl: openaiBase } },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true },
  logRequests: false,
});

const preview = async (port, text) => {
  const r = await fetch(`http://127.0.0.1:${port}/redact`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { status: r.status, body: await r.json() };
};

test('it returns the text with PII replaced by tokens, and says what each token is', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  try {
    const { status, body } = await preview(port, 'mail alex@example.com about the demo');
    assert.equal(status, 200);
    assert.match(body.text, /\[\[EMAIL_1\]\]/);
    assert.doesNotMatch(body.text, /alex@example\.com/);
    assert.equal(body.count, 1);
    assert.deepEqual(body.entities, [{ token: 'EMAIL_1', type: 'EMAIL' }]);
  } finally { gw.close(); }
});

test('the real value NEVER comes back — the response crosses a process boundary', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  try {
    const { body } = await preview(port, 'mail alex@example.com');
    assert.equal(JSON.stringify(body).includes('alex@example.com'), false);
    for (const e of body.entities) assert.equal('value' in e, false);
  } finally { gw.close(); }
});

test('empty text is an empty preview, not an error', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  try {
    const { status, body } = await preview(port, '');
    assert.equal(status, 200);
    assert.equal(body.text, '');
    assert.equal(body.count, 0);
  } finally { gw.close(); }
});

test('invisible Unicode is stripped and counted — it is a redaction bypass, not a typo', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  try {
    // A zero-width space inside an address is how a detector gets walked past.
    const { body } = await preview(port, 'mail alex​@example.com');
    assert.ok(body.sanitized >= 1, `expected a sanitized count, got ${body.sanitized}`);
    assert.doesNotMatch(body.text, /​/);
  } finally { gw.close(); }
});

test('THE PREVIEW IS WHAT IS SENT — same text, same string on the wire', async () => {
  let seen = null;
  const up = await fakeUpstream((body, req, res) => {
    seen = JSON.parse(body).messages[0].content;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  const gw = createGateway(cfg(`http://127.0.0.1:${up.port}`));
  const port = await listen(gw);
  try {
    const text = 'ping alex@example.com and 555-867-5309 before Friday';
    const { body } = await preview(port, text);
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: text }] }),
    });
    assert.equal(seen, body.text);
  } finally { gw.close(); up.close(); }
});

// WHAT THE PREVIEW COULD NOT SEE. Patterns run with no detector at all, so a preview taken
// while the detector is down is visually indistinguishable from a clean one — same shield,
// same tokens for the email, the name left standing. `detector.coverage` is the only thing
// that tells them apart, so a client can say "patterns only" instead of implying names.
test('the preview reports its own coverage — patterns only, when no detector is running', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  try {
    const { body } = await preview(port, 'mail alex@example.com about the demo');
    assert.equal(body.detector.coverage, 'patterns');
    assert.equal(body.detector.ready, false);
    assert.equal(body.detector.source, 'bundled');
  } finally { gw.close(); }
});

test('a configured external detector is reported as the source — its own turn is the test', async () => {
  const c = cfg();
  c.redaction.detection = { backend: 'endpoint', url: 'http://127.0.0.1:9/ner' };
  c.redaction.tier = 'full';
  const gw = createGateway(c);
  const port = await listen(gw);
  try {
    const { body } = await preview(port, 'mail alex@example.com');
    assert.equal(body.detector.source, 'external');
    assert.equal(body.detector.coverage, 'names');
  } finally { gw.close(); }
});

test('an empty draft still answers with the detector block — the strip renders before you type', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  try {
    const { body } = await preview(port, '');
    assert.equal(body.detector.coverage, 'patterns');
  } finally { gw.close(); }
});
