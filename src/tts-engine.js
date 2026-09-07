// Local text-to-speech — Kokoro (StyleTTS2-family) via the same in-process ONNX
// engine, model root and download plumbing as NER and STT. Phase 4 of
// docs/voice-pipeline.md: "voice out".
//
// Why this drives the model directly instead of using `kokoro-js`: that package
// depends on @huggingface/transformers ^3.5.1 and the gateway pins ^4.2.0, so
// adding it would nest a SECOND transformers install — a second ONNX runtime in a
// binary whose build script (scripts/build.mjs) exists specifically to control
// which runtime ships. transformers 4.2 has StyleTextToSpeech2Model built in, so
// the model loads on the pinned version and the only thing kokoro-js was really
// providing — grapheme→phoneme — comes from `phonemizer` (zero dependencies, a
// pure-JS espeak-ng, so it survives Bun --compile).
//
// Privacy: synthesis is entirely local. Nothing is sent anywhere, which is why the
// route speaks RESTORED text rather than redacted text — see the /tts handler.
//
// This module owns ONE concern: text in, PCM out. Streaming, routing and redaction
// live at the server/route layer, because a pipeline stage never imports another
// stage.

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { ensureLib, modelRoot } from './ner-engine.js';
import { runtimeDtype, runtimeName, DTYPE_SUFFIX } from './model-runtime.js';
import {
  DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, STYLE_DIM, MAX_PHONEME_TOKENS,
  ttsModelDtype, isKnownTtsModel, isValidVoiceId, voiceLang, ttsModelEngine, ttsModel,
} from './tts-models.js';
import { bundleOnDisk as pocketBundleOnDisk } from './pocket-tts-engine.js';

// Kokoro's rate. Kept as a named export because it is the default and several
// callers want a number before anything is loaded — but it is NOT universal: a
// VITS/MMS model outputs 16 kHz, and writing its samples into a 24 kHz WAV header
// plays it back fast and chipmunked. Use sampleRate() once a model is active.
export const SAMPLE_RATE = 24000;

let _state = 'off';       // 'off' | 'loading' | 'downloading' | 'ready' | 'error'
let _model = null;
let _net = null;          // StyleTextToSpeech2Model
let _tok = null;          // phoneme tokenizer
let _dtype = null;
let _err = null;
let _progress = null;
let _initPromise = null;
let _arch = null;         // 'style-tts2' (Kokoro) | 'vits' (MMS) | 'speecht5' (custom voices)
let _vocoder = null;      // speecht5 only — mel → waveform
let _pocket = null;       // pocket-tts only — its own PocketTTS instance
let _encoder = null;      // a PocketTTS kept ONLY to encode voices, never to speak
let _rate = SAMPLE_RATE;  // the ACTIVE model's output rate
const _voices = new Map(); // voice id → Float32Array style bank

// The architectures this engine can actually drive. Anything else is refused at
// load with a message naming what it is, rather than failing later inside a
// forward pass with a shape error nobody can act on.
export const SUPPORTED_ARCH = { style_text_to_speech_2: 'style-tts2', vits: 'vits', speecht5: 'speecht5' };

// Pocket TTS is not a transformers.js model — it is five raw ONNX graphs with a
// hand-written generation loop, exactly like parakeet on the STT side — so it is
// dispatched by catalog id rather than by a transformers config.model_type.
export const POCKET_ARCH = 'pocket-tts';

// SpeechT5 is the only architecture here that takes a SPEAKER EMBEDDING, which is
// what makes a custom voice possible at all: Kokoro's voices are fixed style banks
// and VITS is single-speaker, so neither can be pointed at a person. It needs a
// separate vocoder (mel → waveform), hence the extra model id.
export const SPEECHT5_VOCODER = 'Xenova/speecht5_hifigan';
// Both engines that can be pointed at a person. Pocket TTS is the one built for
// it; SpeechT5 is kept because it is small and already downloaded for anyone who
// tried it, but it borrows a voice rather than reproducing one.
export function supportsCustomVoices() { return _arch === 'speecht5' || _arch === POCKET_ARCH; }
export function isPocket() { return _arch === POCKET_ARCH; }
/** The built-in speaker names the loaded Pocket model offers, if any. */
export function builtinVoices() { return _pocket?.builtinVoices?.() || []; }

/**
 * A PocketTTS instance purely for ENCODING a voice, without disturbing whatever
 * model is currently speaking. Saving a voice has to derive its conditioning while
 * the sample still exists, and that must not silently switch the active engine out
 * from under a conversation in progress.
 */
