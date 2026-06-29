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

import * as engine from './ner-engine.js';

export function startNer(cfg) {
  const n = cfg.ner;
  if (!n || !n.autostart) return null;

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
