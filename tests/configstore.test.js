import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistConfig, applyConfigPatch, publicConfig } from '../src/configstore.js';

test('persistConfig round-trips DESTINATIONS (a restart must not drop configured agents/APIs)', () => {
  const cfg = {
    host: '127.0.0.1', port: 4320, backend: 'api',
    destinations: [
      { id: 'codex', type: 'agent', agent: 'codex', models: ['codex'] },
      { id: 'Gemma4', type: 'api', protocol: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'k', models: ['gemma-4-26b'] },
    ],
    bridge: { url: 'http://127.0.0.1:4319', agent: 'codex' },
    upstreams: { openai: { baseUrl: 'https://api.openai.com' } },
    redaction: { tier: 'basic', dictionary: [] },
    ner: {}, allowedOrigins: [], pro: {}, tools: {},
  };
  const path = join(tmpdir(), `cp-gw-cfg-${process.pid}.json`);
  try {
    persistConfig(cfg, path);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.destinations.length, 2, 'destinations are persisted');
    assert.deepEqual(saved.destinations.map((d) => d.id).sort(), ['Gemma4', 'codex']);
    assert.equal(saved.destinations.find((d) => d.id === 'codex').type, 'agent');
    // the api key persists too (so a saved API destination keeps working after restart)
    assert.equal(saved.destinations.find((d) => d.id === 'Gemma4').apiKey, 'k');
  } finally {
    rmSync(path, { force: true });
  }
});

test('applyConfigPatch → persistConfig keeps a saved destination across the cycle', () => {
  const cfg = { host: '127.0.0.1', port: 4320, backend: 'api', bridge: {}, upstreams: { openai: {}, anthropic: {} }, redaction: { dictionary: [] }, ner: {}, allowedOrigins: [], pro: { free: {} }, tools: {} };
  applyConfigPatch(cfg, { destinations: [{ id: 'codex', type: 'agent', agent: 'codex', models: ['codex'] }] });
  const path = join(tmpdir(), `cp-gw-cfg2-${process.pid}.json`);
  try {
    persistConfig(cfg, path);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(saved.destinations.some((d) => d.id === 'codex' && d.type === 'agent'), 'codex agent survives patch+persist');
    // and the public view still exposes it
    assert.ok(publicConfig(cfg).destinations.some((d) => d.id === 'codex'));
  } finally {
    rmSync(path, { force: true });
  }
});
