// Which voice a /tts request actually speaks in — decided in ONE place, with every
// dependency injected so the table below can be tested without loading a model.
//
// The rule that shapes this: a saved clone is a CHOICE, never a default. Someone's
// own voice print must not start speaking because the config was empty, named a
// voice from another model, or pointed at a voice since deleted. A model with
// built-in speakers (Pocket) falls back to one of those; only SpeechT5, which has
// no built-ins, has nothing to fall back to but a recording.
//
// A voice named EXPLICITLY in the request never falls back — it succeeds or fails
// loudly, so a caller that asked for a specific voice can trust what it got.
//
// Returns either { ok: true, voice, customId, speakerEmbedding }
//             or { ok: false, status, type, message }.

export function resolveTtsVoice({
  requested = null,     // body.voice, or null when the caller left it to the config
  configured,           // the voice the request would use absent an override
  engine,               // { isPocket(), supportsCustomVoices(), supportsVoices(), arch() }
  voices,               // { parseCustomVoice, getVoice, listVoices, getPocketVoice }
  isPocketVoice,
  isKnownVoice,
  isValidVoiceId,
  defaultVoice,         // Kokoro's default
  defaultPocketVoice,   // Pocket's built-in default
}) {
  const voice = requested || configured;
  const pocket = engine.isPocket();
  let customId = voices.parseCustomVoice(voice);

  // A Pocket built-in speaker is a NAME, not an embedding, so it is recognised
  // before the custom-voice path — which would otherwise demand a recording for a
  // model that ships eight voices of its own.
  if (pocket && isPocketVoice(voice)) return { ok: true, voice, customId: null, speakerEmbedding: null };

  if (engine.supportsCustomVoices()) {
    let rec = customId ? voices.getVoice(customId) : null;
    if (!rec && !requested) {
      // Nothing valid was configured and nothing was asked for.
      if (pocket) return { ok: true, voice: defaultPocketVoice, customId: null, speakerEmbedding: null };
      const saved = voices.listVoices();
      if (saved.length) { customId = saved[0].id; rec = voices.getVoice(customId); }
    }
    if (!rec) {
      return customId
        ? { ok: false, status: 404, type: 'bad_voice', message: 'no such saved voice' }
        : { ok: false, status: 400, type: 'bad_voice', message: 'this model speaks in a voice you record — add one in Settings → Text-to-speech' };
    }
    // Which print to hand over depends on the engine: Pocket TTS takes its Mimi
    // conditioning, SpeechT5 the 512-d x-vector. A voice saved before the pocket
    // bundle existed has only the latter.
    let speakerEmbedding;
    if (pocket) {
      speakerEmbedding = voices.getPocketVoice(customId);
      if (!speakerEmbedding) {
        return { ok: false, status: 409, type: 'voice_kind_missing', message: 'this voice was saved without a Pocket TTS conditioning — record it again with Pocket TTS selected' };
      }
    } else {
      speakerEmbedding = rec.vec;
    }
    return { ok: true, voice: `custom:${customId}`, customId, speakerEmbedding };
  }

  if (customId) {
    // Explicitly asked for a recorded voice this model cannot use — say so.
    // Inherited from config, though, it is just a stale setting, and refusing to
    // speak at all is a worse answer than speaking in the default voice.
    if (requested) {
      return { ok: false, status: 409, type: 'voice_unsupported', message: `the active model (${engine.arch()}) cannot use a recorded voice — switch to SpeechT5` };
    }
    return { ok: true, voice: defaultVoice, customId: null, speakerEmbedding: null };
  }
  if (pocket && !isPocketVoice(voice)) return { ok: true, voice: defaultPocketVoice, customId: null, speakerEmbedding: null };
  if (engine.supportsVoices() && !pocket && !(isKnownVoice(voice) && isValidVoiceId(voice))) {
    return { ok: false, status: 400, type: 'bad_voice', message: 'unknown or invalid voice' };
  }
  return { ok: true, voice, customId: null, speakerEmbedding: null };
}
