// MEMORY on the gateway — the durable facts about the user, available to every local agent.
//
// The extension has its own copy in chrome.storage; this is the one CLI agents can reach.
// Claude Code, Codex, OpenCode and anything else that speaks MCP get the user's standing
// preferences through `chatpanel-gateway mcp`, so "call me Alex, never open with a preamble"
// holds in the terminal exactly as it does in the side panel. That was the whole point of
// putting memory in a shared contract rather than in the panel.
//
// TWO STORES, ONE TRUTH, because reconcile is idempotent. The extension pushes its memories
// here and pulls back what the agents wrote (see the extension's warm-sync). A naive
// two-way sync would duplicate on every pass; this one converges because `reconcile` keys on
// the FACT (its slot, then its wording), not on a row id — so pushing the same memory twice
// is a no-op and a corrected one supersedes rather than accumulating. The merge is the same
// function on both sides, from the same file, which is the only reason that holds.
//
// ENCRYPTED AT REST with the same local key as the history store — this is the on-device
// tier, and a local key is correct for it.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  normalizeMemory, reconcile, recall, memoryBlock, matchForForget, pruneMemories, markUsed,
  isValidMemory, upcastMemory, DEFAULT_MAX_MEMORIES,
} from './memory.js';

const DIR = join(os.homedir(), '.chatpanel');
const STORE_PATH = process.env.CHATPANEL_MEMORY_STORE || join(DIR, 'memory-store.enc');
const KEY_PATH = process.env.CHATPANEL_HISTORY_KEY || join(DIR, 'history-key');

const uid = () => `mem_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

// The same local key file the history store uses. One device key, not two: a second key file
// is a second thing to lose, and both stores are the same tier with the same threat model.
function loadOrCreateKey() {
  try {
    if (existsSync(KEY_PATH)) return Buffer.from(readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
  } catch { /* regenerate below */ }
  const key = randomBytes(32);
  mkdirSync(dirname(KEY_PATH), { recursive: true });
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

export class MemoryStore {
  constructor({ storePath = STORE_PATH } = {}) {
    this.storePath = storePath;
    this.memories = [];
    this._key = null;
  }

  get size() { return this.memories.length; }

  get bytes() {
    try { return existsSync(this.storePath) ? statSync(this.storePath).size : 0; } catch { return 0; }
  }

  key() {
    if (!this._key) this._key = loadOrCreateKey();
    return this._key;
  }

  // Fail-open on a missing or corrupt file — memory is an enhancement, and refusing to start
  // the gateway because one cache file is unreadable trades a small loss for a total one.
  // A record that fails validation is DROPPED, never repaired: it would otherwise be handed
  // to a model as a standing fact about the user.
  load() {
    try {
      if (!existsSync(this.storePath)) return this;
      const raw = JSON.parse(decrypt(this.key(), JSON.parse(readFileSync(this.storePath, 'utf8'))).toString('utf8'));
      this.memories = (Array.isArray(raw) ? raw : [])
        .map((m) => { try { return upcastMemory(m); } catch { return null; } })
        .filter((m) => m && isValidMemory(m));
    } catch {
      this.memories = [];
    }
    return this;
  }

  persistNow() {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(encrypt(this.key(), Buffer.from(JSON.stringify(this.memories), 'utf8'))), { mode: 0o600 });
    } catch { /* a failed cache write must not fail the call that triggered it */ }
  }

  #commit(list) {
    const { kept } = pruneMemories(list, { now: Date.now(), max: DEFAULT_MAX_MEMORIES });
    this.memories = kept.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    this.persistNow();
    return this.memories;
  }

  list() { return this.memories; }

  /** Save one memory, reconciled against what is held. The only write path. */
  remember(input) {
    const now = Date.now();
    const { action, record, replaces } = reconcile(this.memories, input, { now, newId: uid });
    this.#commit([record, ...(replaces ? this.memories.filter((m) => m.id !== replaces.id) : this.memories)]);
    return { action, record, replaces };
  }

  /** Drop by id, or by however a person named it ("forget the Frankfurt thing"). */
  forget(query) {
    const q = String(query || '').trim();
    const hits = this.memories.some((m) => m.id === q)
      ? this.memories.filter((m) => m.id === q)
      : matchForForget(this.memories, q);
    if (!hits.length) return { removed: [] };
    const gone = new Set(hits.map((m) => m.id));
    this.#commit(this.memories.filter((m) => !gone.has(m.id)));
    return { removed: hits };
  }

  /** The memories a turn should carry, and the rendered block — the SAME ranking the panel uses. */
  recall({ text = '', scopes = ['global'], limit, maxChars } = {}) {
    const chosen = recall(this.memories, {
      text, scopes, now: Date.now(),
      ...(limit ? { limit } : {}),
      ...(maxChars ? { maxChars } : {}),
    });
    if (chosen.length) {
      this.memories = markUsed(this.memories, chosen.map((m) => m.id), { now: Date.now() });
      this.persistNow();
    }
    return { memories: chosen, block: memoryBlock(chosen) };
  }

  /**
   * Bulk merge from the extension's sync. Every incoming record goes through `reconcile`, so
   * a repeated push is a no-op rather than a doubling — that idempotence is what makes the
   * two-way sync safe.
   */
  bulk({ upserts = [], removes = [] } = {}) {
    for (const id of removes) {
      const gone = new Set([String(id)]);
      this.memories = this.memories.filter((m) => !gone.has(m.id));
    }
    let merged = 0;
    for (const raw of upserts) {
      let candidate;
      try { candidate = normalizeMemory(raw, { now: Date.now(), newId: uid }); } catch { continue; }
      const { action, record, replaces } = reconcile(this.memories, candidate, { now: Date.now(), newId: uid });
      if (action === 'duplicate') continue;
      this.#commit([record, ...(replaces ? this.memories.filter((m) => m.id !== replaces.id) : this.memories)]);
      merged += 1;
    }
    if (removes.length && !merged) this.#commit(this.memories);
    return { size: this.memories.length, merged };
  }

  clear() {
    const dropped = this.memories.length;
    this.#commit([]);
    return dropped;
  }
}

export async function createMemoryStore(opts) {
  return new MemoryStore(opts).load();
}
