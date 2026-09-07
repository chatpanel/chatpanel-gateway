// Catalog of text-to-speech models the gateway can run — Phase 4 of the voice
// pipeline (docs/voice-pipeline.md), the "voice out" counterpart to stt-models.js.
// Same engine family (ONNX via transformers.js), same model root, same download
// plumbing, same picker shape — so the Gateway tab renders it like the STT list.
//
// Why Kokoro and not the piper-class voices the design doc originally named: piper
// phonemizes through `piper-phonemize`, a NATIVE espeak-ng binding, and the
// standalone binary is a Bun --compile artifact that cannot carry native addons
// (it is why scripts/build.mjs stubs onnxruntime-node and sharp). Kokoro's G2P is
// the pure-JS `phonemizer` package — zero dependencies — so it is the one that
// actually runs on BOTH delivery channels. It is also Apache-2.0, 82M params, and
// ships fp32 + quantized ONNX exports, which is exactly the dual-runtime split
// model-runtime.js already encodes.
//
// Adding a model: it must expose `onnx/model{suffix}.onnx` and a tokenizer, and be
// driveable by a transformers.js class (Kokoro = StyleTextToSpeech2Model). Verify
// it loads on BOTH runtimes (native q8 + WASM fp32) before listing it.

export const DEFAULT_TTS_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const DEFAULT_TTS_VOICE = 'af_heart';

// Style-vector width in a voices/*.bin file, and the max token window a single
// forward pass accepts. Both are properties of the Kokoro export, and the engine
// needs them to slice the voice and to chunk long text.
export const STYLE_DIM = 256;
export const MAX_PHONEME_TOKENS = 510;

// Upper bound on one /tts request. Long text is CHUNKED rather than rejected, so
// this is not a model limit — it is a fairness limit: synthesis is single-engine
// and roughly realtime, so an unbounded body would hold it for minutes.
export const MAX_TTS_CHARS = 5000;

export const TTS_MODEL_CATALOG = [
  {
    id: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    label: 'Kokoro 82M (v1.0)',
    lang: 'English (US/UK)',
    tier: 'balanced',
    arch: 'style-tts2',
    approxMB: 330,  // fp32 on WASM; ~90 on native q8
    ramMB: 600,
    sampleRate: 24000,
    voices: true,
    note: 'Apache-2.0, 82M params. Natural voices at ~5× realtime on CPU. The default.',
  },
  {
    id: 'onnx-community/Kokoro-82M-v1.1-zh-ONNX',
    label: 'Kokoro 82M (v1.1, Chinese)',
    lang: 'Chinese + English',
    tier: 'balanced',
    arch: 'style-tts2',
    approxMB: 330,
    ramMB: 600,
    sampleRate: 24000,
    voices: true,
    note: 'The Mandarin-tuned Kokoro. Same engine and voice mechanism as v1.0.',
  },
  {
    id: 'Xenova/speecht5_tts',
    label: 'SpeechT5 — your own voice',
    lang: 'English',
    tier: 'custom',
    arch: 'speecht5',
    // PINNED to fp32, and not as a preference. At the runtime default (q8 on
    // native) this model renders about half of all speaker embeddings as
    // near-silence — measured: 91-92% of samples under the noise floor, where the
    // same embeddings at fp32 produce clean speech at ~47% silence, which is just
    // the pauses between words. The quantization is destroying the speaker
    // conditioning, and the failure looks exactly like "voice cloning does not
    // work" rather than "the precision is wrong".
    dtype: 'fp32',
    approxMB: 190,   // plus the ~50 MB HiFi-GAN vocoder it needs
    ramMB: 500,
    sampleRate: 16000,
    voices: false,          // no built-in voices…
    customVoices: true,     // …but it is the ONE model here that can use yours
    note: 'Speaks using a voice you record — but it will NOT sound like you. It borrows pitch and timbre in a general way and produces a consistent voice of its own. Kokoro sounds better if you do not need a personal voice.',
  },
  {
    // One MMS entry so the second architecture is DISCOVERABLE from the list rather
    // than only findable by search. The rest of the family (~1000 languages) is
    // exactly what the search box is for — listing them all here would be a menu,
    // not a catalog.
    id: 'Xenova/mms-tts-hin',
    label: 'MMS TTS — Hindi',
    lang: 'Hindi (हिन्दी)',
    tier: 'light',
    arch: 'vits',
    approxMB: 40,
    ramMB: 200,
    sampleRate: 16000,
    voices: false,
    note: 'Tiny single-speaker VITS. Meta\u2019s MMS covers ~1000 languages — search "mms-tts" for yours.',
  },
];

// Voice prefix → the language phonemizer must use for G2P. First letter = language,
// second = gender (f/m). Only the English families are listed: the other Kokoro
// voices (es/fr/hi/it/ja/pt/zh) need misaki-class G2P, which has no dependency-free
// JS port — shipping them against an English phonemizer would produce confident
// gibberish, which is worse than not offering them.
const VOICE_LANG = { a: 'en-us', b: 'en-gb' };

