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

const DEFAULT_MODEL = 'Xenova/bert-base-NER';

let _state = 'off';        // 'off' | 'loading' | 'downloading' | 'ready' | 'error'
let _model = null;         // active model id, e.g. 'Xenova/bert-base-NER'
let _pipe = null;          // the loaded token-classification pipeline
let _err = null;           // last error message (for /status)
let _initPromise = null;   // single-flight init

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
  const out = await _pipe(String(text || ''), { aggregation_strategy: 'simple' });
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
  // Drop noise: a lone 1-char span that didn't get stitched is never useful PII.
  return ents.filter((e) => e.value.length > 1);
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

// Load the model once. Returns a promise that resolves when ready (or after a
// fail-open error). `cfg` = { model?, allowDownload?, onLog? }.
export function init(cfg = {}) {
  if (_initPromise) return _initPromise;
  _model = cfg.model || DEFAULT_MODEL;
  const log = typeof cfg.onLog === 'function' ? cfg.onLog : () => {};

  _initPromise = (async () => {
    _state = 'loading';
    const root = modelRoot();
    try { mkdirSync(root, { recursive: true }); } catch { /* best effort */ }

    const haveLocal = modelOnDisk(_model);
    // Offline if cached (fast + private); only reach the network on a true first
    // run, and only if downloads aren't disabled.
    const allowRemote = haveLocal ? false : (cfg.allowDownload !== false);

    // In a Bun --compile single-file binary there is no native onnxruntime-node
    // (its dylib can't be embedded), so the binary entry embeds the onnxruntime-web
    // WASM runtime and hands us its paths via this global. When present we force the
    // WASM backend (transformers picks it when it doesn't see a Node env) BEFORE
    // importing transformers. The npm/Node path leaves this unset and uses the
    // faster native runtime.
    const wasmPaths = globalThis.__CHATPANEL_WASM_PATHS__ || null;
    if (wasmPaths) {
      try { Object.defineProperty(process, 'release', { value: { ...process.release, name: 'bun' }, configurable: true }); } catch { /* ignore */ }
    }

    let env, pipeline;
    try {
      ({ env, pipeline } = await import('@huggingface/transformers'));
    } catch (e) {
      _state = 'error'; _err = `engine load failed: ${e.message}`;
      log(`[ner] transformers.js not available (${e.message}) — deterministic-only`);
      return;
    }

    // Point the library at our persistent model dir for BOTH local loads and any
    // remote download cache, so weights land in one place we control.
    env.cacheDir = root;
    env.localModelPath = root;
    env.allowRemoteModels = allowRemote;
    try { env.backends.onnx.wasm.numThreads = 1; } catch { /* optional */ }
    if (wasmPaths) {
      // Single-thread + no proxy + preloaded wasm bytes — this is what avoids the
      // `blob:` ESM-scheme failure when ORT-web runs outside a browser.
      try {
        env.backends.onnx.wasm.proxy = false;
        env.backends.onnx.wasm.wasmPaths = wasmPaths;
      } catch { /* optional */ }
    }

    if (!haveLocal && allowRemote) {
      _state = 'downloading';
      log(`[ner] first run: downloading model ${_model} (one-time, ~100 MB)…`);
    } else if (!haveLocal && !allowRemote) {
      _state = 'error'; _err = 'model not on disk and downloads disabled';
      log(`[ner] model ${_model} not installed and downloads disabled — deterministic-only`);
      return;
    }

    try {
      _pipe = await pipeline('token-classification', _model, {
        dtype: 'q8',
        progress_callback: (p) => {
          if (p?.status === 'done' && p?.file) log(`[ner] fetched ${p.file}`);
        },
      });
      _state = 'ready';
      log(`[ner] ready — model ${_model} (in-process, no Python, port :reuse) — entity detection active`);
    } catch (e) {
      _state = 'error'; _err = e.message;
      log(`[ner] model load failed (${e.message}) — deterministic-only`);
    }
  })();
  return _initPromise;
}

// Test hook: reset module state (used by unit tests).
export function _reset() {
  _state = 'off'; _model = null; _pipe = null; _err = null; _initPromise = null;
}
