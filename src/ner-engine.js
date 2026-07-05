// In-process Named Entity Recognition — zero Python, zero second port.
//
// Replaces the old bundled spaCy microservice (a Python venv + uvicorn on :9009)
// with an ONNX transformer model run IN-PROCESS via transformers.js. This is what
// makes the gateway self-contained: nothing to install, no interpreter, no second
// port — the same model runs identically on macOS / Windows / Linux, and offline
// once the weights are on disk.
//
// Accuracy: the default (Xenova/bert-base-NER) matches or beats spaCy's
// en_core_web_sm on PERSON / ORG / LOCATION. Numeric PII (phone/card/SSN) is NOT
// the model's job — the deterministic regex layer in @chatpanel/pii handles that,
// same as before.
//
// Fail-open by design: if the model can't load (e.g. first run with no network and
// no cached weights), the gateway logs one line and runs deterministic-only.

import os from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { isKnownModel } from './models.js';
import { isLoopbackHost, isPrivateHost, isMetadataHost } from '@chatpanel/pii';
import { verifyModelWeights } from './model-integrity.js';

const DEFAULT_MODEL = 'Xenova/bert-base-NER';
const DEFAULT_MODEL_HOST = 'https://dl.chatpanel.net/models/';

// Where model weights are fetched from — ChatPanel's own edge-cached CDN by default,
// so a clean install depends only on chatpanel.net. CHATPANEL_MODEL_BASE_URL can
// override it (HF for dev, or an air-gapped LAN mirror) — but that env var is a
// download-redirect vector: an attacker who sets it could serve a malicious ONNX
// model into the runtime. So we VALIDATE the override before trusting it: http(s)
// only, never cloud metadata, and no PLAINTEXT http to a PUBLIC host (a LAN/loopback
// mirror on http is fine — that's the air-gap case). Anything else falls back to the
// signed default and logs loudly. (True per-file checksum verification is the
// remaining H3 step — needs a committed {model→sha256} manifest.)
export function resolveModelHost() {
  const raw = process.env.CHATPANEL_MODEL_BASE_URL;
  if (!raw) return DEFAULT_MODEL_HOST;
  const fallback = (why) => {
    console.warn(`[models] ignoring CHATPANEL_MODEL_BASE_URL (${raw}): ${why} — using ${DEFAULT_MODEL_HOST}`);
    return DEFAULT_MODEL_HOST;
  };
  let u;
  try { u = new URL(raw); } catch { return fallback('not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback(`scheme ${u.protocol} not allowed`);
  if (isMetadataHost(u.hostname)) return fallback('points at cloud metadata');
  const localish = isLoopbackHost(u.hostname) || isPrivateHost(u.hostname);
  if (u.protocol === 'http:' && !localish) return fallback('plaintext http:// to a public host (use https or a LAN/loopback mirror)');
  console.warn(`[models] ⚠ model weights will be downloaded from ${u.origin} (CHATPANEL_MODEL_BASE_URL override), not ${DEFAULT_MODEL_HOST}`);
  return raw.replace(/\/*$/, '/');
}

// Must end with '/' (transformers appends the model path template to it).
const MODEL_HOST = resolveModelHost();

let _state = 'off';        // 'off' | 'loading' | 'downloading' | 'ready' | 'error'
let _model = null;         // active model id, e.g. 'Xenova/bert-base-NER'
let _pipe = null;          // the loaded token-classification pipeline
let _err = null;           // last error message (for /status)
let _initPromise = null;   // single-flight init
let _lib = null;           // memoized { env, pipeline } from transformers (imported once)
let _progress = null;      // { model, file, pct } while a model is downloading, else null

// Where model weights live ON DISK. A real, writable, persistent user dir — NOT
// inside node_modules (wiped on reinstall, and absent entirely in a compiled
// binary). The settings "download larger models" flow writes here too.
export function modelRoot() {
  return process.env.CHATPANEL_MODELS_DIR || join(os.homedir(), '.chatpanel', 'models');
}

// Is the model already on disk? (q8 = the quantized weights we load.) When present
// we load fully offline — no network, a hard privacy guarantee.
export function modelOnDisk(modelId = _model || DEFAULT_MODEL) {
  const dir = join(modelRoot(), ...modelId.split('/'));
  return existsSync(join(dir, 'onnx', 'model_quantized.onnx')) || existsSync(join(dir, 'onnx', 'model.onnx'));
}

export function state() { return _state; }
export function isReady() { return _state === 'ready' && !!_pipe; }

// Shape the /status `ner` block consumes. `url` is reported by the server as the
// public in-process contract (http://host:port/ner); we expose the model + state.
export function health() {
  return {
    configured: _state !== 'off',
    ok: isReady(),
    state: _state,
    model: _model,
    error: _err,
  };
}

// PER/ORG/LOC/MISC come back as `entity_group`. We hand {value,type} straight to
// @chatpanel/pii, whose normalizeEntities() maps PER->PERSON, ORG->ORG,
// LOC->LOCATION and applies the user's category toggles — one source of truth.
//
// Subword healing: wordpiece tokenizers can occasionally split a name even with
// aggregation on (e.g. "Acme" -> "A" + "##cme"). A leaked "##" fragment or a
// 1-char head would NOT string-match the original text, leaving PII un-redacted.
// So we stitch a `##` continuation back onto the previous same-type span. This is
// belt-and-suspenders — most spans already arrive merged.
export async function detect(text, { signal } = {}) {
  if (!isReady()) return [];
  if (signal?.aborted) return [];
  const src = String(text || '');
  const out = await _pipe(src, { aggregation_strategy: 'simple' });
  const ents = [];
  for (const e of out || []) {
    let word = String(e.word ?? '');
    const type = e.entity_group ?? e.entity ?? 'ENTITY';
    if (word.startsWith('##') && ents.length && ents[ents.length - 1].type === type) {
      // Continuation of the previous token (no space): "A" + "##cme Corp".
      ents[ents.length - 1].value += word.slice(2);
      continue;
    }
    word = word.replace(/##/g, '').trim();
    if (!word) continue;
    ents.push({ value: word, type });
  }
  // Heal subword truncation AFTER merging (expanding before would corrupt a span the
  // next "##" token still extends, e.g. "Sure"→"Suresh" then +"sh Kumar"). Then drop
  // 1-char noise + dedupe (expansion can make two spans collide).
  const seen = new Set();
  const out2 = [];
  for (const e of ents) {
    const value = expandToWord(src, e.value.trim());
    if (value.length <= 1) continue;
    const k = `${e.type}:${value.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out2.push({ value, type: e.type });
  }
  return out2;
}

// Grow a detected span to its full surrounding word in the ORIGINAL text. A cased
// model can truncate a name to a subword ("Suresh" → "Sure"), which would leave a
// dangling fragment ("…[[PERSON]]sh") un-redacted — a leak. We extend across word
// characters at both edges so the whole token is captured. Multi-word spans are
// unaffected (their edges are already at spaces).
function expandToWord(text, value) {
  if (!value) return value;
  const idx = text.indexOf(value);
  if (idx < 0) return value;
  const isWord = (c) => !!c && /[\p{L}\p{N}'’-]/u.test(c);
  let s = idx;
  let e = idx + value.length;
  while (s > 0 && isWord(text[s - 1])) s--;
  while (e < text.length && isWord(text[e])) e++;
  return text.slice(s, e);
}

// Lets @chatpanel/pii's existing `endpoint` detection backend call us with NO real
// HTTP and NO second port: pii POSTs {text}->{entities} to a URL; we intercept by
// being passed as `fetchImpl`, run the model in-process, and return a Response.
// This reuses all of pii's caching / timeout / type-gating untouched.
export async function fetchAdapter(_url, opts = {}) {
  let text = '';
  try { text = JSON.parse(opts.body || '{}').text || ''; } catch { /* empty */ }
  const entities = await detect(text, { signal: opts.signal });
  return new Response(JSON.stringify({ entities }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Live download progress for the model currently being fetched (or null). The
// extension's model manager polls this. { model, file, pct }.
export function progress() { return _progress; }

// Import transformers ONCE and configure its env (model dir + WASM in a binary).
// Exported so sibling engines (stt-engine.js) share the same configured lib —
// one env, one cache dir, one WASM setup; never a second copy of this logic.
export async function ensureLib() {
  if (_lib) return _lib;
  const root = modelRoot();
  try { mkdirSync(root, { recursive: true }); } catch { /* best effort */ }

  // In a Bun --compile single-file binary there is no native onnxruntime-node (its
  // dylib can't be embedded), so the binary entry embeds the onnxruntime-web WASM
  // runtime and hands us its paths via this global. When present we force the WASM
  // backend (transformers picks it when it doesn't see a Node env) BEFORE importing
  // transformers. The npm/Node path leaves this unset and uses the faster native
  // runtime.
  const wasmPaths = globalThis.__CHATPANEL_WASM_PATHS__ || null;
  if (wasmPaths) {
    try { Object.defineProperty(process, 'release', { value: { ...process.release, name: 'bun' }, configurable: true }); } catch { /* ignore */ }
  }

  const { env, pipeline, Tensor, AutoModel, AutoProcessor } = await import('@huggingface/transformers');
  env.cacheDir = root;          // where remote downloads are cached
  env.localModelPath = root;    // where local loads resolve — same dir, we control it
  try { env.remoteHost = MODEL_HOST; } catch { /* optional */ }
  try { env.backends.onnx.wasm.numThreads = 1; } catch { /* optional */ }
  if (wasmPaths) {
    // Single-thread + no proxy + preloaded wasm bytes — avoids the `blob:` ESM-scheme
    // failure when ORT-web runs outside a browser.
    try { env.backends.onnx.wasm.proxy = false; env.backends.onnx.wasm.wasmPaths = wasmPaths; } catch { /* optional */ }
  }
  _lib = { env, pipeline, Tensor, AutoModel, AutoProcessor };
  return _lib;
}

// (Re)load a specific model into _pipe. Downloads it first if missing (and allowed).
// Reusable by init() and setModel(). Fail-open: on error, state='error', _pipe stays
// whatever it was (so a failed SWITCH doesn't kill a working detector).
/** @param {string} modelId @param {{ log?: (m: string) => void, allowDownload?: boolean }} [opts] */
async function loadModel(modelId, { log = () => {}, allowDownload = true } = {}) {
  const prevPipe = _pipe;
  const prevModel = _model;
  let lib;
  try {
    lib = await ensureLib();
  } catch (e) {
    _state = 'error'; _err = `engine load failed: ${e.message}`;
    log(`[ner] transformers.js not available (${e.message}) — deterministic-only`);
    return false;
  }

  const haveLocal = modelOnDisk(modelId);
  // Offline if cached (fast + private); only reach the network when missing.
  lib.env.allowRemoteModels = haveLocal ? false : !!allowDownload;
  if (!haveLocal && !allowDownload) {
    _state = 'error'; _err = 'model not on disk and downloads disabled';
    log(`[ner] model ${modelId} not installed and downloads disabled — deterministic-only`);
    return false;
  }

  // Curated catalog models come from the private dl.chatpanel.net mirror
  // (ensureLib set that as remoteHost). A user's BYO id isn't mirrored, so fetch
  // it from Hugging Face directly — only for this load, then restore.
  const prevHost = lib.env.remoteHost;
  const isCustom = !isKnownModel(modelId);
  if (!haveLocal && isCustom) { try { lib.env.remoteHost = 'https://huggingface.co/'; } catch { /* optional */ } }

  _state = haveLocal ? 'loading' : 'downloading';
  if (!haveLocal) { _progress = { model: modelId, file: null, pct: 0 }; log(`[ner] downloading model ${modelId} (one-time${isCustom ? ', from Hugging Face' : ''})…`); }

  try {
    const progress_callback = (p) => {
      if (!p) return;
      const pct = typeof p.progress === 'number' ? Math.round(p.progress) : (_progress?.pct ?? 0);
      if (p.status === 'progress' || p.status === 'download' || p.status === 'initiate') {
        _progress = { model: modelId, file: p.file || _progress?.file || null, pct };
      } else if (p.status === 'done' && p.file) {
        log(`[ner] fetched ${p.file}`);
      }
    };
    let pipe;
    try {
      pipe = await lib.pipeline('token-classification', modelId, { dtype: 'q8', progress_callback });
    } catch (e) {
      // Mirror gap → fall back to Hugging Face (same as stt-engine).
      if (haveLocal || isCustom || !allowDownload) throw e;
      log(`[ner] mirror fetch failed (${String(e.message).slice(0, 80)}) — retrying from Hugging Face…`);
      lib.env.remoteHost = 'https://huggingface.co/';
      lib.env.allowRemoteModels = true;
      pipe = await lib.pipeline('token-classification', modelId, { dtype: 'q8', progress_callback });
    }
    // H3: verify freshly-downloaded weights against committed hashes before we trust
    // this pipeline. On a mismatch, dispose it (never use its outputs) and let the
    // throw fall through to the catch (keeps the previous model / deterministic-only).
    // NOTE: transformers downloads+loads in one call, so this runs POST-load — it
    // prevents USING and PERSISTING a tampered model, not a hypothetical ORT
    // parse-time bug. Warn-and-allow when the model isn't in the hash manifest.
    if (!haveLocal) {
      try {
        verifyModelWeights(modelId, { modelsDir: modelRoot(), log });
      } catch (e) {
        try { await pipe.dispose?.(); } catch { /* ignore */ }
        throw e;
      }
    }
    // Swap in the new pipeline, dispose the old one (free its WASM/native session).
    _pipe = pipe; _model = modelId; _state = 'ready'; _err = null; _progress = null;
    if (prevPipe && prevPipe !== pipe) { try { await prevPipe.dispose?.(); } catch { /* ignore */ } }
    log(`[ner] ready — model ${modelId} (in-process, no Python) — entity detection active`);
    return true;
  } catch (e) {
    _err = e.message; _progress = null;
    // Keep any previously-working detector rather than going dark on a bad switch.
    if (prevPipe) { _pipe = prevPipe; _model = prevModel; _state = 'ready'; }
    else { _state = 'error'; }
    log(`[ner] model load failed (${e.message})${prevPipe ? ' — keeping previous model' : ' — deterministic-only'}`);
    return false;
  } finally {
    try { lib.env.remoteHost = prevHost; } catch { /* optional */ } // restore the mirror
  }
}

// Load the default/configured model once at startup. Returns a promise that
// resolves when ready (or after a fail-open error). `cfg` = { model?, allowDownload?, onLog? }.
export function init(cfg = {}) {
  if (_initPromise) return _initPromise;
  const log = typeof cfg.onLog === 'function' ? cfg.onLog : () => {};
  _model = cfg.model || DEFAULT_MODEL;
  _state = 'loading';
  _initPromise = loadModel(_model, { log, allowDownload: cfg.allowDownload !== false });
  return _initPromise;
}

// Switch to a different model (download it first if needed). Used by the model
// manager. Returns true on success. A failed switch keeps the current detector.
export async function setModel(modelId, opts = {}) {
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const allowDownload = opts.allowDownload !== false;
  if (!modelId) return false;
  if (modelId === _model && isReady()) return true;
  return loadModel(modelId, { log, allowDownload });
}

// Test hook: reset module state (used by unit tests).
export function _reset() {
  _state = 'off'; _model = null; _pipe = null; _err = null; _initPromise = null; _lib = null; _progress = null;
}
