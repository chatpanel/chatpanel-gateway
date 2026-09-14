// The gateway carries the bridge — one install, two processes.
//
// A user installs ONE thing (this gateway: the binary, or `npm i -g @chatpanel/gateway`) and
// gets the bridge with it: `@chatpanel/bridge` is a dependency, bundled into the same binary,
// and the gateway STARTS it as a child process when nothing already answers on the bridge
// port. Two processes on purpose: the bridge spawns CLIs, holds SCM tokens and runs shells —
// a small zero-dependency process with its own failure domain — and the NER / STT / TTS
// runtimes that crash or eat memory live here, not there. A gateway restart never takes a
// running Claude Code task down with it.
//
// What is already there is ADOPTED, never fought: a bridge the desktop app installed, a
// standalone the user put in ~/.local/bin (preferred when it is NEWER than the embedded copy,
// so a bridge fix keeps shipping on its own tag), a remote bridge named in config. The plan
// is a pure function (`planBridge`) so the rule is testable without spawning anything.
//
// An embedded child is started with CHATPANEL_BRIDGE_EMBEDDED=1: its `process.execPath` is
// the GATEWAY binary, so the bridge's self-update is disabled there (it would overwrite the
// gateway with a bridge) and its /health says `update.embedded: 'gateway'`. Both children get
// CHATPANEL_MANAGED_BY=gateway so a client can say who runs it instead of offering install.sh.

import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolveLaunch } from './service.js';
import { DEFAULT_BRIDGE_URL } from './bridge.js';

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:(\d+))?\/?$/i;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const STABLE_MS = 60_000; // a child up this long resets the back-off
const PROBE_TIMEOUT_MS = 1200;

/** Where the standalone bridge installer puts its binary (scripts/install.sh / install.ps1 in the bridge repo). */
export function standaloneCandidates({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return [path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ChatPanel', 'chatpanel-bridge.exe')];
  return [path.join(home, '.local', 'bin', 'chatpanel-bridge')];
}

/** semver-ish: 1 when a > b, -1 when a < b, 0 when equal or unreadable. */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10)); const pb = String(b || '').split('.').map((x) => parseInt(x, 10));
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN) || pa.length < 3 || pb.length < 3) return 0;
  for (let i = 0; i < 3; i += 1) { if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1; }
  return 0;
}

/**
 * What to do about the bridge — pure.
 *   managed: false / 'off'      → off   (the host runs its own, e.g. the desktop app)
 *   a non-loopback bridge.url   → off   (a remote bridge is the user's; never start one here)
 *   something answers the port  → adopt
 *   a standalone newer than the embedded copy → spawn-standalone
 *   an embedded copy            → spawn-embedded
 *   only a standalone           → spawn-standalone
 */
export function planBridge({ managed = true, cfgUrl = '', healthy = null, standalone = null, embeddedVersion = null } = {}) {
  if (managed === false || managed === 'off') return { action: 'off', why: 'bridge supervision is off (the host runs its own)' };
  const url = String(cfgUrl || DEFAULT_BRIDGE_URL);
  if (!LOOPBACK.test(url)) return { action: 'off', why: `bridge.url ${url} is not on this machine; nothing to start here` };
  if (healthy) return { action: 'adopt', why: `a bridge already answers at ${url}${healthy.version ? ` (v${healthy.version}${healthy.managedBy ? `, run by ${healthy.managedBy}` : ''})` : ''}` };
  const sv = standalone?.version || null;
  if (standalone?.path && embeddedVersion && compareVersions(sv, embeddedVersion) > 0) return { action: 'spawn-standalone', why: `the installed bridge (v${sv}) is newer than the embedded one (v${embeddedVersion})`, path: standalone.path };
  if (embeddedVersion) return { action: 'spawn-embedded', why: `starting the embedded bridge (v${embeddedVersion})${standalone?.path ? ` — the installed one is v${sv || '?'}` : ''}` };
  if (standalone?.path) return { action: 'spawn-standalone', why: `starting the installed bridge${sv ? ` (v${sv})` : ''}`, path: standalone.path };
  return { action: 'off', why: 'no bridge to start (no embedded copy, no standalone install)' };
}

