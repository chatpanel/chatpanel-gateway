// The engines' ledgers — every fact the runner and a host observed about a MODEL or a
// HARNESS, chained and attested here (model-ledger.js), one chain per engine key.
//
// The scorecard store's twin. A scorecard says what an AGENT did; a ledger says how an
// ENGINE behaved while doing it — did it answer, how fast, how much, was the JSON valid, was
// the verdict good. The facts come from the run store's fold (a finished task is a `call`,
// a re-appointment is a `declined` on the engine that was left, a hand-off a
// `rotated-from`), from a host that timed its own chat calls (`POST /v1/engines/:key/entries`),
// and from a person (a rating on a task lands on the engine that served it; a price they
// typed). Nothing is ever edited. The same store key attests both stores, under its own
// label, so a scorecard's mark cannot be replayed as a ledger's.
//
// Read: `GET /v1/engines` (every card), `GET /v1/engines/:key/card` (the card, the chain
// on request, whether it verifies). The card is what a client feeds `applyCard` — observed
// quality, latency and cost over the name-based guess once there is enough history.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { createHmac, webcrypto } from 'node:crypto';
import { makeLedgerEntry, verifyChain, attest, verifyAttested, summarizeEngine, ledgerKey, LEDGER_ENTRY_KINDS, DECLINE_REASONS } from './model-ledger.js';
import { normalizeEngine } from './scorecard.js';

const DIR = join(os.homedir(), '.chatpanel');
const STORE_PATH = process.env.CHATPANEL_ENGINES_STORE || join(DIR, 'engines.json');
const MAX_ENTRIES_PER_ENGINE = 20000;

/** Why an engine declined, read from the error the runner recorded. */
export function declineReasonOf(error) {
  const m = String(error || '');
  if (/rate|429|overloaded|capacity|too many/i.test(m)) return 'rate';
  if (/401|403|unauthori[sz]ed|no api key|invalid.*key|forbidden|not configured/i.test(m)) return 'auth';
  if (/credit|quota|billing|insufficient|402/i.test(m)) return 'credits';
  if (/timed? ?out|ETIMEDOUT|deadline/i.test(m)) return 'timeout';
  if (/context|too long|maximum.*tokens|token limit/i.test(m)) return 'context';
  if (/not[_ ]found|404|not deployed|unavailable|does not exist|unknown model|ECONNREFUSED|could ?n.t reach|closed the connection|exited|502|503|500/i.test(m)) return 'unavailable';
  return 'other';
}

