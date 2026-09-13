// The board every client can read: appended by the client that runs a team, replayed and
// tailed by any other, stoppable from either side, honest about a writer that went quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { TeamStore, applyEvent } from '../src/team-store.js';
import { createGateway } from '../src/server.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const dir = mkdtempSync(join(tmpdir(), 'cp-teams-'));
let t = 1000;
const store = () => new TeamStore({ storePath: join(dir, `runs-${Math.random()}.enc`), now: () => t, staleAfterMs: 500 }).load();

test('a run is the fold of its events: plan → tasks → findings → proposal, and it survives a reload', () => {
  const s = store();
  s.create({ id: 'run_1', client: 'desktop', team: 'research', request: 'compare A and B' });
  s.append('run_1', [
    { type: 'run.started', at: 1, team: 'research', request: 'compare A and B', budget: { tokens: 100 }, roles: ['r', 'w'] },
    { type: 'plan.ready', at: 2, by: 'fixed', tasks: [{ id: 't_r', role: 'r', title: 'R' }, { id: 't_w', role: 'w', title: 'W', dependsOn: ['t_r'] }] },
    { type: 'task.started', at: 3, taskId: 't_r', role: 'r' },
    { type: 'task.finding', at: 4, taskId: 't_r', role: 'r', finding: { id: 't_r:1', kind: 'claim', text: 'A costs 10', refs: ['note:1'], role: 'r', taskId: 't_r' } },
    { type: 'task.done', at: 5, taskId: 't_r', status: 'ok', ms: 2 },
  ]);
  const v = s.get('run_1');
  assert.equal(v.status, 'running');
  assert.deepEqual(v.tasks.map((x) => [x.id, x.status, x.findings]), [['t_r', 'ok', 1], ['t_w', 'pending', 0]]);
  assert.equal(v.board[0].text, 'A costs 10');
  assert.equal(v.events, undefined, 'the view is the record, not the log');
  assert.equal(s.get('run_1', { events: true }).events.length, 5);
  s.append('run_1', [{ type: 'run.done', at: 9, status: 'completed', usage: { spent: { tokens: 40 } }, proposal: { kind: 'answer', text: 'A is cheaper' } }]);
  const again = new TeamStore({ storePath: s.path, now: () => t }).load();
  const r = again.get('run_1');
  assert.equal(r.status, 'completed');
  assert.equal(r.proposal.text, 'A is cheaper');
  assert.equal(r.usage.spent.tokens, 40);
  assert.equal(again.list()[0].findings, 1);
  assert.equal(again.list()[0].board, undefined, 'the list carries no boards');
});

test('a late reader replays from where it was; a live one tails; stop is an event the runner sees', () => {
  const s = store();
  s.create({ id: 'run_2', client: 'desktop', team: 't' });
  s.append('run_2', [{ type: 'run.started', at: 1 }, { type: 'plan.ready', at: 2, tasks: [{ id: 'a', role: 'r' }] }]);
  assert.deepEqual(s.eventsSince('run_2', 0).map((e) => e.type), ['plan.ready']);
  const seen = [];
  const off = s.watch('run_2', (ev) => seen.push(ev.type));
  s.stop('run_2');
  assert.deepEqual(seen, ['run.stop-requested']);
  assert.equal(s.get('run_2').stopRequested, 1000);
  off();
  s.append('run_2', [{ type: 'run.done', at: 3, status: 'stopped' }]);
  assert.deepEqual(seen, ['run.stop-requested'], 'unwatched');
  assert.equal(s.stop('run_2').status, 'stopped', 'stopping a finished run changes nothing');
});

test('a running run whose writer went quiet is reported stale; the newest runs are kept', () => {
  const s = store();
  s.create({ id: 'run_3', team: 't' });
  s.append('run_3', [{ type: 'run.started', at: t }, { type: 'plan.ready', at: t, tasks: [] }]);
  assert.equal(s.get('run_3').stale, false);
  t += 600;
  assert.equal(s.get('run_3').stale, true);
  assert.equal(s.list()[0].stale, true);
  assert.throws(() => s.create({ id: 'x' }), /run id/);
  assert.throws(() => s.append('nope', []), /no run/);
  assert.equal(applyEvent({ tasks: [], board: [] }, { type: 'weird', at: 1, payload: {} }).lastEventAt, 1);
});

