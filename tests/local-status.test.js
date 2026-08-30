// U3 — one view of the local runtime, both services, and a startup note for the operator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localStatus, formatLocalStatus, bridgePresenceNote } from '../src/local-status.js';

const realFetch = globalThis.fetch;
function mock(routes) {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const key = `${u.port}${u.pathname}`;
    if (routes[key] === 'down') throw new Error('ECONNREFUSED');
    const body = routes[key];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
}

test('both running: reports versions, agents, skills, and the routing summary', async () => {
  mock({
    '4320/health': { version: '0.6.34', tier: 'full' },
    '4319/health': { version: '0.10.32', agents: [{ available: true }, { available: true }], skills: { count: 17 } },
    '4319/skills': { skills: new Array(17).fill({}) },
  });
  try {
    const s = await localStatus();
    assert.equal(s.gateway.running, true);
    assert.equal(s.bridge.running, true);
    assert.equal(s.bridge.agents, 2);
    assert.equal(s.bridge.skills, 17);
    const out = formatLocalStatus(s);
    assert.match(out, /Gateway {2}running · v0\.6\.34/);
    assert.match(out, /Bridge {2}running · v0\.10\.32/);
    assert.match(out, /17 skill/);
    assert.match(out, /route through the gateway/);
  } finally { globalThis.fetch = realFetch; }
});

test('bridge absent reads as optional, not an error', async () => {
  mock({ '4320/health': { version: '0.6.34' }, '4319/health': 'down' });
  try {
    const s = await localStatus();
    assert.equal(s.bridge.running, false);
    const out = formatLocalStatus(s);
    assert.match(out, /Bridge {2}not running/);
    assert.match(out, /Start the bridge/);
    assert.doesNotMatch(out, /error|✕/i, 'a missing bridge is never an error');
    const note = await bridgePresenceNote();
    assert.match(note, /not detected/);
    assert.match(note, /runs fine without it/);
  } finally { globalThis.fetch = realFetch; }
});

test('gateway absent: the command still reports the bridge', async () => {
  mock({ '4320/health': 'down', '4319/health': { version: '0.10.32' } });
  try {
    const out = formatLocalStatus(await localStatus());
    assert.match(out, /Gateway {2}not running/);
    assert.match(out, /Bridge {2}running/);
    assert.match(out, /optional upgrade/i);
  } finally { globalThis.fetch = realFetch; }
});

test('the startup note names the bridge when present', async () => {
  mock({ '4319/health': { version: '0.10.32', skills: { count: 17 } } });
  try {
    const note = await bridgePresenceNote();
    assert.match(note, /bridge detected/);
    assert.match(note, /17 skills/);
    assert.match(note, /through this gateway/);
  } finally { globalThis.fetch = realFetch; }
});
