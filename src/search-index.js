// WARM tier — full-corpus search on the LOCAL gateway.
//
// The gateway is the user's own process, so it may hold decrypted records + the key and
// build a real index outside the browser's memory/CPU (see docs/architecture-data-tiers).
// This is the compute core: a BM25 doc store you can incrementally upsert/remove and
// query. Persistence (encrypted at rest) and the HTTP endpoints layer on top of this.
//
// The tokenizer + BM25 are a VENDORED copy of the extension's meeting-index.js so the
// gateway ranks identically to the browser hot tier — keep them in sync. Pure, no deps.

const STOP = new Set((
  'the a an and or but of to in on at for with is are was were be been being it this that these those as i you he '
  + 'if am because need needs needed its lets let '
  + 'she they we us my your our their me him her them so no yes not do does did have has had will would can could '
  + 'should from by about into over under again further then once here there all any both each few more most other '
  + 'some such only own same than too very just dont cant couldnt didnt doesnt hadnt hasnt havent im ive id isnt '
  + 'youre were werent theyre thats theres whats wheres whos wont wouldnt shouldnt okay yeah uh um like really '
  + 'going get got know think mean right well say said also one two how what when where which who whom why'
).split(/\s+/));

function normalizeToken(raw) {
  let word = String(raw || '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/^['+_-]+|['+_-]+$/g, '');
  if (word.endsWith("'s")) word = word.slice(0, -2);
  const compact = word.replace(/['_-]+/g, '');
  if (/^[a-z]\+\+$/.test(word)) return word;
  if (compact.length < 2 || /^\d+$/.test(compact)) return '';
  if (STOP.has(word) || STOP.has(compact)) return '';
  return word.replace(/'/g, '');
}

export function tokenize(text) {
  const m = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'_+-]{1,}/g);
  if (!m) return [];
  return m.map(normalizeToken).filter(Boolean);
}

// A mutable BM25 index over documents. Each doc: { id, text, title?, type?, date? }.
// upsert/remove are incremental (no full rebuild); search() ranks lazily off the current
// term stats. Deletes are honest removals (the whole point of tombstoned sync upstream).
export class SearchIndex {
  constructor() {
    this.docs = new Map();  // id -> { tf: Map<term,count>, len, meta }
    this.df = new Map();    // term -> #docs containing it
    this.totalLen = 0;
  }

  get size() { return this.docs.size; }

  _removeStats(prev) {
    this.totalLen -= prev.len;
    for (const term of prev.tf.keys()) {
      const n = (this.df.get(term) || 0) - 1;
      if (n <= 0) this.df.delete(term); else this.df.set(term, n);
    }
  }

  upsert(doc) {
    if (!doc || !doc.id) return;
    const prev = this.docs.get(doc.id);
    if (prev) this._removeStats(prev);
    const terms = tokenize(`${doc.title || ''}\n${doc.text || ''}`);
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.totalLen += terms.length;
    this.docs.set(doc.id, {
      tf,
      len: terms.length,
      meta: { id: doc.id, title: doc.title || '', type: doc.type || '', date: doc.date || 0 },
    });
  }

  remove(id) {
    const prev = this.docs.get(id);
    if (!prev) return false;
    this._removeStats(prev);
    this.docs.delete(id);
    return true;
  }

  bulk({ upserts = [], removes = [] } = {}) {
    for (const id of removes) this.remove(id);
    for (const d of upserts) this.upsert(d);
    return this.size;
  }

  // Okapi BM25. Returns [{ id, score, title, type, date }] sorted desc, top `limit`.
  search(query, { limit = 10, k1 = 1.5, b = 0.75 } = {}) {
    const qterms = [...new Set(tokenize(query))];
    if (!qterms.length || !this.docs.size) return [];
    const N = this.docs.size;
    const avgdl = this.totalLen / N || 1;
    const idf = new Map();
    for (const t of qterms) {
      const n = this.df.get(t) || 0;
      idf.set(t, n ? Math.log(1 + (N - n + 0.5) / (n + 0.5)) : 0);
    }
    const out = [];
    for (const [id, d] of this.docs) {
      let s = 0;
      for (const t of qterms) {
        const f = d.tf.get(t);
        if (!f) continue;
        s += (idf.get(t) || 0) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / avgdl)));
      }
      if (s > 0) out.push({ id, score: s, ...d.meta });
    }
    out.sort((a, c) => c.score - a.score);
    return out.slice(0, Math.max(1, limit));
  }

  // Serialize/restore for encrypted-at-rest persistence (next slice). Maps → arrays.
  toJSON() {
    return {
      v: 1,
      docs: [...this.docs].map(([id, d]) => ({ id, len: d.len, meta: d.meta, tf: [...d.tf] })),
    };
  }

  static fromJSON(blob) {
    const idx = new SearchIndex();
    for (const d of (blob?.docs || [])) {
      const tf = new Map(d.tf || []);
      idx.docs.set(d.id, { tf, len: d.len || 0, meta: d.meta || { id: d.id } });
      idx.totalLen += d.len || 0;
      for (const t of tf.keys()) idx.df.set(t, (idx.df.get(t) || 0) + 1);
    }
    return idx;
  }
}
