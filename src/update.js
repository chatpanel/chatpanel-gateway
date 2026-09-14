// In-app updater for the gateway — the one install (0.6.92+), so its update is the update.
//
// The gateway is a background service the user never opens. The EXTENSION (and the desktop)
// surface "update available" from /status and offer a one-click Update that POSTs /update.
// The bridge has had this for its standalone binary (chatpanel-bridge/src/update.js); the
// gateway needs it for BOTH of its delivery channels, because they are not interchangeable:
//
//   • binary — the compiled Bun build install.sh / dl.chatpanel.net serve. Latest = the
//     newest GitHub release; the update downloads the asset, swaps it over the running file
//     (atomic rename; Windows renames the running .exe aside first) and restarts the service.
//   • npm    — `npm i -g @chatpanel/gateway`, launched as `node …/bin/chatpanel-gateway.js`.
//     Latest = the npm registry; the update runs `npm install -g @chatpanel/gateway@latest`
//     with the npm that ships beside the node running this process — the same install tree
//     the service launches — and restarts the service.
//
// Two rules carried over from the desktop's updater (electron/runtime/updater.js), learned
// the hard way there: the npm registry is PINNED to the public one (a corporate ~/.npmrc
// served a stale mirror minutes after a publish), and nothing here reports success on its
// own say-so — the caller restarts and the client watches /status until the version moves.
//
// The install can take minutes (a cold global install has been measured at five), so
// POST /update starts a JOB and answers at once; GET /update reports it. A request that
// waited on npm would have been the extension's fetch timing out mid-install.

import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { chmod, rename, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { restartService, serviceRegistered } from './service.js';

const PACKAGE = '@chatpanel/gateway';
const REPO = 'chatpanel/chatpanel-gateway';
const LATEST_RELEASE = `https://api.github.com/repos/${REPO}/releases/latest`;
const LATEST_NPM = `https://registry.npmjs.org/${PACKAGE}/latest`;
const NPM_REGISTRY = 'https://registry.npmjs.org';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // 6h
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000; // 10min
const FETCH_TIMEOUT_MS = Math.max(500, Number(process.env.CHATPANEL_UPDATE_TIMEOUT_MS) || 5000);
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const CACHE = process.env.CHATPANEL_UPDATE_CACHE || path.join(os.homedir(), '.chatpanel', 'gateway-update-check.json');
/** `CHATPANEL_SELF_UPDATE=off`: no network check, no install — the test runner sets it, and a
 *  deployment that manages the gateway itself can. `/status` then says `disabled: true`. */
const DISABLED = String(process.env.CHATPANEL_SELF_UPDATE || '').toLowerCase() === 'off';
const UA = { 'User-Agent': 'chatpanel-gateway-updater' };

/** Where a binary download may END UP. dl.chatpanel.net and the GitHub API both redirect
 *  to the release CDN; the final url is checked, because that is where the bytes come from
 *  and the file is about to be made executable. Same trust model as install.sh. */
const DL_HOSTS = new Set(['dl.chatpanel.net', 'github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
export function downloadHostAllowed(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && DL_HOSTS.has(u.hostname); } catch { return false; }
}

let lastFailure = { at: 0, error: '' };
/** Test seam: forget the last failure so the next unforced check reaches the network. */
export function resetUpdateBackoff() { lastFailure = { at: 0, error: '' }; }

/** A compiled single-file build, or node running the npm package. Mirrors service.js's resolveLaunch. */
export function isCompiledBinary() {
  const base = path.basename(process.execPath).toLowerCase();
  return !(base.startsWith('node') || base.startsWith('bun'));
}

/** Release asset for THIS platform (scripts/build.mjs outputs). */
function assetName() {
  if (process.platform === 'darwin') return `chatpanel-gateway-macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (process.platform === 'linux') return process.arch === 'x64' ? 'chatpanel-gateway-linux-x64' : null;
  if (process.platform === 'win32') return 'chatpanel-gateway-windows-x64.exe';
  return null;
}

function parseVersion(s = '') { const m = /(\d+(?:\.\d+){0,3})/.exec(s || ''); return m ? m[1] : null; }
/** >0 if a is newer than b. */
export function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

async function readCache() { try { return JSON.parse(await readFile(CACHE, 'utf8')); } catch { return null; } }
async function writeCache(obj) { try { await mkdir(path.dirname(CACHE), { recursive: true }); await writeFile(CACHE, JSON.stringify(obj)); } catch { /* best effort */ } }

/** One fetch with a real timer (AbortSignal.timeout's is unref'd and can never fire in an idle process). */
async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json, application/vnd.github+json', ...UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(res.status === 403 && /github/.test(url) ? 'GitHub rate limit (60/hour per IP) — try again later' : `HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    // Node's `fetch failed` hides the reason (a VPN's TLS block, DNS); the cause names it.
    const why = e?.cause?.code || e?.cause?.message || e?.message || String(e);
    throw new Error(ctl.signal.aborted ? `the update server did not answer within ${Math.round(timeoutMs / 1000)}s` : `${new URL(url).hostname}: ${why}`);
  } finally { clearTimeout(timer); }
}

// ── the npm install, as the service launches it ───────────────────────────────────────

/**
 * The package root of the running npm install (…/node_modules/@chatpanel/gateway), or ''.
 * The service launches the bin SYMLINK (<prefix>/bin/chatpanel-gateway), whose own path says
 * nothing — the realpath is what is inside node_modules. (Reading it literally classified a
 * global install as "not npm" and hid the Update button behind the command.)
 */
export function npmPackageRoot(script = process.argv[1]) {
  let real = script ? path.resolve(script) : '';
  try { real = realpathSync(real); } catch { /* a dangling link is still a clue */ }
  const m = /^(.*[/\\]node_modules[/\\]@chatpanel[/\\]gateway)[/\\]/.exec(real);
  return m ? m[1] : '';
}
/** The version the npm install on disk reports — what the NEXT start will run. */
function installedNpmVersion() {
  const root = npmPackageRoot();
  if (!root) return '';
  try { return String(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''); } catch { return ''; }
}
/**
 * The npm that belongs to the node running this process. A login service inherits no shell
 * PATH, so `npm` bare is not findable; but npm's cli ships beside node in every layout this
 * meets (nvm, Homebrew, the official installer, fnm): <prefix>/lib/node_modules/npm.
 */
function npmCli() {
  const bin = path.dirname(process.execPath);
  const candidates = [
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // the Windows layout
  ];
  return candidates.find((p) => existsSync(p)) || '';
}
function runNpmInstall() {
  const cli = npmCli();
  const env = { ...process.env, npm_config_registry: NPM_REGISTRY, npm_config_fund: 'false', npm_config_audit: 'false' };
  delete env.ELECTRON_RUN_AS_NODE; // leaked from a desktop host, it makes npm's node shims boot as Electron
  const [cmd, args] = cli ? [process.execPath, [cli, 'install', '-g', `${PACKAGE}@latest`]] : ['npm', ['install', '-g', `${PACKAGE}@latest`]];
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 << 20, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (!err) return resolve({ ok: true, out });
      if (err.killed && !out) return resolve({ ok: false, out: `npm was still running after ${Math.round(INSTALL_TIMEOUT_MS / 60000)} minutes and was stopped` });
      return resolve({ ok: false, out: out || (cli ? err.message : 'could not run npm: it is not beside the node running this gateway and not on the service\'s PATH') });
    });
  });
}

