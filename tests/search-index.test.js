import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchIndex, tokenize } from '../src/search-index.js';

test('tokenize drops stopwords + short/numeric tokens', () => {
  const t = tokenize('The quarterly revenue was 42 and the roadmap');
  assert.ok(t.includes('quarterly'));
  assert.ok(t.includes('revenue'));
  assert.ok(t.includes('roadmap'));
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('42'));
});

test('bm25 ranks the more relevant doc first', () => {
  const idx = new SearchIndex();
  idx.upsert({ id: 'a', title: 'Budget review', text: 'we discussed the marketing budget and the budget forecast' });
  idx.upsert({ id: 'b', title: 'Standup', text: 'quick standup, no budget talk here, just status' });
  const r = idx.search('budget forecast');
  assert.equal(r[0].id, 'a', 'doc heavy on the query terms wins');
  assert.ok(r[0].score > (r[1]?.score ?? 0));
});

test('incremental upsert updates stats (re-index a doc)', () => {
  const idx = new SearchIndex();
  idx.upsert({ id: 'a', title: '', text: 'alpha alpha' });
  assert.equal(idx.search('alpha').length, 1);
  idx.upsert({ id: 'a', title: '', text: 'beta gamma' }); // replace content
  assert.equal(idx.search('alpha').length, 0, 'old terms gone after re-upsert');
  assert.equal(idx.search('beta')[0].id, 'a');
  assert.equal(idx.size, 1, 're-upsert does not duplicate');
});

test('remove (tombstone) drops a doc and its terms', () => {
  const idx = new SearchIndex();
  idx.upsert({ id: 'a', text: 'unicorn rainbow' });
  idx.upsert({ id: 'b', text: 'rainbow bridge' });
  assert.equal(idx.remove('a'), true);
  assert.equal(idx.remove('a'), false, 'removing twice is a no-op');
  assert.equal(idx.search('unicorn').length, 0);
  assert.equal(idx.search('rainbow')[0].id, 'b', 'other docs unaffected');
  assert.equal(idx.size, 1);
});

test('bulk applies removes then upserts', () => {
  const idx = new SearchIndex();
  idx.upsert({ id: 'a', text: 'old data' });
  idx.bulk({ removes: ['a'], upserts: [{ id: 'b', text: 'new data' }, { id: 'c', text: 'more data' }] });
  assert.equal(idx.size, 2);
  assert.equal(idx.search('old').length, 0);
  assert.equal(idx.search('data').length, 2);
});

test('carries meta (title/type/date) into results + honors limit', () => {
  const idx = new SearchIndex();
  for (let i = 0; i < 5; i++) idx.upsert({ id: `m${i}`, type: 'meeting', date: 1000 + i, title: `Sync ${i}`, text: 'sync sync roadmap' });
  const r = idx.search('roadmap sync', { limit: 3 });
  assert.equal(r.length, 3);
  assert.equal(r[0].type, 'meeting');
  assert.ok(r[0].title.startsWith('Sync'));
  assert.ok(r[0].date >= 1000);
});

test('toJSON / fromJSON round-trips (for encrypted-at-rest persistence)', () => {
  const idx = new SearchIndex();
  idx.upsert({ id: 'a', title: 'Launch plan', text: 'launch the privacy gateway next week' });
  idx.upsert({ id: 'b', title: 'Notes', text: 'privacy privacy privacy notes' });
  const restored = SearchIndex.fromJSON(JSON.parse(JSON.stringify(idx.toJSON())));
  assert.equal(restored.size, 2);
  assert.deepEqual(restored.search('privacy').map((r) => r.id), idx.search('privacy').map((r) => r.id));
  assert.equal(restored.search('launch')[0].id, 'a');
});

console.log('search-index tests defined');
