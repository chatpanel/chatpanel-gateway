// Parakeet TDT (transducer) engine wiring — offline unit tests. A real decode needs
// the ~650 MB v3 model, so these cover the routing/catalog/helpers that decide WHICH
// engine runs and how it reports, not the ONNX decode itself (validated manually).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as parakeet from '../src/parakeet-engine.js';
import { STT_MODEL_CATALOG, sttModelEngine, isKnownSttModel } from '../src/stt-models.js';

const PARAKEET_ID = 'istupakov/parakeet-tdt-0.6b-v3-onnx';

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
  assert.equal(parakeet.parakeetOnDisk(PARAKEET_ID), false);
});

test('loadRecognizer with downloads disabled and no local files fails cleanly', async () => {
  await assert.rejects(
    () => parakeet.loadRecognizer({ modelId: PARAKEET_ID, allowDownload: false }),
    /not on disk/,
  );
});
