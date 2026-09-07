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
  ttsModelDtype, isKnownTtsModel, isValidVoiceId, voiceLang,
} from './tts-models.js';

export const SAMPLE_RATE = 24000; // Kokoro's output rate — fixed by the model

let _state = 'off';       // 'off' | 'loading' | 'downloading' | 'ready' | 'error'
let _model = null;
let _net = null;          // StyleTextToSpeech2Model
let _tok = null;          // phoneme tokenizer
let _dtype = null;
let _err = null;
let _progress = null;
let _initPromise = null;
const _voices = new Map(); // voice id → Float32Array style bank

export function state() { return _state; }
export function isReady() { return _state === 'ready' && !!_net; }
export function progress() { return _progress; }

export function health() {
  return { configured: _state !== 'off', ok: isReady(), state: _state, model: _model, dtype: _dtype, runtime: runtimeName(), error: _err };
}

export function modelDir(modelId) {
  return join(modelRoot(), ...String(modelId).split('/'));
}

// Present = the EXACT ONNX file this runtime will load, plus the tokenizer. Both
// non-empty: a truncated download must not read as installed.
export function modelOnDisk(modelId = _model || DEFAULT_TTS_MODEL, dtype = ttsModelDtype(modelId) || runtimeDtype()) {
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
    const [net, tok] = await Promise.all([
      tf.StyleTextToSpeech2Model.from_pretrained(modelId, {
        dtype,
        progress_callback: (p) => {
          if (p?.status === 'progress' && p.file) _progress = { model: modelId, file: p.file, pct: Math.round(p.progress || 0) };
        },
      }),
      tf.AutoTokenizer.from_pretrained(modelId),
    ]);
    _net = net; _tok = tok; _model = modelId; _dtype = dtype;
    _state = 'ready'; _err = null; _progress = null;
    log(`[tts] ready — model ${modelId} @ ${dtype} (${runtimeName()}, offline) — local speech active`);
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
export async function synthChunk(text, { voice = DEFAULT_TTS_VOICE, speed = 1 } = {}) {
  if (!isReady()) throw new Error('tts model not ready');
  const { phonemize } = await import('phonemizer');
  const tf = await import('@huggingface/transformers');

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
export async function synth(text, { voice = DEFAULT_TTS_VOICE, speed = 1, onChunk = null } = {}) {
  const chunks = splitSentences(text);
  const out = [];
  for (const c of chunks) {
    const pcm = await synthChunk(c, { voice, speed });
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
  _err = null; _progress = null; _initPromise = null; _voices.clear();
}