// ── check ───────────────────────────────────────────────────────────────────────────

/**
 * Returns { current, latest, updateAvailable, mode, canSelfUpdate, assetUrl, stale, error, npmCommand, channel }.
 * `mode` binary | npm — each checks ITS channel (the release, the registry), because a fix
 * published to npm does not exist as a binary until its tag is cut. `stale` says `latest`
 * is yesterday's cache, not an answer. Throttled to CHECK_EVERY_MS unless `force`.
 */
export async function checkForUpdate(current, { force = false } = {}) {
  const mode = isCompiledBinary() ? 'binary' : 'npm';
  if (DISABLED) return { current, latest: null, updateAvailable: false, mode, canSelfUpdate: false, assetUrl: null, stale: false, error: '', npmCommand: null, channel: mode === 'npm' ? 'npm' : 'release', service: false, disabled: true };
  const want = assetName();
  let latest = null; let assetUrl = null; let stale = false; let error = ''; let checkedAt = 0;
  const cache = await readCache();
  const cacheFits = cache && cache.mode === mode;
  const fallBack = () => { latest = cacheFits ? cache.latest || null : null; assetUrl = cacheFits ? cache.assetUrl || null : null; checkedAt = cacheFits ? cache.checkedAt || 0 : 0; stale = true; };
  if (!force && cacheFits && Date.now() - cache.checkedAt < CHECK_EVERY_MS) {
    latest = cache.latest; assetUrl = cache.assetUrl; checkedAt = cache.checkedAt;
  } else if (!force && lastFailure.at && Date.now() - lastFailure.at < RETRY_AFTER_FAILURE_MS) {
    error = lastFailure.error; fallBack();
  } else {
    try {
      if (mode === 'npm') {
        const data = await fetchJson(LATEST_NPM);
        latest = parseVersion(data.version);
      } else {
        const data = await fetchJson(LATEST_RELEASE);
        latest = parseVersion(data.tag_name) || parseVersion(data.name);
        assetUrl = want ? (data.assets || []).find((a) => a.name === want)?.browser_download_url || null : null;
      }
      checkedAt = Date.now();
      await writeCache({ checkedAt, mode, latest, assetUrl });
      lastFailure = { at: 0, error: '' };
    } catch (e) {
      error = e.message; lastFailure = { at: Date.now(), error }; fallBack();
    }
  }
  const updateAvailable = !!latest && cmpVersions(latest, current) > 0;
  // Windows npm: a running gateway holds onnxruntime's DLL and npm's copy fails with EBUSY, so
  // the install runs AFTER this process exits, from the restart helper — which needs the
  // registered service to relaunch it. No service, no self-update: the command is shown.
  const canSelfUpdate = mode === 'binary' ? !!assetUrl && (process.platform !== 'win32' || serviceRegistered())
    : !!npmPackageRoot() && (process.platform !== 'win32' || (serviceRegistered() && !!npmCli()));
  const npmCommand = mode === 'npm' ? (process.platform === 'win32' ? `chatpanel-gateway --stop; npm i -g ${PACKAGE}@latest; chatpanel-gateway --install` : `npm i -g ${PACKAGE}@latest`) : null;
  // `checkedAt`: when `latest` was last a real answer — so a client can say "as of 3 h ago"
  // instead of an unqualified "up to date" minutes after a publish.
  return { current, latest, updateAvailable, mode, canSelfUpdate, assetUrl, stale, error, npmCommand, channel: mode === 'npm' ? 'npm' : 'release', service: serviceRegistered(), checkedAt };
}

