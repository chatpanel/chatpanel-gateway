// Model router: route by the requested model to an agent or an api destination,
// and aggregate models for /v1/models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDestination, aggregateModels, listDestinations } from '../src/router.js';

const DESTS = [
  { id: 'codex', type: 'agent', agent: 'codex', models: ['codex', 'gpt-5-codex'] },
  { id: 'claude', type: 'agent', agent: 'claude', models: ['claude'] },
  { id: 'oai', type: 'api', protocol: 'openai', baseUrl: 'https://api.openai.com', models: ['gpt-4o'] },
  { id: 'ollama', type: 'api', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3.2'] },
];

test('routes a model to its agent destination', () => {
  const d = resolveDestination('gpt-5-codex', { destinations: DESTS }, 'openai');
  assert.equal(d.type, 'agent');
  assert.equal(d.agent, 'codex');
});

test('routes a model to its api destination', () => {
  const d = resolveDestination('llama3.2', { destinations: DESTS }, 'openai');
  assert.equal(d.type, 'api');
  assert.equal(d.baseUrl, 'http://127.0.0.1:11434/v1');
});

test('matches by destination id when no model membership', () => {
  const d = resolveDestination('claude', { destinations: DESTS }, 'openai');
  assert.equal(d.id, 'claude');
});

test('/v1/models aggregates configured models + the always-available known agents', () => {
  const m = aggregateModels({ destinations: DESTS });
  const ids = m.data.map((x) => x.id);
  // Configured destinations' models first…
  for (const id of ['codex', 'gpt-5-codex', 'claude', 'gpt-4o', 'llama3.2']) {
    assert.ok(ids.includes(id), `missing configured model ${id}`);
  }
  // …plus the known CLI agents that always work via the bridge (no API key).
  for (const a of ['opencode', 'pi', 'kiro', 'antigravity']) {
    assert.ok(ids.includes(a), `missing always-available agent ${a}`);
  }
  assert.equal(m.object, 'list');
});

test('back-compat: no destinations + bridge backend → agent destinations', () => {
  const dests = listDestinations({ backend: 'bridge', bridge: { agent: 'codex' } });
  assert.ok(dests.every((d) => d.type === 'agent'));
  assert.ok(dests.some((d) => d.id === 'codex'));
});

test('back-compat: api backend → openai/anthropic api destinations', () => {
  const dests = listDestinations({ backend: 'api', upstreams: { openai: { baseUrl: 'X' }, anthropic: { baseUrl: 'Y' } } });
  assert.equal(dests.find((d) => d.id === 'openai').baseUrl, 'X');
  assert.equal(dests.find((d) => d.id === 'openai').type, 'api');
});

test('unknown model falls back to a same-protocol destination', () => {
  const oa = resolveDestination('mystery', { destinations: DESTS }, 'openai');
  assert.ok(oa, 'returns a destination');
});
