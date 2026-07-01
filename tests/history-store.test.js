// WARM record store: bulk/search/list/get + encrypted-at-rest persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const dir = mkdtempSync(join(os.tmpdir(), 'cp-hist-'));
process.env.CHATPANEL_HISTORY_STORE = join(dir, 'store.enc');
process.env.CHATPANEL_HISTORY_KEY = join(dir, 'key');

const { HistoryStore } = await import('../src/history-store.js');

test('bulk + search + list + get', () => {
  const s = new HistoryStore().load();
  s.bulk({
    upserts: [
      { id: 'chat:1', text: 'privacy gateway roadmap and warm tier', title: 'Roadmap', type: 'chat', date: 200 },
      { id: 'meeting:2', text: 'budget review with the finance team', title: 'Budget', type: 'meeting', date: 100 },
    ],
  });
  assert.equal(s.size, 2);

  const hits = s.search('budget', { limit: 5 });
  assert.equal(hits[0].id, 'meeting:2');

  const list = s.list({ limit: 10 });
  assert.equal(list.total, 2);
  assert.equal(list.items[0].id, 'chat:1', 'newest (date desc) first');
  assert.equal(list.items[0].chars > 0, true);
  assert.equal('text' in list.items[0], false, 'list carries no bodies');

  const rec = s.get('meeting:2');
  assert.equal(rec.text, 'budget review with the finance team');
  assert.equal(s.get('nope'), null);
});

test('remove tombstones from store + index', () => {
  const s = new HistoryStore().load();
  s.bulk({ upserts: [{ id: 'a', text: 'alpha', date: 1 }] });
  s.bulk({ removes: ['a'] });
  assert.equal(s.size, 0);
  assert.equal(s.search('alpha').length, 0);
});

test('persistence survives a restart and the file is ciphertext (encrypted at rest)', () => {
  const a = new HistoryStore().load();
  a.bulk({ upserts: [{ id: 'chat:9', text: 'SECRETPLAINTEXTMARKER budget notes', title: 'X', type: 'chat', date: 5 }] });
  a.persistNow();

  // On-disk bytes must NOT contain the plaintext.
  const onDisk = readFileSync(process.env.CHATPANEL_HISTORY_STORE, 'utf8');
  assert.equal(onDisk.includes('SECRETPLAINTEXTMARKER'), false, 'plaintext must not be on disk');
  const env = JSON.parse(onDisk);
  assert.equal(env.v, 1);
  assert.ok(env.iv && env.tag && env.ct, 'AES-GCM envelope fields present');

  // A fresh store loading the same encrypted file recovers everything (no cold start).
  const b = new HistoryStore().load();
  assert.equal(b.get('chat:9').text, 'SECRETPLAINTEXTMARKER budget notes');
  assert.equal(b.search('budget')[0].id, 'chat:9', 'index rebuilt from the store on load');
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