/** `GET /health` on the bridge, or null. */
export async function probeBridge(url, { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${String(url).replace(/\/$/, '')}/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return j && j.ok !== false ? { version: j.version || null, managedBy: j.managedBy || null } : null;
  } catch { return null; } finally { clearTimeout(t); }
}

/** `<program> [...args] --version`, or null — one process, bounded. */
export function versionOf(program, args = [], { timeoutMs = 8000 } = {}) {
  try {
    const r = spawnSync(program, [...args, '--version'], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CHATPANEL_BRIDGE_EMBEDDED: '1' } });
    const v = String(r.stdout || '').trim().split('\n').pop();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch { return null; }
}

/** How THIS gateway starts its embedded bridge: itself, with `--bridge` (bin/chatpanel-gateway.js). */
export function embeddedLaunch() {
  const { program, args } = resolveLaunch();
  return { program, args: [...args, '--bridge'] };
}

const portOf = (url) => { const m = LOOPBACK.exec(String(url || DEFAULT_BRIDGE_URL)); return m?.[3] || '4319'; };

/**
 * Make sure a bridge is running for this gateway, and keep it running. Returns a controller:
 * `status()` → `{ mode: 'adopted'|'embedded'|'standalone'|'off', version, pid, restarts, why }`,
 * `stop()` ends a child we started. Everything that touches the machine is injectable so the
 * rule can be tested without a process: `probe`, `spawnImpl`, `version`, `candidates`, `exists`.
 */