export async function pocketForEncoding({ allowDownload = true, log = () => {} } = {}) {
  if (_pocket) return _pocket;
  const { PocketTTS, bundleOnDisk, DEFAULT_BUNDLE } = await import('./pocket-tts-engine.js');
  if (!bundleOnDisk(DEFAULT_BUNDLE) && !allowDownload) return null;
  if (_encoder) return _encoder;
  const pt = new PocketTTS();
  await pt.load(DEFAULT_BUNDLE, { log });
  _encoder = pt;
  return pt;
}

export function arch() { return _arch; }
export function sampleRate() { return _rate; }
// Kokoro picks a voice from a style bank; VITS is single-speaker and has none, so
// the UI must not offer a voice list that cannot do anything.
export function supportsVoices() { return _arch === 'style-tts2'; }

export function state() { return _state; }
export function isReady() { return _state === 'ready' && !!_net; }
export function progress() { return _progress; }

export function health() {
  return { configured: _state !== 'off', ok: isReady(), state: _state, model: _model, dtype: _dtype, runtime: runtimeName(), error: _err, arch: _arch, sampleRate: _rate, voices: supportsVoices(), customVoices: supportsCustomVoices() };
}

export function modelDir(modelId) {
  return join(modelRoot(), ...String(modelId).split('/'));
}

// Present = the EXACT ONNX file this runtime will load, plus the tokenizer. Both
// non-empty: a truncated download must not read as installed.
export function modelOnDisk(modelId = _model || DEFAULT_TTS_MODEL, dtype = ttsModelDtype(modelId) || runtimeDtype()) {
  // Pocket TTS keeps a bundle of five graphs under its own directory, not a single
  // transformers-style onnx/ folder. bundleOnDisk is a pure fs predicate — the
  // heavy onnxruntime import inside that module is dynamic — so importing it
  // statically costs nothing.
  if (ttsModelEngine(modelId) === POCKET_ARCH) return pocketBundleOnDisk(ttsModel(modelId)?.bundle);
  const dir = modelDir(modelId);
  const suffix = DTYPE_SUFFIX[dtype] ?? '';
  const need = [join(dir, 'onnx', `model${suffix}.onnx`), join(dir, 'tokenizer.json')];
  try {
    return need.every((p) => existsSync(p) && statSync(p).size > 0);
  } catch { return false; }
}

// A voice is a separate ~500 KB style bank (voices/<id>.bin), not part of the model
// download, so it is fetched and checked on its own.
export function voiceOnDisk(voice, modelId = _model || DEFAULT_TTS_MODEL) {
  if (!isValidVoiceId(voice)) return false;
  const p = join(modelDir(modelId), 'voices', `${voice}.bin`);
  try { return existsSync(p) && statSync(p).size > 0; } catch { return false; }
}

export function init(cfg = {}) {
  const tts = cfg.tts || {};
  if (tts.enabled === false) { _state = 'off'; return; }
  _model = tts.model || DEFAULT_TTS_MODEL;
  // No autostart, same as STT: the model downloads on FIRST synthesis, never on
  // gateway boot — a 90-330 MB fetch must not be a side effect of starting up.
}

