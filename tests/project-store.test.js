// The projects on the gateway: a page opens a record; jobs post and move along their
// machine; runs link and spend; the job board lists open postings across projects; a live
// tail sees each event; the record survives a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createProjectStore } from '../src/project-store.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-projects-'));

test('a project record: page, jobs, runs, spend, the board, persistence', () => {
  const key = randomBytes(32);
  const s = createProjectStore({ storePath: join(dir, 'p.enc'), key, now: () => 1000 });
  const page = { id: 'utah', title: 'Utah trip', goal: 'a 5-day plan under $4,000', doneWhen: 'itinerary + budget approved', budget: { tokens: 100000 }, status: 'draft' };
  const p = s.create({ id: 'utah', project: page });
  assert.equal(p.page.title, 'Utah trip'); assert.equal(p.status, 'draft');
  assert.equal(s.create({ id: 'utah' }).id, 'utah', 'idempotent');
  const posted = s.postJob('utah', { id: 'research', title: 'Research the parks', brief: 'winter conditions, lodging', needs: { skills: ['research'], grants: ['web'] }, budget: { tokens: 20000 } }, { by: 'executive' });
  assert.equal(posted.jobs.length, 1); assert.equal(posted.status, 'open');
  assert.throws(() => s.postJob('utah', { id: 'research', title: 'x', brief: 'y' }), /already exists/);
  assert.throws(() => s.postJob('utah', { id: 'bad', title: 'x', brief: 'y', needs: { grants: ['page'] } }), /not grantable/);
  assert.throws(() => s.updateJob('utah', 'research', { status: 'done' }), /cannot go from open to done/);
  const rec = s.updateJob('utah', 'research', { status: 'recruited', recruited: { agentId: 'researcher', by: 'evaluator', budget: { tokens: 20000 } } });
  assert.equal(rec.status, 'active'); assert.equal(rec.jobs[0].recruited.agentId, 'researcher');
  assert.deepEqual(s.openJobs().map((j) => [j.id, j.projectTitle]), [['research', 'Utah trip']]);
  s.append('utah', [{ type: 'run.linked', runId: 'r1', jobId: 'research' }, { type: 'run.spent', runId: 'r1', spent: { tokens: 1500 } }]);
  const after = s.updateJob('utah', 'research', { status: 'in-progress' });
  const done = s.updateJob('utah', 'research', { status: 'done', result: { text: 'found it', by: 'researcher' } });
  assert.equal(done.progress.done, 1); assert.equal(done.spend.tokens, 1500); assert.equal(done.progress.budgetUsed, 0.015);
  assert.deepEqual(s.openJobs(), [], 'a done job is off the board');
  assert.equal(s.list()[0].jobCount, 1); assert.equal(s.list()[0].jobs, undefined, 'the list counts jobs, it does not carry them');
  // Reload from disk.
  const again = createProjectStore({ storePath: join(dir, 'p.enc'), key });
  const back = again.get('utah', { events: true });
  assert.equal(back.jobs[0].status, 'done'); assert.equal(back.events.length, 7, 'created, posted, recruited, linked, spent, in-progress, done');
  // A watcher sees each event.
  const seen = [];
  const off = again.watch('utah', (ev) => seen.push(ev.type));
  again.append('utah', [{ type: 'project.decision', by: 'person', kind: 'note', text: 'good' }]);
  off();
  assert.deepEqual(seen, ['project.decision']);
});
