// A saved clone is a CHOICE, never a default. This table is what the /tts route
// speaks in; every row here was once a request that came out wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTtsVoice } from '../src/tts-voice-resolve.js';
import { isPocketVoice, DEFAULT_POCKET_VOICE } from '../src/tts-models.js';

const KOKORO = 'af_heart';
const CLONE = { id: '11111111-1111-4111-8111-111111111111', vec: new Float32Array(512) };
const OLD_CLONE = { id: '22222222-2222-4222-8222-222222222222', vec: new Float32Array(512) }; // saved before Pocket existed

function voices({ saved = [CLONE, OLD_CLONE], pocketFor = [CLONE.id] } = {}) {
  return {
    parseCustomVoice: (v) => (typeof v === 'string' && v.startsWith('custom:') ? v.slice(7) : null),
    getVoice: (id) => saved.find((r) => r.id === id) || null,
    listVoices: () => saved.map(({ id }) => ({ id })),
    getPocketVoice: (id) => (pocketFor.includes(id) ? new Float32Array(8) : null),
  };
}
const engine = (arch) => ({
  isPocket: () => arch === 'pocket-tts',
  supportsCustomVoices: () => arch === 'pocket-tts' || arch === 'speecht5',
  supportsVoices: () => arch === 'style-tts2',
  arch: () => arch,
});
const resolve = (arch, requested, configured, v = voices()) => resolveTtsVoice({
  requested, configured, engine: engine(arch), voices: v,
  isPocketVoice, isKnownVoice: (x) => x === KOKORO || x === 'am_adam', isValidVoiceId: (x) => /^[a-z_]+$/.test(x),
  defaultVoice: KOKORO, defaultPocketVoice: DEFAULT_POCKET_VOICE,
});

test('pocket: an unset config speaks the built-in default, NOT whichever clone was saved first', () => {
  // The bug: cfg.tts.voice "" fell through to Kokoro's default name, which Pocket
  // does not know, and the custom-voice path then picked saved[0] — a real person.
  const r = resolve('pocket-tts', null, KOKORO);
  assert.deepEqual(r, { ok: true, voice: DEFAULT_POCKET_VOICE, customId: null, speakerEmbedding: null });
});

test('pocket: a config naming a deleted clone falls back to the built-in default', () => {
  const r = resolve('pocket-tts', null, 'custom:deadbeef');
  assert.equal(r.ok, true);
  assert.equal(r.voice, DEFAULT_POCKET_VOICE);
});

test('pocket: a clone speaks only when it was chosen — config or request', () => {
  for (const [req, cfg] of [[null, `custom:${CLONE.id}`], [`custom:${CLONE.id}`, KOKORO]]) {
    const r = resolve('pocket-tts', req, cfg);
    assert.equal(r.ok, true);
    assert.equal(r.voice, `custom:${CLONE.id}`);
    assert.equal(r.customId, CLONE.id);
    assert.ok(r.speakerEmbedding instanceof Float32Array, 'hands over the Mimi conditioning');
  }
});

test('pocket: a built-in named in the request wins over a configured clone', () => {
  const r = resolve('pocket-tts', 'javert', `custom:${CLONE.id}`);
  assert.deepEqual(r, { ok: true, voice: 'javert', customId: null, speakerEmbedding: null });
});

test('pocket: a chosen clone saved before Pocket existed is a 409, not a silent swap', () => {
  const r = resolve('pocket-tts', null, `custom:${OLD_CLONE.id}`);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.type, 'voice_kind_missing');
});

test('an explicitly requested voice never falls back', () => {
  assert.equal(resolve('pocket-tts', 'custom:deadbeef', KOKORO).status, 404);
  assert.equal(resolve('speecht5', 'custom:deadbeef', KOKORO).status, 404);
  assert.equal(resolve('style-tts2', `custom:${CLONE.id}`, KOKORO).type, 'voice_unsupported');
  assert.equal(resolve('style-tts2', 'not_a_voice', KOKORO).type, 'bad_voice');
});

test('speecht5 has no built-ins, so there a saved voice IS the only default', () => {
  const r = resolve('speecht5', null, KOKORO);
  assert.equal(r.ok, true);
  assert.equal(r.customId, CLONE.id);
  assert.equal(r.speakerEmbedding, CLONE.vec, 'the x-vector, not a Pocket conditioning');
  const none = resolve('speecht5', null, KOKORO, voices({ saved: [] }));
  assert.equal(none.status, 400);
});

test('kokoro: a stale custom: config speaks the default instead of refusing', () => {
  assert.deepEqual(resolve('style-tts2', null, `custom:${CLONE.id}`), { ok: true, voice: KOKORO, customId: null, speakerEmbedding: null });
  assert.equal(resolve('style-tts2', null, 'am_adam').voice, 'am_adam');
});

test('a single-speaker model (VITS) accepts whatever it is handed', () => {
  assert.equal(resolve('vits', null, KOKORO).ok, true);
});
