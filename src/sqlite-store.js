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
import { mkdirSync } from 'node:fs';
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
    if (this.path !== ':memory:') mkdirSync(DIR, { recursive: true });
    this.db = await openDb(this.path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, title TEXT, type TEXT, date INTEGER, chars INTEGER)');
    this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, title, text, tokenize='unicode61')");
    return this;
  }

  // Kept for interface-compatibility with HistoryStore (SQLite is already loaded).
  load() {
    return this;
  }

  get size() {
    return this.db.get('SELECT COUNT(*) c FROM records')?.c || 0;
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

  // [{ id, score, title, type, date }] — score higher = better (bm25 is negated).
  search(query, { limit = 10 } = {}) {
    const match = ftsMatch(query);
    if (!match) return [];
    const rows = this.db.all(
      'SELECT r.id id, r.title title, r.type type, r.date date, bm25(fts) b FROM fts JOIN records r ON r.id = fts.id WHERE fts MATCH ? ORDER BY b LIMIT ?',
      [match, limit],
    );
    return rows.map((r) => ({ id: r.id, score: -r.b, title: r.title, type: r.type, date: r.date }));
  }

  list({ limit = 50, offset = 0 } = {}) {
    const total = this.db.get('SELECT COUNT(*) c FROM records')?.c || 0;
    const items = this.db.all('SELECT id, title, type, date, chars FROM records ORDER BY date DESC LIMIT ? OFFSET ?', [limit, offset]);
    return { total, items };
  }

  get(id) {
    const meta = this.db.get('SELECT id, title, type, date FROM records WHERE id = ?', [id]);
    if (!meta) return null;
    const body = this.db.get('SELECT text FROM fts WHERE id = ?', [id]);
    return { ...meta, text: body?.text || '' };
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
