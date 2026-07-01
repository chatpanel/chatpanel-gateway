// Backup-ingest: seed the warm store from the user's own daily encrypted backup so
// the gateway holds the full corpus even when the extension isn't running. Finds the
// newest backup file, decrypts it with the handed-off passphrase, and turns it into
// warm records.
//
// The record extraction here is a SIMPLIFIED mirror of the extension's rich
// conversationSource/meetingSource — same ids (chat:<id> / meeting:<id>), so when the
// extension IS running its live-sync upserts its exact records right over these. This
// path only needs "searchable text + title + date + id"; it is the fallback, not the
// source of truth.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { decryptBackupEnvelope } from './backup-decrypt.js';

const BACKUP_DIR = process.env.CHATPANEL_BACKUP_DIR || join(os.homedir(), 'Downloads', 'ChatPanel Backups');
const BACKUP_RE = /^chatpanel-backup-[A-Za-z]+\.encrypted\.json$/;

// Newest chatpanel-backup-*.encrypted.json in the backups dir, or null.
export function findLatestBackup(dir = BACKUP_DIR) {
  try {
    let best = null;
    for (const f of readdirSync(dir)) {
      if (!BACKUP_RE.test(f)) continue;
      const path = join(dir, f);
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    }
    return best?.path || null;
  } catch {
    return null;
  }
}

// Decrypted backup data → warm records [{ id, text, title, type, date }].
export function backupToRecords(data) {
  const out = [];
  for (const c of data?.conversations || []) {
    if (!c?.id) continue;
    const title = c.title || 'Chat';
    const date = c.updatedAt || c.createdAt || 0;
    const body = (c.messages || [])
      .filter((m) => m && m.content)
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'You'}: ${m.content}`)
      .join('\n\n');
    out.push({ id: `chat:${c.id}`, type: 'chat', title, date, text: `CHAT: ${title}\n\n${body}`.trim() });
  }
  for (const m of data?.meetings || []) {
    // Meetings are exported wrapped: { record: {...meeting}, notes: <summary>, topics }.
    const rec = m?.record || m;
    const id = rec?.id;
    if (!id) continue;
    const title = rec.title || 'Meeting';
    const date = rec.startedAt || rec.date || 0;
    const notes = typeof m?.notes === 'string' ? m.notes : '';
    const segs = (rec.segments || []).map((s) => `${s.speaker || '?'}: ${s.text || ''}`).join('\n');
    const parts = [`MEETING: ${title}`];
    if (rec.platform) parts.push(`Platform: ${rec.platform}`);
    if (notes) parts.push('', 'SUMMARY:', notes);
    if (segs) parts.push('', 'TRANSCRIPT:', segs);
    out.push({ id: `meeting:${id}`, type: 'meeting', title, date, text: parts.join('\n').trim() });
  }
  return out;
}

// Decrypt the latest (or given) backup and upsert its records into the store.
// Returns { ok, ingested, size } or { ok:false, reason }. Never throws on a missing
// file / passphrase; surfaces a decrypt failure as reason:'decrypt'.
export async function ingestBackup(store, passphrase, { path } = {}) {
  const file = path || findLatestBackup();
  if (!file || !existsSync(file)) return { ok: false, reason: 'no-backup' };
  if (!passphrase) return { ok: false, reason: 'no-passphrase' };
  let data;
  try {
    data = await decryptBackupEnvelope(JSON.parse(readFileSync(file, 'utf8')), passphrase);
  } catch (e) {
    return { ok: false, reason: 'decrypt', error: String(e?.message || e) };
  }
  const records = backupToRecords(data);
  store.bulk({ upserts: records });
  return { ok: true, file, ingested: records.length, size: store.size };
}
