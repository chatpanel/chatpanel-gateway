// Free-tier "taste" gate: without a Pro entitlement token, redaction is
// deterministic-only and metered to a daily cap; the request past the cap is
// refused with an upsell. (Pro-token verification is exercised by entitlement.js;
// here we prove the metering + the free/basic downgrade.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../src/server.js';
import { redactSegments, segment } from '../src/redact.js';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}
function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

test('free tier: requests past the daily cap are refused (402 upsell)', async () => {
  const gw = createGateway({
    host: '127.0.0.1', port: 0, backend: 'bridge',
    bridge: { url: 'http://127.0.0.1:1', agent: 'codex', token: '' },
    upstreams: { openai: {}, anthropic: {} },
    redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' } },
    ner: { autostart: false }, allowedOrigins: [], maxBodyBytes: 1 << 20,
    pro: { entitlementToken: '', free: { maxRequestsPerDay: 2 } }, logRequests: false,
  });
  const port = await listen(gw);
  // bridge is unreachable, but the meter runs BEFORE the bridge call; the first
  // two are allowed (then fail at the bridge → 502), the third is refused (402).
  const r1 = await post(port, { messages: [{ role: 'user', content: 'hi' }] });
  const r2 = await post(port, { messages: [{ role: 'user', content: 'hi' }] });
  const r3 = await post(port, { messages: [{ role: 'user', content: 'hi' }] });
  assert.notEqual(r1.status, 402);
  assert.notEqual(r2.status, 402);
  assert.equal(r3.status, 402);
  assert.match(r3.body, /free limit/i);
  gw.close();
});

test('free tier downgrades full→basic (no entity redaction without Pro)', async () => {
  // With isPro=false, even a configured 'full' tier must not pull in entities.
  const body = [{ role: 'user', content: 'Alex Rivera emailed a@b.io' }];
  const seg = (m) => segment(() => m.content, (v) => { m.content = v; });
  const segs = body.map(seg);
  const { count } = await redactSegments(segs, {
    tier: 'full', dictionary: [], detection: { backend: 'off' },
  }, { isPro: false });
  // The email is redacted deterministically; the name is NOT (entity tier is Pro).
  assert.match(body[0].content, /\[\[EMAIL_1\]\]/);
  assert.match(body[0].content, /Alex Rivera/);
  assert.equal(count, 1);
});
