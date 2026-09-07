// Remote TTS. Two invariants carry this whole module, and both are the kind that
// fail silently: a stored key that should never exist, and text reaching a vendor
// unredacted because a flag was absent rather than false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ttsDestination, synthesizeRemote, isValidRemoteVoice, isValidTtsProvider } from '../src/tts-remote.js';

const REDACTION = { tier: 'basic', detection: { backend: 'off' } };

function fakeFetch(capture, { ok = true, status = 200, body = 'AUDIO', ct = 'audio/mpeg' } = {}) {
  return async (url, init) => {
    capture.url = url; capture.init = init;
    capture.body = init?.body ? JSON.parse(init.body) : null;
    return {
      ok, status,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      text: async () => body,
    };
  };
}

test('local is the default, and returns no destination at all', () => {
  assert.equal(ttsDestination({}), null);
  assert.equal(ttsDestination({ tts: { provider: 'local' } }), null);
  // An unknown provider must fall back to local, not to "some remote host".
  assert.equal(ttsDestination({ tts: { provider: 'evil' } }), null);
  assert.equal(isValidTtsProvider('elevenlabs'), true);
  assert.equal(isValidTtsProvider('nope'), false);
});

// An ABSENT redact flag is not permission. This is the one that would leak.
test('redaction defaults ON when the flag is missing, not off', () => {
  assert.equal(ttsDestination({ tts: { provider: 'openai' } }).redact, true);
  assert.equal(ttsDestination({ tts: { provider: 'openai', remote: {} } }).redact, true);
  assert.equal(ttsDestination({ tts: { provider: 'openai', remote: { redact: undefined } } }).redact, true);
  assert.equal(ttsDestination({ tts: { provider: 'openai', remote: { redact: null } } }).redact, true);
  // Only an explicit false turns it off.
  assert.equal(ttsDestination({ tts: { provider: 'openai', remote: { redact: false } } }).redact, false);
});

test('an email does not reach the vendor when redaction is on', async () => {
  const cap = {};
  const dest = ttsDestination({ tts: { provider: 'openai' } });
  const r = await synthesizeRemote({
    dest, text: 'Mail alex.rivera@example.com about it', voice: 'alloy',
    auth: 'Bearer sk-test', redaction: REDACTION, fetchImpl: fakeFetch(cap),
  });
  assert.ok(!cap.body.input.includes('alex.rivera@example.com'), 'the raw address must not be in the request body');
  assert.match(cap.body.input, /\[\[EMAIL_1\]\]/, 'and it should be a restorable placeholder');
  assert.ok(r.redacted >= 1, 'the caller must be told how much left redacted');
});

test('opting out sends the real text — the trade is explicit, not accidental', async () => {
  const cap = {};
  const dest = ttsDestination({ tts: { provider: 'openai', remote: { redact: false } } });
  await synthesizeRemote({ dest, text: 'Mail alex.rivera@example.com', voice: 'alloy', redaction: REDACTION, fetchImpl: fakeFetch(cap) });
  assert.match(cap.body.input, /alex\.rivera@example\.com/);
});

test('the caller\'s auth is forwarded, and nothing is read from config', async () => {
  const cap = {};
  await synthesizeRemote({
    dest: ttsDestination({ tts: { provider: 'openai' } }),
    text: 'hi', voice: 'alloy', auth: 'Bearer sk-caller', redaction: REDACTION, fetchImpl: fakeFetch(cap),
  });
  assert.equal(cap.init.headers.Authorization, 'Bearer sk-caller');
  // The whole config surface must not carry a key to leak in the first place.
  const dest = ttsDestination({ tts: { provider: 'openai' } });
  assert.deepEqual(Object.keys(dest).sort(), ['baseUrl', 'kind', 'model', 'redact', 'voice']);
  assert.ok(!('apiKey' in dest) && !('key' in dest) && !('token' in dest));
});

