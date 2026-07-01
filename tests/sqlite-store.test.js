// WARM SQLite+FTS5 engine: bulk/search/list/get/remove. Runs under node:sqlite
// here; the same class drives bun:sqlite in the compiled binary (same SQL/FTS5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteHistoryStore } from '../src/sqlite-store.js';

test('bulk + FTS5 search + list + get + remove', async () => {
  const s = await new SqliteHistoryStore({ path: ':memory:' }).init();
  s.bulk({
    upserts: [
      { id: 'chat:1', text: 'privacy gateway roadmap and the warm tier plan', title: 'Roadmap', type: 'chat', date: 200 },
      { id: 'meeting:2', text: 'budget review with the finance team numbers', title: 'Budget', type: 'meeting', date: 100 },
    ],
  });
  assert.equal(s.size, 2);

  const hits = s.search('budget finance', { limit: 5 });
  assert.equal(hits[0].id, 'meeting:2');
  assert.ok(hits[0].score > 0, 'score is positive (bm25 negated), higher = better');
  assert.equal(s.search('roadmap')[0].id, 'chat:1');
  assert.deepEqual(s.search('zzzznotoken'), []);
  assert.deepEqual(s.search(''), []);

  const list = s.list({ limit: 10 });
  assert.equal(list.total, 2);
  assert.equal(list.items[0].id, 'chat:1', 'newest (date desc) first');
  assert.equal(list.items[0].chars > 0, true);
  assert.equal('text' in list.items[0], false, 'list carries no bodies');

  const rec = s.get('meeting:2');
  assert.equal(rec.text, 'budget review with the finance team numbers');
  assert.equal(s.get('nope'), null);
});

test('upsert replaces; remove tombstones from records + fts', async () => {
  const s = await new SqliteHistoryStore({ path: ':memory:' }).init();
  s.bulk({ upserts: [{ id: 'a', text: 'alpha original', title: 'A', date: 1 }] });
  s.bulk({ upserts: [{ id: 'a', text: 'alpha rewritten beta', title: 'A2', date: 2 }] });
  assert.equal(s.size, 1, 'upsert, not duplicate');
  assert.equal(s.get('a').text, 'alpha rewritten beta');
  assert.equal(s.search('beta')[0].id, 'a');

  s.bulk({ removes: ['a'] });
  assert.equal(s.size, 0);
  assert.equal(s.search('alpha').length, 0);
  assert.equal(s.get('a'), null);
});

test('FTS operator chars in a query do not throw (sanitized)', async () => {
  const s = await new SqliteHistoryStore({ path: ':memory:' }).init();
  s.bulk({ upserts: [{ id: 'x', text: 'quarterly OR planning AND review', title: 'X', date: 1 }] });
  assert.doesNotThrow(() => s.search('planning OR (review* AND "quarterly'));
  assert.equal(s.search('planning')[0].id, 'x');
});