export async function ensureBridge(cfg, {
  log = (line) => console.log(line),
  probe = probeBridge,
  spawnImpl = spawn,
  version = versionOf,
  candidates = standaloneCandidates(),
  exists = existsSync,
  launch = embeddedLaunch,
  managed = process.env.CHATPANEL_BRIDGE_MANAGED === 'off' ? false : cfg?.bridge?.managed,
  waitForSiblingMs = 2500,
  now = Date.now,
  setTimer = setTimeout,
  // The watch on an ADOPTED bridge: its own timer seam (a test's immediate `setTimer` would
  // spin it), unref'd so a pending watch never keeps the process alive.
  setWatch = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  watchEveryMs = 10_000,
} = {}) {
  const url = String(cfg?.bridge?.url || DEFAULT_BRIDGE_URL).replace(/\/$/, '');
  const state = { mode: 'off', version: null, pid: null, restarts: 0, why: '', child: null, stopping: false, backoff: 0 };
  const settle = (mode, why, extra = {}) => { Object.assign(state, { mode, why }, extra); log(`  bridge   : ${why}`); };

  // Someone else (the desktop's supervisor, launchd) may be starting a bridge this very
  // second; wait a moment before deciding it is absent, or two bridges race for one port.
  let healthy = await probe(url);
  if (!healthy && managed !== false && managed !== 'off' && LOOPBACK.test(url) && waitForSiblingMs > 0) {
    const until = now() + waitForSiblingMs;
    while (!healthy && now() < until) { await new Promise((r) => setTimer(r, 500)); healthy = await probe(url); }
  }
  const emb = launch();
  const embeddedVersion = managed === false || managed === 'off' || healthy ? null : version(emb.program, emb.args);
  const standalonePath = candidates.find((p) => exists(p)) || null;
  const standalone = standalonePath && !healthy ? { path: standalonePath, version: version(standalonePath, []) } : null;
  const plan = planBridge({ managed, cfgUrl: url, healthy, standalone, embeddedVersion });

  if (plan.action === 'off') { settle('off', plan.why); return controller(); }

  // What WE would run, decided once and kept: an adopted bridge that goes away is replaced
  // by this without re-planning from scratch.
  const specFor = (p) => (p.action === 'spawn-embedded'
    ? { ...emb, env: { CHATPANEL_BRIDGE_EMBEDDED: '1' }, mode: 'embedded', version: p.version || embeddedVersion }
    : { program: p.path, args: [], env: {}, mode: 'standalone', version: standalone?.version || null });
  let spec = plan.action === 'adopt' ? null : specFor(plan);
  let startedAt = 0;
  let watch = null;
  let misses = 0;

  // AN ADOPTED BRIDGE IS WATCHED, NOT TRUSTED FOREVER. The gateway carries the bridge: when
  // the one it adopted goes away — the desktop app that ran it quit, an old login unit was
  // removed, a standalone was stopped — the port is quiet and every agent turn fails with
  // "bridge unreachable" until someone restarts the gateway. Two missed probes (a refused
  // port counts at once) and ours starts.
  const adopt = (why, ver) => {
    settle('adopted', why, { version: ver || null });
    misses = 0;
    const tick = async () => {
      if (state.stopping || state.mode !== 'adopted') return;
      const h = await probe(url);
      if (h) { misses = 0; state.version = h.version || state.version; watch = setWatch(tick, watchEveryMs); return; }
      misses += 1;
      if (misses < 2) { watch = setWatch(tick, Math.min(watchEveryMs, 3000)); return; }
      if (!spec) {
        const ev = embeddedVersion || version(emb.program, emb.args);
        const p = planBridge({ managed, cfgUrl: url, healthy: null, standalone, embeddedVersion: ev });
        if (p.action === 'off') { settle('off', `the adopted bridge went away and ${p.why}`); return; }
        spec = specFor({ ...p, version: ev });
      }
      log(`  bridge   : the adopted bridge at ${url} went away — ${spec.mode === 'embedded' ? `starting the embedded bridge (v${spec.version || '?'})` : `starting the installed bridge (v${spec.version || '?'})`}`);
      settle(spec.mode, `the adopted bridge went away; ${spec.mode} bridge started in its place`, { version: spec.version });
      start();
    };
    watch = setWatch(tick, watchEveryMs);
  };

  const start = () => {
    if (state.stopping) return;
    const child = spawnImpl(spec.program, spec.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...spec.env, CHATPANEL_MANAGED_BY: 'gateway', CHATPANEL_BRIDGE_PORT: portOf(url) },
    });
    startedAt = now();
    state.child = child; state.pid = child.pid || null;
    const relay = (stream, tag) => stream?.on('data', (buf) => { for (const line of String(buf).split('\n')) if (line.trim()) log(`[bridge] ${line}`); });
    relay(child.stdout, 'out'); relay(child.stderr, 'err');
    child.on('error', (e) => log(`[bridge] could not start ${spec.program}: ${e?.message || e}`));
    child.on('exit', async (code, sig) => {
      state.child = null; state.pid = null;
      if (state.stopping) return;
      // The port may have been taken by a bridge someone else started while ours came up —
      // that is not a failure to restart from, it is a bridge to adopt.
      const other = await probe(url);
      if (other) { adopt(`a bridge already answers at ${url} (v${other.version || '?'}${other.managedBy ? `, run by ${other.managedBy}` : ''}) — ours stepped aside`, other.version); return; }
      if (now() - startedAt > STABLE_MS) state.backoff = 0;
      const delay = BACKOFF_MS[Math.min(state.backoff, BACKOFF_MS.length - 1)];
      state.backoff += 1; state.restarts += 1;
      log(`[bridge] exited (${sig || code}); restarting in ${delay / 1000}s`);
      setTimer(start, delay);
    });
  };
  if (plan.action === 'adopt') { adopt(plan.why, healthy.version); return controller(); }
  settle(spec.mode, plan.why, { version: spec.version });
  start();
  return controller();

  function controller() {
    return {
      status: () => ({ mode: state.mode, version: state.version, pid: state.pid, restarts: state.restarts, why: state.why }),
      stop: () => { state.stopping = true; if (watch) { clearTimeout(watch); watch = null; } if (state.child && !state.child.killed) { try { state.child.kill('SIGTERM'); } catch { /* gone */ } } },
    };
  }
}
