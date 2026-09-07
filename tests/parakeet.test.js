// Parakeet TDT (transducer) engine wiring — offline unit tests. A real decode needs
// the ~650 MB v3 model, so these cover the routing/catalog/helpers that decide WHICH
// engine runs and how it reports, not the ONNX decode itself (validated manually).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the model root at an empty temp dir BEFORE importing the engine, so the
// on-disk tests describe a machine with no models rather than whichever models this
// developer happens to have downloaded. `modelRoot()` reads the env on every call,
// but setting it first keeps the intent obvious.
//
// This is deliberately per-file rather than in scripts/run-tests.mjs: stt.test.js runs
// with allowDownload:false against the REAL models dir, so redirecting it globally
// would leave those tests with nothing to load.
const MODELS = mkdtempSync(join(tmpdir(), 'cp-parakeet-'));
process.env.CHATPANEL_MODELS_DIR = MODELS;
after(() => rmSync(MODELS, { recursive: true, force: true }));

const parakeet = await import('../src/parakeet-engine.js');
const { STT_MODEL_CATALOG, sttModelEngine, isKnownSttModel } = await import('../src/stt-models.js');

const PARAKEET_ID = 'istupakov/parakeet-tdt-0.6b-v3-onnx';

// The files parakeetOnDisk requires, mirroring filesFor() in the engine. Written as
// non-empty stubs: this asks "does the presence check agree?", never "does ONNX load?".
const INT8_FILES = ['config.json', 'vocab.txt', 'nemo128.onnx', 'encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx'];
const FP32_FILES = ['config.json', 'vocab.txt', 'nemo128.onnx', 'encoder-model.onnx', 'decoder_joint-model.onnx', 'encoder-model.onnx.data'];

function installStubModel(files, { truncate = null } = {}) {
  const dir = parakeet.parakeetDir(PARAKEET_ID);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), f === truncate ? '' : 'stub');
  return dir;
}
function removeStubModel() {
  rmSync(parakeet.parakeetDir(PARAKEET_ID), { recursive: true, force: true });
}

test('catalog lists parakeet v3 as a parakeet-tdt engine model', () => {
  const m = STT_MODEL_CATALOG.find((x) => x.id === PARAKEET_ID);
  assert.ok(m, 'parakeet v3 present in catalog');
  assert.equal(m.engine, 'parakeet-tdt');
  assert.ok(isKnownSttModel(PARAKEET_ID));
});

test('sttModelEngine routes transducer vs whisper', () => {
  assert.equal(sttModelEngine(PARAKEET_ID), 'parakeet-tdt');
  assert.equal(sttModelEngine('onnx-community/whisper-base'), 'whisper');
  assert.equal(sttModelEngine('some/unknown-model'), 'whisper'); // default
});

test('isTransducerModelType recognizes the TDT/RNNT config model_types', () => {
  assert.ok(parakeet.isTransducerModelType('nemo-conformer-tdt'));
  assert.ok(parakeet.isTransducerModelType('parakeet_tdt'));
  assert.ok(!parakeet.isTransducerModelType('whisper'));
  assert.ok(!parakeet.isTransducerModelType(''));
});

test('parakeetDtype collapses to the two exported precisions', () => {
  assert.equal(parakeet.parakeetDtype('auto'), 'int8');   // default
  assert.equal(parakeet.parakeetDtype('q8'), 'int8');     // whisper dtype → int8
  assert.equal(parakeet.parakeetDtype(undefined), 'int8');
  assert.equal(parakeet.parakeetDtype('fp32'), 'fp32');   // only explicit fp32 survives
});

test('parakeetOnDisk is false when files are absent', () => {
  removeStubModel();
  assert.equal(parakeet.parakeetOnDisk(PARAKEET_ID), false);
});

// The counterpart that gives the negative test its meaning: without this, a
// parakeetOnDisk() that always returned false would pass the suite.
test('parakeetOnDisk is true once every required file is present', () => {
  installStubModel(INT8_FILES);
  assert.equal(parakeet.parakeetOnDisk(PARAKEET_ID), true);
  removeStubModel();
});

test('a missing file — not just a missing directory — reads as absent', () => {
  installStubModel(INT8_FILES.filter((f) => f !== 'vocab.txt'));
  assert.equal(parakeet.parakeetOnDisk(PARAKEET_ID), false);
  removeStubModel();
});

// "A truncated download must not read as installed" is the engine's stated intent, and
// it is the failure this check exists for: an interrupted 650 MB fetch leaves a
// zero-byte graph that exists() alone would call ready, and ORT then dies at load.
test('a zero-byte file from an interrupted download reads as absent', () => {
  installStubModel(INT8_FILES, { truncate: 'encoder-model.int8.onnx' });
  assert.equal(parakeet.parakeetOnDisk(PARAKEET_ID), false);
  removeStubModel();
});

// fp32 needs the sibling external-weights file; int8 carries its weights inline. An
// fp32 tree missing .onnx.data loads a graph with no weights, so it is not "on disk".
test('fp32 also requires the external-weights sibling', () => {
  installStubModel(FP32_FILES.filter((f) => f !== 'encoder-model.onnx.data'));
  assert.equal(parakeet.parakeetOnDisk(PARAKEET_ID, 'fp32'), false);
  installStubModel(FP32_FILES);
  assert.equal(parakeet.parakeetOnDisk(PARAKEET_ID, 'fp32'), true);
  // ...and the int8 tree is not mistaken for an fp32 one.
  removeStubModel();
  installStubModel(INT8_FILES);
  assert.equal(parakeet.parakeetOnDisk(PARAKEET_ID, 'fp32'), false);
  removeStubModel();
});

test('loadRecognizer with downloads disabled and no local files fails cleanly', async () => {
  removeStubModel();
  await assert.rejects(
    () => parakeet.loadRecognizer({ modelId: PARAKEET_ID, allowDownload: false }),
    /not on disk/,
  );
});
