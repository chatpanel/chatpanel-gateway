// The gateway's access log: who-read-what, admin-gated, and PII-redacted before storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/server.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const ADMIN = { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'content-type': 'application/json' };
const start = async () => {
  const gw = createGateway({ host: '127.0.0.1', port: 0, redaction: { tier: 'basic', detection: { backend: 'off' } }, ner: { autostart: false }, logRequests: false });
  const port = await listen(gw);
  return { gw, url: `http://127.0.0.1:${port}` };
};

test('observability is admin-gated (read and report)', async () => {
  const { gw, url } = await start();
  assert.equal((await fetch(`${url}/v1/observability`)).status, 403);
  assert.equal((await fetch(`${url}/v1/observability/access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  gw.close();
});

test('access log records the agent + tool but REDACTS the query', async () => {
  const { gw, url } = await start();
  const q = 'my SSN is 123-45-6789';
  await fetch(`${url}/v1/observability/access`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ client: 'Codex CLI', tool: 'search_history', ok: true, ms: 8, args: { query: q, limit: 5 } }) });
  const obs = await (await fetch(`${url}/v1/observability`, { headers: ADMIN })).json();
  assert.equal(obs.access.length, 1);
  assert.equal(obs.access[0].client, 'Codex CLI');
  assert.equal(obs.access[0].tool, 'search_history');
  assert.equal(obs.access[0].note, 'limit=5', 'only safe fields kept');
  assert.ok(!JSON.stringify(obs).includes('123-45-6789'), 'the query text is never stored');
  gw.close();
});

test('storage stats report warm-tier records/bytes/newest', async () => {
  const { gw, url } = await start();
  await fetch(`${url}/v1/history/ingest`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ upserts: [{ id: 'm1', text: 'quarterly plan', title: 'Zoom Meeting', type: 'meeting', date: 1_700_000_000_000 }] }) });
  const obs = await (await fetch(`${url}/v1/observability`, { headers: ADMIN })).json();
  assert.equal(obs.storage.warm.records, 1);
  assert.equal(obs.storage.warm.newest, 1_700_000_000_000);
  assert.ok(obs.storage.warm.bytes >= 0);
  gw.close();
});