// ONE gateway for the route tests: createGateway seeds the warm index from the user's real
// backup at startup, which is seconds, not milliseconds — paying it once is the difference
// between a suite and a wait.
let shared = null;
async function gateway() {
  if (shared) return shared;
  const gw = createGateway({ host: '127.0.0.1', port: 0, backend: 'bridge', bridge: { url: 'http://127.0.0.1:1', agent: 'codex', token: 't' }, upstreams: { openai: {}, anthropic: {} }, redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true }, ner: { autostart: false }, logRequests: false });
  const port = await listen(gw);
  shared = { gw, base: `http://127.0.0.1:${port}` };
  return shared;
}
const H = { 'content-type': 'application/json', origin: 'chrome-extension://test' };
const sse = (res) => {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const got = [];
  const pump = (async () => { let buf = ''; for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); if (f.startsWith('data:')) got.push(JSON.parse(f.slice(5))); } } })().catch(() => {});
  const until = async (n) => { for (let i = 0; i < 80 && got.length < n; i += 1) await new Promise((r) => setTimeout(r, 25)); return got; };
  return { got, until, close: async () => { reader.cancel().catch(() => {}); await pump; } };
};

test('the routes: create, append, read, tail live over SSE, stop from another client', async () => {
  const { base } = await gateway();
  const noAuth = await fetch(`${base}/v1/teams/runs`);
  assert.equal(noAuth.status, 403, 'a drive-by page does not read boards');
  const id = `run_http_${Date.now().toString(36)}`;
  const created = await (await fetch(`${base}/v1/teams/runs`, { method: 'POST', headers: H, body: JSON.stringify({ id, team: 'research', request: 'q', client: 'desktop' }) })).json();
  assert.equal(created.ok, true, JSON.stringify(created));
  // A second client tails the run live, from the start: the record first (hello), then events.
  const tail = sse(await fetch(`${base}/v1/teams/runs/${id}/events`, { headers: H }));
  await tail.until(1);
  assert.equal(tail.got[0].type, 'hello');
  assert.equal(tail.got[0].payload.run.id, id);
  await (await fetch(`${base}/v1/teams/runs/${id}/events`, { method: 'POST', headers: H, body: JSON.stringify({ events: [{ type: 'run.started', at: 1, team: 'research' }, { type: 'plan.ready', at: 2, tasks: [{ id: 'a', role: 'r' }] }, { type: 'task.finding', at: 3, taskId: 'a', finding: { text: 'found it', kind: 'claim', role: 'r', taskId: 'a' } }] }) })).json();
  await tail.until(4);
  assert.deepEqual(tail.got.slice(1).map((e) => e.type), ['run.started', 'plan.ready', 'task.finding']);
  // A reader that joins late replays from where it was.
  const late = sse(await fetch(`${base}/v1/teams/runs/${id}/events?after=1`, { headers: H }));
  await late.until(2);
  assert.deepEqual(late.got.map((e) => e.type), ['hello', 'task.finding']);
  await late.close();
  // The extension presses Stop; the runner (tailing) sees it.
  const stopped = await (await fetch(`${base}/v1/teams/runs/${id}/stop`, { method: 'POST', headers: H })).json();
  assert.equal(stopped.run.stopRequested > 0, true);
  await tail.until(5);
  assert.equal(tail.got[4].type, 'run.stop-requested');
  const read = await (await fetch(`${base}/v1/teams/runs/${id}`, { headers: H })).json();
  assert.equal(read.run.board[0].text, 'found it');
  const list = await (await fetch(`${base}/v1/teams/runs?limit=5`, { headers: H })).json();
  assert.equal(list.runs[0].id, id);
  await tail.close();
  await fetch(`${base}/v1/teams/runs/${id}`, { method: 'DELETE', headers: H });
});

