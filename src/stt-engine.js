// In-process speech-to-text — whisper via transformers.js, zero native deps.
//
// Same design as ner-engine.js (and deliberately the same file shape): an ONNX
// model run IN-PROCESS, downloaded once on first use into ~/.chatpanel/models,
// fully offline afterwards — audio NEVER leaves the machine. This is what makes
// dictation private: the extension streams mic PCM over loopback, we transcribe
// locally, and only text goes back.
//
// Two layers:
//   engine   — load/switch the whisper pipeline (mirrors ner-engine verbatim)
//   sessions — rolling-buffer streaming decode: interim results every ~1.2s,
//              finals on trailing silence or when a segment grows too long.
//              Whisper isn't natively streaming, so we re-decode the open
//              segment and commit it when the speaker pauses.
//
// Fail-open by design: if the model can't load, sessions emit one error event
// and dictation falls back to the browser engine client-side.

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureLib, modelRoot } from './ner-engine.js';
import { DEFAULT_STT_MODEL, isEnglishOnly, sttModelDtype, isKnownSttModel } from './stt-models.js';

export const SAMPLE_RATE = 16000; // fixed wire contract: 16 kHz mono Float32 PCM

// The right whisper quantization depends on the ONNX RUNTIME, not the OS:
//   • native onnxruntime-node (the npm gateway) loads the small, fast `q8`
//     (_quantized) exports — best size + speed.
//   • onnxruntime-web WASM (the standalone binary — SAME wasm on macOS/Windows/
//     Linux, so this is inherently cross-platform) CANNOT load the block-quantized
//     exports (q8/int8/uint8 → MatMulNBits "missing scale"; fp16 → graph error);
//     of the loadable ones only `fp32` is fast enough for real-time (q4/bnb4 are
//     ~8× slower). Verified empirically against the bundled ORT-web build.
// The binary entry sets __CHATPANEL_WASM_PATHS__, so that global tells us which
// runtime we're on. A model may override via `dtype` in the STT catalog.
export function runtimeDtype() {
  return globalThis.__CHATPANEL_WASM_PATHS__ ? 'fp32' : 'q8';
}

let _state = 'off';        // 'off' | 'loading' | 'downloading' | 'ready' | 'error'
let _model = null;         // active model id
let _pipe = null;          // the loaded automatic-speech-recognition pipeline
let _err = null;           // last error message (for /health)
let _initPromise = null;   // single-flight init
let _progress = null;      // { model, file, pct } while downloading, else null
let _dtype = null;         // the quantization actually loaded (fp32 on WASM, q8 native)

// transformers.js dtype → the ONNX filename suffix it loads. Presence must check
// the EXACT file the current runtime will fetch — otherwise a q8 install (native)
// looks "present" to the WASM runtime, which actually needs the fp32 file, and the
// offline load fails. Checking the real target makes a runtime switch re-download.
const DTYPE_SUFFIX = {
  fp32: '', q8: '_quantized', int8: '_int8', uint8: '_uint8',
  fp16: '_fp16', q4: '_q4', bnb4: '_bnb4', q4f16: '_q4f16',
};

export function modelOnDisk(modelId = _model || DEFAULT_STT_MODEL, dtype = sttModelDtype(modelId) || runtimeDtype()) {
  const dir = join(modelRoot(), ...modelId.split('/'), 'onnx');
  if (!existsSync(dir)) return false;
  const suffix = DTYPE_SUFFIX[dtype] ?? '';
  try {
    const files = readdirSync(dir);
    return files.includes(`encoder_model${suffix}.onnx`)
      && files.some((f) => f === `decoder_model_merged${suffix}.onnx` || f === `decoder_model${suffix}.onnx`);
  } catch { return false; }
}

export function state() { return _state; }
export function isReady() { return _state === 'ready' && !!_pipe; }
export function progress() { return _progress; }

export function health() {
  return { configured: _state !== 'off', ok: isReady(), state: _state, model: _model, dtype: _dtype, error: _err };
}

