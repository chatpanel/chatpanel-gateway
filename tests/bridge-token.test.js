// The bridge token: the config's copy goes stale; the bridge says so; the file is what
// the bridge wrote. Nothing is second-guessed before the bridge has actually said no.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { readBridgeToken, bridgeTokenRejected, resetBridgeTokenPreference, streamBridgeChat, openBridgeChat } from '../src/bridge.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-token-'));
const file = join(dir, 'bridge-token');
writeFileSync(file, 'file-token\n');
const missing = join(dir, 'nope');

test('the configured token is trusted until the bridge rejects it', () => {
  resetBridgeTokenPreference();
  assert.equal(readBridgeToken('cfg-token', file), 'cfg-token', 'a pinned token on a loopback bridge stays pinned');
  assert.equal(readBridgeToken('', file), 'file-token');
  assert.equal(readBridgeToken('cfg', missing), 'cfg');
  assert.equal(readBridgeToken('', missing), '');
});

test('a rejection flips every later read to the file — the desktop 403', () => {
  resetBridgeTokenPreference();
  const warned = [];
  const orig = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    assert.equal(bridgeTokenRejected('stale-copy', missing), '', 'no file: nothing else to try');
    assert.equal(bridgeTokenRejected('file-token', file), '', 'the file was what got rejected: nothing else to try');
    assert.equal(bridgeTokenRejected('stale-copy', file), 'file-token');
    assert.equal(readBridgeToken('stale-copy', file), 'file-token', 'and from now on the file wins');
    assert.equal(readBridgeToken('file-token', file), 'file-token');
    bridgeTokenRejected('stale-copy', file);
    assert.equal(warned.length, 1, 'said once');
    assert.match(warned[0], /rejected bridge\.token/);
  } finally { console.warn = orig; resetBridgeTokenPreference(); }
});

test('a /chat refused with the stale copy is retried once with the file token, and streams', async () => {
  resetBridgeTokenPreference();
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization !== 'Bearer file-token') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":"forbidden"}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'delta', text: 'Barack Obama.' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', text: '' })}\n\n`);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const bridgeUrl = `http://127.0.0.1:${server.address().port}`;
  const orig = console.warn; console.warn = () => {};
  try {
    let text = '';
    await streamBridgeChat({ bridgeUrl, agent: 'codex', token: 'stale-copy', messages: [{ role: 'user', content: 'q' }], tokenPath: file }, (t) => { text += t; });
    assert.equal(text, 'Barack Obama.');
    assert.deepEqual(seen, ['Bearer stale-copy', 'Bearer file-token']);
    // The tool-relay opener takes the same path.
    seen.length = 0;
    const res = await openBridgeChat({ bridgeUrl, agent: 'codex', token: 'stale-copy', messages: [], specs: [{ name: 't' }], tokenPath: file });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['Bearer file-token'], 'the preference stuck: no second 403');
  } finally { console.warn = orig; resetBridgeTokenPreference(); server.close(); }
});
