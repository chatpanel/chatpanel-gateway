// Anthropic-protocol adapter: /v1/messages (what Claude Code speaks). Same shape
// as the OpenAI adapter — collect in-place text segments from the request,
// restore tokens in a non-streaming response. Streaming is handled generically.

import { segment } from './redact.js';
import { restoreDeep } from './stream.js';

export function matches(pathname) {
  return /\/messages$/.test(pathname);
}

// Push segments for a content field that may be a string or an array of blocks
// ({type:'text',text}, {type:'tool_result',content}, …).
function collectContent(content, segs) {
  if (typeof content === 'string') {
    // Can't set a primitive in place; caller wraps string content separately.
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      segs.push(segment(() => block.text, (v) => { block.text = v; }));
    } else if (block.type === 'tool_result') {
      collectContent(block.content, segs);
    }
  }
}

export function collectSegments(body, redactionCfg) {
  const segs = [];

  // Top-level system prompt: string or array of {type:'text',text} blocks.
  if (redactionCfg.redactSystem !== false && body) {
    if (typeof body.system === 'string') {
      segs.push(segment(() => body.system, (v) => { body.system = v; }));
    } else if (Array.isArray(body.system)) {
      collectContent(body.system, segs);
    }
  }

  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      segs.push(segment(() => m.content, (v) => { m.content = v; }));
    } else {
      collectContent(m.content, segs);
    }
  }
  return segs;
}

// Extract the conversation for the bridge backend. Anthropic carries the system
// prompt at the top level (string or text blocks) — flatten it to a string.
export function toTurn(body) {
  let system = '';
  if (typeof body?.system === 'string') system = body.system;
  else if (Array.isArray(body?.system)) {
    system = body.system.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  return { messages: Array.isArray(body?.messages) ? body.messages : [], system };
}

// Restore a buffered response: text blocks + tool_use input objects.
export function restoreResponse(json, vault) {
  for (const block of json?.content || []) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      block.text = restoreDeep(block.text, vault);
    } else if (block.type === 'tool_use' && block.input) {
      block.input = restoreDeep(block.input, vault);
    }
  }
  return json;
}