// `grade` is Kokoro's own published quality rating for the voice. Ordered best-first
// so the picker's default ordering is already the useful one.
export const TTS_VOICES = [
  { id: 'af_heart',    label: 'Heart (US, female)',    lang: 'en-us', gender: 'female', grade: 'A'  },
  { id: 'af_bella',    label: 'Bella (US, female)',    lang: 'en-us', gender: 'female', grade: 'A-' },
  { id: 'bf_emma',     label: 'Emma (UK, female)',     lang: 'en-gb', gender: 'female', grade: 'B-' },
  { id: 'af_nicole',   label: 'Nicole (US, female)',   lang: 'en-us', gender: 'female', grade: 'B-', note: 'Recorded close-mic — best on headphones.' },
  { id: 'af_aoede',    label: 'Aoede (US, female)',    lang: 'en-us', gender: 'female', grade: 'C+' },
  { id: 'af_kore',     label: 'Kore (US, female)',     lang: 'en-us', gender: 'female', grade: 'C+' },
  { id: 'af_sarah',    label: 'Sarah (US, female)',    lang: 'en-us', gender: 'female', grade: 'C+' },
  { id: 'am_michael',  label: 'Michael (US, male)',    lang: 'en-us', gender: 'male',   grade: 'C+' },
  { id: 'am_fenrir',   label: 'Fenrir (US, male)',     lang: 'en-us', gender: 'male',   grade: 'C+' },
  { id: 'am_puck',     label: 'Puck (US, male)',       lang: 'en-us', gender: 'male',   grade: 'C+' },
  { id: 'af_nova',     label: 'Nova (US, female)',     lang: 'en-us', gender: 'female', grade: 'C'  },
  { id: 'af_alloy',    label: 'Alloy (US, female)',    lang: 'en-us', gender: 'female', grade: 'C'  },
  { id: 'bf_isabella', label: 'Isabella (UK, female)', lang: 'en-gb', gender: 'female', grade: 'C'  },
  { id: 'bm_george',   label: 'George (UK, male)',     lang: 'en-gb', gender: 'male',   grade: 'C'  },
  { id: 'bm_fable',    label: 'Fable (UK, male)',      lang: 'en-gb', gender: 'male',   grade: 'C'  },
];

// Which engine drives a model — the same dispatch seam stt-models.js has for
// 'whisper' (transformers.js pipeline) vs 'parakeet-tdt' (raw onnxruntime, its own
// decode loop). 'style-tts2' = Kokoro through transformers.js.
//
// The seam exists because the obvious second engine is already on the table:
// Kyutai's Pocket TTS (MIT code, CC-BY-4.0 weights, ~100M params, streams a first
// chunk in ~200 ms, six languages, and — unlike Kokoro — CLONES a voice from a
// sample). It is not listed here because it is not implemented: its ONNX form is a
// five-graph bundle (text_conditioner + flow_lm_main + flow_lm_flow + mimi
// encoder/decoder) needing a hand-written flow-matching decode loop, from a
// THIRD-PARTY re-export of a gated checkpoint. That is a parakeet-engine-sized
// piece of work, not a catalog entry — so the seam is here and the engine is not.
export function ttsModelEngine(id) {
  return ttsModel(id)?.arch || 'style-tts2';
}

// Does this catalog entry have selectable voices? Kokoro picks one from a style
// bank; VITS/MMS is single-speaker. Unknown (a searched model) resolves at load.
export function ttsModelHasVoices(id) {
  const m = ttsModel(id);
  return m ? m.voices !== false : true;
}

// Can it speak in a voice the user recorded? Only SpeechT5 takes a speaker
// embedding — the other two are conditioned on something fixed.
export function ttsModelHasCustomVoices(id) {
  return ttsModel(id)?.customVoices === true;
}

export function ttsModel(id) {
  return TTS_MODEL_CATALOG.find((m) => m.id === id) || null;
}
export function isKnownTtsModel(id) {
  return TTS_MODEL_CATALOG.some((m) => m.id === id);
}
export function ttsModelDtype(id) {
  return ttsModel(id)?.dtype || null;
}
export function ttsVoice(id) {
  return TTS_VOICES.find((v) => v.id === id) || null;
}
export function isKnownVoice(id) {
  return TTS_VOICES.some((v) => v.id === id);
}

// A voice id becomes a FILENAME (voices/<id>.bin) and a phonemizer language lookup,
// so it is validated by shape as well as by catalog membership — belt and braces
// against a traversal reaching the fetch/join even if the catalog check is ever
// refactored away. Kokoro ids are strictly `<lang><gender>_<name>`.
export function isValidVoiceId(id) {
  return /^[a-z]{2}_[a-z0-9]+$/.test(String(id || ''));
}

// The phonemizer language for a voice — an American voice reading British phonemes
// (or vice versa) is audibly wrong, so G2P follows the voice, not the request.
export function voiceLang(id) {
  return VOICE_LANG[String(id || '')[0]] || 'en-us';
}

// Same strict `org/name` shape as isValidCustomSttId — no traversal.
export function isValidCustomTtsId(id) {
  const s = String(id || '');
  return /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(s) && !s.includes('..');
}

// Selectable precisions. Same ids as the STT picker (they are transformers.js
// dtypes, not a whisper concept) but the notes are about synthesis speed.
export const TTS_DTYPES = [
  { id: 'auto', label: 'Auto (recommended)', note: 'q8 on the native gateway, fp32 on the WASM binary.' },
  { id: 'q8', label: 'q8 — fast, balanced', note: 'Int8. Best speed/quality trade-off (native default).' },
  { id: 'q4', label: 'q4 — smallest & fastest', note: '4-bit. Least memory; audibly rougher.' },
  { id: 'fp16', label: 'fp16 — more accurate', note: 'Half precision. Larger, a bit slower.' },
  { id: 'fp32', label: 'fp32 — best quality (slow)', note: 'Full precision. The only one that loads on the WASM binary.' },
];

export function isValidTtsDtype(d) {
  return TTS_DTYPES.some((x) => x.id === d);
}
