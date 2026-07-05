// Model-weight integrity verification (H3).
//
// The gateway downloads ONNX model weights (NER / Whisper / Parakeet) from the
// dl.chatpanel.net mirror or Hugging Face and loads them straight into an ONNX
// runtime. A compromised mirror, an HF repo takeover, or a MITM on a downgraded
// connection could therefore feed a malicious model into native code. This module
// verifies a downloaded model's weight files against committed SHA-256 hashes.
//
// Design (deliberately non-breaking):
//   • Hashes live in the committed `model-hashes.json` — a { modelId: { relPath:
//     sha256 } } map generated on a TRUSTED host by `tools/gen-model-hashes.mjs`.
//   • FAIL-CLOSED only on a genuine mismatch: a listed file whose hash differs is
//     deleted and the load is refused (throws). That's the security event.
//   • WARN-AND-ALLOW everywhere else: a model not in the manifest, or a listed file
//     not yet on disk, logs loudly and proceeds — so an empty/partial manifest never
//     bricks model loading, and shipping the mechanism before the hashes are
//     populated is safe. (Populate on a trusted machine to switch protection on.)
//   • Verified on the DOWNLOAD path (when weights first arrive from the network —
//     the supply-chain moment), not on every offline load (avoids re-hashing 100s of
//     MB each boot).

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_PATH = fileURLToPath(new URL('./model-hashes.json', import.meta.url));
let _manifest = null;

// { modelId: { 'onnx/model_quantized.onnx': '<sha256>' , … } }. Keys starting with
// '_' are metadata (schema note) and ignored. Missing/invalid file → empty map
// (verification simply becomes warn-and-allow for everything).
export function loadHashManifest(path = MANIFEST_PATH) {
  if (_manifest && path === MANIFEST_PATH) return _manifest;
  let parsed = {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('_') && v && typeof v === 'object') parsed[k] = v;
    }
  } catch { parsed = {}; }
  if (path === MANIFEST_PATH) _manifest = parsed;
  return parsed;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Verify a model's weight files under `modelsDir`. Returns a result object; THROWS
// only on a real hash mismatch (fail-closed). `modelsDir` is the model cache root
// (e.g. ~/.chatpanel/models); the per-model dir is modelsDir/<org>/<name>.
/**
 * @param {string} modelId
 * @param {{ modelsDir?: string, log?: (msg: string) => void, manifest?: Record<string, Record<string, string>> }} [opts]
 */
export function verifyModelWeights(modelId, { modelsDir, log = () => {}, manifest = loadHashManifest() } = {}) {
  const expected = manifest[modelId];
  if (!expected || Object.keys(expected).length === 0) {
    log(`[integrity] no recorded hashes for ${modelId} — skipping verification `
      + `(run tools/gen-model-hashes.mjs on a trusted host to enable)`);
    return { verified: false, reason: 'unlisted', checked: 0 };
  }
  const dir = join(modelsDir, ...modelId.split('/'));
  let checked = 0;
  for (const [rel, wantSha] of Object.entries(expected)) {
    const p = join(dir, ...rel.split('/'));
    if (!existsSync(p)) { log(`[integrity] ${modelId}: listed file ${rel} not on disk — skipping`); continue; }
    const gotSha = sha256File(p);
    if (gotSha !== wantSha) {
      try { rmSync(p); } catch { /* best effort */ }
      throw new Error(
        `[integrity] ${modelId}/${rel} SHA-256 mismatch `
        + `(expected ${wantSha.slice(0, 12)}…, got ${gotSha.slice(0, 12)}…) — `
        + `deleted the file and refusing to load a tampered model`,
      );
    }
    checked++;
  }
  if (checked) log(`[integrity] ${modelId}: ${checked} weight file(s) verified ✓`);
  return { verified: checked > 0, reason: checked ? 'ok' : 'no-files-present', checked };
}