async function loadModel(modelId, { log = () => {}, allowDownload = true, dtype: dtypeOverride = null } = {}) {
  // Pocket TTS has its own loader (raw onnxruntime, its own bundle layout), so it
  // is routed before any transformers.js machinery is touched.
  if (ttsModelEngine(modelId) === POCKET_ARCH) return loadPocket(modelId, { log, allowDownload });

  const prevNet = _net, prevModel = _model;
  let lib;
  try {
    lib = await ensureLib();
  } catch (e) {
    _state = 'error'; _err = `engine load failed: ${e.message}`;
    log(`[tts] transformers.js not available (${e.message}) — read-aloud falls back to browser speech`);
    return false;
  }

  const chosen = dtypeOverride && dtypeOverride !== 'auto' ? dtypeOverride : null;
  const dtype = chosen || ttsModelDtype(modelId) || runtimeDtype();
  const haveLocal = modelOnDisk(modelId, dtype);
  lib.env.allowRemoteModels = haveLocal ? false : !!allowDownload;
  if (!haveLocal && !allowDownload) {
    _state = 'error'; _err = 'model not on disk and downloads disabled';
    log(`[tts] model ${modelId} not installed and downloads disabled`);
    return false;
  }

  // ensureLib points remoteHost at the private dl.chatpanel.net mirror, which
  // carries the NER and STT models but NOT the TTS ones yet (it 403s on them), so
  // every TTS fetch goes to Hugging Face for now — curated and custom alike. Once
  // the mirror carries them, narrow this back to `!isKnownTtsModel(modelId)` the
  // way stt-engine does, and curated downloads move to the mirror with no other
  // change. Voice banks (loadVoice) fetch from HF for the same reason.
  const prevHost = lib.env.remoteHost;
  const mirrored = false; // ← flip when dl.chatpanel.net mirrors the TTS models
  if (!haveLocal && (!mirrored || !isKnownTtsModel(modelId))) {
    try { lib.env.remoteHost = 'https://huggingface.co/'; } catch { /* optional */ }
  }

  _state = haveLocal ? 'loading' : 'downloading';
  if (!haveLocal) { _progress = { model: modelId, file: null, pct: 0 }; log(`[tts] downloading voice model ${modelId} (one-time)…`); }

  try {
    // The extra classes ensureLib doesn't return. Module resolution is cached, so
    // this is the SAME transformers instance ensureLib already configured (env,
    // cacheDir, wasm paths) — importing it here keeps ner-engine free of TTS.
    const tf = await import('@huggingface/transformers');

    // Which architecture is this? Read the config BEFORE choosing a class, so an
    // unsupported model is refused by name instead of exploding inside a forward
    // pass with a tensor-shape error.
    let modelType = '';
    try {
      const conf = await tf.AutoConfig.from_pretrained(modelId);
      modelType = String(conf?.model_type || '').toLowerCase();
    } catch { /* no config we can read — fall through to the Kokoro default */ }
    const kind = SUPPORTED_ARCH[modelType] || (modelType ? null : 'style-tts2');
    if (!kind) throw new Error(`unsupported TTS architecture "${modelType}" — this engine drives Kokoro (style_text_to_speech_2) and VITS/MMS`);

    const onProgress = (p) => {
      if (p?.status === 'progress' && p.file) _progress = { model: modelId, file: p.file, pct: Math.round(p.progress || 0) };
    };
    const Klass = kind === 'vits' ? tf.VitsModel
      : kind === 'speecht5' ? tf.SpeechT5ForTextToSpeech
        : tf.StyleTextToSpeech2Model;
    const [net, tok] = await Promise.all([
      Klass.from_pretrained(modelId, { dtype, progress_callback: onProgress }),
      tf.AutoTokenizer.from_pretrained(modelId),
    ]);
    // The vocoder is a second download and a second failure point, so it is loaded
    // only for the architecture that needs one.
    _vocoder = kind === 'speecht5'
      ? await tf.SpeechT5HifiGan.from_pretrained(SPEECHT5_VOCODER, { dtype, progress_callback: onProgress })
      : null;
    _net = net; _tok = tok; _model = modelId; _dtype = dtype; _arch = kind;
    // VITS/MMS emit 16 kHz; Kokoro 24 kHz. Take it from the model's own config
    // where it says so, because guessing wrong plays the voice at the wrong pitch.
    _rate = Number(net?.config?.sampling_rate) || (kind === 'style-tts2' ? SAMPLE_RATE : 16000);
    _state = 'ready'; _err = null; _progress = null;
    log(`[tts] ready — model ${modelId} @ ${dtype} (${kind}, ${_rate} Hz, ${runtimeName()}, offline) — local speech active`);
    return true;
  } catch (e) {
    // A failed SWITCH keeps the previous working model, same as ner/stt.
    _net = prevNet; _model = prevModel;
    _state = prevNet ? 'ready' : 'error';
    _err = e.message; _progress = null;
    log(`[tts] model load failed (${e.message})`);
    return false;
  } finally {
    try { lib.env.remoteHost = prevHost; } catch { /* optional */ }
  }
}

