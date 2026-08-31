// Sophisticated retrieval, stage 0: BM25 + metadata filters + snippets + paging + graph.
import './isolate-store.js'; // MUST be first — gives this file its own warm store
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/server.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const A = { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'content-type': 'application/json' };
const DAY = 86_400_000;

async function seeded() {
  const gw = createGateway({ host: '127.0.0.1', port: 0, redaction: { tier: 'basic', detection: { backend: 'off' } }, ner: { autostart: false }, logRequests: false });
  const url = 'http://127.0.0.1:' + await listen(gw);
  await fetch(`${url}/v1/history/clear`, { method: 'POST', headers: A, body: '{}' }); // singleton store — normalize
  const now = 1_800_000_000_000;
  await fetch(`${url}/v1/history/ingest`, { method: 'POST', headers: A, body: JSON.stringify({ upserts: [
    { id: 'meeting:1', type: 'meeting', title: 'Zoom Meeting', date: now - DAY, text: 'Ben demo of the tooling roadmap. Decision: ship the observability dashboard.' },
    { id: 'meeting:2', type: 'meeting', title: 'Zoom Meeting', date: now - 40 * DAY, text: 'Old planning about unrelated budget topics.' },
    { id: 'note:3', type: 'note', title: 'Tooling notes', date: now - 2 * DAY, text: 'Follow-ups from the Ben tooling demo: dashboard, roadmap review.' },
  ] }) });
  return { gw, url, now };
}

test('metadata filters: type + since narrow the result set', async () => {
  const { gw, url, now } = await seeded();
  try {
    const r = await (await fetch(`${url}/v1/history/search`, { method: 'POST', headers: A, body: JSON.stringify({ query: 'Ben tooling demo roadmap', type: 'meeting', since: now - 7 * DAY }) })).json();
    const ids = r.results.map((x) => x.id);
    assert.ok(ids.includes('meeting:1'), 'keeps the recent Ben meeting');
    assert.ok(!ids.includes('meeting:2'), 'since excludes the 40-day-old meeting');
    assert.ok(!ids.includes('note:3'), 'type=meeting excludes the note');
  } finally { gw.close(); }
});

test('snippets return the matching excerpt, not the whole body', async () => {
  const { gw, url } = await seeded();
  try {
    const r = await (await fetch(`${url}/v1/history/search`, { method: 'POST', headers: A, body: JSON.stringify({ query: 'observability dashboard' }) })).json();
    const hit = r.results.find((x) => x.id === 'meeting:1');
    assert.ok(hit.snippet && /dashboard/i.test(hit.snippet), 'snippet contains the match');
    assert.ok(hit.snippet.length < 200, 'snippet is a short excerpt');
  } finally { gw.close(); }
});

test('get_record paging: maxChars truncates and reports how much remains', async () => {
  const { gw, url } = await seeded();
  try {
    const g = await (await fetch(`${url}/v1/history/get?id=meeting:1&maxChars=20`)).json();
    assert.equal(g.record.text.length, 20);
    assert.equal(g.record.truncated, true);
    assert.ok(g.record.totalChars > 20);
    const g2 = await (await fetch(`${url}/v1/history/get?id=meeting:1&offset=20&maxChars=1000`)).json();
    assert.equal(g2.record.offset, 20);
    assert.equal(g2.record.truncated, false);
  } finally { gw.close(); }
});

test('graph: find_related surfaces records about the same thing', async () => {
  const { gw, url } = await seeded();
  try {
    const r = await (await fetch(`${url}/v1/history/related?id=meeting:1&limit=5`)).json();
    const ids = r.results.map((x) => x.id);
    assert.ok(!ids.includes('meeting:1'), 'excludes itself');
    assert.ok(ids.includes('note:3'), 'surfaces the note about the same demo');
  } finally { gw.close(); }
});

test('smart_search expands one question into several queries and fuses the rankings', async () => {
  const { gw, url, now } = await seeded();
  try {
    await fetch(`${url}/v1/history/ingest`, { method: 'POST', headers: A, body: JSON.stringify({ upserts: [
      { id: 'note:9', type: 'note', title: 'Follow-ups', date: now - 3600_000, text: 'Action items from the demo: dashboard rollout, roadmap review with Ben.' },
    ] }) });
    const r = await (await fetch(`${url}/v1/history/smart-search`, { method: 'POST', headers: A, body: JSON.stringify({
      question: 'What did we decide in the Ben tooling demo?',
      queries: ['Ben demo decisions', 'tooling demo action items'],
    }) })).json();

    assert.ok(r.queries.length >= 3, 'the question was expanded, not asked once');
    assert.ok(r.queries.includes('Ben demo decisions'), "the agent's own phrasings lead");
    const ids = r.results.map((x) => x.id);
    assert.ok(ids.includes('meeting:1'), 'finds the demo meeting');
    assert.ok(ids.includes('note:9'), 'and the follow-up note — the point of fusing');
    assert.ok(!ids.includes('meeting:2'), 'the unrelated old record stays out');
    assert.ok(r.results[0].snippet, 'results carry snippets, not bodies');
    assert.ok(r.results[0].foundBy?.length, 'each hit reports which queries found it');
    assert.ok(r.newest, 'freshness is still reported');
  } finally { gw.close(); }
});

test('smart_search honours filters and never throws on an empty question', async () => {
  const { gw, url, now } = await seeded();
  try {
    const r = await (await fetch(`${url}/v1/history/smart-search`, { method: 'POST', headers: A, body: JSON.stringify({
      question: 'Ben tooling demo roadmap', type: 'meeting', since: now - 7 * DAY,
    }) })).json();
    assert.ok(r.results.every((x) => x.id.startsWith('meeting:')), 'type filter applied to every query');
    const empty = await (await fetch(`${url}/v1/history/smart-search`, { method: 'POST', headers: A, body: JSON.stringify({ question: '' }) })).json();
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.results, []);
  } finally { gw.close(); }
});
