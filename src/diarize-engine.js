// Speaker diarization ("who said what") — in-process, same engine + model dir as
// STT/NER. Two layers:
//   engine    — load Xenova/wavlm-base-plus-sv and embed a segment of audio into a
//               512-d x-vector (speaker fingerprint). Download-on-demand, fail-open.
//   Diarizer  — online clustering: keep a running centroid per speaker; a new
//               segment joins the nearest centroid if cosine ≥ threshold, else it
//               starts a new speaker. Stable "Speaker N" labels within a session.
//
// Honest limits: embeddings separate DIFFERENT speakers well but same-gender / very
// similar voices can merge (synthetic TTS especially). In meetings the mic channel
// is anchored as "You" and clustering only splits the remote channel — so a merge
// there is far less costly. Opt-in per session (diarize:true); off for dictation.

import { ensureLib, modelRoot } from './ner-engine.js';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

export const DIARIZE_MODEL = 'Xenova/wavlm-base-plus-sv';

let _state = 'off';        // 'off' | 'loading' | 'downloading' | 'ready' | 'error'
let _model = null;
let _processor = null;
let _err = null;
let _initPromise = null;
let _progress = null;

// WASM can't load some quantized exports (see stt runtimeDtype); fp32 is the safe
// cross-runtime choice on the binary, q8 on native.
function runtimeDtype() {
  return globalThis.__CHATPANEL_WASM_PATHS__ ? 'fp32' : 'q8';
}

export function state() { return _state; }
export function isReady() { return _state === 'ready' && !!_model && !!_processor; }
export function progress() { return _progress; }
export function health() { return { configured: _state !== 'off', ok: isReady(), state: _state, model: _model, error: _err }; }

export function modelOnDisk(modelId = DIARIZE_MODEL, dtype = runtimeDtype()) {
  const dir = join(modelRoot(), ...modelId.split('/'), 'onnx');
  if (!existsSync(dir)) return false;
  const suffix = dtype === 'fp32' ? '' : (dtype === 'q8' ? '_quantized' : `_${dtype}`);
  try { return readdirSync(dir).some((f) => f === `model${suffix}.onnx`); }
  catch { return false; }
}

async function load({ log = () => {}, allowDownload = true } = {}) {
  let lib;
  try { lib = await ensureLib(); }
  catch (e) { _state = 'error'; _err = e.message; log(`[diarize] engine unavailable (${e.message})`); return false; }

  const haveLocal = modelOnDisk();
  lib.env.allowRemoteModels = haveLocal ? false : !!allowDownload;
  if (!haveLocal && !allowDownload) { _state = 'error'; _err = 'model not on disk and downloads disabled'; return false; }

  const prevHost = lib.env.remoteHost;
  if (!haveLocal) { try { lib.env.remoteHost = 'https://huggingface.co/'; } catch { /* wavlm isn't on the dl mirror */ } }
  _state = haveLocal ? 'loading' : 'downloading';
  if (!haveLocal) { _progress = { model: DIARIZE_MODEL, file: null, pct: 0 }; log(`[diarize] downloading ${DIARIZE_MODEL} (one-time)…`); }

  try {
    const { AutoModel, AutoProcessor } = lib;
    const cb = (p) => {
      if (!p) return;
      const pct = typeof p.progress === 'number' ? Math.round(p.progress) : (_progress?.pct ?? 0);
      if (p.status === 'progress' || p.status === 'download' || p.status === 'initiate') _progress = { model: DIARIZE_MODEL, file: p.file || _progress?.file || null, pct };
    };
    const processor = await AutoProcessor.from_pretrained(DIARIZE_MODEL, { progress_callback: cb });
    const model = await AutoModel.from_pretrained(DIARIZE_MODEL, { dtype: runtimeDtype(), progress_callback: cb });
    _processor = processor; _model = model; _state = 'ready'; _err = null; _progress = null;
    log(`[diarize] ready — ${DIARIZE_MODEL} @ ${runtimeDtype()}`);
    return true;
  } catch (e) {
    _err = e.message; _progress = null; _state = 'error';
    log(`[diarize] load failed (${e.message}) — diarization off`);
    return false;
  } finally {
    try { lib.env.remoteHost = prevHost; } catch { /* optional */ }
  }
}

export function init(cfg = {}) {
  if (_initPromise) return _initPromise;
  _state = 'loading';
  _initPromise = load({ log: cfg.onLog, allowDownload: cfg.allowDownload !== false });
  return _initPromise;
}

// Embed a mono 16 kHz Float32 segment → Float32Array x-vector, or null if not ready.
export async function embed(audio) {
  if (!isReady() || !(audio instanceof Float32Array) || !audio.length) return null;
  try {
    const inputs = await _processor(audio);
    const out = await _model(inputs);
    const t = out.embeddings ?? out.logits ?? out.last_hidden_state;
    return t?.data ? Float32Array.from(t.data) : null;
  } catch { return null; }
}

export function _reset() { _state = 'off'; _model = null; _processor = null; _err = null; _initPromise = null; _progress = null; }
export function _setForTest(model, processor) { _model = model; _processor = processor; _state = model ? 'ready' : 'off'; }

// ── Online speaker clustering ────────────────────────────────────────────────────

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? d / denom : 0;
}

// A per-session speaker tracker. `threshold` = min cosine to be the SAME speaker;
// lower → fewer speakers (merges more), higher → more speakers (splits more).
export class Diarizer {
  constructor({ threshold = 0.75, maxSpeakers = 8 } = {}) {
    this.threshold = threshold;
    this.maxSpeakers = maxSpeakers;
    this.centroids = []; // { id, label, vec: Float32Array, n }
  }

  // Assign an embedding to a speaker (nearest centroid ≥ threshold, else new).
  // `pinnedLabel` forces a label (used for the mic channel = "You" in meetings).
  assign(vec, { pinnedLabel = null } = {}) {
    if (!vec) return null;
    if (pinnedLabel) return this._merge(this._find(pinnedLabel) || this._create(pinnedLabel), vec);
    let best = null, bestSim = -1;
    for (const c of this.centroids) { const s = cosine(vec, c.vec); if (s > bestSim) { bestSim = s; best = c; } }
    if (best && bestSim >= this.threshold) return this._merge(best, vec);
    if (this.centroids.length >= this.maxSpeakers && best) return this._merge(best, vec); // cap: fold into nearest
    return this._merge(this._create(`Speaker ${this.centroids.length + 1}`), vec);
  }

  _find(label) { return this.centroids.find((c) => c.label === label) || null; }
  _create(label) { const c = { id: this.centroids.length + 1, label, vec: null, n: 0 }; this.centroids.push(c); return c; }
  _merge(c, vec) {
    if (!c.vec) { c.vec = Float32Array.from(vec); }
    else { for (let i = 0; i < c.vec.length; i++) c.vec[i] = (c.vec[i] * c.n + vec[i]) / (c.n + 1); } // running mean centroid
    c.n += 1;
    return { id: c.id, label: c.label };
  }
}
