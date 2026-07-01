// #3b: decrypt a ChatPanel backup envelope (extension wire format), extract warm
// records, ingest them; plus encrypted key storage. Uses a temp ~/.chatpanel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import os from 'node:os';

const dir = mkdtempSync(join(os.tmpdir(), 'cp-3b-'));
process.env.CHATPANEL_HISTORY_STORE = join(dir, 'store.enc');
process.env.CHATPANEL_HISTORY_KEY = join(dir, 'key');
process.env.CHATPANEL_HISTORY_SECRET = join(dir, 'secret.enc');
process.env.CHATPANEL_BACKUP_DIR = dir;

const { HistoryStore, saveBackupSecret, loadBackupSecret, hasBackupSecret } = await import('../src/history-store.js');
const { decryptBackupEnvelope } = await import('../src/backup-decrypt.js');
const { ingestBackup, backupToRecords, findLatestBackup } = await import('../src/backup-ingest.js');

// Build an envelope EXACTLY as the extension's encryptBackup does (v2: gzip → AES-GCM).
async function makeEnvelope(data, passphrase) {
  const b64 = (b) => Buffer.from(b).toString('base64');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const gz = gzipSync(Buffer.from(JSON.stringify(data)));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz));
  return { type: 'chatpanel-backup-encrypted', version: 2, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 250000, salt: b64(salt) }, cipher: 'AES-GCM', compression: 'gzip', iv: b64(iv), ct: b64(ct) };
}

const DATA = {
  type: 'chatpanel-backup',
  version: 4,
  conversations: [{ id: 'c1', title: 'Roadmap', updatedAt: 200, messages: [{ role: 'user', content: 'privacy gateway warm tier plan' }, { role: 'assistant', content: 'ship RRF fusion' }] }],
  meetings: [{ id: 'imp_9', title: 'Budget sync', startedAt: 100, segments: [{ speaker: 'Alex', text: 'finance budget review numbers' }] }],
};

test('decrypt (extension envelope) → records → ingest → search', async () => {
  const env = await makeEnvelope(DATA, 'hunter2');
  const back = await decryptBackupEnvelope(env, 'hunter2');
  assert.equal(back.conversations.length, 1, 'gzip+AES-GCM round-trips across repos');

  const records = backupToRecords(back);
  assert.deepEqual(records.map((r) => r.id).sort(), ['chat:c1', 'meeting:imp_9']);
  assert.ok(records.find((r) => r.id === 'meeting:imp_9').text.includes('finance budget'));

  const store = new HistoryStore().load();
  store.bulk({ upserts: records });
  assert.equal(store.search('budget')[0].id, 'meeting:imp_9');
  assert.equal(store.search('roadmap')[0].id, 'chat:c1');
});

test('wrong passphrase throws', async () => {
  const env = await makeEnvelope(DATA, 'right');
  await assert.rejects(() => decryptBackupEnvelope(env, 'wrong'), /wrong passphrase/);
});

test('ingestBackup finds the newest file in the backups dir + uses the stored key', async () => {
  const env = await makeEnvelope(DATA, 'pw');
  writeFileSync(join(dir, 'chatpanel-backup-Mon.encrypted.json'), JSON.stringify(env));
  assert.ok(findLatestBackup().endsWith('chatpanel-backup-Mon.encrypted.json'));

  saveBackupSecret('pw');
  assert.equal(hasBackupSecret(), true);
  assert.equal(loadBackupSecret(), 'pw');

  const store = new HistoryStore().load();
  const r = await ingestBackup(store, loadBackupSecret());
  assert.equal(r.ok, true);
  assert.equal(r.ingested, 2);
  assert.equal(store.search('finance')[0].id, 'meeting:imp_9');
});

test('ingestBackup fails soft with no file / no passphrase', async () => {
  const store = new HistoryStore();
  assert.equal((await ingestBackup(store, 'pw', { path: join(dir, 'nope.json') })).reason, 'no-backup');
  assert.equal((await ingestBackup(store, '', { path: join(dir, 'chatpanel-backup-Mon.encrypted.json') })).reason, 'no-passphrase');
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