// (Re)load a model into _pipe. Same contract as ner-engine.loadModel: fail-open,
// and a failed SWITCH keeps the previous working pipeline.
/** @param {string} modelId @param {{ log?: (m: string) => void, allowDownload?: boolean }} [opts] */
async function loadModel(modelId, { log = () => {}, allowDownload = true } = {}) {
  const prevPipe = _pipe;
  const prevModel = _model;
  let lib;
  try {
    lib = await ensureLib();
  } catch (e) {
    _state = 'error'; _err = `engine load failed: ${e.message}`;
    log(`[stt] transformers.js not available (${e.message}) — dictation falls back to the browser engine`);
    return false;
  }

  const haveLocal = modelOnDisk(modelId);
  lib.env.allowRemoteModels = haveLocal ? false : !!allowDownload;
  if (!haveLocal && !allowDownload) {
    _state = 'error'; _err = 'model not on disk and downloads disabled';
    log(`[stt] model ${modelId} not installed and downloads disabled`);
    return false;
  }

  // Curated catalog models come from the private dl.chatpanel.net mirror (ensureLib
  // already set that as remoteHost). A CUSTOM ("Advanced") id isn't mirrored, so
  // fetch it from Hugging Face directly — only for this load, then restore.
  const prevHost = lib.env.remoteHost;
  const isCustom = !isKnownSttModel(modelId);
  if (!haveLocal && isCustom) { try { lib.env.remoteHost = 'https://huggingface.co/'; } catch { /* optional */ } }

  _state = haveLocal ? 'loading' : 'downloading';
  if (!haveLocal) { _progress = { model: modelId, file: null, pct: 0 }; log(`[stt] downloading model ${modelId} (one-time${isCustom ? ', from Hugging Face' : ''})…`); }

  try {
    // Per-model override wins (catalog `dtype`), else the runtime-appropriate default.
    const dtype = sttModelDtype(modelId) || runtimeDtype();
    const pipe = await lib.pipeline('automatic-speech-recognition', modelId, {
      dtype,
      progress_callback: (p) => {
        if (!p) return;
        const pct = typeof p.progress === 'number' ? Math.round(p.progress) : (_progress?.pct ?? 0);
        if (p.status === 'progress' || p.status === 'download' || p.status === 'initiate') {
          _progress = { model: modelId, file: p.file || _progress?.file || null, pct };
        } else if (p.status === 'done' && p.file) {
          log(`[stt] fetched ${p.file}`);
        }
      },
    });
    _pipe = pipe; _model = modelId; _state = 'ready'; _err = null; _progress = null; _dtype = dtype;
    if (prevPipe && prevPipe !== pipe) { try { await prevPipe.dispose?.(); } catch { /* ignore */ } }
    log(`[stt] ready — model ${modelId} @ ${dtype} (in-process, offline) — local dictation active`);
    return true;
  } catch (e) {
    _err = e.message; _progress = null;
    if (prevPipe) { _pipe = prevPipe; _model = prevModel; _state = 'ready'; }
    else { _state = 'error'; }
    log(`[stt] model load failed (${e.message})${prevPipe ? ' — keeping previous model' : ''}`);
    return false;
  } finally {
    try { lib.env.remoteHost = prevHost; } catch { /* optional */ } // restore the mirror for NER + catalog loads
  }
}

// Load the configured model once, on FIRST USE (never at gateway startup — the
// download is deferred until someone actually dictates). Single-flight.
export function init(cfg = {}) {
  if (_initPromise) return _initPromise;
  const log = typeof cfg.onLog === 'function' ? cfg.onLog : () => {};
  _model = cfg.model || DEFAULT_STT_MODEL;
  _state = 'loading';
  _initPromise = loadModel(_model, { log, allowDownload: cfg.allowDownload !== false });
  return _initPromise;
}

export async function setModel(modelId, opts = {}) {
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  if (!modelId) return false;
  if (modelId === _model && isReady()) return true;
  return loadModel(modelId, { log, allowDownload: opts.allowDownload !== false });
}

// ── Streaming sessions ──────────────────────────────────────────────────────────

