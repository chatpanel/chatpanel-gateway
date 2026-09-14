// The gateway carries the bridge: adopt what answers, prefer a newer standalone, else start
// the embedded copy as a child and keep it up — and step aside when someone else's bridge
// takes the port. Nothing here spawns a real process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { planBridge, compareVersions, ensureBridge, standaloneCandidates } from '../src/bridge-supervisor.js';

test('planBridge: off for a host that runs its own or a remote bridge; adopt what answers; newer standalone beats embedded', () => {
  assert.equal(planBridge({ managed: false }).action, 'off');
  assert.equal(planBridge({ managed: 'off' }).action, 'off');
  assert.match(planBridge({ cfgUrl: 'http://10.0.0.7:4319' }).why, /not on this machine/);
  assert.equal(planBridge({ healthy: { version: '0.11.19', managedBy: 'desktop' } }).action, 'adopt');
  assert.match(planBridge({ healthy: { version: '0.11.19', managedBy: 'desktop' } }).why, /v0\.11\.19, run by desktop/);
  assert.equal(planBridge({ embeddedVersion: '0.11.20' }).action, 'spawn-embedded');
  assert.equal(planBridge({ embeddedVersion: '0.11.20', standalone: { path: '/x/chatpanel-bridge', version: '0.11.19' } }).action, 'spawn-embedded', 'older standalone loses');
  const newer = planBridge({ embeddedVersion: '0.11.20', standalone: { path: '/x/chatpanel-bridge', version: '0.11.21' } });
  assert.equal(newer.action, 'spawn-standalone'); assert.equal(newer.path, '/x/chatpanel-bridge'); assert.match(newer.why, /newer than the embedded/);
  assert.equal(planBridge({ standalone: { path: '/x/chatpanel-bridge', version: null } }).action, 'spawn-standalone', 'no embedded copy: the standalone is what there is');
  assert.equal(planBridge({}).action, 'off');
  assert.equal(compareVersions('0.11.21', '0.11.20'), 1); assert.equal(compareVersions('0.11.9', '0.11.20'), -1); assert.equal(compareVersions('x', '0.1.0'), 0);
  assert.match(standaloneCandidates({ home: '/h', platform: 'darwin' })[0], /\/h\/.local\/bin\/chatpanel-bridge$/);
  assert.match(standaloneCandidates({ home: '/h', platform: 'win32', env: {} })[0], /ChatPanel[\\/]chatpanel-bridge\.exe$/);
});

const fakeChild = () => { const c = new EventEmitter(); c.pid = 4242; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.killed = false; c.kill = () => { c.killed = true; c.emit('exit', null, 'SIGTERM'); }; return c; };

test('ensureBridge: adopts a running bridge without spawning; waits for a sibling to come up first', async () => {
  const log = [];
  let probes = 0;
  const probe = async () => { probes += 1; return probes >= 3 ? { version: '0.11.19', managedBy: 'desktop' } : null; };
  let spawned = 0;
  const c = await ensureBridge({ bridge: { url: 'http://127.0.0.1:4319' } }, { log: (l) => log.push(l), probe, spawnImpl: () => { spawned += 1; return fakeChild(); }, version: () => '0.11.20', candidates: [], waitForSiblingMs: 5000, now: (() => { let t = 0; return () => (t += 600); })(), setTimer: (fn) => fn() });
  assert.equal(c.status().mode, 'adopted'); assert.equal(c.status().version, '0.11.19'); assert.equal(spawned, 0);
  assert.ok(probes >= 3, 'kept probing while the sibling came up');
  assert.match(log[0], /run by desktop/);
});

