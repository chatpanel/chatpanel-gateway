// WARM store — SQLite + FTS5 backend (the scale engine behind the same interface
// as history-store.js's HistoryStore). SQLite is memory-mapped, so a year of
// chats/meetings is searchable without loading the whole corpus into RAM, with
// battle-tested BM25 full-text search and O(1) record lookups.
//
// Dual runtime: the npm gateway runs on Node (node:sqlite, built in since 22); the
// standalone binary is compiled with Bun (bun:sqlite). Both ship FTS5. The
// specifier is computed so neither bundler tries to resolve the other runtime's
// module. createHistoryStore() falls back to the encrypted-JSON HistoryStore if
// SQLite can't load at all, so this can never break a gateway.
//
// AT REST: a local .db file (0600) under ~/.chatpanel, protected by OS disk
// encryption — the on-device warm tier. Zero-knowledge encryption is the COLD/cloud
// tier's job, not this one. The backup passphrase (a credential) stays encrypted
// via history-store.js's saveBackupSecret.

import { join } from 'node:path';
import { mkdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { HistoryStore } from './history-store.js';

const DIR = join(os.homedir(), '.chatpanel');
const DB_PATH = process.env.CHATPANEL_HISTORY_DB || join(DIR, 'history.db');

// Silence node:sqlite's one-time "experimental" warning for a clean CLI; pass
// every other warning through untouched.
if (typeof Bun === 'undefined') {
  const emit = process.emitWarning.bind(process);
  process.emitWarning = (w, ...a) => (typeof w === 'string' && w.includes('SQLite is an experimental') ? undefined : emit(w, ...a));
}

// Normalize node:sqlite (DatabaseSync) and bun:sqlite (Database) to one tiny API.
async function openDb(path) {
  if (typeof Bun !== 'undefined') {
    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { create: true });
    return {
      exec: (sql) => db.run(sql),
      run: (sql, p = []) => db.prepare(sql).run(...p),
      all: (sql, p = []) => db.query(sql).all(...p),
      get: (sql, p = []) => db.query(sql).get(...p),
    };
  }
  const spec = 'node' + ':sqlite'; // computed so the Bun bundler won't touch it
  const { DatabaseSync } = await import(spec);
  const db = new DatabaseSync(path);
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, p = []) => db.prepare(sql).run(...p),
    all: (sql, p = []) => db.prepare(sql).all(...p),
    get: (sql, p = []) => db.prepare(sql).get(...p),
  };
}