test('the board: threads and posts fold on the record; a person answers an ask from another client and the runner\'s tail sees it; decisions land', async () => {
  const { base } = await gateway();
  const id = `run_board_${Date.now().toString(36)}`;
  await (await fetch(`${base}/v1/teams/runs`, { method: 'POST', headers: H, body: JSON.stringify({ id, team: 'travel', request: 'trip', client: 'desktop' }) })).json();
  const tail = sse(await fetch(`${base}/v1/teams/runs/${id}/events`, { headers: H }));
  await tail.until(1);
  // The running client's runner opens a task thread, a member posts a finding, then asks.
  await (await fetch(`${base}/v1/teams/runs/${id}/events`, { method: 'POST', headers: H, body: JSON.stringify({ events: [
    { type: 'run.started', at: 1, team: 'travel' }, { type: 'plan.ready', at: 2, tasks: [{ id: 't1', role: 'researcher' }] },
    { type: 'board.thread', at: 2, thread: { id: 'th1', kind: 'task', taskId: 't1', title: 'Find facts', by: 'runner', status: 'open', at: 2, posts: 0 } },
    { type: 'board.post', at: 3, post: { id: 'p1', threadId: 'th1', by: 'researcher', kind: 'finding', text: 'Rooms $260', refs: [], replyTo: null, status: 'open', at: 3, finding: { kind: 'claim' } } },
    { type: 'board.thread', at: 4, thread: { id: 'ask1', kind: 'ask', taskId: 't1', title: 'Which week?', by: 'researcher', status: 'waiting', at: 4, posts: 0, ask: { type: 'info', options: ['Feb 13–17'] } } },
    { type: 'board.post', at: 4, post: { id: 'q1', threadId: 'ask1', by: 'researcher', kind: 'question', text: 'Which week?', refs: [], replyTo: null, status: 'open', at: 4 } },
    { type: 'task.waiting', at: 4, taskId: 't1', role: 'researcher', threadId: 'ask1', text: 'Which week?' },
  ] }) })).json();
  const rec = await (await fetch(`${base}/v1/teams/runs/${id}`, { headers: H })).json();
  assert.equal(rec.run.threads.threads.length, 2);
  assert.equal(rec.run.threads.posts.length, 2);
  assert.equal(rec.run.tasks[0].status, 'waiting');
  const list = await (await fetch(`${base}/v1/teams/runs?limit=5`, { headers: H })).json();
  assert.equal(list.runs.find((r) => r.id === id).waiting, 1, 'the list says an ask is waiting');
  // The OTHER client answers.
  const bad = await fetch(`${base}/v1/teams/runs/${id}/answer`, { method: 'POST', headers: H, body: JSON.stringify({ threadId: 'th1', text: 'x' }) });
  assert.equal(bad.status, 400, 'only an ask thread takes an answer');
  const ans = await (await fetch(`${base}/v1/teams/runs/${id}/answer`, { method: 'POST', headers: H, body: JSON.stringify({ threadId: 'ask1', text: 'Feb 13–17', by: 'person' }) })).json();
  assert.equal(ans.ok, true, JSON.stringify(ans));
  const askThread = ans.run.threads.threads.find((t) => t.id === 'ask1');
  assert.equal(askThread.status, 'resolved');
  const answerPost = ans.run.threads.posts.find((x) => x.kind === 'answer');
  assert.equal(answerPost.text, 'Feb 13–17');
  // The runner, tailing its own run, receives the answer post and the thread's status.
  await tail.until(9);
  const types = tail.got.map((e) => e.type);
  assert.ok(types.includes('board.post') && types.at(-1) === 'board.thread-status', types.join(' '));
  assert.equal(tail.got.find((e) => e.type === 'board.post' && e.payload.post.kind === 'answer').payload.post.id, answerPost.id);
  // The runner's own echo of the same answer lands once.
  await (await fetch(`${base}/v1/teams/runs/${id}/events`, { method: 'POST', headers: H, body: JSON.stringify({ events: [{ type: 'board.post', at: 6, post: answerPost }] }) })).json();
  const again = await (await fetch(`${base}/v1/teams/runs/${id}`, { headers: H })).json();
  assert.equal(again.run.threads.posts.filter((x) => x.kind === 'answer').length, 1);
  // A decision on the finding, from either client.
  const dec = await (await fetch(`${base}/v1/teams/runs/${id}/decide`, { method: 'POST', headers: H, body: JSON.stringify({ postId: 'p1', status: 'approved' }) })).json();
  assert.equal(dec.run.threads.posts.find((x) => x.id === 'p1').status, 'approved');
  const note = await (await fetch(`${base}/v1/teams/runs/${id}/post`, { method: 'POST', headers: H, body: JSON.stringify({ threadId: 'th1', text: 'use $160', replyTo: 'p1' }) })).json();
  assert.equal(note.run.threads.posts.at(-1).replyTo, 'p1');
  await tail.close();
  await fetch(`${base}/v1/teams/runs/${id}`, { method: 'DELETE', headers: H });
});

