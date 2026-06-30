// Free-tier "taste" gate: without a Pro entitlement token, the gateway still does
// genuine full-tier redaction, but only for a FIXED LIFETIME allowance
// (freegate.FREE_TOTAL_CAP). A credit is burned only when a request actually
// redacts something; once the allowance is gone, requests are refused with an
// upsell. (Pro-token verification is exercised by entitlement.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { createGateway } from '../src/server.js';
import { checkQuota, consume, usage, FREE_TOTAL_CAP } from '../src/freegate.js';

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
function baseCfg(free) {
  return {
    host: '127.0.0.1', port: 0, backend: 'bridge',
    bridge: { url: 'http://127.0.0.1:1', agent: 'codex', token: '' },
    upstreams: { openai: {}, anthropic: {} },
    redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true },
    ner: { autostart: false }, allowedOrigins: [], maxBodyBytes: 1 << 20,
    pro: { entitlementToken: '', free }, logRequests: false,
  };
}

test('freegate: a fixed lifetime allowance, consumed per redaction; Pro is never gated', () => {
  const cfg = { pro: { entitlementToken: '', free: { used: FREE_TOTAL_CAP - 1 } } };
  assert.equal(checkQuota(cfg, false).allowed, true);   // one credit left
  consume(cfg, false);
  assert.equal(cfg.pro.free.used, FREE_TOTAL_CAP);
  assert.equal(checkQuota(cfg, false).allowed, false);  // trial used up
  assert.equal(usage(cfg).remaining, 0);
  // Pro is always allowed and never consumes.
  assert.equal(checkQuota(cfg, true).allowed, true);
  consume(cfg, true);
  assert.equal(cfg.pro.free.used, FREE_TOTAL_CAP);
});

test('free tier: a credit is burned only when something is actually redacted', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gw-free-'));
  const prev = process.env.CHATPANEL_GATEWAY_CONFIG;
  process.env.CHATPANEL_GATEWAY_CONFIG = path.join(dir, 'gateway.config.json');
  const cfg = baseCfg({ used: 0 });
  const gw = createGateway(cfg);
  const port = await listen(gw);
  // bridge is unreachable (→ 502), but redaction + metering run first.
  await post(port, { messages: [{ role: 'user', content: 'hello there' }] }); // no PII → no charge
  assert.equal(cfg.pro.free.used, 0);
  await post(port, { messages: [{ role: 'user', content: 'mail me at a@b.io' }] }); // email redacted → 1 charge
  assert.equal(cfg.pro.free.used, 1);
  gw.close();
  if (prev === undefined) delete process.env.CHATPANEL_GATEWAY_CONFIG; else process.env.CHATPANEL_GATEWAY_CONFIG = prev;
});

test('free tier: requests past the lifetime allowance are refused (402 upsell)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gw-free-'));
  const prev = process.env.CHATPANEL_GATEWAY_CONFIG;
  process.env.CHATPANEL_GATEWAY_CONFIG = path.join(dir, 'gateway.config.json');
  const cfg = baseCfg({ used: FREE_TOTAL_CAP });
  const gw = createGateway(cfg);
  const port = await listen(gw);
  const r = await post(port, { messages: [{ role: 'user', content: 'mail me at a@b.io' }] });
  assert.equal(r.status, 402);
  assert.match(r.body, /redactions|free trial/i);
  gw.close();
  if (prev === undefined) delete process.env.CHATPANEL_GATEWAY_CONFIG; else process.env.CHATPANEL_GATEWAY_CONFIG = prev;
});
