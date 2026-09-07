// TTS (Kokoro) wiring — offline unit tests. A real synthesis needs the ~90-330 MB
// model, so these cover the catalog, validation, chunking and WAV framing that
// decide WHAT gets synthesized and how it is framed, not the ONNX forward pass
// (validated end-to-end by hand against POST /tts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same isolation as parakeet.test.js, for the same reason: the on-disk checks must
// describe an empty machine, not whichever models this developer has downloaded.
const MODELS = mkdtempSync(join(tmpdir(), 'cp-tts-'));
process.env.CHATPANEL_MODELS_DIR = MODELS;
after(() => rmSync(MODELS, { recursive: true, force: true }));

const tts = await import('../src/tts-engine.js');
const {
  TTS_VOICES, TTS_MODEL_CATALOG, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, MAX_TTS_CHARS,
  isKnownVoice, isValidVoiceId, isValidCustomTtsId, isKnownTtsModel, voiceLang, ttsModel, ttsModelDtype,
  ttsModelEngine, isValidTtsDtype,
} = await import('../src/tts-models.js');

test('catalog: the default model and voice are both listed', () => {
  assert.ok(isKnownTtsModel(DEFAULT_TTS_MODEL));
  assert.ok(isKnownVoice(DEFAULT_TTS_VOICE));
  assert.equal(ttsModelEngine(DEFAULT_TTS_MODEL), 'style-tts2');
  // Not every model shares Kokoro's rate any more — VITS/MMS is 16 kHz. What must
  // hold is that the DEFAULT matches the constant callers read before load.
  assert.equal(ttsModel(DEFAULT_TTS_MODEL).sampleRate, tts.SAMPLE_RATE);
});

