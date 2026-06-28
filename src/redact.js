// Gateway-level redaction: blind an arbitrary set of text segments into one
// shared vault, so [[PERSON_1]] means the same entity across every message in a
// request. Protocol adapters (openai.js / anthropic.js) extract the text, call
// redactSegments, and splice the redacted strings back in.
//
// A fresh vault per request is correct here: coding agents resend the full
// history each turn and the engine assigns tokens by first-appearance, so the
// mapping is self-consistent within the request. (Same reasoning as the
// extension's pii-pipeline.)

import { createVault, redactText, detectEntities, effectiveTier, gatedDictionary } from 'chatpanel-pii';

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

  let entities = [];
  if (tier === 'full' && redactionCfg.detection?.backend && redactionCfg.detection.backend !== 'off') {
    // One detection pass over the joined text — the detector is cached + fail-open,
    // so a slow/broken NER service never blocks the request (deterministic layer
    // still runs).
    try {
      entities = await detectEntities(texts.join('\n\n'), { detection: redactionCfg.detection }, { signal });
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
