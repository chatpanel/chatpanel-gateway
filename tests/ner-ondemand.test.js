// STARTING THE DETECTOR BECAUSE SOMEONE ASKED FOR DETECTION.
//
// `startNer` runs once, at boot, and only when `ner.autostart` is on. A config carrying
// autostart:false (older gateways wrote it, and it survives every upgrade) therefore left
// the engine off for the life of the process: POST /ner answered 503, the extension's
// composer read "name detection is not answering", and every chat turn fell back to
// deterministic-only redaction with the weights sitting on disk the whole time.
//
// These cover the decisions that keep the on-demand path from being a surprise — it never
// downloads, and it never overrides a user's own detector or their explicit tier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// An empty model dir: nothing is installed, so nothing can load. Set before the engine
// module resolves its root.
process.env.CHATPANEL_MODELS_DIR = mkdtempSync(join(tmpdir(), 'cp-no-models-'));

const { ensureNer } = await import('../src/ner.js');

const base = () => ({
  redaction: { tier: 'basic', detection: { backend: 'off' } },
  ner: { autostart: false, model: 'Xenova/bert-base-NER', enableFullTier: true },
});

test('a user\'s own detector is left alone — "use mine" is not "use mine if it is up"', async () => {
  const cfg = base();
  cfg.redaction.detection = { backend: 'endpoint', url: 'http://127.0.0.1:9/ner' };
  assert.equal(await ensureNer(cfg), 'external');
});

test('it never downloads — absent weights are reported, not fetched', async () => {
  const cfg = base();
  assert.equal(await ensureNer(cfg), 'not-downloaded');
  // And the tier stays where the user left it: claiming 'full' with no detector behind it
  // is the exact overstatement this whole path exists to avoid.
  assert.equal(cfg.redaction.tier, 'basic');
});

test('autostart:false does not block it — the request is the intent', async () => {
  const cfg = base();
  cfg.ner.autostart = false;
  // With no weights the answer is the same either way; what matters is that autostart is
  // not consulted, so a config written years ago cannot switch detection off forever.
  assert.equal(await ensureNer(cfg), 'not-downloaded');
});

test('it never throws — redaction must survive a broken detector', async () => {
  await assert.doesNotReject(() => ensureNer(null));
  await assert.doesNotReject(() => ensureNer({}));
});
