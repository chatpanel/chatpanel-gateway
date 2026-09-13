// TEAM RUNS — the board every client can read, held here because the gateway is the one
// address the extension and the desktop both have.
//
// A run happens in ONE client (its models, its tools, its guards), but the extension cannot
// read the desktop's database and vice versa. So the running client APPENDS the run's
// events here as they happen — planned, started, a finding, done — and any client can read
// the run: list it, open its board, follow it live (SSE), and stop it. The store is the
// truth about what a team did; the client that ran it is just the first reader.
//
// Events are the unit, applied to a run record as they arrive (the shape @chatpanel/events
// team-run.js emits), so a reader that joins late replays and one that is watching tails.
// A run whose writer went quiet is reported as such: `staleAfterMs` past its last event a
// `running` run is marked stale, never silently kept "running" forever. Stop is a flag the
// running client sees on its own SSE stream and honours; the store cannot kill anything.
//
// Encrypted at rest with the device key like memory and prefs — a board carries the user's
// own findings — and bounded: the newest runs are kept, the oldest evicted.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const DIR = join(os.homedir(), '.chatpanel');
const STORE_PATH = process.env.CHATPANEL_TEAMS_STORE || join(DIR, 'team-runs.enc');
const KEY_PATH = process.env.CHATPANEL_HISTORY_KEY || join(DIR, 'history-key');

export const MAX_RUNS = 200;
export const MAX_EVENTS_PER_RUN = 2000;
export const MAX_EVENT_BYTES = 64 * 1024;
export const STALE_AFTER_MS = 5 * 60_000;
const RUN_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const LIVE = new Set(['planning', 'running', 'merging']);

function loadOrCreateKey() {
  try { if (existsSync(KEY_PATH)) return Buffer.from(readFileSync(KEY_PATH, 'utf8').trim(), 'base64'); } catch { /* regenerate */ }
  const key = randomBytes(32);
  mkdirSync(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(KEY_PATH, key.toString('base64'), { mode: 0o600 });
  return key;
}
function encrypt(key, buf) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function decrypt(key, env) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]);
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Apply one event to a run record. The record is the fold of its events. */
export function applyEvent(run, ev) {
  const type = String(ev?.type || '');
  const p = ev?.payload && typeof ev.payload === 'object' ? ev.payload : {};
  run.lastEventAt = ev.at;
  switch (type) {
    case 'run.started':
      run.team = p.team || run.team; run.request = p.request ?? run.request; run.budget = p.budget || run.budget;
      run.roles = Array.isArray(p.roles) ? p.roles : run.roles; run.status = 'planning'; run.startedAt = run.startedAt || ev.at;
      break;
    case 'plan.ready':
      run.plan = { by: p.by || 'fixed', tasks: Array.isArray(p.tasks) ? p.tasks : [] };
      run.tasks = run.plan.tasks.map((t) => ({ id: t.id, role: t.role, title: t.title, status: 'pending', findings: 0 }));
      run.status = 'running';
      break;
    case 'task.started': { const t = run.tasks.find((x) => x.id === p.taskId); if (t) { t.status = 'running'; t.startedAt = ev.at; } run.status = 'running'; break; }
    case 'task.delta': { const t = run.tasks.find((x) => x.id === p.taskId); if (t) t.text = String(p.text || '').slice(0, 20_000); break; }
    case 'task.finding':
      if (p.finding && p.finding.text) { run.board.push({ ...p.finding, at: ev.at }); const t = run.tasks.find((x) => x.id === p.taskId); if (t) t.findings += 1; }
      break;
    case 'task.done':
    case 'task.failed': { const t = run.tasks.find((x) => x.id === p.taskId); if (t) { t.status = p.status || (type === 'task.done' ? 'ok' : 'failed'); t.error = p.error || null; t.ms = p.ms; } break; }
    case 'run.merging': run.status = 'merging'; break;
    case 'run.done':
      run.status = p.status || 'completed'; run.usage = p.usage || run.usage; run.proposal = p.proposal ?? run.proposal; run.endedAt = ev.at;
      break;
    case 'run.stop-requested': run.stopRequested = ev.at; break;
    default: break;
  }
  return run;
}

