// Diarization: the online clustering logic (Diarizer) + the session wiring that
// attaches a `speaker` to finals when diarize is on. The embedding model is faked
// so the test is deterministic and needs no download.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/server.js';
import * as sttEngine from '../src/stt-engine.js';
import * as diarize from '../src/diarize-engine.js';

const v = (arr) => Float32Array.from(arr);

test('Diarizer: similar vectors → one speaker; distinct → two', () => {
  const d = new diarize.Diarizer({ threshold: 0.75 });
  const a1 = d.assign(v([1, 0, 0]));
  const a2 = d.assign(v([0.98, 0.02, 0])); // ~same direction → same speaker
  const b1 = d.assign(v([0, 1, 0]));       // orthogonal → new speaker
  assert.equal(a1.label, 'Speaker 1');
  assert.equal(a2.label, 'Speaker 1');
  assert.equal(b1.label, 'Speaker 2');
});

test('Diarizer: pinned label skips clustering (mic = "You")', () => {
  const d = new diarize.Diarizer();
  assert.equal(d.assign(v([1, 0, 0]), { pinnedLabel: 'You' }).label, 'You');
  assert.equal(d.assign(v([0, 1, 0]), { pinnedLabel: 'You' }).label, 'You'); // different voice, still You
});

test('Diarizer: maxSpeakers caps the count (folds into nearest)', () => {
  const d = new diarize.Diarizer({ threshold: 0.99, maxSpeakers: 2 });
  d.assign(v([1, 0, 0])); d.assign(v([0, 1, 0])); // 2 speakers
  const third = d.assign(v([0, 0, 1]));           // would be a 3rd, but capped
  assert.equal(d.centroids.length, 2);
  assert.ok(['Speaker 1', 'Speaker 2'].includes(third.label));
});

// ── Session wiring (faked embedding model) ───────────────────────────────────────

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}
const cfg = () => ({
  host: '127.0.0.1', port: 0, backend: 'api',
  upstreams: { openai: { baseUrl: 'http://127.0.0.1:1' }, anthropic: { baseUrl: 'http://127.0.0.1:1' } },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true },
  stt: { enabled: true, model: 'onnx-community/whisper-base', allowDownload: false },
  logRequests: false,
});
function pcm(tone, quiet = 0) {
  const sr = sttEngine.SAMPLE_RATE;
  const out = new Float32Array(Math.round((tone + quiet) * sr));
  for (let i = 0; i < tone * sr; i++) out[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / sr);
  return Buffer.from(out.buffer);
}
async function collectSse(url, stop, timeoutMs = 8000) {
  const events = []; const res = await fetch(url); const reader = res.body.getReader();
  const t0 = Date.now(); let buf = '';
  for (;;) {
    if (Date.now() - t0 > timeoutMs) break;
    const { done, value } = await reader.read(); if (done) break;
    buf += new TextDecoder().decode(value); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); }
    if (stop(events)) { reader.cancel().catch(() => {}); break; }
  }
  return events;
}

beforeEach(() => { sttEngine._reset(); diarize._reset(); });

test('session diarize:true attaches a speaker to finals', async () => {
  sttEngine._setPipeForTest(async () => ({ text: 'hello there' }));
  diarize._setForTest(async () => ({ embeddings: { data: [1, 0, 0] } }), async (a) => a); // fake model+processor
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const base = `http://127.0.0.1:${port}`;
  const { id } = await (await fetch(`${base}/stt/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diarize: true }),
  })).json();
  const sse = collectSse(`${base}/stt/sessions/${id}/events`, (evs) => evs.some((e) => e.type === 'end'));
  await fetch(`${base}/stt/sessions/${id}/audio`, { method: 'POST', body: pcm(1, 1) });
  await new Promise((r) => setTimeout(r, 400));
  await fetch(`${base}/stt/sessions/${id}`, { method: 'DELETE' });
  const events = await sse;
  const fin = events.find((e) => e.type === 'final');
  assert.ok(fin, `no final in ${JSON.stringify(events)}`);
  assert.ok(fin.speaker && fin.speaker.label, `no speaker on final: ${JSON.stringify(fin)}`);
  gw.close();
});

test('session without diarize has no speaker field', async () => {
  sttEngine._setPipeForTest(async () => ({ text: 'hello there' }));
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const base = `http://127.0.0.1:${port}`;
  const { id } = await (await fetch(`${base}/stt/sessions`, { method: 'POST', body: '{}' })).json();
  const sse = collectSse(`${base}/stt/sessions/${id}/events`, (evs) => evs.some((e) => e.type === 'end'));
  await fetch(`${base}/stt/sessions/${id}/audio`, { method: 'POST', body: pcm(1, 1) });
  await new Promise((r) => setTimeout(r, 400));
  await fetch(`${base}/stt/sessions/${id}`, { method: 'DELETE' });
  const fin = (await sse).find((e) => e.type === 'final');
  assert.ok(fin && fin.speaker === undefined);
  gw.close();
});