test('prefs changes are pushed to a live subscriber', async () => {
  const { base } = await gateway();
  const sub = sse(await fetch(`${base}/v1/prefs/events`, { headers: H }));
  await sub.until(1);
  assert.equal(sub.got[0].type, 'hello');
  const section = `teams_test_${Date.now().toString(36)}`;
  await fetch(`${base}/v1/prefs`, { method: 'POST', headers: H, body: JSON.stringify({ sections: { [section]: { value: [{ name: 'research' }], updatedAt: Date.now() } }, by: 'desktop' }) });
  await sub.until(2);
  assert.equal(sub.got[1].type, 'changed');
  assert.deepEqual(sub.got[1].applied, [section]);
  assert.equal(sub.got[1].by, 'desktop');
  await sub.close();
  await fetch(`${base}/v1/prefs?section=${section}`, { method: 'DELETE', headers: H });
});

test.after(() => { if (shared) { shared.gw.closeAllConnections?.(); shared.gw.close(); } });

test('a task\'s transcript is on the record; a run whose client died is resumable from its checkpoint; a hand-off from another client reaches the runner\'s tail', async () => {
  const { base } = await gateway();
  const id = `run_task_${Date.now().toString(36)}`;
  await (await fetch(`${base}/v1/teams/runs`, { method: 'POST', headers: H, body: JSON.stringify({ id, team: 'travel', request: 'trip', client: 'desktop' }) })).json();
  const tail = sse(await fetch(`${base}/v1/teams/runs/${id}/events`, { headers: H }));
  await tail.until(1);
  await (await fetch(`${base}/v1/teams/runs/${id}/events`, { method: 'POST', headers: H, body: JSON.stringify({ events: [
    { type: 'run.started', at: Date.now(), team: 'travel' }, { type: 'plan.ready', at: Date.now(), tasks: [{ id: 't1', role: 'researcher', title: 'Find facts' }] },
    { type: 'task.started', at: Date.now(), taskId: 't1', role: 'researcher' },
    { type: 'task.model', at: Date.now(), taskId: 't1', role: 'researcher', model: 'claude', attempt: 1 },
    { type: 'task.step', at: Date.now(), taskId: 't1', role: 'researcher', steps: [{ role: 'user', content: 'Find facts' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'Feb 15–19' }] },
  ] }) })).json();
  const rec = await (await fetch(`${base}/v1/teams/runs/${id}`, { headers: H })).json();
  assert.equal(rec.run.tasks[0].transcript.length, 3, 'the task\'s conversation is on the record');
  assert.equal(rec.run.tasks[0].model, 'claude');
  assert.equal(rec.run.resumable, false, 'its client is live on it');
  // The list hides transcripts.
  const list = await (await fetch(`${base}/v1/teams/runs?limit=5`, { headers: H })).json();
  assert.equal(list.runs.find((r) => r.id === id).tasks[0].transcript, undefined);
  // A person hands the task to another model from the extension; the running client's tail sees it.
  const ho = await (await fetch(`${base}/v1/teams/runs/${id}/handoff`, { method: 'POST', headers: H, body: JSON.stringify({ taskId: 't1', model: 'opus', reason: 'claude is slow' }) })).json();
  assert.equal(ho.ok, true, JSON.stringify(ho));
  await tail.until(7);
  const req = tail.got.find((e) => e.type === 'task.handoff-requested');
  assert.deepEqual([req.payload.taskId, req.payload.model, req.payload.by], ['t1', 'opus', 'person']);
  // The process dies: no run.done ever arrives. The checkpoint is still buildable from the record.
  const cp = await (await fetch(`${base}/v1/teams/runs/${id}/checkpoint`, { headers: H })).json();
  assert.equal(cp.ok, true);
  assert.equal(cp.checkpoint.tasks[0].status, 'stopped');
  assert.equal(cp.checkpoint.tasks[0].transcript.length, 3);
  // Another client claims it; its client name moves.
  const claimed = await (await fetch(`${base}/v1/teams/runs/${id}/claim`, { method: 'POST', headers: H, body: JSON.stringify({ client: 'extension' }) })).json();
  assert.equal(claimed.run.client, 'extension');
  await tail.close();
  await fetch(`${base}/v1/teams/runs/${id}`, { method: 'DELETE', headers: H });
});
