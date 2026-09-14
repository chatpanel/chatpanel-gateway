// The gateway's self-update (src/update.js): the job runs in the background and reports
// itself; the routes are admin-gated; nothing installs from a test (CHATPANEL_SELF_UPDATE=off).
import './isolate-store.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startUpdate, updateJob, _resetUpdateJob, cmpVersions, downloadHostAllowed, checkForUpdate } from '../src/update.js';
import { createGateway, VERSION } from '../src/server.js';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('versions compare numerically and only ChatPanel release hosts may serve a binary', () => {
  assert.equal(cmpVersions('0.6.107', '0.6.99'), 1);
  assert.equal(cmpVersions('0.6.107', '0.6.107'), 0);
  assert.equal(cmpVersions('0.6.9', '0.6.10'), -1);
  assert.equal(downloadHostAllowed('https://objects.githubusercontent.com/x'), true);
  assert.equal(downloadHostAllowed('https://dl.chatpanel.net/gateway/macos-arm64'), true);
  assert.equal(downloadHostAllowed('http://dl.chatpanel.net/x'), false, 'https only');
  assert.equal(downloadHostAllowed('https://evil.example.com/chatpanel-gateway'), false);
});

test('the job: installing → restarting (the restart runs after the answer is out) → done when there is no service; a failure is a sentence; two at once is one', async () => {
  _resetUpdateJob();
  let restarted = 0;
  const j = startUpdate('0.6.1', { apply: async () => { await tick(20); return { from: '0.6.1', to: '0.6.2', mode: 'npm' }; }, restart: () => { restarted += 1; return false; } });
  assert.equal(j.state, 'installing');
  assert.equal(startUpdate('0.6.1', { apply: async () => ({}) }).already, true, 'a second start while one runs returns the running job');
  await tick(40);
  assert.equal(updateJob().state, 'restarting');
  assert.equal(updateJob().to, '0.6.2');
  assert.equal(restarted, 0, 'not yet — the response goes out first');
  await tick(450);
  assert.equal(restarted, 1);
  assert.equal(updateJob().state, 'done', 'no service to restart: installed, and says to start it again');
  assert.match(updateJob().detail, /start it again yourself/i);
  _resetUpdateJob();
  startUpdate('0.6.1', { apply: async () => { throw new Error('npm install failed: EACCES'); }, restart: () => true });
  await tick(20);
  assert.equal(updateJob().state, 'failed');
  assert.match(updateJob().detail, /EACCES/);
  _resetUpdateJob();
});

test('with self-update off (the test runner) the check makes no network call and says so', async () => {
  const u = await checkForUpdate(VERSION, { force: true });
  assert.equal(u.disabled, true);
  assert.equal(u.updateAvailable, false);
  assert.equal(u.canSelfUpdate, false);
});

test('the routes: /status carries `update`; GET and POST /update need the extension origin or the token; POST starts a job', async () => {
  const gw = createGateway({ host: '127.0.0.1', port: 0, backend: 'bridge', bridge: { url: 'http://127.0.0.1:1', agent: 'codex', token: 't' }, upstreams: { openai: {}, anthropic: {} }, redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true }, ner: { autostart: false }, logRequests: false });
  const port = await new Promise((resolve) => gw.listen(0, '127.0.0.1', () => resolve(gw.address().port)));
  const base = `http://127.0.0.1:${port}`;
  const H = { origin: 'chrome-extension://test' };
  try {
    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.update.current, VERSION);
    assert.equal(status.update.disabled, true);
    assert.equal((await fetch(`${base}/update`)).status, 403, 'no origin, no token: no');
    assert.equal((await fetch(`${base}/update`, { method: 'POST' })).status, 403);
    const got = await (await fetch(`${base}/update`, { headers: H })).json();
    assert.equal(got.ok, true);
    assert.equal(got.job.state, 'idle');
    const started = await fetch(`${base}/update`, { method: 'POST', headers: H });
    assert.equal(started.status, 202);
    await tick(30);
    const after = await (await fetch(`${base}/update`, { headers: H })).json();
    assert.equal(after.job.state, 'failed', 'off in tests: the job fails at once rather than installing anything');
    assert.match(after.job.detail, /switched off/);
  } finally {
    gw.closeAllConnections?.(); gw.close();
    _resetUpdateJob();
  }
});
