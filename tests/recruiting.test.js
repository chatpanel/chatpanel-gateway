// Recruiting on the gateway: the pool from the shared section, the roster from the gateway's
// own model list with the engine cards over it, the applications computed here, the client's
// evaluation read through the schema, the pass landed on the project record through the
// store's own moves — and with no evaluation the fit decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createProjectStore } from '../src/project-store.js';
import { rosterRows, poolFrom, applicationsFor, recruitPass } from '../src/recruiting.js';
import { createGateway } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-recruit-'));
// A config with no bridge to ask (a closed port answers fast) and two API destinations —
// one on this machine, one remote.
const cfg = {
  backend: 'api', maxBodyBytes: 1e6, bridge: { url: 'http://127.0.0.1:9', token: 'x' },
  destinations: [
    { id: 'local', type: 'api', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', models: ['qwen3-8b'], hasKey: true },
    { id: 'cloud', type: 'api', protocol: 'openai', baseUrl: 'https://api.example.com/v1', models: ['big-model'], apiKey: 'k' },
  ],
};
const prefsStore = { get: (id) => (id === 'agents' ? { agents: { value: [
  { id: 'researcher', name: 'Researcher', prompt: 'Research.', skills: ['research'], grants: ['web', 'data'], engine: { kind: 'auto', policy: { prefer: 'cheapest-that-clears' } }, appliesTo: ['jobs'], enabled: true },
  { id: 'analyst', name: 'Analyst', prompt: 'Analyse.', skills: ['research'], grants: ['web'], engine: { kind: 'auto', policy: { prefer: 'best-quality' } }, appliesTo: ['jobs'], enabled: true },
  { id: 'retired', name: 'Retired', prompt: 'r', skills: ['research'], grants: ['web'], appliesTo: ['jobs'], enabled: false },
  { id: 'implementer', name: 'Implementer', prompt: 'Build.', skills: ['coding'], grants: ['shell', 'fs:write'], engine: 'harness:claude', appliesTo: ['jobs'], enabled: true },
] } } : {}) };
const scorecards = { chains: new Map([['analyst', [
  { seq: 0, agentId: 'analyst', kind: 'task.done', engine: { kind: 'model', id: 'big-model' }, size: { steps: 5, tokens: 2000 }, runId: 'r1', taskId: 't1', roleKind: 'ic' },
  { seq: 1, agentId: 'analyst', kind: 'rating', runId: 'r1', taskId: 't1', rating: { by: 'person', score: 0.9 } },
]]]) };
const engines = { list: () => [{ key: 'model:big-model', quality: { overall: { avg: 0.8, count: 9 }, byJobKind: {} }, latency: { ttft: { p50: 600, n: 9 } }, cost: { perTask: 0.02 }, availability: { rate: 1, decliningNow: false }, capabilities: { withdrawn: [] } }] };

test('the roster is the gateway\'s model list as engine rows: agents are harnesses, reach is typed from the address, the card is observed', async () => {
  const rows = await rosterRows(cfg, engines, { timeoutMs: 300 });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey['model:qwen3-8b'].reach, 'device'); assert.equal(byKey['model:qwen3-8b'].quality, null, 'unrated: the prior applies');
  assert.equal(byKey['model:big-model'].reach, 'any'); assert.equal(byKey['model:big-model'].quality, 0.8); assert.deepEqual(byKey['model:big-model'].observed, ['quality', 'latencyMs']);
  const harness = rows.filter((r) => r.engine.kind === 'harness');
  assert.ok(harness.length >= 1, 'the known agents are on the routing table even when the bridge is not there to say which are installed');
  assert.equal(harness[0].reach, 'trusted');
  assert.equal(poolFrom(prefsStore).length, 3, 'a disabled card is not in the pool');
});

