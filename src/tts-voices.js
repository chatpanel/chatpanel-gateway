// Custom voices — a speaker embedding derived from a sample the user recorded.
//
// A voice print is biometric-adjacent data about a specific person, so the rules
// here are deliberately tighter than for anything else this gateway stores:
//   • It NEVER leaves the machine. The embedding is computed in-process by the
//     speaker model already on disk (the one diarization uses), written under
//     ~/.chatpanel, and read back only to condition local synthesis.
//   • The SAMPLE is never persisted. Only the 512 floats derived from it — audio
//     of someone speaking is far more revealing than the vector, and keeping it
//     would serve no purpose once the embedding exists.
//   • Deleting means the file is gone, not flagged. There is no soft-delete for
//     someone's voice.
//
// What this can and cannot do is stated plainly in the UI, and the reason lives
// here: SpeechT5 was trained against speechbrain x-vectors and we embed with
// wavlm-base-plus-sv, which is a different 512-d space. The result is a distinct,
// STABLE voice derived from the sample — the same sample always gives the same
// voice, and different speakers give clearly different ones — but it is not a
// faithful reproduction of the speaker. Calling that "cloning" without saying so
// would be a lie told by a feature name.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

export const EMBED_DIM = 512;
const MAX_VOICES = 20;
const MAX_NAME = 60;

export function voicesDir() {
  return process.env.CHATPANEL_TTS_VOICES || join(os.homedir(), '.chatpanel', 'tts-voices');
}

// An id becomes a FILENAME and arrives from the wire, so it is shape-checked, not
// trusted. UUIDs are what we mint; the pattern is what we accept.
export function isValidVoiceRef(id) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''));
}

// The wire form is `custom:<id>` so one `voice` field can name either a built-in
// Kokoro voice or a saved one, with no ambiguity between the two namespaces.
export function parseCustomVoice(voice) {
  const s = String(voice || '');
  if (!s.startsWith('custom:')) return null;
  const id = s.slice(7);
  return isValidVoiceRef(id) ? id : null;
}

function fileFor(id) {
  return join(voicesDir(), `${id}.json`);
}

export function listVoices() {
  const dir = voicesDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      // The vector is deliberately NOT returned by the listing: the UI needs a
      // name and an id, and 512 floats of someone's voice print have no business
      // in a settings page's JSON.
      if (v?.id && v?.name) out.push({ id: v.id, name: v.name, createdAt: v.createdAt || 0, dim: v.vec?.length || 0 });
    } catch { /* a corrupt file must not break the list */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function getVoice(id) {
  if (!isValidVoiceRef(id)) return null;
  try {
    const v = JSON.parse(readFileSync(fileFor(id), 'utf8'));
    return Array.isArray(v?.vec) && v.vec.length === EMBED_DIM ? v : null;
  } catch { return null; }
}

/** Persist an embedding under a user-chosen name. Returns the stored record. */
export function saveVoice({ name, vec }) {
  const clean = String(name || '').trim().slice(0, MAX_NAME);
  if (!clean) throw new Error('a name is required');
  if (!vec || vec.length !== EMBED_DIM) throw new Error(`expected a ${EMBED_DIM}-value embedding, got ${vec?.length || 0}`);
  if (listVoices().length >= MAX_VOICES) throw new Error(`at most ${MAX_VOICES} saved voices — delete one first`);
  const dir = voicesDir();
  mkdirSync(dir, { recursive: true });
  const rec = { id: randomUUID(), name: clean, createdAt: Date.now(), vec: Array.from(vec, (x) => Number(x) || 0) };
  writeFileSync(fileFor(rec.id), JSON.stringify(rec));
  return { id: rec.id, name: rec.name, createdAt: rec.createdAt, dim: rec.vec.length };
}

/** Remove one permanently. Returns whether there was anything to remove. */
export function deleteVoice(id) {
  if (!isValidVoiceRef(id)) return false;
  const p = fileFor(id);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}