test('ensureBridge: starts the embedded bridge as a child with the embedded env, restarts it with back-off, steps aside when another bridge takes the port, stops on request', async () => {
  const log = []; const spawns = []; const timers = [];
  let running = null;
  let other = null;
  const c = await ensureBridge({ bridge: { url: 'http://127.0.0.1:4319' } }, {
    log: (l) => log.push(l),
    probe: async () => other,
    spawnImpl: (program, args, opts) => { running = fakeChild(); spawns.push({ program, args, env: opts.env }); return running; },
    version: (program) => (program === '/usr/local/bin/chatpanel-bridge' ? '0.11.19' : '0.11.20'),
    candidates: ['/usr/local/bin/chatpanel-bridge'].filter(() => false),
    launch: () => ({ program: '/opt/chatpanel-gateway', args: ['--bridge'] }),
    waitForSiblingMs: 0,
    setTimer: (fn, ms) => { timers.push(ms); fn(); },
  });
  assert.equal(c.status().mode, 'embedded'); assert.equal(c.status().version, '0.11.20'); assert.equal(c.status().pid, 4242);
  assert.equal(spawns.length, 1); assert.deepEqual(spawns[0].args, ['--bridge']);
  assert.equal(spawns[0].env.CHATPANEL_BRIDGE_EMBEDDED, '1'); assert.equal(spawns[0].env.CHATPANEL_MANAGED_BY, 'gateway'); assert.equal(spawns[0].env.CHATPANEL_BRIDGE_PORT, '4319');
  running.stdout.emit('data', Buffer.from('listening on http://127.0.0.1:4319\n'));
  assert.ok(log.some((l) => l === '[bridge] listening on http://127.0.0.1:4319'));
  // It dies: restarted, with back-off.
  running.emit('exit', 1, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(spawns.length, 2); assert.equal(c.status().restarts, 1); assert.deepEqual(timers, [1000]);
  running.emit('exit', 1, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(spawns.length, 3); assert.deepEqual(timers, [1000, 2000]);
  // Someone else's bridge appears on the port while ours is down: adopt it, no restart.
  other = { version: '0.11.21', managedBy: 'desktop' };
  running.emit('exit', 1, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(spawns.length, 3); assert.equal(c.status().mode, 'adopted'); assert.match(c.status().why, /stepped aside/);
  // stop() ends a child we started and does not restart it.
  other = null;
  const d = await ensureBridge({ bridge: { url: 'http://127.0.0.1:4319' } }, { log: () => {}, probe: async () => null, spawnImpl: () => { running = fakeChild(); spawns.push(1); return running; }, version: () => '0.11.20', candidates: [], launch: () => ({ program: 'g', args: ['--bridge'] }), waitForSiblingMs: 0, setTimer: (fn) => fn() });
  const before = spawns.length;
  d.stop();
  await new Promise((r) => setImmediate(r));
  assert.equal(running.killed, true); assert.equal(spawns.length, before); assert.equal(d.status().pid, null);
});

test('ensureBridge: a newer standalone is preferred over the embedded copy; supervision off spawns nothing', async () => {
  const spawns = [];
  const c = await ensureBridge({ bridge: { url: 'http://127.0.0.1:4319' } }, {
    log: () => {}, probe: async () => null,
    spawnImpl: (program) => { spawns.push(program); return fakeChild(); },
    version: (program) => (program === '/x/chatpanel-bridge' ? '0.11.30' : '0.11.20'),
    candidates: ['/x/chatpanel-bridge'], exists: () => true, launch: () => ({ program: 'g', args: ['--bridge'] }), waitForSiblingMs: 0, setTimer: (fn) => fn(),
  });
  assert.equal(c.status().mode, 'standalone'); assert.equal(c.status().version, '0.11.30'); assert.deepEqual(spawns, ['/x/chatpanel-bridge']);
  const off = await ensureBridge({ bridge: { url: 'http://127.0.0.1:4319', managed: false } }, { log: () => {}, probe: async () => null, spawnImpl: () => { throw new Error('must not spawn'); }, version: () => '0.11.20', candidates: [], waitForSiblingMs: 0 });
  assert.equal(off.status().mode, 'off');
  const remote = await ensureBridge({ bridge: { url: 'http://192.168.1.9:4319' } }, { log: () => {}, probe: async () => null, spawnImpl: () => { throw new Error('must not spawn'); }, version: () => '0.11.20', candidates: [], waitForSiblingMs: 0 });
  assert.equal(remote.status().mode, 'off'); assert.match(remote.status().why, /not on this machine/);
});

test('ensureBridge: an adopted bridge is watched — when it goes away, the embedded one starts in its place; stop() ends the watch', async () => {
  const log = []; const spawns = [];
  let there = { version: '0.11.21', managedBy: 'desktop-child' };
  const ticks = [];
  let runTick = null;
  const c = await ensureBridge({ bridge: { url: 'http://127.0.0.1:4319' } }, {
    log: (l) => log.push(l), probe: async () => there,
    spawnImpl: (program, args, opts) => { spawns.push({ program, args, env: opts.env }); return fakeChild(); },
    version: () => '0.11.23', candidates: [], launch: () => ({ program: 'g', args: ['--bridge'] }),
    waitForSiblingMs: 0, setTimer: (fn) => fn(),
    setWatch: (fn, ms) => { ticks.push(ms); runTick = fn; return 1; },
  });
  assert.equal(c.status().mode, 'adopted'); assert.equal(c.status().version, '0.11.21');
  assert.equal(spawns.length, 0);
  assert.deepEqual(ticks, [10000], 'a watch was armed');
  await runTick(); assert.equal(c.status().mode, 'adopted', 'still there');
  // The desktop quit: its child bridge is gone. One miss is patience; the second starts ours.
  there = null;
  await runTick(); assert.equal(c.status().mode, 'adopted'); assert.equal(spawns.length, 0);
  assert.equal(ticks.at(-1), 3000, 'a miss re-probes sooner');
  await runTick();
  assert.equal(c.status().mode, 'embedded'); assert.equal(c.status().version, '0.11.23');
  assert.equal(spawns.length, 1); assert.deepEqual(spawns[0].args, ['--bridge']); assert.equal(spawns[0].env.CHATPANEL_MANAGED_BY, 'gateway');
  assert.ok(log.some((l) => /adopted bridge .* went away — starting the embedded bridge \(v0\.11\.23\)/.test(l)), log.join('\n'));
  // Nothing to run in its place: off, said plainly.
  let t2 = { version: '0.11.1' };
  let tick2 = null;
  const d = await ensureBridge({ bridge: { url: 'http://127.0.0.1:4319' } }, { log: () => {}, probe: async () => t2, spawnImpl: () => { throw new Error('must not spawn'); }, version: () => null, candidates: [], launch: () => ({ program: 'g', args: ['--bridge'] }), waitForSiblingMs: 0, setWatch: (fn) => { tick2 = fn; return 1; } });
  t2 = null; await tick2(); await tick2();
  assert.equal(d.status().mode, 'off'); assert.match(d.status().why, /went away and no bridge to start/);
});
