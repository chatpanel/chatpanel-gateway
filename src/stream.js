// Protocol-agnostic stream restorer.
//
// Both OpenAI and Anthropic stream Server-Sent Events whose payloads embed the
// model's text (and tool-call argument JSON) as plain strings. Our placeholders
// are literal, well-formed substrings ([[TYPE_n]]) wherever they appear — inside
// "delta.content", inside a streamed "arguments" JSON string, anywhere. So we can
// restore them with a single pass over the raw outgoing bytes, regardless of
// protocol, holding back a tail when a token might be split across chunks.
//
// Note on pseudonyms: a dictionary `alias` is substituted at REDACTION time (the
// upstream already sees the alias, never a placeholder), so it flows back to the
// agent unchanged — its defined "permanent substitution" behavior. Only reversible
// [[TYPE_n]] tokens are restored here.

import { restoreText, restoreWithAliases } from '@chatpanel/pii';

// Returns a TransformStream-free chunk transformer: feed it decoded string chunks,
// it returns the prefix that's safe to forward now and buffers a possibly-partial
// trailing token. Call flush() at end-of-stream.
export function makeTokenRestorer(vault) {
  let buf = '';
  return {
    push(chunk) {
      if (!vault) return chunk || '';
      buf += chunk || '';
      // If an unterminated "[[" sits in the tail, a token may still be forming —
      // hold from there. "[[" can't legitimately appear except as a token open.
      const open = buf.lastIndexOf('[[');
      let safe;
      if (open !== -1 && !buf.slice(open).includes(']]')) {
        safe = buf.slice(0, open);
        buf = buf.slice(open);
      } else {
        safe = buf;
        buf = '';
      }
      return restoreText(safe, vault);
    },
    flush() {
      const out = vault ? restoreText(buf, vault) : buf;
      buf = '';
      return out;
    },
  };
}

// Deep-restore a parsed value (non-streaming responses): tool-call argument
// objects hold placeholders inside their string fields. Walks strings/arrays/
// objects, restoring reversible tokens. (Streaming uses makeTokenRestorer; this
// is only for the buffered/non-stream path.)
export function restoreDeep(value, vault) {
  if (!vault) return value;
  if (typeof value === 'string') return restoreText(value, vault);
  if (Array.isArray(value)) return value.map((v) => restoreDeep(v, vault));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = restoreDeep(value[k], vault);
    return out;
  }
  return value;
}

// Deep-restore for tool-call argument values (non-stream), undoing aliases too —
// so a client running tools LOCALLY gets the REAL value (pseudonyms included),
// while the model stays blinded. Mirrors the extension's restoreDeep.
export function restoreDeepAliases(value, vault) {
  if (!vault) return value;
  if (typeof value === 'string') return restoreWithAliases(value, vault);
  if (Array.isArray(value)) return value.map((v) => restoreDeepAliases(v, vault));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = restoreDeepAliases(value[k], vault);
    return out;
  }
  return value;
}

// A per-field tail-buffered restorer (holds a partial trailing [[token). `restoreFn`
// is restoreText for VISIBLE text (keep pseudonyms) or restoreWithAliases for
// TOOL-CALL args (real values).
function makeFieldRestorer(vault, restoreFn) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk || '';
      const open = buf.lastIndexOf('[[');
      let safe;
      if (open !== -1 && !buf.slice(open).includes(']]')) { safe = buf.slice(0, open); buf = buf.slice(open); }
      else { safe = buf; buf = ''; }
      return restoreFn(safe, vault);
    },
    flush() { const out = restoreFn(buf, vault); buf = ''; return out; },
  };
}

// OpenAI streaming restorer that restores VISIBLE content with restoreText (the
// model + user keep the pseudonym) but TOOL-CALL argument deltas with
// restoreWithAliases (the client runs the tool on the REAL value). Passes through
// any non-JSON event untouched.
export async function pipeRestoredOpenAIStream(upstreamBody, nodeRes, vault) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const contentR = makeFieldRestorer(vault, restoreText);
  const argRs = new Map(); // tool_call index -> field restorer (aliases)

  const handleBlock = (block) => {
    const out = [];
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) { out.push(line); continue; }
      const payload = line.slice(5).replace(/^\s/, '');
      if (!payload) { out.push(line); continue; }
      if (payload === '[DONE]') {
        const tail = contentR.flush();
        if (tail) out.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] })}`);
        out.push(line);
        continue;
      }
      let evt; try { evt = JSON.parse(payload); } catch { out.push(line); continue; }
      for (const choice of evt.choices || []) {
        const d = choice.delta;
        if (!d) continue;
        if (typeof d.content === 'string') d.content = contentR.push(d.content);
        for (const tc of d.tool_calls || []) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (tc.function && typeof tc.function.arguments === 'string') {
            if (!argRs.has(idx)) argRs.set(idx, makeFieldRestorer(vault, restoreWithAliases));
            tc.function.arguments = argRs.get(idx).push(tc.function.arguments);
          }
        }
      }
      out.push(`data: ${JSON.stringify(evt)}`);
    }
    return out.join('\n');
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        nodeRes.write(handleBlock(buf.slice(0, i)) + '\n\n');
        buf = buf.slice(i + 2);
      }
    }
    if (buf) nodeRes.write(handleBlock(buf));
  } finally {
    nodeRes.end();
  }
}

// Pipe a fetch Response body (web ReadableStream) through the restorer into a
// Node response. Works on raw bytes decoded as UTF-8 — fine because placeholders
// are ASCII, so even if a multibyte char is split the token bytes are intact.
export async function pipeRestoredStream(upstreamBody, nodeRes, vault) {
  const restorer = makeTokenRestorer(vault);
  const decoder = new TextDecoder();
  const reader = upstreamBody.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      const out = restorer.push(text);
      if (out) nodeRes.write(out);
    }
    const tail = restorer.push(decoder.decode()) + restorer.flush();
    if (tail) nodeRes.write(tail);
  } finally {
    nodeRes.end();
  }
}
