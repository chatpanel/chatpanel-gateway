// WARM-tier record store + encrypted-at-rest persistence (gateway side).
//
// The SearchIndex keeps only term-frequencies + light meta, so it can rank but
// can't hand back a full record. This store keeps the raw records so the gateway
// can (a) survive a restart WITHOUT the extension re-ingesting everything — the
// user's "no cold start" requirement — and (b) serve read endpoints (list/get)
// that an external UI renders. The BM25 index is derived from the store and
// rebuilt on load (cheap, in-memory), so only the store is persisted.
//
// ENCRYPTED AT REST: records are AES-256-GCM'd with a key generated once and kept
// at ~/.chatpanel/history-key (0600). This is the LOCAL/on-device tier — a local
// key is correct here; zero-knowledge (keys never on the box) is the future CLOUD
// tier, not this one. The file on disk is useless without the local key.

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { SearchIndex } from './search-index.js';

const DIR = join(os.homedir(), '.chatpanel');
const STORE_PATH = process.env.CHATPANEL_HISTORY_STORE || join(DIR, 'history-store.enc');
const KEY_PATH = process.env.CHATPANEL_HISTORY_KEY || join(DIR, 'history-key');
const SECRET_PATH = process.env.CHATPANEL_HISTORY_SECRET || join(DIR, 'history-secret.enc');

function loadOrCreateKey() {
  try {
    if (existsSync(KEY_PATH)) return Buffer.from(readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
  } catch {
    /* regenerate below */
  }
  const key = randomBytes(32);
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, key.toString('base64'), { mode: 0o600 });
  try {
    chmodSync(KEY_PATH, 0o600);
  } catch {
    /* best effort on platforms without POSIX perms */
  }
  return key;
}

function encrypt(key, plaintextBuf) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(key, env) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
}

// The handed-off backup passphrase, encrypted at rest with the same local key.
// Kept separate from the records file: it's a credential, not corpus data, and the
// gateway needs it before the store is even loaded (startup backup-ingest).
export function saveBackupSecret(passphrase) {
  if (!String(passphrase || '')) return clearBackupSecret();
  const env = encrypt(loadOrCreateKey(), Buffer.from(String(passphrase || ''), 'utf8'));
  mkdirSync(dirname(SECRET_PATH), { recursive: true });
  writeFileSync(SECRET_PATH, JSON.stringify(env), { mode: 0o600 });
}

export function clearBackupSecret() {
  try { if (existsSync(SECRET_PATH)) unlinkSync(SECRET_PATH); } catch { /* best effort */ }
}

export function loadBackupSecret() {
  try {
    if (!existsSync(SECRET_PATH)) return '';
    return decrypt(loadOrCreateKey(), JSON.parse(readFileSync(SECRET_PATH, 'utf8'))).toString('utf8');
  } catch {
    return '';
  }
}

export function hasBackupSecret() {
  return !!loadBackupSecret();
}

// Records-plus-index with lazy, debounced encrypted persistence.
export class HistoryStore {
  constructor({ storePath = STORE_PATH, persistMs = 2000 } = {}) {
    this.records = new Map(); // id -> { id, text, title, type, date }
    this.index = new SearchIndex();
    this.storePath = storePath;
    this.persistMs = persistMs;
    this._key = null;
    this._timer = null;
    this._dirty = false;
  }

  get size() {
    return this.records.size;
  }

  // The timestamp of the freshest record, so a client can tell how current this warm copy
  // is — the difference between "no such meeting" and "not synced yet".
  get newest() {
    let max = 0;
    for (const r of this.records.values()) if ((r.date || 0) > max) max = r.date || 0;
    return max || null;
  }

  // On-disk footprint for the storage dashboard: the encrypted store file.
  get bytes() {
    try { return existsSync(this.storePath) ? statSync(this.storePath).size : 0; } catch { return 0; }
  }

  key() {
    if (!this._key) this._key = loadOrCreateKey();
    return this._key;
  }

  // Load the encrypted store from disk and rebuild the index. Safe on a missing/
  // corrupt file — starts empty rather than throwing (fail-open for a cache).
  load() {
    try {
      if (!existsSync(this.storePath)) return this;
      const env = JSON.parse(readFileSync(this.storePath, 'utf8'));
      const records = JSON.parse(decrypt(this.key(), env).toString('utf8'));
      this.records = new Map(records.map((r) => [r.id, r]));
      this.index = new SearchIndex();
      for (const r of this.records.values()) this.index.upsert(r);
    } catch {
      this.records = new Map();
      this.index = new SearchIndex();
    }
    return this;
  }