export class TeamStore {
  constructor({ storePath = STORE_PATH, now = () => Date.now(), staleAfterMs = STALE_AFTER_MS } = {}) {
    this.path = storePath;
    this.now = now;
    this.staleAfterMs = staleAfterMs;
    this._key = null;
    this.runs = new Map(); // id -> { id, client, createdAt, events: [], ...folded record }
    this.watchers = new Map(); // id -> Set<fn(ev)>
  }
  load() {
    this._key = loadOrCreateKey();
    try {
      if (existsSync(this.path)) {
        const env = JSON.parse(readFileSync(this.path, 'utf8'));
        const doc = JSON.parse(decrypt(this._key, env).toString('utf8'));
        for (const r of Array.isArray(doc?.runs) ? doc.runs : []) if (r?.id) this.runs.set(r.id, r);
      }
    } catch { this.runs = new Map(); }
    return this;
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const env = encrypt(this._key, Buffer.from(JSON.stringify({ v: 1, runs: [...this.runs.values()] }), 'utf8'));
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
  _fresh(id, { client = '' } = {}) {
    return { id, client: String(client || '').slice(0, 40), createdAt: this.now(), lastEventAt: this.now(), status: 'planning', team: '', request: '', roles: [], plan: null, tasks: [], board: [], proposal: null, usage: null, stopRequested: null, events: [] };
  }
  _evict() {
    if (this.runs.size <= MAX_RUNS) return;
    const byAge = [...this.runs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const r of byAge.slice(0, this.runs.size - MAX_RUNS)) this.runs.delete(r.id);
  }
  /** The record with liveness judged NOW, never as it was last written. */
  _view(run, { events = false } = {}) {
    const v = clone({ ...run, events: undefined });
    delete v.events;
    v.stale = LIVE.has(run.status) && this.now() - run.lastEventAt > this.staleAfterMs;
    if (events) v.events = clone(run.events);
    return v;
  }
  create({ id, client, team, request } = {}) {
    if (!RUN_ID_RE.test(String(id || ''))) throw new Error('run id: 4–64 of [a-zA-Z0-9_-]');
    if (this.runs.has(id)) throw new Error(`run ${id} already exists`);
    const run = this._fresh(id, { client });
    run.team = String(team || '').slice(0, 64);
    run.request = String(request || '').slice(0, 4000);
    this.runs.set(id, run);
    this._evict();
    this.save();
    return this._view(run);
  }
  /** Append events (the runner's `emit` shape: `{ type, at, ...payload }`). Returns the view. */
  append(id, events) {
    const run = this.runs.get(String(id || ''));
    if (!run) throw new Error(`no run ${id}`);
    const list = Array.isArray(events) ? events : [events];
    let seq = run.events.length;
    for (const e of list) {
      if (!e || typeof e !== 'object' || !e.type) continue;
      let bytes; try { bytes = Buffer.byteLength(JSON.stringify(e), 'utf8'); } catch { continue; }
      if (bytes > MAX_EVENT_BYTES) continue;
      if (run.events.length >= MAX_EVENTS_PER_RUN) break;
      const { type, at, runId: _r, ...payload } = e;
      const ev = { seq: seq++, type: String(type), at: Number(at) || this.now(), payload };
      run.events.push(ev);
      applyEvent(run, ev);
      for (const fn of this.watchers.get(run.id) || []) { try { fn(ev); } catch { /* a dead watcher */ } }
    }
    this.save();
    return this._view(run);
  }
  get(id, opts) { const r = this.runs.get(String(id || '')); return r ? this._view(r, opts) : null; }
  /** Newest first, without boards — the list a lens shows. */
  list({ limit = 50, team = '' } = {}) {
    return [...this.runs.values()]
      .filter((r) => !team || r.team === team)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map((r) => { const v = this._view(r); return { ...v, board: undefined, tasks: v.tasks.map((t) => ({ ...t, text: undefined })), findings: r.board.length }; });
  }
  /** Ask the running client to stop. Recorded as an event, so watchers (the runner) see it. */
  stop(id) {
    const run = this.runs.get(String(id || ''));
    if (!run) return null;
    if (!LIVE.has(run.status)) return this._view(run);
    return this.append(id, [{ type: 'run.stop-requested', at: this.now() }]);
  }
  /** Events from `after` (a seq) onward, for a late reader's replay. */
  eventsSince(id, after = -1) {
    const run = this.runs.get(String(id || ''));
    if (!run) return [];
    return run.events.filter((e) => e.seq > after).map(clone);
  }
  watch(id, fn) {
    if (!this.watchers.has(id)) this.watchers.set(id, new Set());
    this.watchers.get(id).add(fn);
    return () => this.watchers.get(id)?.delete(fn);
  }
  remove(id) {
    const had = this.runs.delete(String(id || ''));
    if (had) this.save();
    return had;
  }
  get size() { return this.runs.size; }
}

export function createTeamStore(opts) { return new TeamStore(opts).load(); }
