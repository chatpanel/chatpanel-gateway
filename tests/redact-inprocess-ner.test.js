// THE BUNDLED DETECTOR MUST REACH THE REDACTOR.
//
// The gateway runs its NER model in its own process and reaches it through a sentinel URL
// plus an injected fetch. That sentinel failed @chatpanel/pii's SSRF scheme check; the throw
// landed in the fail-open path, which exists for a slow or broken remote detector and is
// exactly right there — and completely wrong here, because nothing was broken. The engine
// loaded, answered `/ner` correctly, and contributed to no redaction at all. Every layer
// reported success.
//
// So this test asserts the whole seam end to end: the engine's entities come out the other
// side of redactSegments as tokens in the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSegments, segment } from '../src/redact.js';
import * as engine from '../src/ner-engine.js';

const CFG = { tier: 'full', dictionary: [], detection: { backend: 'off' } };

/** Stands in for the loaded model, through the SAME seam the real engine plugs into. */
const stubEngine = (entities, onCall) => ({
  isReady: () => true,
  fetchAdapter: async (url, opts) => {
    onCall?.(url, JSON.parse(opts.body).text);
    return new Response(JSON.stringify({ entities }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  },
});

const noEngine = { isReady: () => false, fetchAdapter: async () => { throw new Error('not loaded'); } };

const redact = async (text, { nerEngine, tier = 'full' } = {}) => {
  let out = text;
  const r = await redactSegments(
    [segment(() => out, (v) => { out = v; })],
    { ...CFG, tier },
    { isPro: true, ...(nerEngine ? { nerEngine } : {}) },
  );
  return { text: out, ...r };
};

test('a name found by the in-process engine is REPLACED, not merely detected', async () => {
  const { text } = await redact(
    'Alex Rivera works at Acme Corp and mails alex@example.com',
    { nerEngine: stubEngine([{ value: 'Alex Rivera', type: 'PER' }, { value: 'Acme Corp', type: 'ORG' }]) },
  );
  assert.doesNotMatch(text, /Alex Rivera/, 'the person was replaced');
  assert.doesNotMatch(text, /Acme Corp/, 'the organisation was replaced');
  assert.match(text, /\[\[PERSON_\d+\]\]/);
  assert.match(text, /\[\[EMAIL_1\]\]/, 'and the deterministic layer still ran');
});

test('the sentinel URL is handed to the adapter and never dialled', async () => {
  const calls = [];
  await redact('Alex Rivera works at Acme Corp today', {
    nerEngine: stubEngine([{ value: 'Alex Rivera', type: 'PER' }], (url, text) => calls.push({ url, text })),
  });
  assert.equal(calls.length, 1, 'the engine was actually consulted');
  assert.equal(calls[0].url, 'inproc:ner');
  assert.match(calls[0].text, /Alex Rivera/, 'it sees the raw text — that is the point of it being local');
});

test('with no engine loaded it is deterministic-only — patterns yes, names no', async () => {
  // The honest fallback, and the state the bug made permanent and invisible.
  const { text } = await redact('Alex Rivera mails alex@example.com', { nerEngine: noEngine });
  assert.match(text, /\[\[EMAIL_1\]\]/);
  assert.match(text, /Alex Rivera/, 'without a detector a name cannot be found');
});

test('basic tier never consults the detector, however ready it is', async () => {
  const calls = [];
  const { text } = await redact('Alex Rivera mails alex@example.com', {
    tier: 'basic',
    nerEngine: stubEngine([{ value: 'Alex Rivera', type: 'PER' }], (u, t) => calls.push(t)),
  });
  assert.equal(calls.length, 0, 'basic tier is patterns only, by definition');
  assert.match(text, /\[\[EMAIL_1\]\]/);
  assert.match(text, /Alex Rivera/);
});
