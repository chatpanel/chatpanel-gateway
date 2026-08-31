// Memory on the gateway: the store, and the property the two-way sync depends on.
import './isolate-store.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory-store.js';

const fresh = () => new MemoryStore({ storePath: join(mkdtempSync(join(tmpdir(), 'cp-mem-')), 'memory.enc') }).load();

test('a memory survives a restart, encrypted on disk', async () => {
  // The gateway is a long-lived service that gets restarted; memory that did not survive
  // that would be worse than no memory, because the user would have taught it twice.
  const store = fresh();
  store.remember({ text: 'Prefers pnpm over npm', kind: 'preference' });
  const reopened = new MemoryStore({ storePath: store.storePath }).load();
  assert.equal(reopened.size, 1);
  assert.equal(reopened.list()[0].text, 'Prefers pnpm over npm');

  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(store.storePath, 'utf8');
  assert.doesNotMatch(raw, /pnpm/, 'the plaintext is not on disk');
});

test('a corrupt store starts empty rather than failing the gateway', async () => {
  const { writeFileSync } = await import('node:fs');
  const store = fresh();
  writeFileSync(store.storePath, 'not json at all');
  assert.equal(new MemoryStore({ storePath: store.storePath }).load().size, 0);
});

test('writes reconcile — the property the two-way sync rests on', () => {
  const store = fresh();
  assert.equal(store.remember({ text: 'Goes by Alex', kind: 'identity' }).action, 'create');
  assert.equal(store.remember({ text: 'goes by alex', kind: 'identity' }).action, 'duplicate');
  assert.equal(store.remember({ text: 'Goes by Sam', kind: 'identity' }).action, 'update');
  assert.equal(store.size, 1, 'one fact, one row, whatever was said');
  assert.equal(store.list()[0].text, 'Goes by Sam');
});

test('syncing the same set twice is a no-op — otherwise every pass doubles memory', () => {
  // This is the whole reason two stores can hold one truth: the merge keys on the FACT, not
  // on a row id, so pushing what you already pushed changes nothing.
  const store = fresh();
  const upserts = [
    { text: 'Goes by Alex', kind: 'identity', createdAt: 1, updatedAt: 1 },
    { text: 'Prefers pnpm over npm', kind: 'preference', createdAt: 1, updatedAt: 1 },
  ];
  assert.equal(store.bulk({ upserts }).merged, 2);
  assert.equal(store.bulk({ upserts }).merged, 0, 'a second push merges nothing');
  assert.equal(store.size, 2);

  // …and a correction still lands.
  assert.equal(store.bulk({ upserts: [{ text: 'Goes by Sam', kind: 'identity', createdAt: 2, updatedAt: 2 }] }).merged, 1);
  assert.equal(store.size, 2);
  assert.equal(store.list().find((m) => m.kind === 'identity').text, 'Goes by Sam');
});

test('a malformed record in a sync is skipped, not stored', () => {
  // It would otherwise be handed to a model as a standing fact about the user.
  const store = fresh();
  const { merged } = store.bulk({ upserts: [{ text: '' }, { text: 'x'.repeat(400) }, { text: 'Prefers pnpm over npm', kind: 'preference' }] });
  assert.equal(merged, 1);
  assert.equal(store.size, 1);
});

test('recall carries the ambient facts and only the relevant others', () => {
  const store = fresh();
  store.remember({ text: 'Goes by Alex', kind: 'identity' });
  store.remember({ text: 'Runs Postgres in Frankfurt', kind: 'fact' });

  const off = store.recall({ text: 'rename this variable' });
  assert.match(off.block, /Goes by Alex/, 'who they are applies to every task');
  assert.doesNotMatch(off.block, /Frankfurt/);

  assert.match(store.recall({ text: 'can postgres reach frankfurt' }).block, /Frankfurt/);
  assert.equal(fresh().recall({ text: 'anything' }).block, '', 'an empty store renders to nothing');
});

test('forget names a memory the way a person would', () => {
  const store = fresh();
  store.remember({ text: 'Runs Postgres in Frankfurt', kind: 'fact' });
  store.remember({ text: 'Prefers pnpm over npm', kind: 'preference' });
  assert.equal(store.forget('the Frankfurt thing').removed[0].text, 'Runs Postgres in Frankfurt');
  assert.equal(store.size, 1);
  assert.deepEqual(store.forget('nothing like this').removed, [], 'a miss removes nothing');
  assert.equal(store.size, 1);
});
