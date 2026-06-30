// Gateway-level redaction: blind an arbitrary set of text segments into one
// shared vault, so [[PERSON_1]] means the same entity across every message in a
// request. Protocol adapters (openai.js / anthropic.js) extract the text, call
// redactSegments, and splice the redacted strings back in.
//
// A fresh vault per request is correct here: coding agents resend the full
// history each turn and the engine assigns tokens by first-appearance, so the
// mapping is self-consistent within the request. (Same reasoning as the
// extension's pii-pipeline.)

import { createVault, redactText, detectEntities, gatedDictionary, sanitizeUnicode } from '@chatpanel/pii';
import * as engine from './ner-engine.js';

// tier: 'basic' | 'full'. For 'full' we run the local detector over the combined
// text to harvest names/orgs, then redact every segment against that entity set.
//
// Free vs Pro on the gateway: the free trial is limited by a REQUEST QUOTA
// (freegate.js), not by downgrading quality — so free users get the REAL tier
// (names/orgs via NER) within their allowance. The custom dictionary, though, is
// still a Pro power feature: gatedDictionary caps it to FREE_DICT_LIMIT for free.
export async function redactSegments(segments, redactionCfg, { signal, isPro = true } = {}) {
  const vault = createVault();

  // De-steganography FIRST (before detection). Invisible/format Unicode is a triple
  // threat at this boundary: it can split a value so the detector misses it and the
  // model reassembles real PII (redaction bypass), smuggle a hidden instruction via
  // Tag chars (ASCII smuggling), or carry a fingerprint/watermark a client injected.
  // We strip it in place so detection sees clean text and the forwarded request is
  // clean too. Counted (not silently dropped) so the server can report it.
  let sanitized = 0;
  for (const seg of segments) {
    const before = seg.get();
    if (typeof before !== 'string' || !before) continue;
    const { clean, removed } = sanitizeUnicode(before);
    if (removed) { seg.set(clean); sanitized += removed; }
  }

  const texts = segments.map((s) => s.get()).filter((t) => typeof t === 'string' && t);
  if (texts.length === 0) return { vault, count: 0, sanitized };

  // Use the configured tier as-is (no free downgrade — the quota is the free gate),
  // but keep the dictionary capped for free via the shared chatpanel-pii gate.
  const tier = redactionCfg.tier === 'full' ? 'full' : 'basic';
  const dictionary = gatedDictionary(redactionCfg, isPro);

  // Detection source: a USER-configured external detector takes precedence; else
  // the bundled in-process engine (no second port — we hand pii-detect a fetchImpl
  // that runs the model in-process instead of doing real HTTP). Either way we reuse
  // @chatpanel/pii's caching / timeout / type-gating — one source of truth.
  const det = redactionCfg.detection;
  const useExternal = !!(det && det.backend && det.backend !== 'off');
  const useEngine = !useExternal && engine.isReady();

  let entities = [];
  if (tier === 'full' && (useExternal || useEngine)) {
    // One detection pass over the joined text — cached + fail-open, so a slow/broken
    // detector never blocks the request (the deterministic layer still runs). Give it
    // a generous CEILING (matching the extension): a fast detector returns in well
    // under a second, but a cold one must be allowed to finish; on timeout the turn
    // falls back to dictionary/deterministic-only redaction.
    const detection = useEngine
      ? { backend: 'endpoint', url: 'inproc:ner', timeoutMs: 30000, maxChars: 8000, types: det?.types }
      : { ...det, timeoutMs: Math.max(Number(det.timeoutMs) || 0, 30000) };
    const fetchImpl = useEngine ? engine.fetchAdapter : undefined;
    try {
      entities = await detectEntities(texts.join('\n\n'), { detection }, { signal, fetchImpl });
    } catch {
      entities = [];
    }
  }

  const opts = { tier, entities, dictionary };

  let count = 0;
  for (const seg of segments) {
    const before = seg.get();
    if (typeof before !== 'string' || !before) continue;
    const after = redactText(before, vault, opts);
    if (after !== before) count++;
    seg.set(after);
  }
  return { vault, count, sanitized };
}

// A `segment` is a tiny getter/setter over wherever the text lives in the parsed
// request body, so we can redact in place without rebuilding the structure.
export function segment(getter, setter) {
  return { get: getter, set: setter };
}