async function loadPocket(modelId, { log = () => {}, allowDownload = true } = {}) {
  const prevArch = _arch, prevPocket = _pocket, prevModel = _model;
  const { PocketTTS, bundleOnDisk, DEFAULT_BUNDLE, SAMPLE_RATE: PR } = await import('./pocket-tts-engine.js');
  const bundle = ttsModel(modelId)?.bundle || DEFAULT_BUNDLE;
  if (!bundleOnDisk(bundle) && !allowDownload) {
    _state = 'error'; _err = 'model not on disk and downloads disabled';
    return false;
  }
  _state = bundleOnDisk(bundle) ? 'loading' : 'downloading';
  if (_state === 'downloading') _progress = { model: modelId, file: null, pct: 0 };
  try {
    const pt = new PocketTTS();
    await pt.load(bundle, {
      log,
      onProgress: ({ file, pct }) => { _progress = { model: modelId, file, pct }; },
    });
    _pocket = pt; _net = pt; _tok = null; _vocoder = null;
    _model = modelId; _arch = POCKET_ARCH; _dtype = 'int8'; _rate = PR;
    _state = 'ready'; _err = null; _progress = null;
    return true;
  } catch (e) {
    // A failed switch keeps whatever was working, same as every other engine here.
    _pocket = prevPocket; _arch = prevArch; _model = prevModel;
    _state = prevPocket || _net ? 'ready' : 'error';
    _err = e.message; _progress = null;
    log(`[pocket-tts] load failed (${e.message})`);
    return false;
  }
}

export async function setModel(modelId, { onLog = () => {}, allowDownload = true, dtype = 'auto' } = {}) {
  const want = dtype && dtype !== 'auto' ? dtype : (ttsModelDtype(modelId) || runtimeDtype());
  if (modelId === _model && isReady() && _dtype === want) return true;
  _initPromise = loadModel(modelId, { log: onLog, allowDownload, dtype });
  return _initPromise;
}

export async function ready({ onLog = () => {}, allowDownload = true, model = null, dtype = 'auto' } = {}) {
  if (isReady()) return true;
  if (_initPromise) return _initPromise;
  return setModel(model || _model || DEFAULT_TTS_MODEL, { onLog, allowDownload, dtype });
}

// ── voices ───────────────────────────────────────────────────────────────────────
// voices/<id>.bin is a flat Float32 bank of MAX+1 style vectors — one per possible
// token count — so the row is selected by the length of THIS utterance.
async function loadVoice(voice, { allowDownload = true, log = () => {} } = {}) {
  if (!isValidVoiceId(voice)) throw new Error(`invalid voice id: ${voice}`);
  const cached = _voices.get(voice);
  if (cached) return cached;
  const dir = join(modelDir(_model || DEFAULT_TTS_MODEL), 'voices');
  const dest = join(dir, `${voice}.bin`);
  if (!(existsSync(dest) && statSync(dest).size > 0)) {
    if (!allowDownload) throw new Error(`voice ${voice} not on disk and downloads disabled`);
    mkdirSync(dir, { recursive: true });
    const url = `https://huggingface.co/${_model || DEFAULT_TTS_MODEL}/resolve/main/voices/${voice}.bin`;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`fetch voice ${voice} → HTTP ${res.status}`);
    // .part then rename, so an interrupted fetch never looks complete.
    const tmp = `${dest}.part`;
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    renameSync(tmp, dest);
    log(`[tts] fetched voice ${voice}`);
  }
  const buf = readFileSync(dest);
  const bank = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  _voices.set(voice, bank);
  return bank;
}

// ── text → speech ────────────────────────────────────────────────────────────────
// Kokoro accepts at most MAX_PHONEME_TOKENS per forward pass and SILENTLY drops
// whatever does not fit — the failure is "it stopped reading halfway", with no
// error. So every returned part must be bounded, not merely usually bounded.
//
// Boundaries are tried in descending order of how natural the pause sounds:
// sentence → clause → word → (last resort) a hard slice. Falling through to the
// next one only happens when the previous left a part still over the limit, so
// ordinary prose splits where a listener expects a breath.
export function splitSentences(text, maxChars = 300) {
  const bound = (s, seps) => {
    if (s.length <= maxChars) return [s];
    if (!seps.length) {
      // A single unbroken run longer than the window (a URL, a base64 blob).
      // Slicing it is ugly to listen to, but losing its tail is worse.
      const out = [];
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars).trim());
      return out.filter(Boolean);
    }
    const [sep, ...rest] = seps;
    const out = [];
    let buf = '';
    for (const piece of s.split(sep)) {
      const p = piece.trim();
      if (!p) continue;
      const cand = buf ? `${buf} ${p}` : p;
      if (cand.length > maxChars && buf) { out.push(...bound(buf, rest)); buf = p; }
      else buf = cand;
    }
    if (buf) out.push(...bound(buf, rest));
    return out;
  };

  const parts = [];
  for (const raw of String(text).split(/(?<=[.!?])\s+|\n{2,}/)) {
    const s = raw.trim();
    if (s) parts.push(...bound(s, [/(?<=[,;:])\s+/, /\s+/]));
  }
  return parts;
}

