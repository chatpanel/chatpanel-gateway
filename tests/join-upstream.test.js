// Joining a destination base to the incoming path.
//
// THE BUG THIS PREVENTS. Every OpenAI-compatible provider hands you a base URL that already
// ends at the version, and the request arriving here carries the version too. Concatenating
// gave /v1/v1/chat/completions and the provider answered "404 page not found" — which reads
// like a broken gateway or a bad model id, and sent a debugging session everywhere except the
// one line that was wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { joinUpstream } from '../src/server.js';

test('a base that already ends at the version does not double it', () => {
  assert.equal(
    joinUpstream('https://integrate.api.nvidia.com/v1', '/v1/chat/completions'),
    'https://integrate.api.nvidia.com/v1/chat/completions',
  );
  assert.equal(
    joinUpstream('https://openrouter.ai/api/v1', '/v1/chat/completions'),
    'https://openrouter.ai/api/v1/chat/completions',
  );
  assert.equal(
    joinUpstream('https://router.huggingface.co/v1/', '/v1/chat/completions'),
    'https://router.huggingface.co/v1/chat/completions',
  );
});

test('a base without the version still gets it', () => {
  assert.equal(joinUpstream('https://api.openai.com', '/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(joinUpstream('https://api.anthropic.com', '/v1/messages'), 'https://api.anthropic.com/v1/messages');
});

test('the version is matched, not assumed to be v1', () => {
  assert.equal(joinUpstream('https://example.test/v2', '/v2/chat'), 'https://example.test/v2/chat');
  // A base ending in something the path does NOT start with is left alone — it is a real path
  // segment, not a duplicated version.
  assert.equal(joinUpstream('https://example.test/openai', '/v1/chat'), 'https://example.test/openai/v1/chat');
});

test('the query string rides along', () => {
  assert.equal(joinUpstream('https://x.test/v1', '/v1/models', '?limit=5'), 'https://x.test/v1/models?limit=5');
});

test('a local model server is joined the same way', () => {
  // Ollama / LM Studio are the point of a BYO gateway; they are configured with /v1 too.
  assert.equal(joinUpstream('http://127.0.0.1:11434/v1', '/v1/chat/completions'), 'http://127.0.0.1:11434/v1/chat/completions');
});
