// Recruiting on the gateway — the pool, the cards and the roster THIS machine knows, handed
// to the shared recruiter (recruit.js, vendored) for one job.
//
// The pool is the shared `agents` prefs section; each agent's record is its attested
// scorecard chain (scorecard-store.js); each engine's card is its attested ledger
// (engine-ledger-store.js); the roster is the gateway's own model list — every destination it
// routes to, with the bridge's word on which agents are installed. None of that is the
// client's to claim: a client asks for the applications and posts the evaluator's answer, and
// the gateway recomputes the fit before it records a pick. The gateway makes no model call of
// its own here — the evaluator is the client's structured call (`runStructured`), and when no
// client makes one the fit decides, so a job is recruitable from a curl.

import { summarize } from './scorecard.js';
import { applications, evaluatorPrompt, parseEvaluation, decide, recruitEvents, engineRows, MIN_FIT } from './recruit.js';
import { aggregateModelsAsync, listDestinations } from './router.js';

const REACH = new Set(['device', 'trusted', 'any']);

/** Where a destination's model runs, typed from its address — never learned. */
function reachOfDestination(d) {
  if (!d || d.type === 'agent') return 'trusted';
  const url = String(d.baseUrl || '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url)) return 'device';
  if (/^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/]+\.local(:|\/|$))/i.test(url)) return 'trusted';
  return 'any';
}

/**
 * The roster as engine rows: the gateway's model list (`aggregateModelsAsync`) with each
 * engine's card applied. A bridge agent is a harness; an API model's reach is its
 * destination's; `available` is the bridge's word for agents (absent = unknown, taken as
 * usable) and `configured` for API destinations. Quality is the card's when observed —
 * the gateway does not vendor the router's name-based guess, so an unrated engine is the
 * 0.5 prior and the recruiter's reasons say so.
 */
export async function rosterRows(cfg, engines, { jobKind = null, minCalls, timeoutMs = 2500 } = {}) {
  const models = await aggregateModelsAsync(cfg, { timeoutMs }).catch(() => ({ data: [] }));
  const dests = new Map(listDestinations(cfg).map((d) => [d.id, d]));
  const candidates = (models.data || []).map((m) => {
    const agent = m.owned_by === 'chatpanel-bridge';
    const d = dests.get(m.provider);
    return {
      id: m.id, model: m.id, kind: agent ? 'bridge' : 'api', label: m.model ? `${m.provider} · ${m.model}` : m.id,
      reach: agent ? 'trusted' : reachOfDestination(d),
      capabilities: ['tools'],
      available: m.configured === false ? false : (m.available !== false),
    };
  });
  const cards = Object.fromEntries((engines?.list?.({ minCalls }) || []).map((c) => [c.key, c]));
  return engineRows(candidates, { cards, minCalls, jobKind });
}

/** The pool: the shared `agents` section, enabled cards only. */
export function poolFrom(prefsStore) {
  const v = prefsStore?.get?.('agents')?.agents?.value;
  return (Array.isArray(v) ? v : []).filter((a) => a && a.id && a.enabled !== false);
}

/** Every applicant's card, from the attested chains. */
export function summariesFrom(scorecards, pool) {
  const out = {};
  for (const a of pool) { const chain = scorecards?.chains?.get?.(a.id); if (chain?.length) out[a.id] = summarize(chain); }
  return out;
}

/**
 * The applications for a job as this gateway sees them, plus the evaluator's prompt a client
 * runs through its structured layer. `reach` is the project's privacy ceiling, the client's
 * to state (default `any`).
 */
export async function applicationsFor(job, { cfg, prefsStore, scorecards, engines, reach = 'any', chatModel = null, now = Date.now() } = {}) {
  const pool = poolFrom(prefsStore);
  const rows = await rosterRows(cfg, engines);
  const summaries = summariesFrom(scorecards, pool);
  const r = REACH.has(reach) ? reach : 'any';
  const apps = applications(job, pool, { summaries, rows, reach: r, chatModel, now });
  return { applications: apps, prompt: evaluatorPrompt(job, apps, pool, { rows }), rows: rows.map((x) => ({ key: x.key, label: x.label, reach: x.reach, quality: x.quality, costPer1k: x.costPer1k, latencyMs: x.latencyMs, available: x.available, observed: x.observed })), poolSize: pool.length };
}

/**
 * One recruiting pass: recompute the applications (never trust a posted fit), read the
 * client's evaluation when it sent one (`evaluation` parsed, or `text` raw — the schema
 * reads it), decide, and return the events for the project record. The caller appends them.
 */
export async function recruitPass(job, { cfg, prefsStore, scorecards, engines, record = null, reach = 'any', chatModel = null, evaluation = null, text = null, by = 'evaluator', minFit = MIN_FIT, now = Date.now() } = {}) {
  const { applications: apps, prompt } = await applicationsFor(job, { cfg, prefsStore, scorecards, engines, reach, chatModel, now });
  let ev = null;
  if (text != null) ev = parseEvaluation(String(text), apps);
  else if (evaluation && typeof evaluation === 'object') ev = parseEvaluation(JSON.stringify({ pick: evaluation.pick, why: evaluation.why, confidence: evaluation.confidence, proposalName: evaluation.proposal?.name, proposalPurpose: evaluation.proposal?.purpose, proposalSkills: evaluation.proposal?.skills, proposalGrants: evaluation.proposal?.grants }), apps);
  const decision = decide(job, apps, { evaluation: ev, minFit });
  const events = recruitEvents(job, apps, decision, { by: decision.by === 'evaluator' ? by : 'fit', at: now, record });
  return { applications: apps, evaluation: ev, decision, events, prompt };
}
