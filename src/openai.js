// OpenAI-protocol adapter: /v1/chat/completions (what opencode, codex, aider,
// cursor, and most tools speak). Pulls every redactable text string out of the
// request body as in-place segments, and restores tokens in a non-streaming
// response. (Streaming is restored generically in stream.js.)

import { restoreText } from '@chatpanel/pii';
import { segment } from './redact.js';
import { restoreDeepAliases } from './stream.js';

export function matches(pathname) {
  return /\/chat\/completions$/.test(pathname) || /\/completions$/.test(pathname);
}

// Append a (non-redacted) instruction to the system prompt — e.g. the placeholder
// note that tells the model placeholders are auto-restored for tools.
export function injectSystemNote(body, note) {
  if (!note || !body || !Array.isArray(body.messages)) return body;
  const sys = body.messages.find((m) => m && m.role === 'system');
  if (sys && typeof sys.content === 'string') sys.content += `\n\n${note}`;
  else body.messages.unshift({ role: 'system', content: note });
  return body;
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

// Tool-relay: the client's tool definitions, and (on a follow-up request) the
// most recent tool result the client sent back.
export function extractTools(body) {
  return Array.isArray(body?.tools) ? body.tools : [];
}
export function extractLatestToolResult(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === 'tool' && m.tool_call_id) {
      return { tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
    }
  }
  return null;
}

// Restore a buffered (non-streaming) response: assistant text + tool-call args.
export function restoreResponse(json, vault, harness = null) {
  for (const choice of json?.choices || []) {
    const msg = choice?.message;
    if (!msg) continue;
    // Visible text keeps the pseudonym (restoreText); tool-call args go through the
    // shared harness — real values so the client runs the tool on real data, or the
    // redacted token kept for remote MCP tools under "redact remote".
    if (typeof msg.content === 'string') msg.content = restoreText(msg.content, vault);
    for (const tc of msg.tool_calls || []) {
      if (tc?.function && typeof tc.function.arguments === 'string') {
        tc.function.arguments = harness
          ? harness.toTool(tc.function.name, tc.function.arguments)
          : restoreDeepAliases(tc.function.arguments, vault);
      }
    }
  }
  return json;
}