// query text → a safe FTS5 MATCH string. Each term is quoted (so FTS5 operators in
// user text can't inject), joined with OR for recall — bm25 handles the ranking.
function ftsMatch(query) {
  const terms = String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9'_+-]*/g);
  if (!terms || !terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export class SqliteHistoryStore {
  constructor({ path = DB_PATH } = {}) {
    this.path = path;
    this.db = null;
  }

  async init() {
    if (this.path !== ':memory:') {
      mkdirSync(DIR, { recursive: true, mode: 0o700 });
      try { chmodSync(DIR, 0o700); } catch { /* non-POSIX */ }
    }
    this.db = await openDb(this.path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, title TEXT, type TEXT, date INTEGER, chars INTEGER)');
    this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, title, text, tokenize='unicode61')");
    if (this.path !== ':memory:') {
      for (const path of [this.path, this.path + '-wal', this.path + '-shm']) {
        try { if (existsSync(path)) chmodSync(path, 0o600); } catch { /* best effort */ }
      }
    }
    return this;
  }

  // Kept for interface-compatibility with HistoryStore (SQLite is already loaded).
  load() {
    return this;
  }

  get size() {
    return this.db.get('SELECT COUNT(*) c FROM records')?.c || 0;
  }

  // Freshness horizon — the newest record's timestamp. The MCP tools surface this so
  // an agent knows how current the warm copy is (and stops denying un-synced items).
  get newest() {
    return this.db.get('SELECT MAX(date) m FROM records')?.m || 0;
  }

  // On-disk footprint for the storage dashboard: the .db plus its WAL/shm sidecars.
  get bytes() {
    if (this.path === ':memory:') return 0;
    let total = 0;
    for (const p of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try { if (existsSync(p)) total += statSync(p).size; } catch { /* ignore */ }
    }
    return total;
  }

  bulk({ upserts = [], removes = [] } = {}) {
    this.db.exec('BEGIN');
    try {
      for (const id of removes) {
        this.db.run('DELETE FROM records WHERE id = ?', [id]);
        this.db.run('DELETE FROM fts WHERE id = ?', [id]);
      }
      for (const d of upserts) {
        if (!d || !d.id) continue;
        const text = String(d.text || '');
        this.db.run('DELETE FROM fts WHERE id = ?', [d.id]); // FTS5 has no UPSERT on UNINDEXED id
        this.db.run('INSERT INTO fts(id, title, text) VALUES(?, ?, ?)', [d.id, d.title || '', text]);
        this.db.run('INSERT OR REPLACE INTO records(id, title, type, date, chars) VALUES(?, ?, ?, ?, ?)', [d.id, d.title || '', d.type || '', d.date || 0, text.length]);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.size;
  }

  // [{ id, score, title, type, date, snippet }] — score higher = better (bm25 is negated).
  // Filters: type (chat|meeting|note), since/before (epoch ms bounds), offset (paging).
  // `snippet` returns the matching excerpt from the transcript/body so a caller can rank and
  // decide what to fetch WITHOUT pulling full bodies — the token-management path.
  search(query, { limit = 10, offset = 0, type = null, since = null, before = null } = {}) {
    const match = ftsMatch(query);
    if (!match) return [];
    const where = ['fts MATCH ?'];
    const params = [match];
    if (type) { where.push('r.type = ?'); params.push(String(type)); }
    if (since != null) { where.push('r.date >= ?'); params.push(Number(since)); }
    if (before != null) { where.push('r.date <= ?'); params.push(Number(before)); }
    params.push(limit, offset);
    const rows = this.db.all(
      `SELECT r.id id, r.title title, r.type type, r.date date, bm25(fts) b,
              snippet(fts, 2, '«', '»', ' … ', 12) snip
       FROM fts JOIN records r ON r.id = fts.id
       WHERE ${where.join(' AND ')} ORDER BY b LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map((r) => ({ id: r.id, score: -r.b, title: r.title, type: r.type, date: r.date, snippet: r.snip || '' }));
  }

  // Graph navigation — records most connected to a given one, by shared content. "More like
  // this": build a MATCH from the record's title + a sample of its body, rank by bm25, drop
  // self. Cheap and index-only; no embeddings needed for a first-class "related" primitive.
  related(id, { limit = 5 } = {}) {
    const rec = this.get(id);
    if (!rec) return [];
    const terms = ftsMatch(`${rec.title || ''} ${String(rec.text || '').slice(0, 2000)}`);
    if (!terms) return [];
    // Cap the OR-set so a long transcript doesn't build a giant MATCH.
    const capped = terms.split(' OR ').slice(0, 40).join(' OR ');
    const rows = this.db.all(
      `SELECT r.id id, r.title title, r.type type, r.date date, bm25(fts) b
       FROM fts JOIN records r ON r.id = fts.id
       WHERE fts MATCH ? AND r.id != ? ORDER BY b LIMIT ?`,
      [capped, id, limit],
    );
    return rows.map((r) => ({ id: r.id, score: -r.b, title: r.title, type: r.type, date: r.date }));
  }

  list({ limit = 50, offset = 0 } = {}) {
    const total = this.db.get('SELECT COUNT(*) c FROM records')?.c || 0;
    const items = this.db.all('SELECT id, title, type, date, chars FROM records ORDER BY date DESC LIMIT ? OFFSET ?', [limit, offset]);
    return { total, items };
  }

  // Paged fetch for token management: maxChars caps the returned slice, offset pages a long
  // transcript. Reports totalChars + truncated so a caller knows there is more to fetch.
  get(id, { maxChars = null, offset = 0 } = {}) {
    const meta = this.db.get('SELECT id, title, type, date FROM records WHERE id = ?', [id]);
    if (!meta) return null;
    const body = this.db.get('SELECT text FROM fts WHERE id = ?', [id]);
    const full = body?.text || '';
    let text = offset ? full.slice(offset) : full;
    let truncated = false;
    if (maxChars && text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
    return { ...meta, text, totalChars: full.length, offset: Number(offset) || 0, truncated };
  }

  // Wipe every record — the user purging the on-disk warm copy. Returns how many were dropped.
  clear() {
    const n = this.size;
    this.db.exec('DELETE FROM records');
    this.db.exec('DELETE FROM fts');
    return n;
  }
}

// Pick the best available warm engine. SQLite when it loads; otherwise the
// encrypted-JSON HistoryStore — so a gateway is never left without a warm store.
export async function createHistoryStore(opts = {}) {
  try {
    return await new SqliteHistoryStore(opts).init();
  } catch (e) {
    console.log(`[warm] SQLite unavailable (${e.message}); using the encrypted file store`);
    return new HistoryStore(opts).load();
  }
}