  // Write the encrypted store now (synchronous). Callers normally use the
  // debounced schedulePersist(); this is the flush.
  persistNow() {
    this._dirty = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const buf = Buffer.from(JSON.stringify([...this.records.values()]), 'utf8');
    const env = encrypt(this.key(), buf);
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(env), { mode: 0o600 });
  }

  schedulePersist() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) {
        try {
          this.persistNow();
        } catch {
          /* keep serving from memory even if disk write fails */
        }
      }
    }, this.persistMs);
    if (this._timer.unref) this._timer.unref(); // don't hold the process open
  }

  // Apply upserts/removes to BOTH the record store and the index, then schedule a
  // persist. Returns the new size. Mirrors SearchIndex.bulk's shape.
  bulk({ upserts = [], removes = [] } = {}) {
    for (const id of removes) {
      this.records.delete(id);
      this.index.remove(id);
    }
    for (const d of upserts) {
      if (!d || !d.id) continue;
      const rec = { id: d.id, text: String(d.text || ''), title: d.title || '', type: d.type || '', date: d.date || 0 };
      this.records.set(rec.id, rec);
      this.index.upsert(rec);
    }
    this.schedulePersist();
    return this.records.size;
  }

  // Wipe every record — the user purging the on-disk warm copy. Returns how many were dropped.
  clear() {
    const n = this.records.size;
    this.records.clear();
    this.index = new SearchIndex();
    this.schedulePersist();
    return n;
  }

  // Mirror the SQLite engine's richer contract so both backends behave the same: type/date
  // filters, offset paging, and a matching snippet (over-fetch from the ranker, then filter
  // and page, since SearchIndex has no WHERE clause).
  search(query, { limit = 10, offset = 0, type = null, since = null, before = null } = {}) {
    const raw = this.index.search(query, { limit: (limit + offset) * 3 + 20 });
    const out = [];
    for (const r of raw) {
      const rec = this.records.get(r.id);
      if (!rec) continue;
      if (type && rec.type !== type) continue;
      if (since != null && (rec.date || 0) < since) continue;
      if (before != null && (rec.date || 0) > before) continue;
      out.push({ id: r.id, score: r.score, title: rec.title, type: rec.type, date: rec.date, snippet: snippetOf(rec.text, query) });
    }
    return out.slice(offset, offset + limit);
  }

  // Graph navigation — records most connected to this one, by shared content.
  related(id, { limit = 5 } = {}) {
    const rec = this.records.get(id);
    if (!rec) return [];
    const raw = this.index.search(`${rec.title || ''} ${String(rec.text || '').slice(0, 2000)}`, { limit: limit + 5 });
    return raw.filter((r) => r.id !== id).slice(0, limit).map((r) => {
      const m = this.records.get(r.id) || {};
      return { id: r.id, score: r.score, title: m.title, type: m.type, date: m.date };
    });
  }

  // Metadata list for an external UI, newest first, paginated. No bodies.
  list({ limit = 50, offset = 0 } = {}) {
    const all = [...this.records.values()]
      .map((r) => ({ id: r.id, title: r.title, type: r.type, date: r.date, chars: r.text.length }))
      .sort((a, b) => (b.date || 0) - (a.date || 0));
    return { total: all.length, items: all.slice(offset, offset + limit) };
  }

  // Paged fetch for token management (maxChars/offset), matching SqliteHistoryStore.get.
  get(id, { maxChars = null, offset = 0 } = {}) {
    const rec = this.records.get(id);
    if (!rec) return null;
    const full = String(rec.text || '');
    let text = offset ? full.slice(offset) : full;
    let truncated = false;
    if (maxChars && text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
    return { ...rec, text, totalChars: full.length, offset: Number(offset) || 0, truncated };
  }
}

// A short excerpt of `text` around the first query-term hit — the token-friendly preview a
// search returns instead of the whole body. Falls back to the head when no term matches.
function snippetOf(text, query, radius = 90) {
  const s = String(text || '');
  if (!s) return '';
  const terms = String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9'_+-]*/g) || [];
  const lower = s.toLowerCase();
  let idx = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (idx < 0 || i < idx)) idx = i; }
  if (idx < 0) return s.slice(0, radius * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, idx - radius);
  return `${start > 0 ? '… ' : ''}${s.slice(start, idx + radius).replace(/\s+/g, ' ').trim()}${idx + radius < s.length ? ' …' : ''}`;
}
