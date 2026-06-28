// OpenAI Responses API adapter: /v1/responses (what the Codex CLI and newer
// OpenAI SDKs use — a different body shape from chat/completions). Without this,
// Codex traffic would pass through un-redacted. Forwarded to the OpenAI upstream.

import { segment } from './redact.js';
import { restoreDeep } from './stream.js';

export function matches(pathname) {
  return /\/responses$/.test(pathname);
}

// Redactable text in a Responses request lives in `instructions` (system) and
// `input` (a string, or an array of items whose content parts carry text).
function collectInputItem(item, segs) {
  if (!item || typeof item !== 'object') return;
  if (typeof item.content === 'string') {
    segs.push(segment(() => item.content, (v) => { item.content = v; }));
  } else if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part && typeof part.text === 'string' && /text$/.test(part.type || 'text')) {
        segs.push(segment(() => part.text, (v) => { part.text = v; }));
      }
    }
  }
  // function_call_output items carry a plain `output` string.
  if (typeof item.output === 'string') {
    segs.push(segment(() => item.output, (v) => { item.output = v; }));
  }
}

export function collectSegments(body, redactionCfg) {
  const segs = [];
  if (redactionCfg.redactSystem !== false && typeof body?.instructions === 'string') {
    segs.push(segment(() => body.instructions, (v) => { body.instructions = v; }));
  }
  if (typeof body?.input === 'string') {
    segs.push(segment(() => body.input, (v) => { body.input = v; }));
  } else if (Array.isArray(body?.input)) {
    for (const item of body.input) collectInputItem(item, segs);
  }
  return segs;
}

// Extract the conversation for the bridge backend. Responses carries the system
// prompt as `instructions` and the turn as `input` (string or item array).
export function toTurn(body) {
  const system = typeof body?.instructions === 'string' ? body.instructions : '';
  let messages = [];
  if (typeof body?.input === 'string') {
    messages = [{ role: 'user', content: body.input }];
  } else if (Array.isArray(body?.input)) {
    messages = body.input.map((it) => ({
      role: it?.role || 'user',
      content: it?.content != null ? it.content : (typeof it?.output === 'string' ? it.output : ''),
    }));
  }
  return { messages, system };
}

// Restore a buffered response: output[].content[].text, function_call args, and
// the `output_text` convenience field some SDKs add.
export function restoreResponse(json, vault) {
  if (typeof json?.output_text === 'string') json.output_text = restoreDeep(json.output_text, vault);
  for (const item of json?.output || []) {
    if (!item) continue;
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && typeof part.text === 'string') part.text = restoreDeep(part.text, vault);
      }
    }
    if (typeof item.arguments === 'string') item.arguments = restoreDeep(item.arguments, vault);
  }
  return json;
}
