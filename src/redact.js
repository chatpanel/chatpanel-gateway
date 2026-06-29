// Gateway-level redaction: blind an arbitrary set of text segments into one
// shared vault, so [[PERSON_1]] means the same entity across every message in a
// request. Protocol adapters (openai.js / anthropic.js) extract the text, call
// redactSegments, and splice the redacted strings back in.
//
// A fresh vault per request is correct here: coding agents resend the full
// history each turn and the engine assigns tokens by first-appearance, so the
// mapping is self-consistent within the request. (Same reasoning as the
// extension's pii-pipeline.)

import { createVault, redactText, detectEntities, effectiveTier, gatedDictionary } from '@chatpanel/pii';
import * as engine from './ner-engine.js';

// tier: 'basic' | 'full'. For 'full' we run the local detector over the combined
// text to harvest names/orgs, then redact every segment against that entity set.
// `isPro` applies the SAME free/Pro gating as the extension (shared package):
// free → deterministic 'basic' tier + a capped dictionary; Pro → full tier.
export async function redactSegments(segments, redactionCfg, { signal, isPro = true } = {}) {
  const vault = createVault();
  const texts = segments.map((s) => s.get()).filter((t) => typeof t === 'string' && t);
  if (texts.length === 0) return { vault, count: 0 };

  // effectiveTier downgrades 'full'→'basic' for free; gatedDictionary trims to the
  // free limit. This reuses chatpanel-pii's gating so the gateway and extension
  // enforce free/Pro identically.
  const tier = effectiveTier({ tier: redactionCfg.tier }, isPro);
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
  return { vault, count };
}

// A `segment` is a tiny getter/setter over wherever the text lives in the parsed
// request body, so we can redact in place without rebuilding the structure.
export function segment(getter, setter) {
  return { get: getter, set: setter };
}
