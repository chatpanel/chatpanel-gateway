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
import { emptyBoardState } from './team-board.js';
import { foldRun, emptyRun, checkpointFrom, isResumable, LIVE_RUN_STATUSES } from './team-record.js';

const DIR = join(os.homedir(), '.chatpanel');
const STORE_PATH = process.env.CHATPANEL_TEAMS_STORE || join(DIR, 'team-runs.enc');
const KEY_PATH = process.env.CHATPANEL_HISTORY_KEY || join(DIR, 'history-key');

export const MAX_RUNS = 200;
export const MAX_EVENTS_PER_RUN = 2000;
export const MAX_EVENT_BYTES = 64 * 1024;
export const STALE_AFTER_MS = 5 * 60_000;
const RUN_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const LIVE = new Set(LIVE_RUN_STATUSES);

export function loadOrCreateKey() {
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

/** Apply one event to a run record — the shared fold (team-record.js, vendored from @chatpanel/events). */
export function applyEvent(run, ev) { return foldRun(run, ev); }

export class TeamStore {
  constructor({ storePath = STORE_PATH, now = () => Date.now(), staleAfterMs = STALE_AFTER_MS, scorecards = null, engines = null } = {}) {
    this.scorecards = scorecards; // the agents' ledgers (scorecard-store.js), fed by task.scored
    this.engines = engines; // the engines' ledgers (engine-ledger-store.js), fed by task.routed / reappointed / handoff / scored
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
    return { ...emptyRun({ id, client, now: this.now() }), events: [] };
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
    // How long since the running client last wrote — a person who knows the process died
    // does not have to wait for the stale mark to pick the run up.
    v.quietMs = LIVE.has(run.status) ? Math.max(0, this.now() - run.lastEventAt) : 0;
    // Can a client pick this run up again? Not while its own client is live on it.
    v.resumable = isResumable(v);
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
    let stored = 0;
    for (const e of list) {
      if (!e || typeof e !== 'object' || !e.type) continue;
      let bytes; try { bytes = Buffer.byteLength(JSON.stringify(e), 'utf8'); } catch { continue; }
      if (bytes > MAX_EVENT_BYTES) continue;
      const { type, at, runId: _r, ...payload } = e;
      // A STREAM IS NOT A FACT. A task's streamed text (`task.delta`) is folded into the record
      // — the task's live text — and handed to the tail so the other client reads along, but it
      // is never stored: the final text is on the record as a step. Deltas alone filled a run's
      // event log in three minutes, and the store then dropped the task.done, the writer's
      // start and the board that followed — a run that read "running" with a finished member.
      const stream = String(type) === 'task.delta';
      const ev = { seq: stream ? null : seq++, type: String(type), at: Number(at) || this.now(), payload };
      // At the cap the RECORD still moves — the fold keeps status, tasks and the board true —
      // only the replayable list stops growing, and says so.
      if (!stream) { if (run.events.length < MAX_EVENTS_PER_RUN) run.events.push(ev); else { ev.seq = null; run.eventsTruncated = true; seq -= 1; } }
      if (!stream) stored += 1;
      applyEvent(run, ev);
      // A finished task's fact goes to the member's scorecard — chained and attested there.
      if (this.scorecards && ev.type === 'task.scored') this.scorecards.fromRunEvent(ev, run);
      // …and to the engine's ledger: the call, or the decline / rotation that preceded it.
      if (this.engines && (ev.type === 'task.routed' || ev.type === 'task.reappointed' || ev.type === 'task.handoff' || ev.type === 'task.scored')) this.engines.fromRunEvent(ev, run);
      for (const fn of this.watchers.get(run.id) || []) { try { fn(ev); } catch { /* a dead watcher */ } }
    }
    // A batch of nothing but stream text does not rewrite the store — the live text is
    // persisted with the next fact (a step, a finding, the task's end).
    if (stored) this.save();
    return this._view(run);
  }
  get(id, opts) { const r = this.runs.get(String(id || '')); return r ? this._view(r, opts) : null; }
  /** Newest first, without boards — the list a lens shows. */
  list({ limit = 50, team = '' } = {}) {
    return [...this.runs.values()]
      .filter((r) => !team || r.team === team)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map((r) => { const v = this._view(r); return { ...v, board: undefined, threads: undefined, checkpoint: undefined, tasks: v.tasks.map((t) => ({ ...t, text: undefined, transcript: undefined })), findings: r.board.length, waiting: (r.threads?.threads || []).filter((t) => t.kind === 'ask' && t.status === 'waiting').length }; });
  }
  /** Ask the running client to stop. Recorded as an event, so watchers (the runner) see it. */
  /**
   * A person's answer to an ask, from ANY client: an answer post and the thread resolved,
   * appended as the events the running client's tail turns into the member's answer.
   * The post id is fixed here so the runner's own echo of it lands once.
   */
  answer(id, { threadId, text, by = 'person' } = {}) {
    const run = this.runs.get(String(id || ''));
    if (!run) throw new Error(`no run ${id}`);
    const thread = (run.threads?.threads || []).find((t) => t.id === threadId);
    if (!thread) throw new Error(`no thread ${threadId}`);
    if (thread.kind !== 'ask') throw new Error(`thread ${threadId} is not an ask`);
    const at = this.now();
    const postId = `ans_${randomBytes(4).toString('hex')}`;
    const post = { id: postId, threadId, by: String(by || 'person').slice(0, 40), kind: 'answer', text: String(text || '').slice(0, 4000), refs: [], replyTo: null, status: 'open', at };
    return this.append(id, [{ type: 'board.post', at, post }, { type: 'board.thread-status', at, threadId, status: 'resolved', answeredAt: at }]);
  }
  /** A person's decision on a post (approve / reject the draft, a finding), from any client. */
  decide(id, { postId, status, by = 'person' } = {}) {
    const run = this.runs.get(String(id || ''));
    if (!run) throw new Error(`no run ${id}`);
    if (!['approved', 'rejected', 'proposed', 'open'].includes(status)) throw new Error('status must be approved, rejected, proposed or open');
    if (!(run.threads?.posts || []).some((x) => x.id === postId)) throw new Error(`no post ${postId}`);
    const at = this.now();
    return this.append(id, [{ type: 'board.decision', at, postId, status, by: String(by || 'person').slice(0, 40) }]);
  }
  /** A person's own post in a thread (a note, a question), from any client. */
  post(id, { threadId, text, by = 'person', kind = 'note', replyTo = null } = {}) {
    const run = this.runs.get(String(id || ''));
    if (!run) throw new Error(`no run ${id}`);
    if (!(run.threads?.threads || []).some((t) => t.id === threadId)) throw new Error(`no thread ${threadId}`);
    const at = this.now();
    const post = { id: `pp_${randomBytes(4).toString('hex')}`, threadId, by: String(by || 'person').slice(0, 40), kind: ['note', 'question', 'decision'].includes(kind) ? kind : 'note', text: String(text || '').slice(0, 4000), refs: [], replyTo: replyTo || null, status: 'open', at };
    return this.append(id, [{ type: 'board.post', at, post }]);
  }
  /** The checkpoint a client resumes from — the runner's own when the run ended with one, else built from the record. */
  checkpoint(id) {
    const run = this.runs.get(String(id || ''));
    if (!run) throw new Error(`no run ${id}`);
    return checkpointFrom(this._view(run));
  }
  /** A person hands a task to another model, from any client: the running client's tail acts on it. */
  handoff(id, { taskId, model, by = 'person', reason = '' } = {}) {
    const run = this.runs.get(String(id || ''));
    if (!run) throw new Error(`no run ${id}`);
    if (!run.tasks.some((t) => t.id === taskId)) throw new Error(`no task ${taskId}`);
    if (!model) throw new Error('a model is required');
    return this.append(id, [{ type: 'task.handoff-requested', at: this.now(), taskId, model: String(model).slice(0, 120), by: String(by || 'person').slice(0, 40), reason: String(reason || '').slice(0, 400) }]);
  }
  /** A client is taking a run over (resume): the record says so, and the old client's stop no longer applies. */
  claim(id, { client = '' } = {}) {
    const run = this.runs.get(String(id || ''));
    if (!run) throw new Error(`no run ${id}`);
    run.client = String(client || run.client || '').slice(0, 40);
    run.stopRequested = null;
    this.save();
    return this._view(run);
  }
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
