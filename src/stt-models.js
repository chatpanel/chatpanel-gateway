// Catalog of speech-to-text (whisper) models the gateway can run, surfaced in the
// extension's Gateway settings and dictation UI. All are ONNX (transformers.js)
// automatic-speech-recognition models — same engine, download plumbing, and model
// root as the NER catalog (models.js). Sizes are the on-disk q8 footprint, approx.
//
// Adding a model: any onnx-community/* (or Xenova/*) whisper export works. Verify
// it loads + transcribes before listing it here. `.en` models are English-only and
// reject language/task options — sttDecodeOptions() below handles that split.

// Default is MULTILINGUAL on purpose: whisper auto-detects the spoken language
// per segment when no `language` is pinned — dictation must "just work" in any
// language without a setting. `.en` models are the speed opt-in, not the default.
export const DEFAULT_STT_MODEL = 'onnx-community/whisper-base';

export const STT_MODEL_CATALOG = [
  {
    id: 'onnx-community/whisper-base',
    label: 'Multilingual — balanced',
    lang: '99 languages (auto-detected)',
    approxMB: 105,
    note: 'Default. Detects the spoken language automatically; good accuracy.',
  },
  {
    id: 'onnx-community/whisper-tiny.en',
    label: 'English — fastest',
    lang: 'English',
    approxMB: 60,
    note: 'Real-time on modest hardware; English only.',
  },
  {
    id: 'onnx-community/whisper-small',
    label: 'Multilingual — accurate',
    lang: '99 languages (auto-detected)',
    approxMB: 330,
    note: 'Best accuracy; needs a faster machine for real-time use.',
  },
];

export function isKnownSttModel(id) {
  return STT_MODEL_CATALOG.some((m) => m.id === id);
}

// English-only exports reject `language`/`task` generation options.
export function isEnglishOnly(id) {
  return /\.en$/.test(String(id || ''));
}
