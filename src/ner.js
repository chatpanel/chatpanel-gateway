// Managed in-process NER. When cfg.ner.autostart is on, launching the gateway
// loads the bundled ONNX entity detector (./ner-engine.js) and flips redaction to
// full tier once it's ready — name/org redaction with a single command, no second
// process, no second port, no Python.
//
// Fail-open by design: if the model can't load (e.g. first run, no network, no
// cached weights), we log a one-line hint and the gateway keeps running with
// deterministic-only redaction. redact.js consults the engine directly, so we do
// NOT mutate cfg.redaction.detection here (that field is reserved for a user's own
// external detector, which takes precedence — see below).
//
// `ensureNer` (bottom) is the same thing on demand, for the case autostart cannot cover:
// a config that says autostart:false, weights already on disk, and a client asking for
// detection right now.

import * as engine from './ner-engine.js';
import { persistConfig, configPath } from './configstore.js';

export function startNer(cfg) {
  const n = cfg.ner;
  if (!n || !n.autostart) return null;

  // Migration: versions <0.6 persisted redaction.detection → the bundled spaCy
  // server on :9009 (now removed). That's NOT a user's external detector — left in
  // place it makes us skip the new in-process engine and probe a dead port. Clear
  // it (and the dead ner.port) so the engine loads, and persist the cleanup.
  const d = cfg.redaction?.detection;
  if (d && d.url && /127\.0\.0\.1:9009\/ner/.test(d.url)) {
    cfg.redaction.detection = { backend: 'off' };
    if (cfg.ner) delete cfg.ner.port;
    try { persistConfig(cfg, configPath()); } catch { /* best effort */ }
    console.log('[ner] migrated legacy spaCy detector config (:9009) → in-process engine');
  }

  // Respect a USER-configured external detector (a custom NER endpoint or a local
  // LLM): don't load the bundled engine — just apply the full-tier bump so their
  // detector is actually used.
  const det = cfg.redaction?.detection;
  if (det && det.backend && det.backend !== 'off') {
    if (n.enableFullTier && cfg.redaction.tier !== 'full') cfg.redaction.tier = 'full';
    console.log(`[ner] using configured detector (${det.backend} ${det.url || ''}) — full tier ${cfg.redaction.tier === 'full' ? 'on' : 'off'}`);
    return null;
  }

  let stopped = false;
  engine.init({
    model: n.model,
    allowDownload: n.allowDownload !== false,
    onLog: (m) => { if (!stopped) console.log(m); },
  }).then(() => {
    if (stopped) return;
    if (engine.isReady() && n.enableFullTier && cfg.redaction.tier !== 'full') {
      cfg.redaction.tier = 'full';
      console.log(`[ner] full tier on — name/org redaction active`);
    }
  }).catch((e) => { if (!stopped) console.log(`[ner] init error (${e.message}) — deterministic-only`); });

  // Nothing to kill (no child process); just stop logging after shutdown.
  return { stop() { stopped = true; } };
}

/**
 * START THE BUNDLED DETECTOR BECAUSE SOMEONE ASKED FOR DETECTION.
 *
 * `startNer` only runs at boot, and only when `ner.autostart` is on. Everything after that
 * assumed the engine was either running or deliberately not wanted — so a config carrying
 * `autostart:false` (older gateways wrote it, and it survives every upgrade) left POST /ner
 * answering 503 forever, with the weights sitting on disk the whole time. The extension's
 * composer showed "name detection is not answering", and every real turn quietly fell back
 * to deterministic-only redaction: names, organisations and places went to the model in full.
 *
 * A request for entity detection IS the intent to detect, so this starts the engine on that
 * request instead of waiting for a restart the user has no reason to perform.
 *
 * Two limits keep it from being a surprise. It never DOWNLOADS: weights arrive through the
 * model manager, which shows progress, so a preview keystroke can never kick off a hundred
 * megabytes. And it defers to a user's own external detector exactly as `startNer` does —
 * that field means "use mine", not "use mine if it happens to be up".
 *
 * Returns the engine state after the attempt; never throws.
 */
export async function ensureNer(cfg, { log = (m) => console.log(m) } = {}) {
  const det = cfg?.redaction?.detection;
  if (det && det.backend && det.backend !== 'off') return 'external';

  const st = engine.state();
  if (st === 'ready') return st;
  // A load already in flight (or one that already failed) — join it rather than starting a
  // second one. engine.init() is single-flight, so this is just the wait.
  if (st === 'loading' || st === 'downloading' || st === 'error') {
    try { await engine.init(); } catch { /* fail-open: deterministic-only */ }
    return engine.state();
  }

  const n = cfg?.ner || {};
  const model = n.model || undefined;
  if (!engine.modelOnDisk(model)) return 'not-downloaded';

  try {
    await engine.init({ model, allowDownload: false, onLog: log });
  } catch (e) {
    log(`[ner] on-demand load failed (${e.message}) — deterministic-only`);
    return engine.state();
  }
  if (engine.isReady()) {
    log(`[ner] started on demand — model ${engine.health().model} — entity detection active`);
    if (n.enableFullTier !== false && cfg.redaction && cfg.redaction.tier !== 'full') {
      cfg.redaction.tier = 'full';
      log('[ner] full tier on — name/org redaction active');
    }
  }
  return engine.state();
}
