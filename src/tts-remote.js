// Remote text-to-speech destinations — ElevenLabs, OpenAI, or anything that speaks
// the OpenAI /audio/speech shape (Groq, a local server, an OpenAI-compatible proxy).
//
// TWO RULES, and they are the whole reason this is a separate module from
// tts-engine.js rather than a branch inside it.
//
// 1. NO KEY LIVES HERE. config.js says it outright — "the gateway forwards the
//    CLIENT's own auth header upstream (it stores no provider keys)" — and a TTS
//    destination is not the place to break that. The caller sends its own
//    Authorization (or xi-api-key) and we pass it through. Config holds the ROUTE.
//
// 2. THE PRIVACY DECISION INVERTS. Local synthesis speaks restored text because the
//    words never leave the machine; there is nothing to protect them from. The
//    moment the destination is remote, the text IS leaving, to a vendor, and every
//    other egress in this gateway is redacted first. So remote synthesis redacts by
//    default.
//
//    That trade is real and cannot be papered over: audio cannot be un-redacted the
//    way a text completion can, so a redacted remote voice literally says
//    "PERSON_1". The honest options are (a) placeholders spoken aloud, or (b) real
//    PII sent to a vendor — and the user picks, per destination, with `redact`. The
//    default is the safe one and the choice is logged via onEgress, so sending real
//    names to ElevenLabs is something someone DID, not something that happened.

import { secureFetch } from './secure-fetch.js';
import { redactSegments, segment } from './redact.js';

export const TTS_PROVIDERS = ['local', 'openai', 'elevenlabs'];

export function isValidTtsProvider(p) {
  return TTS_PROVIDERS.includes(String(p || ''));
}

/** The configured destination, or null when synthesis is local (the default). */
export function ttsDestination(cfg = {}) {
  const t = cfg.tts || {};
  const kind = t.provider || 'local';
  if (kind === 'local' || !isValidTtsProvider(kind)) return null;
  const r = t.remote || {};
  return {
    kind,
    baseUrl: String(r.baseUrl || (kind === 'elevenlabs' ? 'https://api.elevenlabs.io/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, ''),
    model: r.model || (kind === 'elevenlabs' ? 'eleven_multilingual_v2' : 'tts-1'),
    voice: r.voice || (kind === 'elevenlabs' ? '21m00Tcm4TlvDq8ikWAM' : 'alloy'),
    // Undefined means "not set", which must read as ON — an absent flag is never
    // permission to send someone's name to a vendor.
    redact: r.redact !== false,
  };
}

// A remote voice id lands in a URL PATH for ElevenLabs, so it is shape-checked
// rather than trusted: no slashes, no traversal, no query smuggling.
export function isValidRemoteVoice(v) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(v || ''));
}

/**
 * Synthesize remotely. Returns { audio: Buffer, contentType, redacted } — `redacted`
 * is the count of values replaced, so the caller can report what actually left.
 *
 * @param {{dest: any, text: string, voice?: string, speed?: number, auth?: string,
 *          redaction?: any, isPro?: boolean, onEgress?: Function, fetchImpl?: Function}} opts
 */
export async function synthesizeRemote({ dest, text, voice, speed = 1, auth, redaction, isPro = true, onEgress = null, fetchImpl = null } = {}) {
  if (!dest) throw new Error('no remote TTS destination configured');
  const pick = voice || dest.voice;
  if (!isValidRemoteVoice(pick)) throw new Error(`invalid remote voice id: ${pick}`);

  // Redact BEFORE anything is built, so there is no path where the raw string
  // reaches a request body by accident.
  let out = String(text);
  let redacted = 0;
  if (dest.redact && redaction) {
    const box = { text: out };
    const r = await redactSegments([segment(() => box.text, (v) => { box.text = v; })], redaction, { isPro, onEgress });
    out = box.text;
    redacted = r?.count || 0;
  }

  const fetcher = fetchImpl || secureFetch;
  const headers = { 'Content-Type': 'application/json' };
  let url, body;
  if (dest.kind === 'elevenlabs') {
    url = `${dest.baseUrl}/text-to-speech/${encodeURIComponent(pick)}`;
    body = { text: out, model_id: dest.model };
    // ElevenLabs uses its own header. Accept either form from the caller so a
    // generic OpenAI client can drive it too.
    const key = stripBearer(auth);
    if (key) headers['xi-api-key'] = key;
  } else {
    url = `${dest.baseUrl}/audio/speech`;
    body = { model: dest.model, input: out, voice: pick, response_format: 'wav', speed };
    if (auth) headers.Authorization = auth.startsWith('Bearer ') ? auth : `Bearer ${auth}`;
  }

  const res = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.text()).slice(0, 300) || detail; } catch { /* no body */ }
    throw new Error(`remote tts failed: ${detail}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  return { audio, contentType: res.headers.get('content-type') || 'audio/mpeg', redacted };
}

function stripBearer(a) {
  const s = String(a || '').trim();
  return s.toLowerCase().startsWith('bearer ') ? s.slice(7).trim() : s;
}
