// Catalog of NER models the gateway can run, surfaced in the extension's Gateway
// settings so users can install a larger or multilingual detector. All are ONNX
// (transformers.js) token-classification models that emit PER/ORG/LOC — the only
// labels the redaction engine consumes. Sizes are the on-disk q8 footprint, approx.
//
// Adding a model: any Xenova/* token-classification model whose labels map to
// PER/ORG/LOC works (pii-detect normalizeEntities handles the label mapping).
// Verify it loads + detects before listing it here.

export const DEFAULT_MODEL = 'Xenova/bert-base-NER';

export const MODEL_CATALOG = [
  {
    id: 'Xenova/bert-base-NER',
    label: 'English — standard',
    lang: 'English',
    approxMB: 105,
    note: 'Default. Best English accuracy for people, organizations, and locations.',
  },
  {
    id: 'Xenova/distilbert-base-multilingual-cased-ner-hrl',
    label: 'Multilingual — compact',
    lang: '10 languages',
    approxMB: 150,
    note: 'Covers en, es, fr, de, it, pt, nl, ar, zh, ru. Use for non-English text.',
  },
  {
    id: 'Xenova/bert-base-multilingual-cased-ner-hrl',
    label: 'Multilingual — large',
    lang: '10 languages',
    approxMB: 180,
    note: 'Higher multilingual accuracy; larger download.',
  },
];

export function isKnownModel(id) {
  return MODEL_CATALOG.some((m) => m.id === id);
}

// Accept a user-supplied ("bring your own") NER model id. STRICT `org/name` shape,
// no path traversal. We can't verify it's token-classification from the id alone —
// the engine fails open if the download/labels don't fit. Custom ids fetch from
// Hugging Face directly (the engine points remoteHost there for the custom load).
export function isValidCustomModelId(id) {
  const s = String(id || '');
  return /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(s) && !s.includes('..');
}
