// THE BRIDGE ADDRESS IS CHECKED, NOT BELIEVED.
//
// The persisted bridge.url was found pointing at an ephemeral port nothing answered on, while
// the real bridge sat on 4319: every agent showed unavailable and every agent turn failed. A
// configured address that does not answer while the default one does is a stale setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolveBridgeUrl, resetBridgeResolution } from '../src/bridge.js';
import { listDestinations } from '../src/router.js';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

test('a dead configured address falls back to a bridge that answers, and remembers for ten seconds', async () => {
  resetBridgeResolution();
  const live = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const port = await listen(live);
  const fallback = `http://127.0.0.1:${port}`;
  const cfg = { bridge: { url: 'http://127.0.0.1:1' } }; // port 1: nothing listens
  assert.equal(await resolveBridgeUrl(cfg, { fallback, timeoutMs: 400 }), fallback);
  live.close();
  // Cached: the dead server is not asked again inside the window.
  assert.equal(await resolveBridgeUrl(cfg, { fallback, timeoutMs: 400 }), fallback);
});

test('a configured address that answers is kept, even when the default would too', async () => {
  resetBridgeResolution();
  const a = createServer((req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
  const b = createServer((req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
  const pa = await listen(a); const pb = await listen(b);
  const cfg = { bridge: { url: `http://127.0.0.1:${pa}/` } };
  assert.equal(await resolveBridgeUrl(cfg, { fallback: `http://127.0.0.1:${pb}`, timeoutMs: 400 }), `http://127.0.0.1:${pa}`);
  a.close(); b.close();
});

test('nothing answering anywhere: the configured address stands, so the error names it', async () => {
  resetBridgeResolution();
  const cfg = { bridge: { url: 'http://127.0.0.1:1' } };
  assert.equal(await resolveBridgeUrl(cfg, { fallback: 'http://127.0.0.1:2', timeoutMs: 300 }), 'http://127.0.0.1:1');
});

test('agents are listed ahead of API destinations, so an API that lists an agent id cannot shadow it', () => {
  const cfg = { backend: 'bridge', destinations: [
    { id: 'Loop', type: 'api', protocol: 'openai', baseUrl: 'http://example.test/v1', models: ['codex', 'claude', 'x'] },
    { id: 'codex', type: 'agent', agent: 'codex', models: ['codex'] },
  ] };
  const ids = listDestinations(cfg).map((d) => `${d.type}:${d.id}`);
  assert.equal(ids.at(-1), 'api:Loop');
  assert.ok(ids.indexOf('agent:codex') < ids.indexOf('api:Loop'));
  assert.ok(ids.indexOf('agent:claude') < ids.indexOf('api:Loop'), 'known agents that are not configured still come first');
});
