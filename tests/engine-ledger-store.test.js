// The engines' ledgers on the gateway: fed by the run store's fold, attested here, read as cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEngineLedgerStore, declineReasonOf } from '../src/engine-ledger-store.js';
import { createScorecardStore } from '../src/scorecard-store.js';
import { createTeamStore } from '../src/team-store.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-engines-'));

test('a run\'s routed → reappointed → scored becomes a decline on the first engine and a call on the second; a rating on the task lands on the engine too', async () => {
  const key = randomBytes(32);
  const engines = createEngineLedgerStore({ storePath: join(dir, 'engines.json'), key });
  const sc = createScorecardStore({ storePath: join(dir, 'sc.json'), key });
  const teams = createTeamStore({ storePath: join(dir, 'runs.enc'), scorecards: sc, engines });
  teams.create({ id: 'run_e1', team: 't', request: 'q', client: 'desktop' });
  const t = Date.now();
  teams.append('run_e1', [
    { type: 'run.started', at: t, team: 't' }, { type: 'plan.ready', at: t, tasks: [{ id: 't1', role: 'r' }] },
    { type: 'task.routed', at: t, taskId: 't1', role: 'r', attempt: 1, engine: { kind: 'model', id: 'openrouter', model: 'llama-8b' }, reasons: ['cheapest'], alternatives: [] },
    { type: 'task.reappointed', at: t + 1, taskId: 't1', role: 'r', model: 'sonnet', after: ['llama-8b'], error: '429 rate limited' },
    { type: 'task.routed', at: t + 1, taskId: 't1', role: 'r', attempt: 2, engine: { kind: 'model', id: 'anthropic', model: 'sonnet' }, reasons: ['after llama-8b'], alternatives: [] },
    { type: 'task.scored', at: t + 5000, agentId: 'r', taskId: 't1', role: 'r', model: 'sonnet', engine: { kind: 'model', id: 'anthropic', model: 'sonnet' }, outcome: 'task.done', size: { ms: 4000, steps: 3, tools: 1, findings: 2, tokens: 1800 }, roleKind: 'ic', tools: ['find'], with: [], refs: ['run:run_e1'] },
  ]);
  await engines._queue; await sc._queue;
  const llama = await engines.get('model:openrouter/llama-8b', { entries: true });
  assert.equal(llama.entries.length, 1); assert.equal(llama.entries[0].kind, 'declined'); assert.equal(llama.entries[0].declined.reason, 'rate');
  assert.ok(llama.entries[0].sig, 'attested'); assert.equal(llama.attested.ok, true); assert.equal(llama.verified.ok, true);
  assert.equal(llama.card.availability.rate, 0);
  const sonnet = await engines.get('model:anthropic/sonnet', { entries: true });
  assert.equal(sonnet.entries[0].kind, 'call'); assert.equal(sonnet.entries[0].call.totalMs, 4000); assert.equal(sonnet.entries[0].call.tokens, 1800);
  assert.equal(sonnet.card.calls, 1); assert.equal(sonnet.card.cost.tokensPerTask, 1800);
  // A person rates the agent's task; the engine that served it gets the verdict too.
  const rating = await sc.append({ agentId: 'r', kind: 'rating', runId: 'run_e1', taskId: 't1', rating: { by: 'person', score: 0.9 } });
  await engines.fromRating(sc.chains.get('r'), { ...rating, jobKind: 'research' });
  const again = createEngineLedgerStore({ storePath: join(dir, 'engines.json'), key });
  const card = (await again.get('model:anthropic/sonnet')).card;
  assert.equal(card.quality.overall.avg, 0.9); assert.equal(card.quality.byJobKind.research.count, 1);
  assert.deepEqual(again.list().map((c) => c.key).sort(), ['model:anthropic/sonnet', 'model:openrouter/llama-8b']);
  // The chains are per engine and verify with the same key after a reload.
  assert.equal((await again.get('model:anthropic/sonnet', { entries: true })).attested.ok, true);
});

test('a host\'s own observation appends as a call; the store refuses a fact without an engine or of an unknown kind', async () => {
  const engines = createEngineLedgerStore({ storePath: join(dir, 'e2.json'), key: randomBytes(32) });
  const e = await engines.append({ engine: { kind: 'harness', id: 'claude' }, kind: 'call', call: { ttftMs: 900, totalMs: 60000, ok: true } });
  assert.equal(e.key, 'harness:claude');
  await assert.rejects(() => engines.append({ kind: 'call' }), /engine required/);
  await assert.rejects(() => engines.append({ engine: { id: 'x' }, kind: 'wish' }), /kind/);
  assert.equal(declineReasonOf('no api key configured'), 'auth');
  assert.equal(declineReasonOf('model_not_found'), 'unavailable');
  assert.equal(declineReasonOf('request timed out'), 'timeout');
  assert.equal(declineReasonOf('insufficient credits'), 'credits');
  assert.equal(declineReasonOf('something odd'), 'other');
});
