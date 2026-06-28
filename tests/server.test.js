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
