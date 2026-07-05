// H3: verifyModelWeights — fail-closed on a real hash mismatch, warn-and-allow when
// a model/file isn't in the committed manifest (so an empty manifest never bricks
// loads). Pure logic, exercised with a synthetic model dir + in-memory manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyModelWeights, sha256File } from '../src/model-integrity.js';

// Lay down modelsDir/<org>/<name>/onnx/model_quantized.onnx with known bytes.
function fakeModel(bytes = 'weights-v1') {
  const root = mkdtempSync(join(tmpdir(), 'cp-models-'));
  const dir = join(root, 'Xenova', 'bert-base-NER', 'onnx');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'model_quantized.onnx');
  writeFileSync(file, bytes);
  return { root, file, rel: 'onnx/model_quantized.onnx', id: 'Xenova/bert-base-NER' };
}

test('matching hash → verified, file kept', () => {
  const m = fakeModel();
  const manifest = { [m.id]: { [m.rel]: sha256File(m.file) } };
  const r = verifyModelWeights(m.id, { modelsDir: m.root, manifest });
  assert.equal(r.verified, true);
  assert.equal(r.checked, 1);
  assert.equal(existsSync(m.file), true);
});

test('hash mismatch → throws and deletes the tampered file (fail-closed)', () => {
  const m = fakeModel('weights-v1');
  const manifest = { [m.id]: { [m.rel]: createHash('sha256').update('the-good-bytes').digest('hex') } };
  assert.throws(() => verifyModelWeights(m.id, { modelsDir: m.root, manifest }), /mismatch/);
  assert.equal(existsSync(m.file), false, 'tampered file deleted');
});

test('unlisted model → warn-and-allow (no throw)', () => {
  const m = fakeModel();
  const r = verifyModelWeights(m.id, { modelsDir: m.root, manifest: {} });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'unlisted');
  assert.equal(existsSync(m.file), true);
});

test('listed file absent on disk → skipped, no throw', () => {
  const m = fakeModel();
  const manifest = { [m.id]: { 'onnx/missing.onnx': 'deadbeef' } };
  const r = verifyModelWeights(m.id, { modelsDir: m.root, manifest });
  assert.equal(r.checked, 0);
  assert.equal(existsSync(m.file), true);
});
