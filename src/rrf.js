// VENDORED from @chatpanel/events/rrf.js — edit there, then copy over.
// Same pattern as observability.js: one pure module copied in rather than pulling the whole
// events package. Source of truth: chatpanel-events/rrf.js.
//
// rrf.js — Reciprocal Rank Fusion, and the query planning that feeds it.
//
// One question rarely makes one good keyword query. "What was the outcome of the Ben tooling
// demo?" and "Ben demo decisions action items" retrieve different things, and the answer is
// usually in the union. RRF merges several ranked lists without needing their scores to be
// comparable — each list contributes 1/(k+rank) — which is exactly the situation here: BM25
// scores, vector distances and a hot/warm split are all on different scales.
//
// Pure and dependency-free, so the identical fusion runs in the extension (hot+warm), the
// gateway (multi-query search) and any future client. The extension had this privately; it
// lives here now so the gateway doesn't grow a second, subtly different copy.

/**
 * Fuse ranked id lists. `lists` is an array of arrays of ids, each already in rank order.
 * k dampens the head of each list (60 is the standard default). limit 0 = everything.
 */
export function fuseRRF(lists, { k = 60, limit = 0 } = {}) {
  const score = new Map();
  for (const list of lists || []) {
    if (!Array.isArray(list)) continue;
    list.forEach((id, rank) => {
      if (id == null) return;
      score.set(id, (score.get(id) || 0) + 1 / (k + rank));
    });
  }
  const out = [...score.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score);
  return limit > 0 ? out.slice(0, limit) : out;
}

// Words that carry no retrieval signal but do dilute BM25 — dropped to build a keyword-only
// variant of a natural-language question.
const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our ought shall should '
  + 'so than that the their them then there these they this those to um was we were what when where which who whom why will with would you your about tell show give find get '
  + 'please could-you was-there did-we').split(/\s+/));

/**
 * Turn one natural-language question into a small set of complementary queries — the cheap,
 * deterministic half of query expansion. No model call, so it costs nothing and cannot fail.
 *
 * A CALLING AGENT can do better (it understands the domain), which is why the tools accept an
 * explicit `queries` list; these variants are the floor, not the ceiling.
 */
export function planQueries(question, { extra = [], max = 4 } = {}) {
  const q = String(question || '').trim();
  const out = [];
  const seen = new Set();
  const add = (s) => {
    const t = String(s || '').trim().replace(/\s+/g, ' ');
    const key = t.toLowerCase();
    if (t && !seen.has(key)) { seen.add(key); out.push(t); }
  };

  add(q);                                    // the question as asked
  for (const e of extra) add(e);             // whatever the agent proposed — it knows more

  const words = q.toLowerCase().match(/[a-z0-9][a-z0-9'’_+-]*/g) || [];
  const keywords = words.filter((w) => !STOP.has(w) && w.length > 2);
  if (keywords.length >= 2) add(keywords.join(' '));          // keyword-only: BM25's best shape
  // The rarest-looking terms (longest words are a decent proxy for specificity) — helps when
  // the full question is too broad to rank anything well.
  if (keywords.length > 3) add([...keywords].sort((a, b) => b.length - a.length).slice(0, 3).join(' '));

  return out.slice(0, Math.max(1, max));
}

/**
 * Run several queries through one `search(query, opts)` function and fuse the results by id.
 * `search` returns arrays of { id, ... }; the fused output keeps the richest record seen for
 * each id (so snippets survive) and reports which queries found it — the "why is this here"
 * a reader needs when a multi-query search surfaces something unexpected.
 */
export async function multiSearch(queries, search, { limit = 10, k = 60 } = {}) {
  const lists = [];
  const byId = new Map();
  const foundBy = new Map();
  for (const q of queries || []) {
    let rows = [];
    try { rows = (await search(q)) || []; } catch { rows = []; } // one bad query must not sink the rest
    lists.push(rows.map((r) => r.id));
    for (const r of rows) {
      if (!byId.has(r.id) || (!byId.get(r.id).snippet && r.snippet)) byId.set(r.id, r);
      if (!foundBy.has(r.id)) foundBy.set(r.id, []);
      foundBy.get(r.id).push(q);
    }
  }
  return fuseRRF(lists, { k, limit }).map(({ id, score }) => ({
    ...byId.get(id), id, score, foundBy: foundBy.get(id) || [],
  }));
}
