// Before a TTS model is loaded the engine knows nothing; the catalog answers for the active
// model so a fresh install shows its voice picker. And Pocket's built-in speakers download
// WITH the model — `ensureVoicesBin` used to have no caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const pocket = readFileSync(new URL('../src/pocket-tts-engine.js', import.meta.url), 'utf8');

test('/tts/models answers supportsVoices / supportsCustomVoices from the catalog until an engine is loaded', () => {
  assert.match(server, /supportsVoices: ttsEngine\.arch\(\) \? ttsEngine\.supportsVoices\(\) : \(activeEntry \? activeEntry\.arch === 'style-tts2' && !!activeEntry\.voices : true\)/);
  assert.match(server, /supportsCustomVoices: ttsEngine\.arch\(\) \? ttsEngine\.supportsCustomVoices\(\) : !!activeEntry\?\.customVoices/);
});

test('Pocket TTS fetches voices.bin when the model loads and it is not on disk — best effort', () => {
  const load = /async load\(bundle = DEFAULT_BUNDLE[\s\S]*?const ort = await getOrt\(\);/.exec(pocket)?.[0] || '';
  assert.match(load, /if \(!voicesBinOnDisk\(bundle\)\) \{\s*try \{ await ensureVoicesBin\(bundle/, 'the built-in speakers come with the model');
  assert.match(load, /cloning still works/, 'a failed download never blocks the load');
});
