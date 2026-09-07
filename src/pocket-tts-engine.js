// Kyutai Pocket TTS — the engine that can actually speak in YOUR voice.
//
// Kokoro's voices are fixed style banks and SpeechT5 borrows a voice print from a
// space it was not trained on, so neither reproduces a specific person. Pocket TTS
// is built for it: its Mimi encoder turns a few seconds of audio into a voice
// conditioning that seeds generation directly, which is why the same sample gives
// back the same speaker rather than a distant relative of them.
//
// Ported from the reference browser implementation in the `KevinAHM/pocket-tts-web`
// Hugging Face Space (Apache-2.0), adapted from a Web Worker to in-process Node:
// fetch → fs, postMessage → return values, and the CDN onnxruntime → the one this
// gateway already ships (parakeet-engine.js's getOrt() pattern, so the same code
// runs on native ORT and on the binary's WASM build). Model weights are
// CC-BY-4.0 from `KevinAHM/pocket-tts-onnx`.
//
// Five graphs, and the shape of a turn:
//   text_conditioner  text tokens  → text embeddings
//   mimi_encoder      voice sample → voice conditioning        (this is the cloning)
//   flow_lm_main      autoregressive step → conditioning + an end-of-speech logit
//   flow_lm_flow      flow-matching denoise of one latent frame
//   mimi_decoder      latent frames → audio
// flow_lm and mimi are STATEFUL: each call returns the state the next one needs,
// described by a manifest in bundle.json rather than hardcoded here.

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync, createWriteStream, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { modelRoot } from './ner-engine.js';
import { SentencePieceUnigram } from './sentencepiece.js';

export const POCKET_REPO = 'KevinAHM/pocket-tts-onnx';
export const DEFAULT_BUNDLE = 'english_2026-04';
export const SAMPLE_RATE = 24000;

// Generation constants, carried over from the reference implementation.
const MAX_FRAMES = 500;          // hard ceiling per chunk (~40s at 12.5 fps)
const LSD_STEPS = 1;             // flow-matching steps per frame
const TEMPERATURE = 0.7;
const EOS_LOGIT_THRESHOLD = -4.0;
const FIRST_CHUNK_FRAMES = 3;    // decode early so audio starts sooner
const NORMAL_CHUNK_FRAMES = 12;
// The reference resets both states per text chunk; keeping them would let one
// sentence's trailing state colour the next one's opening.
const RESET_STATE_EACH_CHUNK = true;

// voices.bin (the reference implementation's PREDEFINED speakers) is deliberately
// absent: it lives only in the demo Space, not the weights repo, and this engine
// exists to speak in a voice the user recorded. Kokoro already covers "pick a
// stock voice", and far better.
const FILES = (q = '_int8') => [
  'bundle.json', 'tokenizer.model', 'bos_before_voice.npy',
  `text_conditioner${q}.onnx`, `mimi_encoder${q}.onnx`, `mimi_decoder${q}.onnx`,
  `flow_lm_main${q}.onnx`, `flow_lm_flow${q}.onnx`,
];

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

export function bundleDir(bundle = DEFAULT_BUNDLE) {
  return join(modelRoot(), 'pocket-tts', bundle);
}

export function bundleOnDisk(bundle = DEFAULT_BUNDLE, quant = '_int8') {
  const dir = bundleDir(bundle);
  try {
    return FILES(quant).every((f) => { const p = join(dir, f); return existsSync(p) && statSync(p).size > 0; });
  } catch { return false; }
}

async function downloadFile(bundle, file, dir, { onProgress, log } = {}) {
  const url = `https://huggingface.co/${POCKET_REPO}/resolve/main/onnx/${bundle}/${file}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`fetch ${file} → HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = join(dir, `${file}.part`);
  const out = createWriteStream(tmp);
  let got = 0, lastPct = -1;
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => {
    got += c.length;
    if (total) { const pct = Math.round((got / total) * 100); if (pct !== lastPct) { lastPct = pct; onProgress?.({ file, pct }); } }
  });
  await new Promise((resolve, reject) => { src.pipe(out); out.on('finish', resolve); out.on('error', reject); src.on('error', reject); });
  // .part then rename, so an interrupted fetch never reads as installed.
  renameSync(tmp, join(dir, file));
  log?.(`[pocket-tts] fetched ${file}`);
}

