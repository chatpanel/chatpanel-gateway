// Pocket TTS wiring. The generation loop itself needs the 146 MB bundle and is
// verified by hand (8-9x realtime, distinct voices per sample); these cover the
// parts that decide WHETHER it runs and WHAT it is handed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODELS = mkdtempSync(join(tmpdir(), 'cp-pocket-'));
process.env.CHATPANEL_MODELS_DIR = MODELS;
after(() => rmSync(MODELS, { recursive: true, force: true }));

const pt = await import('../src/pocket-tts-engine.js');
const { ttsModelEngine, ttsModelBundle, ttsModel, TTS_MODEL_CATALOG } = await import('../src/tts-models.js');

test('the catalog routes pocket-tts to its own engine, not transformers', () => {
  assert.equal(ttsModelEngine('kyutai/pocket-tts'), 'pocket-tts');
  assert.equal(ttsModelBundle('kyutai/pocket-tts'), 'english_2026-04');
  const m = ttsModel('kyutai/pocket-tts');
  assert.equal(m.customVoices, true, 'it exists to clone a voice');
  assert.equal(m.voices, false, 'and has no built-in ones');
  assert.equal(m.sampleRate, pt.SAMPLE_RATE);
});

test('exactly one model is marked recommended, and it is the cloning one', () => {
  const reco = TTS_MODEL_CATALOG.filter((m) => m.recommended);
  assert.equal(reco.length, 1);
  assert.equal(reco[0].id, 'kyutai/pocket-tts');
});

// The bundle is five graphs plus a tokenizer; a partial download must not read as
// installed, or the engine loads and dies on a missing session.
test('bundleOnDisk requires every file, and non-empty', () => {
  const dir = pt.bundleDir('english_2026-04');
  assert.equal(pt.bundleOnDisk('english_2026-04'), false, 'nothing downloaded yet');
  mkdirSync(dir, { recursive: true });
  const files = ['bundle.json', 'tokenizer.model', 'bos_before_voice.npy',
    'text_conditioner_int8.onnx', 'mimi_encoder_int8.onnx', 'mimi_decoder_int8.onnx',
    'flow_lm_main_int8.onnx', 'flow_lm_flow_int8.onnx'];
  for (const f of files.slice(0, -1)) writeFileSync(join(dir, f), 'stub');
  assert.equal(pt.bundleOnDisk('english_2026-04'), false, 'one missing graph means not installed');
  writeFileSync(join(dir, files.at(-1)), 'stub');
  assert.equal(pt.bundleOnDisk('english_2026-04'), true);
  // A truncated download must not count either.
  writeFileSync(join(dir, 'mimi_encoder_int8.onnx'), '');
  assert.equal(pt.bundleOnDisk('english_2026-04'), false, 'a zero-byte graph is not installed');
  rmSync(dir, { recursive: true, force: true });
});

// voices.bin is the reference implementation's PREDEFINED speakers. It is not in
// the weights repo, and requiring it would make every download fail.
test('the bundle does not require voices.bin', () => {
  const dir = pt.bundleDir('english_2026-04');
  mkdirSync(dir, { recursive: true });
  for (const f of ['bundle.json', 'tokenizer.model', 'bos_before_voice.npy',
    'text_conditioner_int8.onnx', 'mimi_encoder_int8.onnx', 'mimi_decoder_int8.onnx',
    'flow_lm_main_int8.onnx', 'flow_lm_flow_int8.onnx']) writeFileSync(join(dir, f), 'stub');
  assert.equal(pt.bundleOnDisk('english_2026-04'), true, 'voices.bin must not be required');
  rmSync(dir, { recursive: true, force: true });
});

test('NPY parsing reads shape and float32 data', () => {
  // v1 header: magic + version + uint16 len + dict, the whole preamble padded to a
  // multiple of 64 bytes (which is what tripped this fixture the first time).
  const dict = "{'descr': '<f4', 'fortran_order': False, 'shape': (1, 3), }";
  const preamble = 10 + dict.length + 1;
  const header = dict + ' '.repeat((64 - (preamble % 64)) % 64) + '\n';
  const head = Buffer.concat([
    Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(header.length, 0); return b; })(),
    Buffer.from(header),
  ]);
  assert.equal((head.length) % 64, 0, 'the fixture itself must be a valid NPY preamble');
  const body = Buffer.alloc(12);
  body.writeFloatLE(1.5, 0); body.writeFloatLE(-2.5, 4); body.writeFloatLE(0.25, 8);
  const { data, shape } = pt.parseNpyFloat32(Buffer.concat([head, body]));
  assert.deepEqual(shape, [1, 3]);
  assert.deepEqual(Array.from(data), [1.5, -2.5, 0.25]);
});

test('a file that is not NPY is refused rather than read as garbage', () => {
  assert.throws(() => pt.parseNpyFloat32(Buffer.from('not an npy file at all')), /NPY/);
});

test('an unloaded engine refuses work instead of throwing something opaque', async () => {
  const engine = new pt.PocketTTS();
  assert.equal(engine.ready, false);
  await assert.rejects(() => engine.encodeVoice(new Float32Array(1000)), /not loaded/);
  await assert.rejects(() => engine.synth('hi', { voice: { data: new Float32Array(10), shape: [1, 1, 10] } }), /not loaded/);
});

test('synthesis without a voice is refused — there is nothing to speak as', async () => {
  const engine = new pt.PocketTTS();
  engine.ready = true; // pretend loaded; the voice check must come first
  await assert.rejects(() => engine.synth('hi', {}), /needs a voice/);
  await assert.rejects(() => engine.synth('hi', { voice: { data: new Float32Array(0), shape: [] } }), /needs a voice/);
});
