// Bridge backend: drive the ChatPanel bridge's subscription-authed CLI agents
// (codex / claude / opencode / pi) instead of a pay-per-token provider API. This
// is what lets opencode talk to codex-behind-your-ChatGPT-login THROUGH the
// gateway, with redaction in the middle.
//
//   gateway  →  POST http://127.0.0.1:4319/chat  { agent, messages, system }
//            ←  SSE { type:'delta'|'tool'|'reasoning'|'status'|'done'|'error' }
//
// We only surface the model's *text* (delta/done) to the caller; the agent's own
// tool/reasoning events are its local side effects. Auth uses the bridge's
// per-install bearer token (~/.chatpanel/bridge-token), the same token a
// non-browser local client is expected to present.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const DEFAULT_TOKEN_PATH = join(os.homedir(), '.chatpanel', 'bridge-token');

export function readBridgeToken(cfgToken, tokenPath = DEFAULT_TOKEN_PATH) {
  if (cfgToken) return cfgToken;
  try {
    if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  } catch { /* ignore */ }
  return '';
}

// Flatten an OpenAI/Anthropic message's content (string | parts[]) to plain text
// for the bridge, which expects string content. Image parts are dropped here (the
// bridge takes images separately; wire that later if needed).
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (typeof p?.text === 'string' ? p.text : '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function toBridgeMessages(messages) {
  return (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .map((m) => ({ role: m.role, content: flattenContent(m.content) }));
}

// Open a bridge /chat stream WITH tool specs (pageTools), returning the raw fetch
// Response so the tool-relay can hold the reader open across the OpenAI round-trip.
export async function openBridgeChat({ bridgeUrl, agent, token, messages, system, specs, options, signal }) {
  const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      agent,
      messages: toBridgeMessages(messages),
      system: system || '',
      options: options || {},
      ...(Array.isArray(specs) && specs.length ? { pageTools: { specs } } : {}),
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`bridge /chat HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res;
}

// Stream a turn through the bridge. Calls onText(restorableChunk) for each delta
// of model text and returns the full (un-restored) text. Throws on bridge error.
export async function streamBridgeChat({ bridgeUrl, agent, token, messages, system, options, signal }, onText) {
  const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      agent,
      messages: toBridgeMessages(messages),
      system: system || '',
      options: options || {},
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`bridge /chat HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let streamed = false;
  let err = null;

  const handleEvent = (block) => {
    // SSE: lines of "data: <json>" (the bridge emits one JSON object per event).
    for (const line of block.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'delta' && typeof evt.text === 'string') {
        streamed = true;
        full += evt.text;
        onText(evt.text);
      } else if (evt.type === 'done') {
        // Some engines only deliver the full text at the end (not streamed).
        if (!streamed && typeof evt.text === 'string' && evt.text) {
          full += evt.text;
          onText(evt.text);
        }
      } else if (evt.type === 'error') {
        err = new Error(evt.error || 'bridge error');
      }
      // tool / reasoning / status events are the agent's local side effects — ignore.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    // Events are separated by a blank line.
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      handleEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handleEvent(buf);
  if (err) throw err;
  return full;
}
