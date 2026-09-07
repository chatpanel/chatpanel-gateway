// A saved voice is a print of a specific person's voice. The guarantees this
// module makes about it are the kind that must be enforced, not remembered:
// the sample is never kept, the vector never appears in a listing, an id from the
// wire never becomes a path, and delete means gone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'cp-voices-'));
process.env.CHATPANEL_TTS_VOICES = DIR;
after(() => rmSync(DIR, { recursive: true, force: true }));

const v = await import('../src/tts-voices.js');
const vec = (fill = 0.1) => Float32Array.from({ length: v.EMBED_DIM }, () => fill);

test('a saved voice round-trips, and the vector is retrievable only by id', () => {
  const rec = v.saveVoice({ name: 'My voice', vec: vec(0.25) });
  assert.equal(rec.name, 'My voice');
  assert.equal(rec.dim, 512);
  assert.ok(rec.id);
  const got = v.getVoice(rec.id);
  assert.equal(got.vec.length, 512);
  assert.equal(got.vec[0], 0.25);
});

// The listing goes to a settings page. 512 floats of someone's voice have no
// business travelling with a name and a date.
test('the listing carries no vectors', () => {
  const list = v.listVoices();
  assert.ok(list.length >= 1);
  for (const item of list) {
    assert.ok(!('vec' in item), 'a voice print must not appear in a listing');
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'dim', 'id', 'name']);
  }
});

// An id arrives from the wire and becomes a FILENAME.
test('ids that could escape the directory are refused, not sanitized', () => {
  for (const bad of ['../../etc/passwd', 'a/b', '..', '.', '', 'x'.repeat(65), 'a b', null]) {
    assert.equal(v.isValidVoiceRef(bad), false, `should reject ${JSON.stringify(bad)}`);
    assert.equal(v.getVoice(bad), null);
    assert.equal(v.deleteVoice(bad), false);
  }
});

test('the custom: prefix is the only way to name a saved voice, and it is validated', () => {
  const rec = v.saveVoice({ name: 'Ref test', vec: vec() });
  assert.equal(v.parseCustomVoice(`custom:${rec.id}`), rec.id);
  assert.equal(v.parseCustomVoice('af_heart'), null, 'a built-in voice is not a custom one');
  assert.equal(v.parseCustomVoice('custom:../../x'), null, 'traversal must not survive the prefix');
  assert.equal(v.parseCustomVoice('custom:'), null);
  assert.equal(v.parseCustomVoice(''), null);
  assert.equal(v.parseCustomVoice(null), null);
});

test('a wrong-sized embedding is refused — it would be a different model’s vector', () => {
  assert.throws(() => v.saveVoice({ name: 'bad', vec: new Float32Array(128) }), /512/);
  assert.throws(() => v.saveVoice({ name: 'bad', vec: null }), /512/);
  assert.throws(() => v.saveVoice({ name: '', vec: vec() }), /name/);
  assert.throws(() => v.saveVoice({ name: '   ', vec: vec() }), /name/);
});

test('names are bounded — a listing is rendered into a settings page', () => {
  const rec = v.saveVoice({ name: 'x'.repeat(500), vec: vec() });
  assert.ok(rec.name.length <= 60);
});

test('delete removes the file itself — there is no soft-delete for a voice', () => {
  const rec = v.saveVoice({ name: 'Doomed', vec: vec() });
  const before = readdirSync(DIR).length;
  assert.equal(v.deleteVoice(rec.id), true);
  assert.equal(readdirSync(DIR).length, before - 1, 'the file must be gone, not flagged');
  assert.equal(v.getVoice(rec.id), null);
  assert.equal(v.deleteVoice(rec.id), false, 'deleting twice is not an error, just nothing');
});

// Nothing on disk may contain audio — only the derived vector.
test('what is written is the vector and metadata, never the sample', () => {
  const rec = v.saveVoice({ name: 'Inspect me', vec: vec(0.5) });
  const raw = JSON.parse(readFileSync(join(DIR, `${rec.id}.json`), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['createdAt', 'id', 'name', 'vec']);
  assert.equal(raw.vec.length, 512);
  for (const k of ['pcm', 'audio', 'sample', 'wav']) assert.ok(!(k in raw), `${k} must never be persisted`);
  v.deleteVoice(rec.id);
});

test('a corrupt file is skipped, not fatal — one bad voice must not hide the rest', () => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'broken.json'), '{ not json');
  const list = v.listVoices();
  assert.ok(Array.isArray(list), 'listing must survive a corrupt entry');
  assert.ok(list.every((x) => x.id !== 'broken'));
  rmSync(join(DIR, 'broken.json'), { force: true });
});

test('there is a ceiling — a voice store is not a place to accumulate people', () => {
  const ids = [];
  let threw = null;
  try {
    for (let i = 0; i < 40; i++) ids.push(v.saveVoice({ name: `V${i}`, vec: vec() }).id);
  } catch (e) { threw = e; }
  assert.ok(threw, 'saving must stop at the cap rather than growing without bound');
  assert.match(threw.message, /delete one first/);
  for (const id of ids) v.deleteVoice(id);
});
