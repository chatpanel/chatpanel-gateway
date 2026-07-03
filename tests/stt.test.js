// STT session lifecycle over live HTTP: create → stream PCM → SSE interim/final →
// delete. The whisper pipeline is faked (_setPipeForTest) so no model downloads;
// what's under test is the session/decode/SSE plumbing, not the model.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/server.js';
import * as sttEngine from '../src/stt-engine.js';
import { STT_MODEL_CATALOG, DEFAULT_STT_MODEL, isKnownSttModel, isEnglishOnly, isValidCustomSttId } from '../src/stt-models.js';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

const cfg = (over = {}) => ({
  host: '127.0.0.1', port: 0, backend: 'api',
  upstreams: { openai: { baseUrl: 'http://127.0.0.1:1' }, anthropic: { baseUrl: 'http://127.0.0.1:1' } },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true },
  stt: { enabled: true, model: DEFAULT_STT_MODEL, allowDownload: false },
  logRequests: false,
  ...over,
});

// 16 kHz mono Float32: `tone` seconds of audible signal + `quiet` seconds of silence.
function pcm(tone, quiet = 0) {
  const sr = sttEngine.SAMPLE_RATE;
  const out = new Float32Array(Math.round((tone + quiet) * sr));
  for (let i = 0; i < tone * sr; i++) out[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / sr);
  return Buffer.from(out.buffer);
}

// Read SSE events until `stop(events)` says done (or timeout).
async function collectSse(url, stop, timeoutMs = 8000) {
  const events = [];
  const res = await fetch(url);
  const reader = res.body.getReader();
  const t0 = Date.now();
  let buf = '';
  for (;;) {
    if (Date.now() - t0 > timeoutMs) break;
    const { done, value } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
    }
    if (stop(events)) { reader.cancel().catch(() => {}); break; }
  }
  return events;
}

beforeEach(() => sttEngine._reset());

test('stt catalog: multilingual default (language auto-detect), ids known', () => {
  assert.equal(isEnglishOnly(DEFAULT_STT_MODEL), false); // auto-detect must work out of the box
  assert.ok(isKnownSttModel(DEFAULT_STT_MODEL));
  assert.ok(STT_MODEL_CATALOG.length >= 2);
  assert.ok(!isKnownSttModel('evil/other'));
});

test('runtimeDtype: fp32 on WASM (block-quant unsupported there), q8 on native', () => {
  const prev = globalThis.__CHATPANEL_WASM_PATHS__;
  try {
    globalThis.__CHATPANEL_WASM_PATHS__ = { wasm: 'x', mjs: 'y' };
    assert.equal(sttEngine.runtimeDtype(), 'fp32');
    delete globalThis.__CHATPANEL_WASM_PATHS__;
    assert.equal(sttEngine.runtimeDtype(), 'q8');
  } finally {
    if (prev) globalThis.__CHATPANEL_WASM_PATHS__ = prev; else delete globalThis.__CHATPANEL_WASM_PATHS__;
  }
});

test('custom-id guard: any ASR org/name ok (registry-filtered); traversal/shape rejected', () => {
  assert.ok(isValidCustomSttId('onnx-community/whisper-small.en'));
  assert.ok(isValidCustomSttId('Xenova/whisper-tiny'));
  assert.ok(isValidCustomSttId('UsefulSensors/moonshine-base')); // non-whisper ASR, still valid
  assert.ok(!isValidCustomSttId('../etc/passwd'));    // traversal
  assert.ok(!isValidCustomSttId('a/b/c'));            // bad shape
  assert.ok(!isValidCustomSttId('no-slash'));         // bad shape
});

