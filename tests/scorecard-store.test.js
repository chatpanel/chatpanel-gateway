// The agents' scorecards on the gateway: chained, attested here, fed by the run store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, webcrypto } from 'node:crypto';
import { createScorecardStore } from '../src/scorecard-store.js';
import { createTeamStore } from '../src/team-store.js';
import { verifyChain } from '../src/scorecard.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-scorecards-'));

test('a run\'s task.scored becomes an attested entry on the member\'s chain; a person\'s rating appends; the chain survives a reload and verifies', async () => {
  const key = randomBytes(32);
  const sc = createScorecardStore({ storePath: join(dir, 'sc.json'), key });
  const teams = createTeamStore({ storePath: join(dir, 'runs.enc'), scorecards: sc });
  teams.create({ id: 'run_sc1', team: 't', request: 'q', client: 'desktop' });
  teams.append('run_sc1', [
    { type: 'run.started', at: Date.now(), team: 't' }, { type: 'plan.ready', at: Date.now(), tasks: [{ id: 't1', role: 'researcher' }] },
    { type: 'task.scored', at: Date.now(), agentId: 'researcher', taskId: 't1', role: 'researcher', model: 'claude', engine: { kind: 'harness', id: 'claude', model: 'opus' }, scm: { repo: '/r', branch: 'cp/p/j', head: 'a1', headAfter: 'b2', commits: 2 }, outcome: 'task.done', size: { ms: 90000, steps: 17, tools: 6, findings: 27, tokens: 0 }, roleKind: 'ic', tools: ['find', 'board'], with: ['budget_checker'], refs: ['run:run_sc1'] },
  ]);
  await sc._queue; // appends are serialised behind the fold
  let card = await sc.get('researcher');
  assert.equal(card.entries.length, 1);
  assert.equal(card.entries[0].kind, 'task.done');
  assert.ok(card.entries[0].sig, 'the store marked it');
  assert.equal(card.verified.ok, true); assert.equal(card.attested.ok, true);
  assert.equal(card.summary.jobsDone, 1); assert.deepEqual(card.summary.workedWith, ['budget_checker']);
  // The engine and the checkout travel with the fact — attested like the rest of it.
  assert.deepEqual(card.entries[0].engine, { kind: 'harness', id: 'claude', model: 'opus' });
  assert.equal(card.entries[0].scm.commits, 2);
  assert.deepEqual(card.summary.scm, { tasks: 1, commits: 2, prs: 0, merged: 0 });
  // A person rates the work.
  await sc.append({ agentId: 'researcher', kind: 'rating', runId: 'run_sc1', rating: { by: 'person', score: 0.9, note: 'thorough' } });
  // The file is what survives; a fresh store reads it back and it still verifies with the same key.
  const again = createScorecardStore({ storePath: join(dir, 'sc.json'), key });
  card = await again.get('researcher');
  assert.equal(card.entries.length, 2);
  assert.equal(card.summary.rating.avg, 0.9);
  assert.deepEqual(card.summary.byEngine.map((r) => [r.key, r.tasks, r.rating.avg]), [['harness:claude/opus', 1, 0.9]], 'the rating followed its task to the engine');
  assert.equal(card.verified.ok, true); assert.equal(card.attested.ok, true);
  // Another install's key does not attest this chain; the chain itself still holds.
  const other = createScorecardStore({ storePath: join(dir, 'sc.json'), key: randomBytes(32) });
  const seen = await other.get('researcher');
  assert.equal(seen.attested.ok, false); assert.equal(seen.verified.ok, true);
  // A tampered file: the chain says where.
  const doc = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'sc.json'), 'utf8'));
  doc.chains.researcher[0].size.findings = 999;
  (await import('node:fs')).writeFileSync(join(dir, 'sc.json'), JSON.stringify(doc));
  const tampered = createScorecardStore({ storePath: join(dir, 'sc.json'), key });
  const t = await tampered.get('researcher');
  assert.equal(t.verified.ok, false); assert.equal(t.verified.at, 0);
  assert.equal((await verifyChain(t.entries, { subtle: webcrypto.subtle })).why, 'hash');
  assert.equal(sc.list()[0].agentId, 'researcher');
});