/**
 * Synthesize ONE chunk. Returns 24 kHz mono Float32 PCM.
 * @param {string} text @param {{voice?: string, speed?: number}} [opts]
 */
export async function synthChunk(text, { voice = DEFAULT_TTS_VOICE, speed = 1, speakerEmbedding = null } = {}) {
  if (!isReady()) throw new Error('tts model not ready');
  const tf = await import('@huggingface/transformers');

  // VITS/MMS: single-speaker, tokenizes GRAPHEMES directly — no phonemizer, no
  // style bank, no speed input. One language per model, which is the trade for
  // ~40 MB and a thousand of them.
  if (_arch === 'vits') {
    const inputs = _tok(String(text));
    const out = await _net(inputs);
    return out.waveform.data;
  }

  // Pocket TTS runs its own generation loop and chunking, so a whole utterance is
  // handed over at once rather than being pre-split here.
  if (_arch === POCKET_ARCH) {
    // Either a cloned voice (an embedding) or one of its built-in speakers (a name).
    const v = speakerEmbedding?.data?.length ? speakerEmbedding : voice;
    if (!v) throw new Error('this model needs a voice — pick a built-in one or record your own');
    return _pocket.synth(String(text), { voice: v });
  }

  // SpeechT5: conditioned by a 512-d speaker embedding, which is the whole point —
  // it is the one architecture here that can be pointed at a person's voice.
  // Without an embedding there is no voice to speak in, so this refuses rather
  // than inventing one.
  if (_arch === 'speecht5') {
    if (!speakerEmbedding || speakerEmbedding.length !== 512) {
      throw new Error('this model needs a saved voice — record one in Settings → Text-to-speech');
    }
    const { input_ids } = _tok(String(text));
    const emb = new tf.Tensor('float32', Float32Array.from(speakerEmbedding), [1, 512]);
    const { waveform } = await _net.generate_speech(input_ids, emb, { vocoder: _vocoder });
    return waveform.data;
  }

  const { phonemize } = await import('phonemizer');

  // G2P follows the VOICE, not the request — an American voice reading British
  // phonemes is audibly wrong.
  const phonemes = (await phonemize(String(text), voiceLang(voice))).join(' ');
  const { input_ids } = _tok(phonemes, { truncation: true });

  const bank = await loadVoice(voice);
  // One style row per token count; clamp so a long chunk still picks a valid row.
  const n = Math.min(Math.max(input_ids.dims.at(-1) - 2, 0), Math.floor(bank.length / STYLE_DIM) - 1);
  const style = bank.slice(n * STYLE_DIM, n * STYLE_DIM + STYLE_DIM);

  const out = await _net({
    input_ids,
    style: new tf.Tensor('float32', style, [1, STYLE_DIM]),
    speed: new tf.Tensor('float32', [speed], [1]),
  });
  return out.waveform.data;
}

/** Synthesize arbitrary-length text, chunk by chunk. `onChunk` sees each as it lands. */
export async function synth(text, { voice = DEFAULT_TTS_VOICE, speed = 1, speakerEmbedding = null, onChunk = null } = {}) {
  // Pocket TTS splits internally against its own token ceiling, so splitting again
  // here would cut sentences twice and reset its state mid-thought.
  if (_arch === POCKET_ARCH) return synthChunk(text, { voice, speed, speakerEmbedding });
  const chunks = splitSentences(text);
  const out = [];
  for (const c of chunks) {
    const pcm = await synthChunk(c, { voice, speed, speakerEmbedding });
    out.push(pcm);
    onChunk?.(pcm);
  }
  if (out.length === 1) return out[0];
  const total = out.reduce((n, a) => n + a.length, 0);
  const merged = new Float32Array(total);
  let at = 0;
  for (const a of out) { merged.set(a, at); at += a.length; }
  return merged;
}

// ── WAV ──────────────────────────────────────────────────────────────────────────
// 16-bit PCM WAV: what every <audio> element and every OS player accepts without a
// codec. Float32 → int16 with clamping (a value outside [-1,1] wraps and clicks).
export function toWav(pcm, sampleRate = SAMPLE_RATE) {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // PCM chunk size
  buf.writeUInt16LE(1, 20);           // format = PCM
  buf.writeUInt16LE(1, 22);           // channels = mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

export function _reset() {
  _state = 'off'; _model = null; _net = null; _tok = null; _dtype = null;
  _err = null; _progress = null; _initPromise = null; _arch = null; _rate = SAMPLE_RATE; _vocoder = null; _pocket = null; _encoder = null;
  _voices.clear();
}
