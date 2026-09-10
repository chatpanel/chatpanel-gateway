// Catalog of NER models the gateway can run, surfaced in the extension's Gateway
// settings so users can install a larger or multilingual detector. Sizes are the
// on-disk q8 footprint, approx.
//
// TWO THINGS TO CHECK WHEN ADDING A MODEL, and getting either wrong fails SILENTLY.
//
//   1. ITS LABELS MUST BE MAPPED. `@chatpanel/pii` `normalizeEntities` turns a model's
//      labels into our placeholder types, and an unmapped label is dropped rather than
//      passed through — so a model whose vocabulary it does not know detects entities
//      perfectly and redacts none of them, while the UI still reads as on. Run one
//      sentence through the model, look at the labels it returns, and map every one.
//      This is not hypothetical: multilang-pii-ner emits the ai4privacy vocabulary
//      (GIVENNAME, SURNAME, TELEPHONENUM…) and person redaction was silently off for
//      anyone who selected it, until pii 0.6.0.
//
//   2. `mirrored` MUST BE TRUE ONLY IF IT REALLY IS. A catalogued model is fetched from
//      ChatPanel's CDN so a clean install depends only on chatpanel.net; a model that is
//      not there 404s at first use. `mirrored: false` says "catalogue it, but fetch it
//      from Hugging Face" — which is what lets a model be a first-class, one-click
//      choice before the mirror upload happens, instead of forcing users to paste a
//      custom id and lose the label, the size and the note.

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
  {
    // PURPOSE-BUILT FOR THIS JOB, where the three above are general newswire NER. It
    // finds what redaction actually cares about — given and family names separately,
    // street/building/postcode, phone, national-ID and account numbers, usernames and
    // passwords — none of which a PER/ORG/LOC model emits at all. That makes it the
    // better detector for a privacy product, not merely a bigger one.
    //
    // NOT the default yet, and the reason is written down rather than remembered: it is
    // not on the CDN (see `mirrored`), so defaulting to it would make a clean install
    // depend on Hugging Face, and it needs @chatpanel/pii >= 0.6.0 for its labels to be
    // understood at all. Both are release chores, not code.
    id: 'onnx-community/multilang-pii-ner-ONNX',
    label: 'PII-specialised — multilingual',
    lang: 'Multilingual',
    approxMB: 282,
    mirrored: false,
    recommended: true,
    note: 'Most thorough. Trained for PII rather than general entities: also finds addresses, postcodes, account and ID numbers, usernames and passwords. Larger download, fetched from Hugging Face.',
  },
];

/**
 * Is this model on ChatPanel's CDN, or does it have to come from Hugging Face?
 *
 * Default TRUE for a catalogued model — the mirror is the norm and the point of the
 * catalogue. An entry says `mirrored: false` when it is a first-class choice that has not
 * been uploaded yet. A model that is not in the catalogue at all is a user's own id and is
 * never mirrored.
 */
export function isMirroredModel(id) {
  const m = MODEL_CATALOG.find((x) => x.id === id);
  return !!m && m.mirrored !== false;
}

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