const MAX_SESSIONS = 4;
const IDLE_MS = 60_000;             // no audio for a minute → session expires
const DECODE_GAP_MS = 1200;         // min spacing between decodes of one session
const MAX_SEGMENT_S = 12;           // force-finalize an open segment past this
const SILENCE_FINAL_MS = 700;       // trailing quiet that commits a segment
const SILENCE_RMS = 0.008;          // "quiet" threshold on Float32 PCM
const MAX_BUFFER_S = 30;            // hard cap on the open segment (whisper ctx)

const _sessions = new Map();
let _decodeChain = Promise.resolve(); // whisper is effectively single-threaded —
                                      // serialize decodes across ALL sessions

export function sessionCount() { return _sessions.size; }

/** @param {{ lang?: string, redact?: boolean }} [opts] */
export function createSession({ lang, redact = false } = {}) {
  if (_sessions.size >= MAX_SESSIONS) {
    const e = /** @type {Error & { code?: string }} */ (new Error('too many concurrent dictation sessions'));
    e.code = 'too_many_sessions'; throw e;
  }
  const s = {
    id: randomUUID(),
    lang: typeof lang === 'string' && lang ? lang.slice(0, 12) : null,
    langTried: false, // language auto-detect runs once per session (multilingual models)
    // Opaque to this engine: the server applies the redaction hop to finals when
    // set. Pipeline stages stay independent — STT never imports NER.
    redact: !!redact,
    chunks: [],            // Float32Array pieces of the OPEN (unfinalized) segment
    samples: 0,
    listeners: new Set(),  // (event) => void — the SSE writers
    lastDecodeAt: 0,
    decodeTimer: null,
    lastInterim: '',
    closed: false,
    idleTimer: null,
  };
  _sessions.set(s.id, s);
  touch(s);
  return { id: s.id };
}

export function getSession(id) { return _sessions.get(String(id || '')) || null; }

export function subscribe(id, fn) {
  const s = getSession(id);
  if (!s) return null;
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

function emit(s, ev) {
  for (const fn of s.listeners) { try { fn(ev); } catch { /* listener's problem */ } }
}

function touch(s) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => endSession(s.id).catch(() => {}), IDLE_MS);
  s.idleTimer.unref?.();
}

// Accept a chunk of 16 kHz mono Float32 PCM and schedule a decode.
export function pushAudio(id, float32) {
  const s = getSession(id);
  if (!s || s.closed) {
    const e = /** @type {Error & { code?: string }} */ (new Error('no such session'));
    e.code = 'no_session'; throw e;
  }
  if (!(float32 instanceof Float32Array) || !float32.length) return;
  s.chunks.push(float32);
  s.samples += float32.length;
  touch(s);
  scheduleDecode(s);
}

