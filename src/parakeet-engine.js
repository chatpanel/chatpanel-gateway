// In-process speech-to-text — NVIDIA Parakeet TDT (transducer) via onnxruntime.
//
// Whisper (stt-engine.js) is an encoder-DECODER seq2seq model and loads through the
// transformers.js `automatic-speech-recognition` pipeline. Parakeet is a *transducer*
// (Token-and-Duration Transducer / TDT on a FastConformer encoder) — a fundamentally
// different architecture the transformers.js pipeline can't drive (it errors with
// `Unsupported model type "nemo-conformer-tdt"`). So we run the ONNX graphs directly
// on the same onnxruntime the gateway already ships, with a hand-written greedy TDT
// decode loop.
//
// Why bother: Parakeet-TDT-0.6b-v3 is multilingual (25 European languages, auto-
// detected — no forced-language step) and runs ~35× realtime at int8 on CPU, several
// times faster than Whisper at comparable accuracy. It's the fast local-dictation path.
//
// Model layout (istupakov/onnx-asr export, e.g. `istupakov/parakeet-tdt-0.6b-v3-onnx`):
//   nemo128.onnx            mel preprocessor  (waveforms → 128-bin log-mel features)
//   encoder-model[.int8].onnx   FastConformer encoder (features → [B,D,T'] frames)
//   decoder_joint[.int8].onnx   fused prediction-net (LSTM) + joint network
//   vocab.txt               "<piece> <id>" per line; the last line is "<blk> <id>"
//
// This module owns ONE concern: load those graphs and turn 16 kHz mono Float32 PCM
// into text. The streaming/session/redaction/diarization layer lives in stt-engine.js
// and calls us through a tiny adapter, so nothing downstream needs to know the engine.

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, createWriteStream, renameSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { modelRoot } from './ner-engine.js';

// transformers.js reports these `model_type`s for the transducer exports. Any of them
// means "not a whisper pipeline model — route here instead".
const TRANSDUCER_MODEL_TYPES = new Set([
  'nemo-conformer-tdt', 'nemo-conformer-rnnt', 'parakeet_tdt', 'parakeet-tdt', 'parakeet_rnnt',
]);
export function isTransducerModelType(mt) {
  return TRANSDUCER_MODEL_TYPES.has(String(mt || '').trim());
}

// Parakeet ships its own quantizations (standard QDQ/QOperator int8 — NOT whisper's
// block-quantized q8, so it loads on BOTH the native and WASM runtimes). Default to
// int8: ~690 MB total vs ~2.5 GB for fp32, with negligible accuracy loss for ASR.
export const PARAKEET_DEFAULT_DTYPE = 'int8';
export function parakeetDtype(d) {
  return d === 'fp32' ? 'fp32' : PARAKEET_DEFAULT_DTYPE; // only int8 | fp32 are exported
}

// The repo files this engine needs for a given precision. `encoder-model.onnx` (fp32)
// carries its weights in a sibling `.onnx.data` external-data file that ORT loads
// automatically when it sits next to the graph — so we must fetch it too.
function filesFor(dtype) {
  const s = parakeetDtype(dtype) === 'fp32' ? '' : '.int8';
  const files = ['config.json', 'vocab.txt', 'nemo128.onnx', `encoder-model${s}.onnx`, `decoder_joint-model${s}.onnx`];
  if (!s) files.push('encoder-model.onnx.data'); // fp32 external weights
  return files;
}

export function parakeetDir(modelId) {
  return join(modelRoot(), ...String(modelId).split('/'));
}

// Present on disk = every required file exists and is non-empty (a truncated download
// must not read as "installed"). Mirrors stt/ner `modelOnDisk` intent.
export function parakeetOnDisk(modelId, dtype = PARAKEET_DEFAULT_DTYPE) {
  const dir = parakeetDir(modelId);
  if (!existsSync(dir)) return false;
  try {
    return filesFor(dtype).every((f) => { const p = join(dir, f); return existsSync(p) && statSync(p).size > 0; });
  } catch { return false; }
}

