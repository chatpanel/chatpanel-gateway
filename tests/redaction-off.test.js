// REDACTION OFF, FOR ONE REQUEST, BECAUSE THE USER SAID SO — AND ONLY IF THEY COULD HAVE.
//
// "write about NVIDIA GPUs" reached the model as "write about [[ORG_1]] GPUs" and it wrote
// about a different company. The policy is right for the corpus and wrong for the user's own
// instruction; only the user can tell which a turn is. So an authenticated local client may
// send `X-ChatPanel-Redaction: off`. Three claims: it works for a caller that can prove it is
// the user; it does nothing for an anonymous caller (the header is not a bypass); and the
// trace says "off", which is a different claim from "nothing to redact".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGateway } from '../src/server.js';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

/** A bridge that answers anything and remembers the last chat body. */
async function echoBridge() {
  let seen = '';
  const s = createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.11.14', agents: [{ id: 'codex', available: true }] }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url.startsWith('/list-models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      seen = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'delta', text: 'noted' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });
  });
  const port = await listen(s);
  return { port, close: () => s.close(), get body() { return seen; } };
}

const cfg = (bridgeUrl) => ({
  host: '127.0.0.1', port: 0, backend: 'bridge',
  bridge: { url: bridgeUrl, agent: 'codex', token: 'test-token-123' },
  upstreams: { openai: {}, anthropic: {} },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true },
  ner: { autostart: false },
  logRequests: true,
});

const ask = (port, headers) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ model: 'codex', messages: [{ role: 'user', content: 'mail alex@example.com about it' }] }),
});

test('an authenticated caller can switch redaction off for one request, and the trace says so', async () => {
  const br = await echoBridge();
  const gw = createGateway(cfg(`http://127.0.0.1:${br.port}`));
  const port = await listen(gw);
  const admin = { origin: 'chrome-extension://abcdefghijklmnop' };

  const r = await ask(port, { ...admin, 'X-ChatPanel-Redaction': 'off' });
  assert.equal(r.status, 200);
  await r.text();
  assert.match(br.body, /alex@example\.com/, 'the bridge saw the text as written');
  assert.doesNotMatch(br.body, /\[\[EMAIL_1\]\]/);

  const logs = await (await fetch(`http://127.0.0.1:${port}/logs`, { headers: admin })).json();
  const last = logs.entries?.[0] || logs[0];
  assert.equal(last.redaction, 'off', 'the ledger can say "off" instead of "0 replaced"');
  assert.equal(last.redacted, 0);

  const r2 = await ask(port, admin);
  await r2.text();
  assert.match(br.body, /\[\[EMAIL_1\]\]/, 'without the header the policy applies, for the same caller');
  const logs2 = await (await fetch(`http://127.0.0.1:${port}/logs`, { headers: admin })).json();
  const last2 = logs2.entries?.[0] || logs2[0];
  assert.equal(last2.redaction, 'basic');
  gw.close(); br.close();
});

test('the header is not a bypass: an anonymous caller is redacted regardless', async () => {
  const br = await echoBridge();
  const gw = createGateway(cfg(`http://127.0.0.1:${br.port}`));
  const port = await listen(gw);
  const r = await ask(port, { 'X-ChatPanel-Redaction': 'off' });
  await r.text();
  assert.match(br.body, /\[\[EMAIL_1\]\]/);
  assert.doesNotMatch(br.body, /alex@example\.com/);
  gw.close(); br.close();
});