test('models POST: catalog id 202, custom whisper id 202, junk 400', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const base = `http://127.0.0.1:${port}`;
  const post = (id) => fetch(`${base}/stt/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  assert.equal((await post(DEFAULT_STT_MODEL)).status, 202);
  assert.equal((await post('onnx-community/whisper-small.en')).status, 202); // custom, validated
  assert.equal((await post('not a model')).status, 400);      // bad shape (space)
  assert.equal((await post('../etc/passwd')).status, 400);    // traversal
  gw.close();
});

test('health exposes the additive stt block', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.stt.enabled, true);
  assert.equal(typeof h.stt.state, 'string');
  assert.equal(h.stt.model, DEFAULT_STT_MODEL);
  gw.close();
});

test('stt disabled in config → 403 on session create', async () => {
  const gw = createGateway(cfg({ stt: { enabled: false } }));
  const port = await listen(gw);
  const r = await fetch(`http://127.0.0.1:${port}/stt/sessions`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 403);
  gw.close();
});

test('invalid-shape stt model id → 400', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const r = await fetch(`http://127.0.0.1:${port}/stt/models`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'no-slash-here' }),
  });
  assert.equal(r.status, 400);
  gw.close();
});

test('session: tone+silence streams a final; delete ends the SSE', async () => {
  sttEngine._setPipeForTest(async () => ({ text: ' hello world ' }));
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const base = `http://127.0.0.1:${port}`;

  const { id } = await (await fetch(`${base}/stt/sessions`, { method: 'POST', body: '{}' })).json();
  assert.ok(id);

  const ssePromise = collectSse(`${base}/stt/sessions/${id}/events`, (evs) => evs.some((e) => e.type === 'end'));
  // Speech then a pause → the engine should commit a FINAL on the trailing quiet.
  const up = await fetch(`${base}/stt/sessions/${id}/audio`, { method: 'POST', body: pcm(1, 1) });
  assert.equal(up.status, 200);
  // Give the decode a beat, then close the session (flushes + emits 'end').
  await new Promise((r) => setTimeout(r, 400));
  await fetch(`${base}/stt/sessions/${id}`, { method: 'DELETE' });

  const events = await ssePromise;
  const finals = events.filter((e) => e.type === 'final');
  assert.ok(finals.length >= 1, `expected a final, got: ${JSON.stringify(events)}`);
  assert.equal(finals[0].text, 'hello world');
  assert.ok(events.some((e) => e.type === 'end'));
  gw.close();
});

test('session: audio to a bogus id → 404; silence-only never decodes', async () => {
  let decodes = 0;
  sttEngine._setPipeForTest(async () => { decodes++; return { text: 'ghost' }; });
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const base = `http://127.0.0.1:${port}`;

  const bogus = await fetch(`${base}/stt/sessions/00000000-0000-4000-8000-000000000000/audio`, { method: 'POST', body: pcm(0.2) });
  assert.equal(bogus.status, 404);

  // Pure silence: the energy gate must skip whisper entirely (hallucination guard).
  const { id } = await (await fetch(`${base}/stt/sessions`, { method: 'POST', body: '{}' })).json();
  await fetch(`${base}/stt/sessions/${id}/audio`, { method: 'POST', body: pcm(0, 1.5) });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(decodes, 0);
  await fetch(`${base}/stt/sessions/${id}`, { method: 'DELETE' });
  gw.close();
});

test('optional STT→NER hop: redact:true redacts finals via the shared guard', async () => {
  sttEngine._setPipeForTest(async () => ({ text: 'my email is jordan@example.com ok' }));
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const base = `http://127.0.0.1:${port}`;

  const { id } = await (await fetch(`${base}/stt/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redact: true }),
  })).json();
  const ssePromise = collectSse(`${base}/stt/sessions/${id}/events`, (evs) => evs.some((e) => e.type === 'end'));
  await fetch(`${base}/stt/sessions/${id}/audio`, { method: 'POST', body: pcm(1, 1) });
  await new Promise((r) => setTimeout(r, 400));
  await fetch(`${base}/stt/sessions/${id}`, { method: 'DELETE' });

  const events = await ssePromise;
  const fin = events.find((e) => e.type === 'final');
  assert.ok(fin, `no final in ${JSON.stringify(events)}`);
  assert.ok(!fin.text.includes('jordan@example.com'), `email leaked: ${fin.text}`);
  assert.match(fin.text, /\[\[EMAIL_\d+\]\]/);
  gw.close();
});
