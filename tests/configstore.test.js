import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistConfig, applyConfigPatch, applyNerModelSelection, publicConfig } from '../src/configstore.js';
import { DEFAULTS } from '../src/config.js';

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

test('selecting an NER model enables autostart and preserves the remaining detector settings', () => {
  const cfg = {
    ner: {
      autostart: false,
      model: 'old/model',
      allowDownload: false,
      enableFullTier: true,
    },
  };
  const selected = applyNerModelSelection(cfg, 'Xenova/bert-base-NER');
  assert.equal(selected.autostart, true);
  assert.equal(selected.model, 'Xenova/bert-base-NER');
  assert.equal(selected.allowDownload, false);
  assert.equal(selected.enableFullTier, true);
  assert.equal(cfg.ner, selected);

  const fresh = {};
  const initial = applyNerModelSelection(fresh, 'Xenova/bert-base-NER');
  assert.equal(initial.autostart, true);
  assert.equal(initial.allowDownload, true);
  assert.equal(initial.enableFullTier, true);
});

// persistConfig writes an ALLOWLIST, so every new config section is one someone
// has to remember to add — and forgetting shows up as a setting that reverts on
// restart, which reads as a broken feature rather than an unsaved one. That is
// exactly how the TTS model and voice were being lost.
test('every default config section is either persisted or deliberately excluded', () => {
  // Runtime-only or derived state that must NOT be written back.
  const EXCLUDED = new Set([
    'freeGate',      // recomputed from pro.free
    'tools',         // present in the allowlist already; listed here only if absent
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'cp-cfgstore-'));
  const path = join(dir, 'gateway.config.json');
  try {
    // Give every top-level key a recognisable value, persist, and read back.
    const cfg = JSON.parse(JSON.stringify(DEFAULTS));
    persistConfig(cfg, path);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    const missing = Object.keys(DEFAULTS).filter((k) => !(k in written) && !EXCLUDED.has(k));
    assert.deepEqual(missing, [],
      `these config sections would be LOST on restart: ${missing.join(', ')} — add them to persistConfig's allowlist`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