// ── onnxruntime, matching the gateway's runtime (native npm vs WASM binary) ──────────
// The npm gateway uses native onnxruntime-node (fast). The standalone binary embeds the
// onnxruntime-web WASM runtime and hands us its paths via __CHATPANEL_WASM_PATHS__ (the
// same global ner-engine keys off) — configure ORT-web from it. Memoized once.
let _ortPromise = null;
function getOrt() {
  if (_ortPromise) return _ortPromise;
  _ortPromise = (async () => {
    const wasmPaths = globalThis.__CHATPANEL_WASM_PATHS__ || null;
    const mod = await import(wasmPaths ? 'onnxruntime-web' : 'onnxruntime-node');
    const ort = mod.InferenceSession ? mod : (mod.default || mod);
    if (wasmPaths) {
      try { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.wasmPaths = wasmPaths; } catch { /* optional */ }
    }
    return ort;
  })();
  return _ortPromise;
}

// ── download (only when a model isn't already on disk) ───────────────────────────────
// Custom/BYO STT ids aren't on the dl.chatpanel.net mirror, so — like stt-engine's
// custom path — fetch straight from Hugging Face. Streamed to a .part file then renamed,
// so an interrupted download never looks complete. `onProgress({ file, pct })` drives
// the extension's model-manager UI.
async function downloadFile(modelId, file, dir, { onProgress, log } = {}) {
  const url = `https://huggingface.co/${modelId}/resolve/main/${encodeURIComponent(file).replace(/%2F/g, '/')}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`fetch ${file} → HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = join(dir, `${file}.part`);
  const out = createWriteStream(tmp);
  let got = 0, lastPct = -1;
  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => {
    got += chunk.length;
    if (total) { const pct = Math.round((got / total) * 100); if (pct !== lastPct) { lastPct = pct; onProgress?.({ file, pct }); } }
  });
  await new Promise((resolve, reject) => {
    src.pipe(out);
    out.on('finish', resolve); out.on('error', reject); src.on('error', reject);
  });
  renameSync(tmp, join(dir, file));
  log?.(`[parakeet] fetched ${file}`);
}

async function ensureFiles(modelId, dtype, { onProgress, log } = {}) {
  const dir = parakeetDir(modelId);
  mkdirSync(dir, { recursive: true });
  for (const file of filesFor(dtype)) {
    const dest = join(dir, file);
    if (existsSync(dest) && statSync(dest).size > 0) continue;
    log?.(`[parakeet] downloading ${file}…`);
    await downloadFile(modelId, file, dir, { onProgress, log });
  }
  return dir;
}

// ── vocab / detokenize ───────────────────────────────────────────────────────────────
// vocab.txt: "<piece> <id>" per line. SentencePiece marks a word boundary with ▁
// (U+2581); replace it with a space. The final line "<blk> <id>" is the blank/SOS id.
function loadVocab(dir) {
  const vocab = [];
  let blank = -1;
  for (const line of readFileSync(join(dir, 'vocab.txt'), 'utf8').split('\n')) {
    if (!line) continue;
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const id = parseInt(line.slice(sp + 1), 10);
    const tok = line.slice(0, sp);
    if (!Number.isFinite(id)) continue;
    vocab[id] = tok.replace(/▁/g, ' ');
    if (tok === '<blk>') blank = id;
  }
  if (blank < 0) blank = vocab.length - 1; // fall back to the last id (export convention)
  return { vocab, blank };
}

function argmax(arr, from, to) {
  let bi = from, bv = arr[from];
  for (let i = from + 1; i < to; i++) if (arr[i] > bv) { bv = arr[i]; bi = i; }
  return bi;
}

const DURATIONS = 5;        // TDT duration head bins → advance 0..4 encoder frames
const MAX_SYMBOLS = 10;     // cap non-blank emissions per frame (anti-runaway)

