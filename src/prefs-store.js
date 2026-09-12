// CLIENT PREFERENCES — the settings every ChatPanel client shares, held here because the
// gateway is the one address the extension and the desktop both have.
//
// A document of SECTIONS (the MCP server list, the skills, the search engines — see
// @chatpanel/events/client-prefs.js), each stamped with when it was last written. A client
// pushes the sections it changed with its own stamps; the store keeps the newer stamp per
// section and tells the pusher which of its sections lost, so it can take the other side's
// copy. Per-section last-writer-wins: a section is one screen a person edits, and merging two
// edits of one list key by key would make a list neither of them made.
//
// ENCRYPTED AT REST with the same device key as memory and history — an MCP server entry can
// carry an Authorization header, and this file must not be the plaintext copy of it.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const DIR = join(os.homedir(), '.chatpanel');
const STORE_PATH = process.env.CHATPANEL_PREFS_STORE || join(DIR, 'prefs-store.enc');
const KEY_PATH = process.env.CHATPANEL_HISTORY_KEY || join(DIR, 'history-key');

/** A section id is a short word; anything else is refused before it is stored. */
const SECTION_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
/** One section's JSON, serialized — a list of a thousand MCP servers is not a preference. */
const MAX_SECTION_BYTES = 512 * 1024;

function loadOrCreateKey() {
  try {
    if (existsSync(KEY_PATH)) return Buffer.from(readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
  } catch { /* regenerate below */ }
  const key = randomBytes(32);
  mkdirSync(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(KEY_PATH, key.toString('base64'), { mode: 0o600 });
  return key;
}

function encrypt(key, buf) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(key, env) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]);
}

export class PrefsStore {
  constructor({ storePath = STORE_PATH } = {}) {
    this.path = storePath;
    this._key = null;
    this.sections = {}; // id -> { value, updatedAt, by }
    this.revision = 0;   // bumps on every accepted write, so a client can ask "anything new?"
  }

  load() {
    this._key = loadOrCreateKey();
    try {
      if (existsSync(this.path)) {
        const env = JSON.parse(readFileSync(this.path, 'utf8'));
        const doc = JSON.parse(decrypt(this._key, env).toString('utf8'));
        this.sections = doc?.sections && typeof doc.sections === 'object' ? doc.sections : {};
        this.revision = Number(doc?.revision) || 0;
      }
    } catch {
      // An unreadable store is an empty one, never a crash: the clients still hold their own
      // copies and will push them back on the next change.
      this.sections = {};
      this.revision = 0;
    }
    return this;
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const env = encrypt(this._key, Buffer.from(JSON.stringify({ v: 1, revision: this.revision, sections: this.sections }), 'utf8'));
    // Write beside, then rename: a crash mid-write leaves the old file, not half of a new one.
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Every section, or one. Values are the caller's to keep — they are copies. */
  get(id = '') {
    if (id) {
      const s = this.sections[id];
      return s ? { [id]: { value: clone(s.value), updatedAt: s.updatedAt, by: s.by || '' } } : {};
    }
    const out = {};
    for (const [k, s] of Object.entries(this.sections)) out[k] = { value: clone(s.value), updatedAt: s.updatedAt, by: s.by || '' };
    return out;
  }

  /** Just the stamps — enough for a client to decide whether it needs the values. */
  stamps() {
    const out = {};
    for (const [k, s] of Object.entries(this.sections)) out[k] = s.updatedAt;
    return out;
  }

  /**
   * Merge a client's stamped sections in. A section is taken when its stamp is newer than
   * the one held (or nothing is held); otherwise the client is told it lost and gets the
   * held copy back. Returns `{ applied, kept, sections }` where `sections` holds the current
   * copies of everything the client sent — the client writes `kept` ones over its own.
   */
  put(incoming, { by = '' } = {}) {
    const applied = [];
    const kept = [];
    const sections = {};
    for (const [id, entry] of Object.entries(incoming || {})) {
      if (!SECTION_ID_RE.test(id)) continue;
      const updatedAt = Number(entry?.updatedAt) || 0;
      if (!updatedAt || entry?.value === undefined) continue;
      let bytes;
      try { bytes = Buffer.byteLength(JSON.stringify(entry.value), 'utf8'); } catch { continue; }
      if (bytes > MAX_SECTION_BYTES) continue;
      const held = this.sections[id];
      if (!held || updatedAt > held.updatedAt) {
        this.sections[id] = { value: clone(entry.value), updatedAt, by: String(by || '').slice(0, 40) };
        applied.push(id);
      } else {
        kept.push(id);
      }
      const cur = this.sections[id];
      sections[id] = { value: clone(cur.value), updatedAt: cur.updatedAt, by: cur.by || '' };
    }
    if (applied.length) { this.revision += 1; this.save(); }
    return { applied, kept, sections, revision: this.revision };
  }

  /** Forget one section entirely — the user removed the feature's settings, not just emptied them. */
  remove(id) {
    if (!this.sections[id]) return false;
    delete this.sections[id];
    this.revision += 1;
    this.save();
    return true;
  }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function createPrefsStore(opts) {
  return new PrefsStore(opts).load();
}