// A voice id is interpolated into a FILENAME (voices/<id>.bin) and into a fetch
// URL, so its validator is a security boundary, not a typo check.
test('voice ids: traversal and injection shapes are rejected', () => {
  for (const bad of ['../../etc/passwd', 'af_heart/../../x', 'af heart', 'AF_HEART', '', null, 'af_heart\n', 'a/b']) {
    assert.equal(isValidVoiceId(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
  for (const v of TTS_VOICES) assert.ok(isValidVoiceId(v.id), `catalog voice ${v.id} must pass its own validator`);
});

test('custom model ids: strict org/name, no traversal', () => {
  assert.ok(isValidCustomTtsId('onnx-community/Kokoro-82M-v1.0-ONNX'));
  for (const bad of ['../etc', 'no-slash', 'a/../b', '/abs/path', '']) assert.equal(isValidCustomTtsId(bad), false);
});

// G2P follows the VOICE: a British voice fed American phonemes is audibly wrong.
test('voiceLang maps the voice prefix, not the request', () => {
  assert.equal(voiceLang('af_heart'), 'en-us');
  assert.equal(voiceLang('am_michael'), 'en-us');
  assert.equal(voiceLang('bf_emma'), 'en-gb');
  assert.equal(voiceLang('bm_george'), 'en-gb');
  assert.equal(voiceLang('zz_unknown'), 'en-us'); // safe default, never undefined
});

test('every catalog voice declares a lang its prefix agrees with', () => {
  for (const v of TTS_VOICES) assert.equal(voiceLang(v.id), v.lang, `${v.id} lang mismatch`);
});

test('dtype picker accepts only its own options', () => {
  assert.ok(isValidTtsDtype('auto') && isValidTtsDtype('fp32') && isValidTtsDtype('q8'));
  assert.equal(isValidTtsDtype('bogus'), false);
});

// Kokoro caps a forward pass at ~510 phoneme tokens, so long text MUST be split or
// the tail is silently truncated — the failure mode is "it stopped reading".
test('splitSentences breaks on sentence boundaries', () => {
  assert.deepEqual(tts.splitSentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
  assert.deepEqual(tts.splitSentences('Single sentence'), ['Single sentence']);
  assert.deepEqual(tts.splitSentences('   '), []);
});

// The invariant that matters: NOTHING comes back over the limit, whatever the
// input looks like. Kokoro drops the overflow without erroring, so a part that is
// merely "usually" short enough loses text on the day it isn't.
test('no part ever exceeds the limit, whatever the input shape', () => {
  const cases = {
    'clauses': `${'word '.repeat(80)}, ${'more '.repeat(80)}, ${'end '.repeat(80)}`,
    'no punctuation at all': 'word '.repeat(400),
    'one unbroken run': 'x'.repeat(1200),
    'a long url': `See ${'a'.repeat(700)}.com for details.`,
    'mixed': `Short. ${'long '.repeat(200)}, tail.`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const parts = tts.splitSentences(text, 300);
    assert.ok(parts.length >= 1, `${name}: produced nothing`);
    for (const p of parts) assert.ok(p.length <= 300, `${name}: part of ${p.length} chars exceeds 300`);
    // and nothing is silently dropped — every word survives somewhere
    const words = text.split(/\s+/).filter(Boolean).length;
    const kept = parts.join(' ').split(/\s+/).filter(Boolean).length;
    assert.ok(kept >= words * 0.95, `${name}: lost text (${kept} of ${words} words)`);
  }
});

test('short text is left alone', () => {
  assert.deepEqual(tts.splitSentences('Single sentence'), ['Single sentence']);
});

test('MAX_TTS_CHARS is a fairness cap well above one chunk', () => {
  assert.ok(MAX_TTS_CHARS > 300 && MAX_TTS_CHARS <= 20000);
});

// ── WAV framing ────────────────────────────────────────────────────────────────
test('toWav writes a valid 16-bit mono PCM header', () => {
  const pcm = new Float32Array(100);
  const w = tts.toWav(pcm);
  assert.equal(w.length, 44 + 200);
  assert.equal(w.subarray(0, 4).toString(), 'RIFF');
  assert.equal(w.subarray(8, 12).toString(), 'WAVE');
  assert.equal(w.subarray(36, 40).toString(), 'data');
  assert.equal(w.readUInt32LE(4), 36 + 200);   // RIFF size
  assert.equal(w.readUInt16LE(20), 1);          // PCM
  assert.equal(w.readUInt16LE(22), 1);          // mono
  assert.equal(w.readUInt32LE(24), tts.SAMPLE_RATE);
  assert.equal(w.readUInt32LE(28), tts.SAMPLE_RATE * 2); // byte rate
  assert.equal(w.readUInt16LE(32), 2);          // block align
  assert.equal(w.readUInt16LE(34), 16);         // bits
  assert.equal(w.readUInt32LE(40), 200);        // data size
});

// Out-of-range floats WRAP if written unclamped, turning a loud passage into a
// burst of clicks — the classic float→int16 bug.
test('toWav clamps out-of-range samples instead of wrapping', () => {
  const w = tts.toWav(new Float32Array([1.5, -1.5, 0]));
  assert.equal(w.readInt16LE(44), 32767);
  assert.equal(w.readInt16LE(46), -32767);
  assert.equal(w.readInt16LE(48), 0);
});

// ── on-disk presence (against the temp model root) ─────────────────────────────
const suffix = tts === null ? '' : ''; // documented below
function installStub({ model = DEFAULT_TTS_MODEL, dtype = 'q8', tokenizer = true, truncate = false } = {}) {
  const dir = tts.modelDir(model);
  mkdirSync(join(dir, 'onnx'), { recursive: true });
  const s = { fp32: '', q8: '_quantized', q4: '_q4', fp16: '_fp16' }[dtype] ?? '';
  writeFileSync(join(dir, 'onnx', `model${s}.onnx`), truncate ? '' : 'stub');
  if (tokenizer) writeFileSync(join(dir, 'tokenizer.json'), 'stub');
  return dir;
}
function clearStub(model = DEFAULT_TTS_MODEL) {
  rmSync(tts.modelDir(model), { recursive: true, force: true });
}

test('modelOnDisk is false on an empty machine', () => {
  clearStub();
  assert.equal(tts.modelOnDisk(DEFAULT_TTS_MODEL, 'q8'), false);
});

test('modelOnDisk is true once the graph and tokenizer are both there', () => {
  installStub({ dtype: 'q8' });
  assert.equal(tts.modelOnDisk(DEFAULT_TTS_MODEL, 'q8'), true);
  clearStub();
});

// The whole point of DTYPE_SUFFIX: a q8 install must NOT read as present to the
// WASM runtime, which needs the fp32 file — otherwise it loads offline and fails.
test('a q8 install does not read as present for fp32', () => {
  installStub({ dtype: 'q8' });
  assert.equal(tts.modelOnDisk(DEFAULT_TTS_MODEL, 'q8'), true);
  assert.equal(tts.modelOnDisk(DEFAULT_TTS_MODEL, 'fp32'), false);
  clearStub();
});

test('the tokenizer is required, not just the graph', () => {
  installStub({ dtype: 'q8', tokenizer: false });
  assert.equal(tts.modelOnDisk(DEFAULT_TTS_MODEL, 'q8'), false);
  clearStub();
});

test('a zero-byte graph from an interrupted download reads as absent', () => {
  installStub({ dtype: 'q8', truncate: true });
  assert.equal(tts.modelOnDisk(DEFAULT_TTS_MODEL, 'q8'), false);
  clearStub();
});

test('voiceOnDisk is per-voice, and rejects an invalid id outright', () => {
  const dir = join(tts.modelDir(DEFAULT_TTS_MODEL), 'voices');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'af_heart.bin'), 'stub');
  assert.equal(tts.voiceOnDisk('af_heart'), true);
  assert.equal(tts.voiceOnDisk('bm_george'), false);
  assert.equal(tts.voiceOnDisk('../../etc/passwd'), false);
  clearStub();
});

test('health() is safe to call before anything is loaded', () => {
  const h = tts.health();
  assert.equal(h.ok, false);
  assert.ok(['off', 'error', 'ready', 'loading', 'downloading'].includes(h.state));
  assert.ok(['native', 'wasm'].includes(h.runtime));
});

// ── architecture dispatch ──────────────────────────────────────────────────────
// The engine drives two families. Getting this wrong is not a soft failure: a
// VITS model loaded as Kokoro dies in the forward pass, and a VITS waveform
// written into Kokoro's 24 kHz header plays back fast and chipmunked.
test('the supported architectures are exactly the ones the engine implements', () => {
  const { SUPPORTED_ARCH } = tts;
  // pocket-tts is NOT here on purpose: SUPPORTED_ARCH maps transformers.js
  // config.model_type values, and Pocket TTS is raw onnxruntime dispatched by
  // catalog id instead.
  assert.deepEqual(Object.keys(SUPPORTED_ARCH).sort(), ['speecht5', 'style_text_to_speech_2', 'vits']);
  assert.equal(tts.POCKET_ARCH, 'pocket-tts');
  assert.equal(SUPPORTED_ARCH.style_text_to_speech_2, 'style-tts2');
  assert.equal(SUPPORTED_ARCH.vits, 'vits');
  assert.equal(SUPPORTED_ARCH.speecht5, 'speecht5');
});

test('before anything loads, the defaults are Kokoro-shaped and safe to read', () => {
  assert.equal(tts.arch(), null);
  assert.equal(tts.sampleRate(), tts.SAMPLE_RATE);
  assert.equal(tts.supportsVoices(), false, 'no model means no voices to offer');
});

test('the catalog declares an arch and a rate for every entry', () => {
  for (const m of TTS_MODEL_CATALOG) {
    assert.ok(['style-tts2', 'vits', 'speecht5', 'pocket-tts'].includes(m.arch), `${m.id} has arch "${m.arch}"`);
    assert.ok(m.sampleRate > 0, `${m.id} must declare its output rate`);
    assert.equal(typeof m.voices, 'boolean', `${m.id} must say whether it has voices`);
    // Kokoro and Pocket both ship built-in speakers; VITS is single-speaker and
    // SpeechT5 has none of its own. Pocket is the only one with BOTH kinds, which
    // is exactly why the picker cannot treat them as mutually exclusive.
    assert.equal(m.voices, m.arch === 'style-tts2' || m.arch === 'pocket-tts',
      `${m.id}: built-in voices belong to Kokoro and Pocket`);
    assert.equal(!!m.customVoices, m.arch === 'speecht5' || m.arch === 'pocket-tts',
      `${m.id}: only the cloning engines take a speaker embedding`);
    // A model needing the native runtime must say so, or the binary offers a
    // download it can never load.
    if (m.arch === 'pocket-tts') assert.equal(m.requiresNative, true, `${m.id} must be marked native-only`);
  }
});

// The one model that takes a speaker embedding is also the one that must NOT run
// at the runtime default: q8 renders about half of all embeddings as near-silence.
test('SpeechT5 pins fp32 — at q8 the speaker conditioning collapses', () => {
  const m = ttsModel('Xenova/speecht5_tts');
  assert.ok(m, 'the custom-voice model must be in the catalog');
  assert.equal(m.dtype, 'fp32');
  assert.equal(ttsModelDtype('Xenova/speecht5_tts'), 'fp32', 'and the engine must read that pin');
  // Nothing else pins a precision; they take the runtime default on purpose.
  for (const other of TTS_MODEL_CATALOG.filter((x) => x.arch !== 'speecht5')) {
    assert.equal(other.dtype, undefined, `${other.id} should follow the runtime default`);
  }
});

test('ttsModelEngine dispatches on the catalog arch, defaulting to Kokoro', () => {
  assert.equal(ttsModelEngine('Xenova/mms-tts-hin'), 'vits');
  assert.equal(ttsModelEngine(DEFAULT_TTS_MODEL), 'style-tts2');
  assert.equal(ttsModelEngine('someone/unknown-model'), 'style-tts2', 'an unknown id assumes the default family');
});

// toWav takes the rate as an ARGUMENT for exactly this reason.
test('a 16 kHz model writes a 16 kHz header, not the Kokoro default', () => {
  const w = tts.toWav(new Float32Array(80), 16000);
  assert.equal(w.readUInt32LE(24), 16000, 'sample rate');
  assert.equal(w.readUInt32LE(28), 32000, 'byte rate must follow the sample rate');
  const k = tts.toWav(new Float32Array(80), 24000);
  assert.equal(k.readUInt32LE(24), 24000);
});
