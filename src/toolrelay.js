// Tool-call relay for the bridge backend.
//
// The bridge relays a CLI agent's tool calls MID-SESSION: it emits a
// `tool_request` over the /chat SSE and pauses the agent until a POST /tool-result
// arrives. OpenAI function-calling is the opposite — the model returns `tool_calls`,
// the response ENDS, and the client re-requests with results. To bridge the two we
// keep the codex /chat stream OPEN across the OpenAI round-trip:
//
//   1. open bridge /chat with the client's tools as pageTools.specs
//   2. read SSE; on `tool_request` → emit OpenAI tool_calls, finish_reason:tool_calls,
//      and PARK the session (reader stays open; codex is paused on the bridge side)
//   3. on the client's follow-up request (carrying the tool result + tool_call_id) →
//      POST /tool-result to the bridge and RESUME reading the same stream
//
// Tool args are restored on the way out (so the client runs on real values) and
// the result is redacted on the way back (so codex only sees placeholders).

import { randomUUID } from 'node:crypto';
import { restoreDeep, redactText, createVault } from '@chatpanel/pii';

const sessions = new Map(); // gwSessionId -> { reader, decoder, buf, bridgeSessionId, toolId, vault, redactOpts, bridgeUrl, token }

// Encode/decode the gateway session into the OpenAI tool_call id so the client
// echoes it back on the follow-up request, letting us find the parked session.
const encodeToolCallId = (gwId, toolId) => `gwtr_${gwId}_${toolId}`;
export function parseToolCallId(id) {
  const m = /^gwtr_([^_]+)_(.+)$/.exec(String(id || ''));
  return m ? { gwId: m[1], toolId: m[2] } : null;
}

// Map OpenAI `tools` → the bridge's pageTools.specs ({ name, description, parameters }).
export function toolsToSpecs(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && t.type === 'function' && t.function?.name)
    .map((t) => ({ name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } }));
}

export function createRelaySession({ vault, redactOpts, bridgeUrl, token }) {
  const id = randomUUID().slice(0, 8);
  const s = { id, reader: null, decoder: new TextDecoder(), buf: '', bridgeSessionId: null, toolId: null, vault: vault || createVault(), redactOpts: redactOpts || { tier: 'basic' }, bridgeUrl, token, done: false };
  sessions.set(id, s);
  return s;
}
export const getRelaySession = (id) => sessions.get(id);
export function endRelaySession(id) {
  const s = sessions.get(id);
  if (s?.reader) { try { s.reader.cancel(); } catch { /* ignore */ } }
  sessions.delete(id);
}

// Drain one SSE event block ("data: {json}\n\n") at a time from the held reader,
// dispatching to handlers until a tool_request parks us or the stream is done.
//   handlers: { onText(restorableText), onToolRequest({name, restoredArgs, toolId, bridgeSessionId}), onDone(), onError(err) }
// Returns 'parked' (hit a tool_request) or 'done'.
export async function pumpBridgeStream(s, handlers) {
  for (;;) {
    let nl;
    while ((nl = s.buf.indexOf('\n\n')) !== -1) {
      const block = s.buf.slice(0, nl);
      s.buf = s.buf.slice(nl + 2);
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.type === 'delta' && typeof evt.text === 'string') {
          handlers.onText(evt.text);
        } else if (evt.type === 'tool_request') {
          s.bridgeSessionId = evt.session; s.toolId = evt.id;
          // restore placeholders so the CLIENT runs the tool on REAL values
          const restoredArgs = restoreDeep(evt.input ?? {}, s.vault);
          handlers.onToolRequest({ name: evt.name, restoredArgs, toolId: encodeToolCallId(s.id, evt.id) });
          return 'parked';
        } else if (evt.type === 'done') {
          s.done = true; handlers.onDone?.(); return 'done';
        } else if (evt.type === 'error') {
          handlers.onError?.(new Error(evt.error || 'bridge error')); return 'done';
        }
        // status / reasoning / tool (summary) events are ignored
      }
    }
    const { done, value } = await s.reader.read();
    if (done) { s.done = true; handlers.onDone?.(); return 'done'; }
    s.buf += s.decoder.decode(value, { stream: true });
  }
}

// Deliver a client's tool result back to the parked codex session: redact it (so
// codex sees placeholders) and POST /tool-result; the bridge then resumes the run.
export async function deliverToolResult(s, content) {
  const redacted = redactText(typeof content === 'string' ? content : JSON.stringify(content), s.vault, s.redactOpts);
  const res = await fetch(`${s.bridgeUrl.replace(/\/$/, '')}/tool-result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(s.token ? { authorization: `Bearer ${s.token}` } : {}) },
    body: JSON.stringify({ session: s.bridgeSessionId, id: s.toolId, result: redacted }),
  });
  if (!res.ok) throw new Error(`bridge /tool-result HTTP ${res.status}`);
}