export class EngineLedgerStore {
  constructor({ storePath = STORE_PATH, key = null, now = () => Date.now() } = {}) {
    this.path = storePath;
    this.now = now;
    this._mark = key ? createHmac('sha256', key).update('chatpanel:engine-ledger:attest:v1').digest() : null;
    this.chains = new Map(); // key -> [entries]
    this._routed = new Map(); // `${runId}/${taskId}` -> the engine last routed to (for declines and rotations)
    this._queue = Promise.resolve();
  }
  load() {
    try {
      if (existsSync(this.path)) {
        const doc = JSON.parse(readFileSync(this.path, 'utf8'));
        for (const [k, entries] of Object.entries(doc?.chains || {})) if (Array.isArray(entries)) this.chains.set(k, entries);
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
  /** Append one fact to an engine's chain: made, chained, attested, saved. Serialised per store. */
  append(fact) {
    const run = async () => {
      const engine = normalizeEngine(fact?.engine);
      if (!engine) throw new Error('model-ledger: engine required');
      if (!LEDGER_ENTRY_KINDS.includes(fact?.kind)) throw new Error(`model-ledger: kind must be one of ${LEDGER_ENTRY_KINDS.join(', ')}`);
      const key = ledgerKey(engine);
      const chain = this.chains.get(key) || [];
      if (chain.length >= MAX_ENTRIES_PER_ENGINE) throw new Error('model-ledger: chain is full');
      let entry = await makeLedgerEntry({ ...fact, engine, at: fact.at || this.now() }, chain.at(-1) || null, { now: this.now, subtle: webcrypto.subtle });
      if (this._mark) entry = await attest(entry, this._mark, { subtle: webcrypto.subtle });
      chain.push(entry);
      this.chains.set(key, chain);
      this.save();
      return entry;
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }
  /** The card, and on request the chain and whether it verifies. */
  async get(key, { entries = false, minCalls, now } = {}) {
    const chain = this.chains.get(String(key || '')) || [];
    const out = { key: String(key || ''), card: summarizeEngine(chain, { minCalls, now: now || this.now() }) };
    if (entries) {
      out.entries = chain;
      out.verified = await verifyChain(chain, { subtle: webcrypto.subtle });
      out.attested = this._mark ? await verifyAttested(chain, this._mark, { subtle: webcrypto.subtle }) : { ok: false, attested: 0, of: chain.length };
    }
    return out;
  }
  /** Every engine's card, without the chains. */
  list({ minCalls, now } = {}) {
    return [...this.chains.entries()].map(([key, chain]) => summarizeEngine(chain, { minCalls, now: now || this.now() })).filter((c) => c.key);
  }
  /**
   * A run store event, as the fold sees it. `task.routed` is remembered per task; a later
   * `task.reappointed` is a decline on what was routed before it, `task.handoff` a rotation,
   * and `task.scored` the call itself (the harness's or the model's whole task).
   */
  fromRunEvent(ev, run) {
    const type = String(ev?.type || '');
    const p = ev?.payload && typeof ev.payload === 'object' ? ev.payload : {};
    const runId = run?.id || p.runId || '';
    const slot = `${runId}/${p.taskId || ''}`;
    if (type === 'task.routed') {
      const engine = normalizeEngine(p.engine);
      if (engine) this._routed.set(slot, engine);
      return null;
    }
    if (type === 'task.reappointed' || type === 'task.handoff') {
      const from = this._routed.get(slot);
      if (!from) return null;
      const fact = type === 'task.reappointed'
        ? { engine: from, kind: 'declined', at: ev.at, runId, taskId: p.taskId, declined: { reason: declineReasonOf(p.error), error: p.error } }
        : { engine: from, kind: 'rotated-from', at: ev.at, runId, taskId: p.taskId, rotated: { to: p.to ? { id: p.to } : undefined, reason: p.reason || `handed off by ${p.by || 'a person'}` } };
      return this.append(fact).catch(() => null);
    }
    if (type === 'task.scored') {
      const engine = normalizeEngine(p.engine);
      if (!engine) return null;
      const ok = p.outcome !== 'task.failed';
      return this.append({
        engine, kind: 'call', at: ev.at, runId, taskId: p.taskId, agentId: p.agentId,
        call: { ok, totalMs: p.size?.ms, tokens: p.size?.tokens || undefined, empty: !ok && /no answer|did not answer|returned nothing|empty/i.test(String(p.error || '')) },
        refs: p.refs,
      }).catch(() => null);
    }
    return null;
  }
  /**
   * A rating a person gave an AGENT'S task (scorecard-store.js) lands on the engine that
   * served it too: `chain` is the agent's scorecard, `entry` the rating just appended.
   */
  fromRating(chain, entry) {
    if (!entry?.rating || !Array.isArray(chain)) return null;
    const r = entry.rating;
    const task = r.about != null ? chain.find((e) => e.seq === r.about)
      : entry.taskId ? chain.find((e) => (e.kind === 'task.done' || e.kind === 'task.failed') && e.taskId === entry.taskId && (!entry.runId || e.runId === entry.runId))
        : entry.runId ? (() => { const xs = chain.filter((e) => (e.kind === 'task.done' || e.kind === 'task.failed') && e.runId === entry.runId); return xs.length === 1 ? xs[0] : null; })() : null;
    if (!task?.engine) return null;
    return this.append({ engine: task.engine, kind: 'rating', at: entry.at, runId: task.runId, taskId: task.taskId, agentId: entry.agentId, rating: { by: r.by, score: r.score, jobKind: entry.jobKind, agentId: entry.agentId } }).catch(() => null);
  }
}

export function createEngineLedgerStore(opts) { return new EngineLedgerStore(opts).load(); }
export { DECLINE_REASONS };
