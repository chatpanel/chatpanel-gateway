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
    // `kinds` says WHICH engines can speak as this voice; it carries no vector.
    // `updatedAt` distinguishes a re-recorded voice from an untouched one; still
    // no vector, which is the thing that must never appear here.
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'dim', 'id', 'kinds', 'name', 'updatedAt']);
    assert.ok(Array.isArray(item.kinds) && item.kinds.length >= 1);
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

// A first take is often poor — too quiet, a cough, the wrong room. The fix has to
// be "record that again", not "delete it, make a new one, and go re-select it
// everywhere", because `custom:<id>` is what the gateway config and every client
// hold. So both edits keep the id.
test('renaming keeps the id and every other field', () => {
  const rec = v.saveVoice({ name: 'First take', vec: vec(0.3) });
  const renamed = v.renameVoice(rec.id, 'My voice');
  assert.equal(renamed.id, rec.id, 'a rename must not mint a new id');
  assert.equal(renamed.name, 'My voice');
  assert.equal(v.getVoice(rec.id).vec[0].toFixed(3), (0.3).toFixed(3), 'the print is untouched by a rename');
  assert.ok(renamed.updatedAt > 0);
  v.deleteVoice(rec.id);
});

test('renaming rejects an empty name and an unknown id', () => {
  const rec = v.saveVoice({ name: 'Keep', vec: vec() });
  assert.throws(() => v.renameVoice(rec.id, '   '), /name/);
  assert.equal(v.renameVoice('00000000-0000-0000-0000-000000000000', 'x'), null);
  assert.equal(v.getVoice(rec.id).name, 'Keep', 'a failed rename must not have changed anything');
  v.deleteVoice(rec.id);
});

test('re-recording swaps the prints in place, keeping id and name', () => {
  const rec = v.saveVoice({ name: 'Take one', vec: vec(0.1), pocket: { data: new Float32Array(1024).fill(0.4), shape: [1, 1, 1024] } });
  const before = v.getVoice(rec.id).vec[0];
  const out = v.replaceVoice(rec.id, { vec: vec(0.9), pocket: { data: new Float32Array(2048).fill(0.8), shape: [1, 2, 1024] } });
  assert.equal(out.id, rec.id, 'a re-record must not mint a new id');
  assert.equal(out.name, 'Take one', 'and must keep the name');
  assert.ok(Math.abs(v.getVoice(rec.id).vec[0] - before) > 0.5, 'the print must actually change');
  assert.deepEqual(v.getPocketVoice(rec.id).shape, [1, 2, 1024], 'and so must the pocket conditioning');
  v.deleteVoice(rec.id);
});

// The two prints describe the SAME voice. Leaving a stale one behind would make
// the voice change depending on which engine happened to speak.
test('a re-record without a pocket print drops the stale one', () => {
  const rec = v.saveVoice({ name: 'Mixed', vec: vec(0.1), pocket: { data: new Float32Array(1024), shape: [1, 1, 1024] } });
  assert.ok(v.getPocketVoice(rec.id), 'starts with both prints');
  v.replaceVoice(rec.id, { vec: vec(0.5) });
  assert.equal(v.getPocketVoice(rec.id), null, 'the old conditioning must not survive a new take');
  assert.deepEqual(v.voiceKinds(rec.id), [v.KIND_SPEECHT5]);
  v.deleteVoice(rec.id);
});

test('re-recording an unknown voice does nothing rather than creating one', () => {
  const before = v.listVoices().length;
  assert.equal(v.replaceVoice('00000000-0000-0000-0000-000000000000', { vec: vec() }), null);
  assert.equal(v.listVoices().length, before, 'no voice may be conjured by an update');
});

test('a re-record with the wrong embedding size is refused, leaving the old print', () => {
  const rec = v.saveVoice({ name: 'Guarded', vec: vec(0.25) });
  assert.throws(() => v.replaceVoice(rec.id, { vec: new Float32Array(128) }), /512/);
  assert.equal(v.getVoice(rec.id).vec[0].toFixed(3), (0.25).toFixed(3), 'the good print must survive a rejected take');
  v.deleteVoice(rec.id);
});