// ── recognizer ───────────────────────────────────────────────────────────────────────
// Loads the three ONNX sessions once; `transcribe()` is stateless per call (fresh LSTM
// state), so it's safe to call for every streaming segment. Serialize calls externally
// (stt-engine already funnels decodes through one chain).
export async function loadRecognizer({ modelId, dtype = PARAKEET_DEFAULT_DTYPE, allowDownload = true, onProgress, log = () => {} }) {
  const dt = parakeetDtype(dtype);
  const onDisk = parakeetOnDisk(modelId, dt);
  if (!onDisk && !allowDownload) throw new Error('model not on disk and downloads disabled');
  const dir = onDisk ? parakeetDir(modelId) : await ensureFiles(modelId, dt, { onProgress, log });

  const ort = await getOrt();
  const s = dt === 'fp32' ? '' : '.int8';
  const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  const [prep, encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(join(dir, 'nemo128.onnx'), opts),
    ort.InferenceSession.create(join(dir, `encoder-model${s}.onnx`), opts),
    ort.InferenceSession.create(join(dir, `decoder_joint-model${s}.onnx`), opts),
  ]);
  const { vocab, blank } = loadVocab(dir);
  const VOCAB = blank + 1;   // token logits span [0, VOCAB); duration logits follow
  const Tensor = ort.Tensor;

  async function transcribe(float32) {
    if (!(float32 instanceof Float32Array) || float32.length < 400) return '';
    const n = float32.length;

    // 1) mel features (done in-graph — no manual DSP).
    const pr = await prep.run({
      waveforms: new Tensor('float32', float32, [1, n]),
      waveforms_lens: new Tensor('int64', BigInt64Array.from([BigInt(n)]), [1]),
    });

    // 2) FastConformer encoder → outputs [1, D, T'] (channels-first, TIME LAST).
    const er = await encoder.run({ audio_signal: pr.features, length: pr.features_lens });
    const enc = er.outputs;
    const [, D, T] = enc.dims;
    const encLen = Number(er.encoded_lengths.data[0]);
    const ed = enc.data; // element (0,d,t) at index d*T + t

    // 3) greedy TDT decode. Per encoder frame: run the fused prednet+joint on the
    // previous token + LSTM state; split the logits into token- and duration-heads.
    // Only a NON-BLANK emission appends a token and advances the LSTM state; the
    // duration argmax says how many frames to jump (0..4). duration==0 lets us emit
    // another symbol at the same frame (up to MAX_SYMBOLS) — this is what makes TDT
    // faster than plain RNN-T.
    let h = new Float32Array(2 * 640);
    let c = new Float32Array(2 * 640);
    const tokens = [];
    const frame = new Float32Array(D);
    let t = 0, emitted = 0;
    const guard = encLen * (MAX_SYMBOLS + 1) + 8; // hard stop; the loop always advances, but be safe
    for (let iter = 0; t < encLen && iter < guard; iter++) {
      for (let d = 0; d < D; d++) frame[d] = ed[d * T + t];
      const prev = tokens.length ? tokens[tokens.length - 1] : blank;
      const out = await decoder.run({
        encoder_outputs: new Tensor('float32', frame, [1, D, 1]),
        targets: new Tensor('int32', Int32Array.from([prev]), [1, 1]),
        target_length: new Tensor('int32', Int32Array.from([1]), [1]),
        input_states_1: new Tensor('float32', h, [2, 1, 640]),
        input_states_2: new Tensor('float32', c, [2, 1, 640]),
      });
      const logits = out.outputs.data;
      const tok = argmax(logits, 0, VOCAB);
      const durIdx = argmax(logits, VOCAB, VOCAB + DURATIONS) - VOCAB; // 0..4
      if (tok !== blank) {
        h = out.output_states_1.data; c = out.output_states_2.data; // advance state only on emit
        tokens.push(tok);
        emitted++;
      }
      if (durIdx > 0) { t += durIdx; emitted = 0; }
      else if (tok === blank || emitted >= MAX_SYMBOLS) { t += 1; emitted = 0; }
      // else duration==0 & non-blank & under cap → stay on this frame, emit again
    }

    let text = '';
    for (const id of tokens) text += vocab[id] ?? '';
    return text.replace(/^\s+/, '').replace(/\s+/g, ' ').trimEnd();
  }

  function dispose() {
    for (const sess of [prep, encoder, decoder]) { try { sess.release?.(); } catch { /* ignore */ } }
  }

  return { transcribe, dispose, dtype: dt, dir };
}
