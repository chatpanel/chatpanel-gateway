// The projects — every goal's page and everything done for it, as the record both clients
// read (F8 §12). The page itself is data in the shared `projects` prefs section; this store
// holds the RECORD: the jobs posted on it, who applied and who was recruited, the runs it
// spawned and what they spent, the stakeholder's decisions, the report. Folded from events
// with the shared fold (project.js `foldProject`, vendored), so the desktop, the extension
// and this store never disagree on what a project is.
//
// Encrypted at rest with the team store's key, like the runs. Events append; nothing is
// edited; a watcher gets each event as it lands (the live project board).

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { emptyProjectRecord, foldProject, projectProgress, PROJECT_ID_RE } from './project.js';
import { normalizeJob, canTransition as canJobTransition } from './job.js';

const DIR = join(os.homedir(), '.chatpanel');
const STORE_PATH = process.env.CHATPANEL_PROJECTS_STORE || join(DIR, 'projects.enc');
const MAX_EVENTS_PER_PROJECT = 20_000;
const MAX_EVENT_BYTES = 64 * 1024;

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

export class ProjectStore {
  constructor({ storePath = STORE_PATH, key = null, now = () => Date.now() } = {}) {
    this.path = storePath;
    this.key = key;
    this.now = now;
    this.projects = new Map(); // id -> { ...record, events: [] }
    this.watchers = new Map(); // id -> Set<fn(ev)>
  }
  load() {
    try {
      if (existsSync(this.path) && this.key) {
        const env = JSON.parse(readFileSync(this.path, 'utf8'));
        const doc = JSON.parse(decrypt(this.key, env).toString('utf8'));
        for (const p of Array.isArray(doc?.projects) ? doc.projects : []) if (p?.id) this.projects.set(p.id, p);
      }
    } catch { this.projects = new Map(); }
    return this;
  }
  save() {
    if (!this.key) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const env = encrypt(this.key, Buffer.from(JSON.stringify({ v: 1, projects: [...this.projects.values()] }), 'utf8'));
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
  _view(rec, { events = false } = {}) {
    const v = clone({ ...rec, events: undefined });
    delete v.events;
    v.progress = projectProgress(v);
    if (events) v.events = clone(rec.events);
    return v;
  }
  /** Open a record for a page (idempotent: a page saved twice is one record). */
  create({ id, project = null, by = 'person' } = {}) {
    if (!PROJECT_ID_RE.test(String(id || ''))) throw new Error('project id: a short identifier');
    let rec = this.projects.get(id);
    if (!rec) { rec = { ...emptyProjectRecord({ id, now: this.now() }), events: [] }; this.projects.set(id, rec); }
    if (project) this.append(id, [{ type: rec.page ? 'project.updated' : 'project.created', at: this.now(), project: { ...project, id }, by }]);
    else this.save();
    return this._view(rec);
  }
  append(id, events) {
    const rec = this.projects.get(String(id || ''));
    if (!rec) throw new Error(`no project ${id}`);
    const list = Array.isArray(events) ? events : [events];
    let seq = rec.events.length;
    for (const e of list) {
      if (!e || typeof e !== 'object' || !e.type) continue;
      let bytes; try { bytes = Buffer.byteLength(JSON.stringify(e), 'utf8'); } catch { continue; }
      if (bytes > MAX_EVENT_BYTES) continue;
      if (rec.events.length >= MAX_EVENTS_PER_PROJECT) break;
      const { type, at, ...payload } = e;
      const ev = { seq: seq++, type: String(type), at: Number(at) || this.now(), payload };
      rec.events.push(ev);
      foldProject(rec, ev);
      for (const fn of this.watchers.get(rec.id) || []) { try { fn(ev); } catch { /* a dead watcher */ } }
    }
    this.save();
    return this._view(rec);
  }
  get(id, opts) { const r = this.projects.get(String(id || '')); return r ? this._view(r, opts) : null; }
  /** Newest activity first; the list a board shows — jobs counted, not listed. */
  list({ limit = 50, status = '' } = {}) {
    return [...this.projects.values()]
      .filter((r) => !status || r.status === status)
      .sort((a, b) => b.lastEventAt - a.lastEventAt)
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map((r) => { const v = this._view(r); return { ...v, jobs: undefined, decisions: undefined, report: undefined, runs: undefined, jobCount: r.jobs.length, runCount: r.runs.length }; });
  }
  /** Every open posting across projects — the job board. */
  openJobs() {
    return [...this.projects.values()].flatMap((r) => r.jobs.filter((j) => ['open', 'evaluating', 'recruited'].includes(j.status)).map((j) => ({ ...j, projectTitle: r.page?.title || r.id })));
  }
  /** Post a job on a project: validated as a posting, appended as an event. */
  postJob(id, job, { by = 'person' } = {}) {
    const rec = this.projects.get(String(id || ''));
    if (!rec) throw new Error(`no project ${id}`);
    const j = normalizeJob({ ...job, projectId: rec.id, postedBy: job?.postedBy || by });
    if (rec.jobs.some((x) => x.id === j.id)) throw new Error(`job ${j.id} already exists`);
    return this.append(rec.id, [{ type: 'job.posted', at: this.now(), job: j, by }]);
  }
  /** Move a job along its machine, or update its fields (applications, recruited, result). */
  updateJob(id, jobId, patch, { by = 'person' } = {}) {
    const rec = this.projects.get(String(id || ''));
    if (!rec) throw new Error(`no project ${id}`);
    const cur = rec.jobs.find((x) => x.id === jobId);
    if (!cur) throw new Error(`no job ${jobId}`);
    if (patch?.status && patch.status !== cur.status && !canJobTransition(cur.status, patch.status)) throw new Error(`a job cannot go from ${cur.status} to ${patch.status}`);
    const allowed = ['status', 'applications', 'recruited', 'runId', 'result', 'workspace', 'budget', 'brief', 'title', 'needs', 'dependsOn'];
    const job = { id: jobId };
    for (const k of allowed) if (patch?.[k] !== undefined) job[k] = patch[k];
    return this.append(rec.id, [{ type: 'job.updated', at: this.now(), job, by }]);
  }
  watch(id, fn) {
    const set = this.watchers.get(String(id)) || new Set();
    set.add(fn); this.watchers.set(String(id), set);
    return () => { set.delete(fn); };
  }
  eventsSince(id, after = -1) { const r = this.projects.get(String(id || '')); return r ? r.events.filter((e) => e.seq > after) : []; }
  remove(id) { const had = this.projects.delete(String(id || '')); if (had) this.save(); return had; }
}

export function createProjectStore(opts) { return new ProjectStore(opts).load(); }