/**
 * What /status reports — NEVER waits on the network. The answer is the last check (in
 * memory, else the disk cache — `stale: true` until a fresh one lands), and a fresh check is
 * kicked off in the background when one is due. The first /status after a start therefore
 * says "unknown yet"; the next says what the registry said. A /status that waited on a 5 s
 * fetch behind a VPN missed the extension's 4 s deadline and drew "Not installed" for a
 * gateway that was running.
 */
let known = null;
let inFlight = null;
export function updateStatus(current) {
  const mode = isCompiledBinary() ? 'binary' : 'npm';
  if (DISABLED) return { current, latest: null, updateAvailable: false, mode, canSelfUpdate: false, stale: false, error: '', npmCommand: null, channel: mode === 'npm' ? 'npm' : 'release', service: false, disabled: true };
  const due = !known || (known.stale ? !(lastFailure.at && Date.now() - lastFailure.at < RETRY_AFTER_FAILURE_MS) : Date.now() - known.seenAt > CHECK_EVERY_MS);
  if (due && !inFlight) {
    inFlight = checkForUpdate(current).then((r) => { known = { ...r, seenAt: Date.now() }; }).catch(() => {}).finally(() => { inFlight = null; });
  }
  if (known) return { ...known, seenAt: undefined, current };
  return { current, latest: null, updateAvailable: false, mode, canSelfUpdate: false, stale: true, checking: true, error: '', npmCommand: null, channel: mode === 'npm' ? 'npm' : 'release', service: serviceRegistered() };
}
/** Test seam. */
export function _resetUpdateStatus() { known = null; inFlight = null; }

// ── apply ───────────────────────────────────────────────────────────────────────────

