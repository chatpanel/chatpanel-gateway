// OpenAI-protocol adapter: /v1/chat/completions (what opencode, codex, aider,
// cursor, and most tools speak). Pulls every redactable text string out of the
// request body as in-place segments, and restores tokens in a non-streaming
// response. (Streaming is restored generically in stream.js.)

import { segment } from './redact.js';
import { restoreDeep } from './stream.js';

export function matches(pathname) {
  return /\/chat\/completions$/.test(pathname) || /\/completions$/.test(pathname);
}

// Collect segments from messages[].content (string or multimodal parts). System
// messages are included unless redactSystem is false.
export function collectSegments(body, redactionCfg) {
  const segs = [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system' && redactionCfg.redactSystem === false) continue;
    if (typeof m.content === 'string') {
      segs.push(segment(() => m.content, (v) => { m.content = v; }));
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          segs.push(segment(() => part.text, (v) => { part.text = v; }));
        }
      }
    }
  }
  return segs;
}

// Extract the conversation for the bridge backend. OpenAI carries the system
// prompt as a role:'system' message, so we pass messages through as-is.
export function toTurn(body) {
  return { messages: Array.isArray(body?.messages) ? body.messages : [], system: '' };
}

// Restore a buffered (non-streaming) response: assistant text + tool-call args.
export function restoreResponse(json, vault) {
  for (const choice of json?.choices || []) {
    const msg = choice?.message;
    if (!msg) continue;
    if (typeof msg.content === 'string') msg.content = restoreDeep(msg.content, vault);
    for (const tc of msg.tool_calls || []) {
      if (tc?.function && typeof tc.function.arguments === 'string') {
        tc.function.arguments = restoreDeep(tc.function.arguments, vault);
      }
    }
  }
  return json;
}
