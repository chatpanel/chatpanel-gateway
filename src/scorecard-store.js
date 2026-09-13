// The agents' scorecards — every fact the runner said about a member, chained and attested
// here, where no client and no agent can write one for itself.
//
// One chain per agent id. A fact arrives as the run store's `task.scored` event (or a
// person's rating through the route); the store makes the entry (scorecard.js: canonical,
// hashed onto the previous), marks it with an HMAC over a key only this process holds, and
// appends. Nothing is ever edited: a correction is a new entry. The file is encrypted at
// rest with the team store's key, like the runs; the attestation key is derived from it
// (HKDF-style label), so the same install attests the same way across restarts and a copied
// file elsewhere cannot forge a mark.
//
// Read: `GET /v1/agents/:id/scorecard` → the chain, its summary, and whether it verifies.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { createHmac, webcrypto } from 'node:crypto';
import { makeEntry, attest, verifyChain, verifyAttested, summarize, SCORECARD_ENTRY_KINDS } from './scorecard.js';

const DIR = join(os.homedir(), '.chatpanel');
const STORE_PATH = process.env.CHATPANEL_SCORECARDS_STORE || join(DIR, 'scorecards.json');
const MAX_ENTRIES_PER_AGENT = 5000;

export class ScorecardStore {
  constructor({ storePath = STORE_PATH, key = null, now = () => Date.now() } = {}) {
    this.path = storePath;
    this.now = now;
    // The attestation key: derived from the store key with a label, never the key itself.
    this._mark = key ? createHmac('sha256', key).update('chatpanel:scorecard:attest:v1').digest() : null;
    this.chains = new Map(); // agentId -> [entries]
    this._queue = Promise.resolve(); // appends are serialised: a chain has one head
  }
  load() {
    try {
      if (existsSync(this.path)) {
        const doc = JSON.parse(readFileSync(this.path, 'utf8'));
        for (const [id, entries] of Object.entries(doc?.chains || {})) if (Array.isArray(entries)) this.chains.set(id, entries);
      }
    } catch { this.chains = new Map(); }
    return this;
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, chains: Object.fromEntries(this.chains) }), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
  /** Append one fact to an agent's chain: made, chained, attested, saved. Serialised per store. */
  append(fact) {
    const run = async () => {
      const agentId = String(fact?.agentId || '');
      if (!agentId) throw new Error('scorecard: agentId required');
      if (!SCORECARD_ENTRY_KINDS.includes(fact?.kind)) throw new Error(`scorecard: kind must be one of ${SCORECARD_ENTRY_KINDS.join(', ')}`);
      const chain = this.chains.get(agentId) || [];
      if (chain.length >= MAX_ENTRIES_PER_AGENT) throw new Error('scorecard: chain is full');
      let entry = await makeEntry({ ...fact, at: fact.at || this.now() }, chain.at(-1) || null, { now: this.now, subtle: webcrypto.subtle });
      if (this._mark) entry = await attest(entry, this._mark, { subtle: webcrypto.subtle });
      chain.push(entry);
      this.chains.set(agentId, chain);
      this.save();
      return entry;
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }
  /** The chain, its card, and whether it verifies — what a recruiter (or a person) reads. */
  async get(agentId) {
    const chain = this.chains.get(String(agentId || '')) || [];
    const verified = await verifyChain(chain, { subtle: webcrypto.subtle });
    const attested = this._mark ? await verifyAttested(chain, this._mark, { subtle: webcrypto.subtle }) : { ok: false, attested: 0, of: chain.length };
    return { agentId: String(agentId || ''), entries: chain, summary: summarize(chain), verified, attested };
  }
  /** Every agent's card, without the chains. */
  list() {
    return [...this.chains.entries()].map(([agentId, chain]) => ({ agentId, ...summarize(chain) }));
  }
  /** A run store event, as the fold sees it: only `task.scored` becomes a fact. */
  fromRunEvent(ev, run) {
    if (String(ev?.type || '') !== 'task.scored') return null;
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (!p.agentId) return null;
    return this.append({
      agentId: p.agentId, kind: p.outcome === 'task.failed' ? 'task.failed' : 'task.done', at: ev.at,
      runId: run?.id || p.runId, taskId: p.taskId, model: p.model, engine: p.engine, scm: p.scm, size: p.size, roleKind: p.roleKind,
      tools: p.tools, with: p.with, refs: p.refs, error: p.error,
      ...(run?.projectId ? { projectId: run.projectId } : {}), ...(run?.jobId ? { jobId: run.jobId } : {}),
    }).catch(() => null);
  }
}

export function createScorecardStore(opts) { return new ScorecardStore(opts).load(); }
