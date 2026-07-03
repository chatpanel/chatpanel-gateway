// Catalog of speech-to-text (whisper) models the gateway can run, surfaced in the
// extension's Gateway settings and dictation UI so users pick by their machine's
// resources. All are ONNX (transformers.js) automatic-speech-recognition models —
// same engine, download plumbing, and model root as the NER catalog (models.js).
//
// `tier` groups them for the picker (light / balanced / accurate / max). `ramMB`
// is a rough working-set hint. `approxMB` is the DOWNLOAD size for the dtype the
// current runtime will actually fetch — it differs by runtime (the WASM binary
// downloads fp32; the native npm build downloads q8), so it's a range, and the
// gateway reports the exact bytes as they stream.
//
// Adding a model: any onnx-community/* (or Xenova/*) whisper export works. Verify
// it loads on BOTH runtimes (native q8 + WASM fp32) before listing it — the WASM
// runtime can't load block-quantized (q8/int8) or fp16 exports (see stt-engine
// runtimeDtype). `.en` models are English-only and reject language/task options.

export const DEFAULT_STT_MODEL = 'onnx-community/whisper-base';

export const STT_MODEL_CATALOG = [
  {
    id: 'onnx-community/whisper-tiny.en',
    label: 'Tiny (English)',
    lang: 'English',
    tier: 'light',
    approxMB: 150,   // fp32 on WASM; ~40 on native q8
    ramMB: 400,
    note: 'Fastest, lightest. English only — great for quick dictation on any machine.',
  },
  {
    id: 'onnx-community/whisper-base',
    label: 'Base (multilingual)',
    lang: '99 languages (auto-detected)',
    tier: 'balanced',
    approxMB: 300,   // fp32 on WASM; ~80 on native q8
    ramMB: 700,
    note: 'Default. Detects the spoken language automatically; good accuracy at real-time speed.',
  },
  {
    id: 'onnx-community/whisper-small',
    label: 'Small (multilingual)',
    lang: '99 languages (auto-detected)',
    tier: 'accurate',
    approxMB: 950,   // fp32 on WASM; ~250 on native q8
    ramMB: 1600,
    note: 'Noticeably more accurate; needs a faster CPU to keep up in real time.',
  },
  {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: 'Large v3 Turbo (multilingual)',
    lang: '99 languages (auto-detected)',
    tier: 'max',
    approxMB: 1600,  // native q8 recommended; heavy on WASM
    ramMB: 3200,
    note: 'Best accuracy. For powerful machines; use the native (npm) gateway for speed.',
  },
];

export function isKnownSttModel(id) {
  return STT_MODEL_CATALOG.some((m) => m.id === id);
}

export function sttModel(id) {
  return STT_MODEL_CATALOG.find((m) => m.id === id) || null;
}

// English-only exports reject `language`/`task` generation options.
export function isEnglishOnly(id) {
  return /\.en$/.test(String(id || ''));
}

// A model may pin an explicit dtype (overriding the runtime default). None do by
// default — the engine's runtimeDtype() picks q8 (native) / fp32 (WASM) — but
// this is the seam for a model that needs a specific quantization.
export function sttModelDtype(id) {
  return sttModel(id)?.dtype || null;
}

// Accept a user-supplied / registry-picked STT model id. STRICT `org/name` shape,
// no path traversal. We DON'T require "whisper" in the id — the extension's model
// registry only surfaces transformers.js automatic-speech-recognition models
// (whisper, moonshine, …), all of which load via the ASR pipeline; the engine
// fails open if a pick turns out incompatible. Curated ids use the private
// dl.chatpanel.net mirror; custom ids fetch from Hugging Face directly.
export function isValidCustomSttId(id) {
  const s = String(id || '');
  return /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(s) && !s.includes('..');
}
