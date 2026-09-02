// Which PROVIDER answers, not just which model.
//
// THE BUG THIS PREVENTS. A model id is not a unique key. On a machine with three providers
// connected, 39 ids already collide once you ignore case, and two providers offering the same
// id exactly is ordinary rather than exotic. Routing on the model alone means dests.find()
// returns whichever destination happens to be listed first — so a call goes out on a provider
// the user did not choose, billed to a key they did not pick, and nothing says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDestination, listDestinations } from '../src/router.js';

const cfg = {
  backend: 'api',
  destinations: [
    { id: 'NVIDIA', type: 'api', protocol: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', models: ['shared/model-a'] },
    { id: 'HuggingFace', type: 'api', protocol: 'openai', baseUrl: 'https://router.huggingface.co/v1', models: ['shared/model-a'] },
  ],
};

test('without a destination, an ambiguous model silently picks the first — the old behaviour', () => {
  const d = resolveDestination('shared/model-a', cfg, 'openai');
  assert.equal(d.id, 'NVIDIA', 'documents WHY the hint exists: order decides, not intent');
});

test('an explicit destination decides, whatever the model list says', () => {
  assert.equal(resolveDestination('shared/model-a', cfg, 'openai', { destination: 'HuggingFace' }).id, 'HuggingFace');
  assert.equal(resolveDestination('shared/model-a', cfg, 'openai', { destination: 'NVIDIA' }).id, 'NVIDIA');
});

test('an explicit destination never falls through to a different provider', () => {
  // The whole point. Falling back here would send a credential-bearing call to a provider the
  // user did not choose — the silent misroute this field exists to prevent.
  assert.equal(resolveDestination('shared/model-a', cfg, 'openai', { destination: 'Gone' }), null);
  assert.equal(resolveDestination('anything', cfg, 'openai', { destination: 'Gone' }), null);
});

test('no destination keeps the existing fallback, so older callers are unaffected', () => {
  // Additive by design: a client that never sends the envelope behaves exactly as before.
  assert.ok(resolveDestination('unknown-model', cfg, 'openai'), 'still resolves something');
  assert.equal(resolveDestination('unknown-model', cfg, 'openai', { destination: '' }).id, 'NVIDIA');
});

test('agents stay addressable by name', () => {
  assert.equal(resolveDestination('claude', cfg, 'openai').type, 'agent');
  assert.ok(listDestinations(cfg).some((d) => d.id === 'claude'), 'known agents are always listed');
});

// ── the metadata must never reach the provider ─────────────────────────────────
// This shipped as a `chatpanel` field on the request body and NVIDIA answered
// "unsupported parameters": OpenAI-compatible providers validate the body strictly and reject
// unknown fields, while ignoring unknown headers. A body field also breaks against every
// gateway already installed, since only a newer one knows to remove it.
import { readFileSync } from 'node:fs';
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('routing metadata travels in headers, and headers are stripped before forwarding', () => {
  assert.match(server, /x-chatpanel-destination/, 'the destination rides a header');
  assert.match(server, /x-chatpanel-reach/, 'so does the reach ceiling');
  assert.match(server, /lower\.startsWith\('x-chatpanel-'\)\) continue;/,
    'and forwardHeaders must drop them — they are for this hop, not the provider');
});

test('the legacy body field is still accepted, and removed rather than forwarded', () => {
  // A client that has not updated must keep working instead of 400ing at the provider.
  assert.match(server, /delete body\.chatpanel;/, 'accepted for compatibility, never forwarded');
  assert.match(server, /legacy\?\.destination/, 'and it still selects a destination');
});
