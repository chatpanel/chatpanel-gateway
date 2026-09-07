// The tokenizer decides what the model is asked to say. A wrong id is not a crash —
// it is a word quietly replaced by another word, which no amount of listening to
// the output will explain. So the invariant that matters is round-tripping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { SentencePieceUnigram } from '../src/sentencepiece.js';

const MODEL = join(process.env.CHATPANEL_MODELS_DIR || join(os.homedir(), '.chatpanel', 'models'),
  'pocket-tts', 'english_2026-04', 'tokenizer.model');

// Structural checks that need no model file.
test('a model with no pieces is rejected rather than silently empty', () => {
  assert.throws(() => new SentencePieceUnigram(new Uint8Array([])), /no pieces/);
});

if (!existsSync(MODEL)) {
  test('tokenizer round-trip (skipped — pocket-tts bundle not downloaded)', () => {
    assert.ok(true);
  });
} else {
  const sp = new SentencePieceUnigram(new Uint8Array(readFileSync(MODEL)));

  test('the vocabulary loads with byte fallback available', () => {
    assert.ok(sp.vocabSize > 1000, `only ${sp.vocabSize} pieces`);
    // Byte fallback is what keeps an unseen character from becoming <unk> and
    // vanishing from the utterance.
    assert.ok(sp.byteId.filter((x) => x >= 0).length >= 256, 'all 256 byte pieces must be mapped');
  });

  test('text survives encode → decode unchanged', () => {
    for (const s of [
      'Hello, this is a test.',
      'The quick brown fox jumps over the lazy dog.',
      'Numbers 123 and symbols @#!',
      'Café naïve résumé',
      'Multiple    spaces collapse?',
      'a',
      'Hyphenated well-known words, and "quotes".',
    ]) {
      assert.equal(sp.decodeIds(sp.encodeIds(s)), s, `round-trip failed for ${JSON.stringify(s)}`);
    }
  });

  test('an unseen script still encodes — via bytes, not as <unk>', () => {
    const s = 'こんにちは';
    const ids = sp.encodeIds(s);
    assert.ok(ids.length > 0);
    assert.ok(!ids.every((id) => id === sp.unkId), 'must not collapse to <unk>');
    assert.equal(sp.decodeIds(ids), s, 'byte fallback must reconstruct it exactly');
  });

  test('empty and whitespace input do not throw', () => {
    assert.ok(Array.isArray(sp.encodeIds('')));
    assert.ok(Array.isArray(sp.encodeIds('   ')));
    assert.equal(typeof sp.decodeIds([]), 'string');
  });

  // Viterbi should prefer few long pieces over many short ones; a broken search
  // still round-trips but tokenizes far worse, which shows up as a token count.
  test('common English is tokenized efficiently, not character by character', () => {
    const s = 'The quick brown fox jumps over the lazy dog.';
    const ids = sp.encodeIds(s);
    assert.ok(ids.length < s.length / 2,
      `${ids.length} tokens for ${s.length} chars — the search is falling back to characters`);
  });
}