export async function ensureBundle(bundle = DEFAULT_BUNDLE, quant = '_int8', { onProgress, log } = {}) {
  const dir = bundleDir(bundle);
  mkdirSync(dir, { recursive: true });
  for (const file of FILES(quant)) {
    const dest = join(dir, file);
    if (existsSync(dest) && statSync(dest).size > 0) continue;
    log?.(`[pocket-tts] downloading ${file}…`);
    await downloadFile(bundle, file, dir, { onProgress, log });
  }
  return dir;
}

// ── .npy (float32) ──────────────────────────────────────────────────────────────
export function parseNpyFloat32(buf) {
  const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
  for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) throw new Error('not an NPY file');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const major = view.getUint8(6);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerOffset = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(buf.subarray(headerOffset, headerOffset + headerLen));
  const m = /\(\s*([0-9,\s]*)\)/.exec(header);
  if (!m) throw new Error('could not parse NPY shape');
  const shape = m[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => parseInt(x, 10));
  const start = headerOffset + headerLen;
  const data = new Float32Array((buf.byteLength - start) / 4);
  for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(start + i * 4, true);
  return { data, shape };
}

// ── state manifests ─────────────────────────────────────────────────────────────
// Both stateful graphs describe their own state in bundle.json: which inputs to
// seed, with what shape and fill, and which outputs feed them next turn. Reading
// it beats hardcoding 18 + 56 tensor names that differ per language bundle.
function filledArray(shape, dtype, fill) {
  const size = shape.reduce((a, b) => a * b, 1);
  if (dtype === 'int64') return new BigInt64Array(size);
  if (dtype === 'bool') return new Uint8Array(size);
  const d = new Float32Array(size);
  if (fill === 'nan') d.fill(NaN);
  else if (fill === 'ones') d.fill(1);
  return d;
}

function initState(ort, manifest) {
  const state = {};
  for (const e of manifest) state[e.input_name] = new ort.Tensor(e.dtype, filledArray(e.shape, e.dtype, e.fill), e.shape);
  return state;
}

function advanceState(state, result, manifest) {
  for (const e of manifest) state[e.input_name] = result[e.output_name];
}

export class PocketTTS {
  constructor() {
    this.ready = false;
    this.bundle = null;
    this.meta = null;
    this.tok = null;
    this.bos = null;
    this.sessions = null;
    this.st = null;            // precomputed flow-matching s/t pairs
    this.latentDim = 32;
    this.condDim = 1024;
    this.samplesPerFrame = 1920;
  }

  async load(bundle = DEFAULT_BUNDLE, { quant = '_int8', onProgress, log = () => {} } = {}) {
    const dir = await ensureBundle(bundle, quant, { onProgress, log });
    const ort = await getOrt();
    this.meta = JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8'));
    this.tok = new SentencePieceUnigram(new Uint8Array(readFileSync(join(dir, 'tokenizer.model'))));
    this.bos = this.meta.insert_bos_before_voice ? parseNpyFloat32(readFileSync(join(dir, 'bos_before_voice.npy'))) : null;
    this.latentDim = Number(this.meta.latent_dim) || 32;
    this.condDim = Number(this.meta.conditioning_dim) || 1024;
    this.samplesPerFrame = Math.round(SAMPLE_RATE / (Number(this.meta.frame_rate) || 12.5));

    const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
    const [textConditioner, mimiEncoder, mimiDecoder, flowMain, flowFlow] = await Promise.all([
      ort.InferenceSession.create(join(dir, `text_conditioner${quant}.onnx`), opts),
      ort.InferenceSession.create(join(dir, `mimi_encoder${quant}.onnx`), opts),
      ort.InferenceSession.create(join(dir, `mimi_decoder${quant}.onnx`), opts),
      ort.InferenceSession.create(join(dir, `flow_lm_main${quant}.onnx`), opts),
      ort.InferenceSession.create(join(dir, `flow_lm_flow${quant}.onnx`), opts),
    ]);
    this.sessions = { ort, textConditioner, mimiEncoder, mimiDecoder, flowMain, flowFlow };

    // Flow matching walks s → t in fixed steps; the tensors never change, so they
    // are built once rather than per frame (this runs MAX_FRAMES times a chunk).
    this.st = [];
    const dt = 1 / LSD_STEPS;
    for (let i = 0; i < LSD_STEPS; i++) {
      const s = i / LSD_STEPS;
      this.st.push({
        s: new ort.Tensor('float32', new Float32Array([s]), [1, 1]),
        t: new ort.Tensor('float32', new Float32Array([s + dt]), [1, 1]),
      });
    }
    this.bundle = bundle;
    this.ready = true;
    log(`[pocket-tts] ready — ${bundle} (${quant.replace('_', '') || 'fp32'}, ${SAMPLE_RATE} Hz)`);
    return true;
  }