test('applications are computed here and the evaluator\'s prompt is the client\'s to run; the pass lands through the store', async () => {
  const store = createProjectStore({ storePath: join(dir, 'p.enc'), key: randomBytes(32), now: () => 1000 });
  store.create({ id: 'utah', project: { id: 'utah', title: 'Utah', goal: 'g', status: 'open', budget: { tokens: 50000 } } });
  store.postJob('utah', { id: 'research', title: 'Research the parks', brief: 'winter conditions', needs: { skills: ['research'], grants: ['web'] } });
  store.postJob('utah', { id: 'write', title: 'Write it up', brief: 'b', needs: { skills: ['writing'] } });
  const rec = store.get('utah');
  const job = rec.jobs[0];
  const ctx = { cfg, prefsStore, scorecards, engines };
  const out = await applicationsFor(job, ctx);
  assert.deepEqual(out.applications.map((a) => a.agentId), ['analyst', 'researcher', 'implementer'], 'the rated analyst out-fits the fresh researcher');
  assert.equal(out.applications[1].engine.id, 'qwen3-8b', 'cheapest that clears: the local model');
  assert.equal(out.applications[0].engine.id, 'big-model', 'best quality: the observed 0.8');
  assert.match(out.applications[0].reasons.join(' '), /rated 90%/);
  assert.match(out.prompt, /You are the evaluator/); assert.equal(out.poolSize, 3);
  // A device-only project: the cloud model is out; the analyst still clears on the local one.
  const dev = await applicationsFor(job, { ...ctx, reach: 'device' });
  assert.equal(dev.applications[0].engine.id, 'qwen3-8b');
  // The client's evaluation, read through the schema; the fit is recomputed, not trusted.
  const pass = await recruitPass(job, { ...ctx, record: rec, evaluation: { pick: 'analyst', why: 'the brief wants a comparison', confidence: 0.7 } });
  assert.equal(pass.decision.kind, 'recruit'); assert.equal(pass.decision.agentId, 'analyst'); assert.equal(pass.decision.by, 'evaluator');
  assert.equal(pass.events[1].job.recruited.engine.id, 'big-model');
  assert.deepEqual(pass.events[1].job.recruited.budget, { tokens: 25000 }, 'half of what is left, two jobs waiting');
  let project = null;
  for (const e of pass.events) project = e.type === 'job.updated' ? store.updateJob('utah', 'research', e.job, { by: e.by }) : store.append('utah', [e]);
  assert.equal(project.jobs[0].status, 'recruited'); assert.equal(project.status, 'active'); assert.equal(project.jobs[0].applications.length, 3);
  assert.equal(project.jobs[0].applications[0].covers, undefined, 'the live flag stays off the record');
  // Raw text from a model that answered in prose around JSON.
  const raw = await recruitPass(job, { ...ctx, record: rec, text: 'Sure: {"pick":"researcher","why":"cheapest"}' });
  assert.equal(raw.decision.agentId, 'researcher');
  // No evaluation: the fit decides. No one fits: back to open with a proposal.
  const fitOnly = await recruitPass(job, { ...ctx, record: rec });
  assert.equal(fitOnly.decision.by, 'fit'); assert.equal(fitOnly.decision.agentId, 'analyst');
  const none = await recruitPass(rec.jobs[1], { ...ctx, record: rec });
  assert.equal(none.decision.kind, 'none'); assert.match(none.decision.why, /no applicant has a skill the job names \(writing\)/);
  assert.equal(none.events.at(-1).type, 'project.decision'); assert.equal(none.events.at(-1).kind, 'proposal');
  for (const e of none.events) project = e.type === 'job.updated' ? store.updateJob('utah', 'write', e.job, { by: e.by }) : store.append('utah', [e]);
  assert.equal(project.jobs[1].status, 'open'); assert.equal(project.decisions.at(-1).kind, 'proposal');
});

test('the routes: applications for a job, then recruit — the fit decides when no evaluation is posted; a recruited job is not recruited twice', async () => {
  const gw = createGateway({ host: '127.0.0.1', port: 0, backend: 'api', bridge: { url: 'http://127.0.0.1:9', token: 't' }, destinations: cfg.destinations, upstreams: { openai: {}, anthropic: {} }, redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true }, ner: { autostart: false }, logRequests: false });
  const port = await new Promise((r) => gw.listen(0, '127.0.0.1', () => r(gw.address().port)));
  const base = `http://127.0.0.1:${port}`;
  const H = { 'content-type': 'application/json', origin: 'chrome-extension://test' };
  try {
    // The pool is the shared section.
    const put = await (await fetch(`${base}/v1/prefs`, { method: 'PUT', headers: H, body: JSON.stringify({ sections: { agents: { value: prefsStore.get('agents').agents.value, updatedAt: Date.now() } }, by: 'test' }) })).json();
    assert.equal(put.ok, true, JSON.stringify(put));
    const id = `rec_${Date.now().toString(36)}`;
    await fetch(`${base}/v1/projects`, { method: 'POST', headers: H, body: JSON.stringify({ id, project: { id, title: 'T', goal: 'g', status: 'open', budget: { tokens: 1000 } } }) });
    await fetch(`${base}/v1/projects/${id}/jobs`, { method: 'POST', headers: H, body: JSON.stringify({ job: { id: 'research', title: 'Research', brief: 'b', needs: { skills: ['research'], grants: ['web'] } } }) });
    assert.equal((await fetch(`${base}/v1/projects/${id}/jobs/research/applications`)).status, 403, 'admin only');
    const apps = await (await fetch(`${base}/v1/projects/${id}/jobs/research/applications?reach=device`, { headers: H })).json();
    assert.equal(apps.ok, true, JSON.stringify(apps));
    assert.deepEqual(apps.applications.map((a) => a.agentId), ['researcher', 'analyst', 'implementer']);
    assert.equal(apps.applications[0].engine.id, 'qwen3-8b'); assert.match(apps.prompt, /"pick"/);
    const missing = await fetch(`${base}/v1/projects/${id}/jobs/nope/applications`, { headers: H });
    assert.equal(missing.status, 404);
    const rec = await (await fetch(`${base}/v1/projects/${id}/jobs/research/recruit`, { method: 'POST', headers: H, body: JSON.stringify({ reach: 'device', by: 'test' }) })).json();
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.equal(rec.decision.by, 'fit'); assert.equal(rec.decision.agentId, 'researcher');
    assert.equal(rec.project.jobs[0].status, 'recruited'); assert.deepEqual(rec.project.jobs[0].recruited.budget, { tokens: 1000 }); assert.equal(rec.project.status, 'active');
    const twice = await fetch(`${base}/v1/projects/${id}/jobs/research/recruit`, { method: 'POST', headers: H, body: JSON.stringify({}) });
    assert.equal(twice.status, 400);
    assert.match((await twice.json()).error.message, /is recruited/);
  } finally { await new Promise((r) => gw.close(r)); }
});
