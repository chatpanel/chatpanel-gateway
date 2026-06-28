// Security guards: a malicious web page must not be able to drive the gateway
// (and thus codex). Browsers always send Origin; local CLI clients never do. We
// use raw node:http so we can set otherwise-forbidden headers (Host) and control
// the upload precisely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../src/server.js';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

// Minimal request helper with full header control. Resolves { status, body }.
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const cfg = (over = {}) => ({
  host: '127.0.0.1', port: 0, backend: 'bridge',
  bridge: { url: 'http://127.0.0.1:1', agent: 'codex', token: '' },
  upstreams: { openai: {}, anthropic: {} },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' } },
  ner: { autostart: false }, allowedOrigins: [], maxBodyBytes: 1024, logRequests: false, ...over,
});

test('request with a browser Origin is rejected (drive-by guard)', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const r = await request(port, {
    method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 403);
  gw.close();
});

test('allowlisted Origin is permitted', async () => {
  const gw = createGateway(cfg({ allowedOrigins: ['https://app.chatpanel.net'] }));
  const port = await listen(gw);
  const r = await request(port, { path: '/health', headers: { origin: 'https://app.chatpanel.net' } });
  assert.equal(r.status, 200);
  gw.close();
});

test('no-Origin request (a local CLI) is allowed', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const r = await request(port, { path: '/health' });
  assert.equal(r.status, 200);
  gw.close();
});

test('oversized body is rejected (413)', async () => {
  const gw = createGateway(cfg({ maxBodyBytes: 32 }));
  const port = await listen(gw);
  const r = await request(port, {
    method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(500) }] }),
  });
  assert.equal(r.status, 413);
  gw.close();
});

test('non-loopback Host is rejected (anti DNS-rebinding)', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const r = await request(port, { path: '/health', headers: { host: 'evil.com' } });
  assert.equal(r.status, 403);
  gw.close();
});