test('a bare key is accepted and given the scheme the provider expects', async () => {
  const cap = {};
  await synthesizeRemote({ dest: ttsDestination({ tts: { provider: 'openai' } }), text: 'hi', voice: 'alloy', auth: 'sk-bare', redaction: REDACTION, fetchImpl: fakeFetch(cap) });
  assert.equal(cap.init.headers.Authorization, 'Bearer sk-bare');
  // ElevenLabs wants its own header, and the Bearer prefix stripped off.
  const cap2 = {};
  await synthesizeRemote({ dest: ttsDestination({ tts: { provider: 'elevenlabs' } }), text: 'hi', voice: 'abc123', auth: 'Bearer xi-key', redaction: REDACTION, fetchImpl: fakeFetch(cap2) });
  assert.equal(cap2.init.headers['xi-api-key'], 'xi-key');
  assert.equal(cap2.init.headers.Authorization, undefined);
});

// An ElevenLabs voice id is interpolated into the URL PATH.
test('a remote voice id cannot escape the URL path', async () => {
  for (const bad of ['../../admin', 'a/b', 'x?y=1', 'x#frag', 'a'.repeat(65), 'x y']) {
    assert.equal(isValidRemoteVoice(bad), false, `should reject ${JSON.stringify(bad)}`);
    await assert.rejects(
      () => synthesizeRemote({ dest: ttsDestination({ tts: { provider: 'elevenlabs' } }), text: 'hi', voice: bad, redaction: REDACTION, fetchImpl: fakeFetch({}) }),
      /invalid remote voice/,
    );
  }
  assert.equal(isValidRemoteVoice(''), false, 'empty is not a valid ID…');
  const cap = {};
  await synthesizeRemote({ dest: ttsDestination({ tts: { provider: 'elevenlabs' } }), text: 'hi', voice: 'Abc_123-x', redaction: REDACTION, fetchImpl: fakeFetch(cap) });
  assert.match(cap.url, /\/text-to-speech\/Abc_123-x$/);
});

// …but "no voice given" is not the same as "an invalid voice": omitting it is how a
// caller says "use whatever this destination is configured with".
test('an omitted voice falls back to the destination default rather than failing', async () => {
  const cap = {};
  const dest = ttsDestination({ tts: { provider: 'elevenlabs', remote: { voice: 'configured1' } } });
  await synthesizeRemote({ dest, text: 'hi', voice: '', redaction: REDACTION, fetchImpl: fakeFetch(cap) });
  assert.match(cap.url, /\/text-to-speech\/configured1$/);
});

test('a custom baseUrl is honoured and its trailing slash normalized', async () => {
  const cap = {};
  const dest = ttsDestination({ tts: { provider: 'openai', remote: { baseUrl: 'https://api.groq.com/openai/v1/', model: 'playai-tts' } } });
  await synthesizeRemote({ dest, text: 'hi', voice: 'alloy', redaction: REDACTION, fetchImpl: fakeFetch(cap) });
  assert.equal(cap.url, 'https://api.groq.com/openai/v1/audio/speech');
  assert.equal(cap.body.model, 'playai-tts');
});

test('an upstream failure surfaces the vendor\'s reason, not a bare status', async () => {
  await assert.rejects(
    () => synthesizeRemote({
      dest: ttsDestination({ tts: { provider: 'openai' } }), text: 'hi', voice: 'alloy', redaction: REDACTION,
      fetchImpl: fakeFetch({}, { ok: false, status: 401, body: 'invalid api key' }),
    }),
    /invalid api key/,
  );
});

test('the vendor\'s own audio format is passed through, not relabelled', async () => {
  const cap = {};
  const r = await synthesizeRemote({
    dest: ttsDestination({ tts: { provider: 'elevenlabs' } }), text: 'hi', voice: 'abc', redaction: REDACTION,
    fetchImpl: fakeFetch(cap, { ct: 'audio/mpeg' }),
  });
  assert.equal(r.contentType, 'audio/mpeg', 'claiming audio/wav for an mp3 body would play as noise');
});