// HTTP bodies arrive as Buffers whose byteOffset may not be 4-aligned — copy.
export function toFloat32(buf) {
  const bytes = buf.length - (buf.length % 4);
  const out = new Float32Array(bytes / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function scheduleDecode(s) {
  if (s.closed || s.decodeTimer) return;
  const wait = Math.max(0, s.lastDecodeAt + DECODE_GAP_MS - Date.now());
  s.decodeTimer = setTimeout(() => {
    s.decodeTimer = null;
    _decodeChain = _decodeChain.then(() => decodeSession(s).catch(() => {}));
  }, wait);
  s.decodeTimer.unref?.();
}

function concatBuffer(s) {
  const out = new Float32Array(s.samples);
  let o = 0;
  for (const c of s.chunks) { out.set(c, o); o += c.length; }
  return out;
}

function rms(audio, from = 0, to = audio.length) {
  let sum = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / n);
}

// Whisper's native language-ID, which transformers.js doesn't implement (its
// pipeline just defaults to English): one decoder step from <|startoftranscript|>,
// argmax over the 99 language tokens. Run ONCE per session on the first voiced
// segment, then pinned — so "speak any language, it just works" without a setting.
async function detectLanguage(audio) {
  try {
    const lib = await ensureLib();
    const gc = _pipe?.model?.generation_config;
    if (!gc?.lang_to_id || !gc.decoder_start_token_id || !lib.Tensor) return null; // english-only model (or exotic export)
    const clip = audio.length > SAMPLE_RATE * 8 ? audio.subarray(0, SAMPLE_RATE * 8) : audio;
    const feats = await _pipe.processor(clip);
    const decoder_input_ids = new lib.Tensor('int64', new BigInt64Array([BigInt(gc.decoder_start_token_id)]), [1, 1]);
    const out = await _pipe.model({ ...feats, decoder_input_ids });
    let best = null, bestVal = -Infinity;
    for (const [tok, id] of Object.entries(gc.lang_to_id)) {
      const v = Number(out.logits.data[id]);
      if (v > bestVal) { bestVal = v; best = tok; }
    }
    return best ? best.slice(2, -2) : null; // '<|fr|>' → 'fr'
  } catch { return null; } // fail-open: whisper's English default still transcribes
}

async function decodeSession(s, { flush = false } = {}) {
  if (s.closed && !flush) return;
  if (!isReady() || !s.samples) return;
  s.lastDecodeAt = Date.now();

  const audio = concatBuffer(s);
  const tail = Math.round((SILENCE_FINAL_MS / 1000) * SAMPLE_RATE);
  const trailingQuiet = audio.length > tail && rms(audio, audio.length - tail) < SILENCE_RMS;

  // Nothing but room tone? Don't decode (whisper hallucinates on silence) and
  // don't let the buffer grow unbounded — keep only the last second.
  if (rms(audio) < SILENCE_RMS) {
    if (audio.length > SAMPLE_RATE * 5) {
      s.chunks = [audio.subarray(audio.length - SAMPLE_RATE)];
      s.samples = SAMPLE_RATE;
    }
    return;
  }

  // Auto-detect the spoken language on the session's first voiced audio (≥1s),
  // then pin it. An explicit client `lang` wins; `.en` models skip all of this.
  if (!s.lang && !s.langTried && !isEnglishOnly(_model) && audio.length >= SAMPLE_RATE) {
    s.langTried = true;
    const detected = await detectLanguage(audio);
    if (detected) { s.lang = detected; emit(s, { type: 'language', lang: detected }); }
  }

  let text = '';
  try {
    const opts = isEnglishOnly(_model) ? {} : { language: s.lang || undefined, task: 'transcribe' };
    const out = await _pipe(audio, opts);
    text = String(out?.text || '').trim();
  } catch (e) {
    emit(s, { type: 'error', code: 'decode_failed', message: e.message, fatal: false });
    return;
  }
  if (!text) return;

  const tooLong = audio.length >= MAX_SEGMENT_S * SAMPLE_RATE;
  const overflow = audio.length >= MAX_BUFFER_S * SAMPLE_RATE;
  if (flush || trailingQuiet || tooLong || overflow) {
    // Commit: the open segment becomes a final; the buffer restarts empty.
    s.chunks = []; s.samples = 0; s.lastInterim = '';
    emit(s, { type: 'final', text });
  } else if (text !== s.lastInterim) {
    s.lastInterim = text;
    emit(s, { type: 'interim', text });
  }
  // More audio may have arrived while decoding — the next push reschedules.
}

// Stop a session: flush any remaining speech as a last final, notify, clean up.
export async function endSession(id) {
  const s = getSession(id);
  if (!s || s.closed) return false;
  s.closed = true;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  if (s.decodeTimer) { clearTimeout(s.decodeTimer); s.decodeTimer = null; }
  try {
    await (_decodeChain = _decodeChain.then(() => decodeSession(s, { flush: true }).catch(() => {})));
  } finally {
    emit(s, { type: 'end' });
    s.listeners.clear();
    _sessions.delete(s.id);
  }
  return true;
}

// Test hook: reset module state.
export function _reset() {
  for (const s of _sessions.values()) {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (s.decodeTimer) clearTimeout(s.decodeTimer);
  }
  _sessions.clear();
  _state = 'off'; _model = null; _pipe = null; _err = null; _initPromise = null; _progress = null;
}

// Test hook: inject a fake pipeline (so session logic is testable without a model).
export function _setPipeForTest(pipe, model = 'test/fake') {
  _pipe = pipe; _model = model; _state = pipe ? 'ready' : 'off';
}