  /**
   * THE CLONING STEP. A few seconds of 24 kHz mono audio → the voice conditioning
   * that seeds generation. Returns { data, shape } to be stored as the voice print.
   */
  async encodeVoice(audio) {
    if (!this.ready) throw new Error('pocket-tts not loaded');
    const { ort, mimiEncoder } = this.sessions;
    const pcm = audio instanceof Float32Array ? audio : Float32Array.from(audio);
    const out = await mimiEncoder.run({ audio: new ort.Tensor('float32', pcm, [1, 1, pcm.length]) });
    const emb = out[mimiEncoder.outputNames[0]];
    let dims = emb.dims.slice();
    while (dims.length > 3 && dims[0] === 1) dims = dims.slice(1);
    if (dims.length < 3) dims = [1, dims[0], dims[1]];
    return { data: Float32Array.from(emb.data), shape: dims };
  }

  // The voice conditioning is fed to flow_lm_main in the TEXT-embedding slot,
  // preceded by the bundle's BOS frames — the model is told "this is how the
  // speaker sounds" before it is told what to say.
  #voiceTensor(voice) {
    const { ort } = this.sessions;
    let data = voice.data instanceof Float32Array ? voice.data : Float32Array.from(voice.data);
    let dims = voice.shape.slice();
    if (this.meta.insert_bos_before_voice && this.bos) {
      const combined = new Float32Array(this.bos.data.length + data.length);
      combined.set(this.bos.data, 0);
      combined.set(data, this.bos.data.length);
      data = combined;
      dims = [1, dims[1] + this.bos.shape[1], dims[2]];
    }
    return new ort.Tensor('float32', data, dims);
  }

  async #voiceState(voice) {
    const { ort, flowMain } = this.sessions;
    const state = initState(ort, this.meta.flow_lm_state_manifest);
    const result = await flowMain.run({
      sequence: new ort.Tensor('float32', new Float32Array(0), [1, 0, this.latentDim]),
      text_embeddings: this.#voiceTensor(voice),
      ...state,
    });
    advanceState(state, result, this.meta.flow_lm_state_manifest);
    return state;
  }

  // Normalization the model expects: one line, capitalized, terminated.
  #prepare(text) {
    let s = String(text).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return { text: '', framesAfterEos: 1 };
    if (this.meta.remove_semicolons) s = s.replace(/;/g, ',');
    const words = s.split(/\s+/).filter(Boolean).length;
    let framesAfterEos = words <= 4 ? 3 : 1;
    if (this.meta.model_recommended_frames_after_eos != null) framesAfterEos = Number(this.meta.model_recommended_frames_after_eos);
    if (!/[A-ZÀ-Þ]/.test(s[0])) s = s[0].toUpperCase() + s.slice(1);
    if (/[0-9A-Za-zÀ-ÿ]/.test(s[s.length - 1])) s += '.';
    if (this.meta.pad_with_spaces_for_short_inputs && words < 5) s = `        ${s}`;
    return { text: s, framesAfterEos };
  }

  // One forward pass per FRAME, so a long paragraph in a single chunk is a long
  // time before any audio. Split on sentences, then on the model's token ceiling.
  #chunks(text) {
    const maxTokens = Number(this.meta.max_token_per_chunk) || 50;
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    const out = [];
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s) continue;
      const ids = this.tok.encodeIds(s);
      if (ids.length <= maxTokens) { out.push(s); continue; }
      for (let i = 0; i < ids.length; i += maxTokens) {
        const part = this.tok.decodeIds(ids.slice(i, i + maxTokens)).trim();
        if (part) out.push(part);
      }
    }
    return out.length ? out : [text];
  }

  /**
   * Synthesize. `voice` is what encodeVoice() returned. `onAudio(pcm)` receives
   * each decoded piece as it lands, so a caller can stream; the whole waveform is
   * returned as well.
   */
  async synth(text, { voice, onAudio = null } = {}) {
    if (!this.ready) throw new Error('pocket-tts not loaded');
    if (!voice?.data?.length) throw new Error('pocket-tts needs a voice — record one');
    const { ort, textConditioner, flowMain, flowFlow, mimiDecoder } = this.sessions;
    const prepared = this.#prepare(text);
    if (!prepared.text) return new Float32Array(0);
    const chunks = this.#chunks(prepared.text);
    const baseFlow = await this.#voiceState(voice);

    const emptySeq = new ort.Tensor('float32', new Float32Array(0), [1, 0, this.latentDim]);
    const emptyText = new ort.Tensor('float32', new Float32Array(0), [1, 0, this.condDim]);
    let mimiState = initState(ort, this.meta.mimi_state_manifest);
    let flowState = { ...baseFlow };
    const pieces = [];
    let first = true;

    for (let c = 0; c < chunks.length; c++) {
      if (RESET_STATE_EACH_CHUNK && c > 0) {
        flowState = { ...baseFlow };
        mimiState = initState(ort, this.meta.mimi_state_manifest);
      }
      const ids = this.tok.encodeIds(chunks[c]);
      const tokens = new ort.Tensor('int64', BigInt64Array.from(ids, (t) => BigInt(t)), [1, ids.length]);
      let textEmb = (await textConditioner.run({ token_ids: tokens }))[textConditioner.outputNames[0]];
      if (textEmb.dims.length === 2) textEmb = new ort.Tensor('float32', Float32Array.from(textEmb.data), [1, textEmb.dims[0], textEmb.dims[1]]);

      // Prime the LM with the text, then generate frames from silence.
      advanceState(flowState, await flowMain.run({ sequence: emptySeq, text_embeddings: textEmb, ...flowState }), this.meta.flow_lm_state_manifest);

      const latents = [];
      let decoded = 0;
      let cur = new ort.Tensor('float32', new Float32Array(this.latentDim).fill(NaN), [1, 1, this.latentDim]);
      let eosAt = null;

      for (let step = 0; step < MAX_FRAMES; step++) {
        const ar = await flowMain.run({ sequence: cur, text_embeddings: emptyText, ...flowState });
        const conditioning = ar.conditioning;
        if (ar.eos_logit.data[0] > EOS_LOGIT_THRESHOLD && eosAt == null) eosAt = step;
        const stop = eosAt != null && step >= eosAt + prepared.framesAfterEos;

        // Start from Gaussian noise, then walk it along the learned flow field.
        const std = Math.sqrt(TEMPERATURE);
        const latent = new Float32Array(this.latentDim);
        for (let i = 0; i < this.latentDim; i++) {
          let u = 0, v = 0;
          while (u === 0) u = Math.random();
          while (v === 0) v = Math.random();
          latent[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * std;
        }
        const dt = 1 / LSD_STEPS;
        for (let k = 0; k < LSD_STEPS; k++) {
          const f = await flowFlow.run({ c: conditioning, s: this.st[k].s, t: this.st[k].t, x: new ort.Tensor('float32', latent, [1, this.latentDim]) });
          const dir = f.flow_dir.data;
          for (let i = 0; i < this.latentDim; i++) latent[i] += dir[i] * dt;
        }

        latents.push(Float32Array.from(latent));
        cur = new ort.Tensor('float32', latent, [1, 1, this.latentDim]);
        advanceState(flowState, ar, this.meta.flow_lm_state_manifest);

        // Decode in small batches — the first deliberately tiny so sound starts
        // early, the rest larger because the decoder is cheaper in bulk.
        const pending = latents.length - decoded;
        let take = 0;
        if (stop) take = pending;
        else if (first && pending >= FIRST_CHUNK_FRAMES) take = FIRST_CHUNK_FRAMES;
        else if (pending >= NORMAL_CHUNK_FRAMES) take = NORMAL_CHUNK_FRAMES;

        if (take > 0) {
          const buf = new Float32Array(take * this.latentDim);
          for (let f = 0; f < take; f++) buf.set(latents[decoded + f], f * this.latentDim);
          const dec = await mimiDecoder.run({ latent: new ort.Tensor('float32', buf, [1, take, this.latentDim]), ...mimiState });
          advanceState(mimiState, dec, this.meta.mimi_state_manifest);
          decoded += take;
          first = false;
          const pcm = Float32Array.from(dec[mimiDecoder.outputNames[0]].data);
          pieces.push(pcm);
          onAudio?.(pcm);
        }
        if (stop) break;
      }
    }

    const total = pieces.reduce((n, p) => n + p.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const p of pieces) { out.set(p, at); at += p.length; }
    return out;
  }
}