async function swapBinary(info) {
  const target = process.execPath;
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.chatpanel-gateway.new-${Date.now()}`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DOWNLOAD_TIMEOUT_MS);
  let buf;
  try {
    const res = await fetch(info.assetUrl, { headers: UA, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    if (!downloadHostAllowed(res.url || info.assetUrl)) throw new Error(`refused: the download was redirected to ${res.url}, which is not a ChatPanel release host`);
    buf = Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(timer); }
  // These binaries are tens of megabytes; anything small is an error page or a truncated body.
  if (buf.length < 5 << 20) throw new Error(`the download was only ${(buf.length / 1024).toFixed(0)} KB — that is not the gateway, so nothing was replaced`);
  await writeFile(tmp, buf);
  if (process.platform !== 'win32') await chmod(tmp, 0o755);
  if (process.platform === 'darwin') await new Promise((r) => execFile('xattr', ['-c', tmp], () => r()));
  // The new file must answer --version before it may become the real one.
  const said = await new Promise((r) => execFile(tmp, ['--version'], { timeout: 60_000, windowsHide: true }, (err, stdout) => r(err ? '' : String(stdout || '').trim())));
  if (!parseVersion(said)) { await rm(tmp, { force: true }); throw new Error('the downloaded gateway would not run, so it was discarded'); }
  if (process.platform === 'win32') {
    // A running .exe cannot be overwritten but can be renamed: move it aside, drop the new one in.
    await rename(target, path.join(dir, `chatpanel-gateway.old-${Date.now()}.exe`));
  }
  await rename(tmp, target); // POSIX: atomic over the running file; this process keeps its inode
  return parseVersion(said);
}

/**
 * Apply the update for this install's channel. Throws on any failure, leaving the running
 * install untouched. Does NOT restart — the caller answers its request first, then restarts.
 * Returns { from, to, mode } where `to` is what is now ON DISK (the running process is still `from`).
 */
export async function selfUpdate(current) {
  if (DISABLED) throw new Error('Self-update is switched off on this gateway (CHATPANEL_SELF_UPDATE=off).');
  const info = await checkForUpdate(current, { force: true });
  // A forced check that fell back to the cache checked nothing. Acting on it is how an
  // update lands on a superseded version and calls it a success.
  if (info.stale) throw new Error(`Could not reach the update server${info.error ? ` (${info.error})` : ''}. Refusing to act on a stale check — try again in a few minutes.`);
  if (!info.updateAvailable) throw new Error(`Already on the latest ${info.channel} version (v${current}).`);
  if (!info.canSelfUpdate) throw new Error(info.mode === 'npm' ? `This gateway cannot update itself here. Run: ${info.npmCommand}` : 'No downloadable build for this platform — install it with npm instead.');
  if (info.mode === 'binary') return { from: current, to: await swapBinary(info), mode: 'binary' };
  if (process.platform === 'win32') {
    // The install happens after exit (see restartService); `to` is what the registry says.
    return { from: current, to: info.latest, mode: 'npm', deferred: `"${process.execPath}" "${npmCli()}" install -g ${PACKAGE}@latest --registry=${NPM_REGISTRY} --no-fund --no-audit` };
  }
  const r = await runNpmInstall();
  if (!r.ok) throw new Error(`npm install failed: ${r.out.slice(0, 800)}`);
  // Success is the copy on disk moving, not npm exiting zero — npm reports success when it
  // updated a copy the service never launches.
  const to = installedNpmVersion();
  if (!to || cmpVersions(to, current) <= 0) throw new Error(`npm ran, but the install at ${npmPackageRoot()} is still ${to || 'unreadable'} — the service launches a copy npm did not update. Run: ${info.npmCommand}`);
  return { from: current, to, mode: 'npm' };
}

// ── the job ─────────────────────────────────────────────────────────────────────────

const job = { state: 'idle', mode: '', from: '', to: '', detail: '', startedAt: 0, endedAt: 0 };
/** What GET /update reports. `restarting` is the last thing this process says. */
export function updateJob() { return { ...job }; }
/**
 * Start the update in the background. The restart runs after the install landed, on a later
 * tick, so the caller's response is out before the process goes. Returns the job, or the
 * running one if one is already going (an update twice at once is a corrupt install).
 * `restart` is a test seam; the real one is service.js's restartService.
 */
export function startUpdate(current, { restart = restartService, apply = selfUpdate } = {}) {
  if (job.state === 'installing' || job.state === 'restarting') return { ...job, already: true };
  Object.assign(job, { state: 'installing', mode: isCompiledBinary() ? 'binary' : 'npm', from: current, to: '', detail: '', startedAt: Date.now(), endedAt: 0 });
  apply(current).then((r) => {
    Object.assign(job, { state: 'restarting', to: r.to, mode: r.mode, detail: r.deferred ? `stopping to install v${r.to}, then relaunching` : `v${r.to} is installed; restarting the gateway into it` });
    setTimeout(() => {
      const how = restart({ winInstall: r.deferred || '' });
      if (!how) Object.assign(job, { state: 'done', endedAt: Date.now(), detail: `v${r.to} is installed, but this gateway is not run by a service it can restart. Start it again yourself to run the new version.` });
    }, 400);
  }).catch((e) => {
    Object.assign(job, { state: 'failed', endedAt: Date.now(), detail: String(e?.message || e).slice(0, 1200) });
  });
  return { ...job };
}

/** Test seam. */
export function _resetUpdateJob() { Object.assign(job, { state: 'idle', mode: '', from: '', to: '', detail: '', startedAt: 0, endedAt: 0 }); }
