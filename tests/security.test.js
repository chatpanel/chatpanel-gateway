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

// H2 — outbound SSRF: a destination baseUrl pointing at cloud metadata must be
// refused BEFORE the fetch (credential-theft pivot), while a loopback/LAN model
// endpoint (Ollama/LM Studio/homelab) stays reachable.
const apiDest = (baseUrl) => cfg({
  destinations: [{ id: 'byo', type: 'api', protocol: 'openai', baseUrl, models: ['byo-model'] }],
});
const chat = (port, model) => request(port, {
  method: 'POST', path: '/v1/chat/completions',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
});

test('outbound SSRF: metadata baseUrl is refused before fetch', async () => {
  const gw = createGateway(apiDest('http://169.254.169.254'));
  const port = await listen(gw);
  const r = await chat(port, 'byo-model');
  assert.equal(r.status, 502);
  assert.match(r.body, /blocked address/); // the guard fired, not a network error
  gw.close();
});

test('outbound SSRF: loopback baseUrl is allowed through the guard (Ollama/LM Studio)', async () => {
  const gw = createGateway(apiDest('http://127.0.0.1:1')); // nothing listening on :1
  const port = await listen(gw);
  const r = await chat(port, 'byo-model');
  assert.equal(r.status, 502);              // fails to CONNECT…
  assert.doesNotMatch(r.body, /blocked address/); // …but was NOT blocked by the SSRF guard
  gw.close();
});

// M2 — admin routes (reconfigure / logs) require the extension Origin or the gateway
// token; the /v1 data plane and /health stay open for local CLIs.
test('admin /config is blocked for a no-Origin local process', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const r = await request(port, { path: '/config' }); // no Origin, no token
  assert.equal(r.status, 403);
  assert.match(r.body, /admin route/);
  gw.close();
});

test('admin /logs is blocked without the extension origin/token', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const r = await request(port, { path: '/logs' });
  assert.equal(r.status, 403);
  gw.close();
});

test('admin /config is allowed for the extension origin', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const r = await request(port, { path: '/config', headers: { origin: 'chrome-extension://abc' } });
  assert.equal(r.status, 200); // reaches the real handler
  gw.close();
});

test('data plane /health stays open to a no-Origin client (not an admin route)', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const r = await request(port, { path: '/health' });
  assert.equal(r.status, 200);
  gw.close();
});
