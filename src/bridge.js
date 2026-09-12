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

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4319';
const BRIDGE_PROBE_TTL_MS = 10_000;
let bridgeResolved = { at: 0, cfgUrl: '', url: '', fell: false };

async function bridgeAnswers(url, timeoutMs) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

/**
 * Where the bridge is, checked rather than believed.
 *
 * The persisted bridge.url was found pointing at an ephemeral port nothing answered on,
 * while the real bridge sat on 4319: every agent showed unavailable, every agent turn failed,
 * and the startup line said so in a log nobody was reading. A configured address that does
 * not answer while the default one does is a stale setting, not a decision, so the default
 * is used and the fall-back is logged. Probed at most every ten seconds.
 */
export async function resolveBridgeUrl(cfg, { fallback, timeoutMs = 1500, now = Date.now() } = {}) {
  // CHATPANEL_BRIDGE_FALLBACK=off disables the fallback: the test suite sets it, because a
  // test whose fake bridge has gone away would otherwise find the developer's REAL bridge on
  // 4319 and send its turns to a live coding agent.
  if (fallback === undefined) fallback = process.env.CHATPANEL_BRIDGE_FALLBACK === 'off' ? '' : DEFAULT_BRIDGE_URL;
  const cfgUrl = String(cfg?.bridge?.url || '').replace(/\/$/, '');
  if (bridgeResolved.url && bridgeResolved.cfgUrl === cfgUrl && now - bridgeResolved.at < BRIDGE_PROBE_TTL_MS) return bridgeResolved.url;
  let url = cfgUrl || fallback;
  let fell = false;
  if (fallback && url !== fallback && !(await bridgeAnswers(url, timeoutMs)) && await bridgeAnswers(fallback, timeoutMs)) {
    url = fallback;
    fell = true;
    if (!bridgeResolved.fell || bridgeResolved.cfgUrl !== cfgUrl) console.log(`[gateway] bridge.url ${cfgUrl} is not answering; the bridge on ${fallback} is — using it (fix the address in Settings to silence this)`);
  }
  bridgeResolved = { at: now, cfgUrl, url, fell };
  return url;
}

/** Test seam. */
export function resetBridgeResolution() { bridgeResolved = { at: 0, cfgUrl: '', url: '', fell: false }; }

// Once the bridge has REJECTED the configured token while the file held a different one,
// the file is what every later call presents. Set by `bridgeTokenRejected`, below.
let preferFileToken = false;

function fileToken(tokenPath) {
  try {
    if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  } catch { /* ignore */ }
  return '';
}

/**
 * The bridge token: the config's value first, the file otherwise — until the bridge says
 * the config's value is wrong.
 *
 * `bridge.token` in gateway.config.json is a COPY: the extension's Gateway tab writes its
 * own setting there, and a bridge that regenerates its token leaves the copy behind. The
 * desktop then relayed every Codex turn with the stale copy and got 403 from a bridge ten
 * milliseconds away — an empty streaming bubble, forever. The file is written by the
 * bridge itself, so when the configured token is rejected and the file differs, the file
 * is tried once and, if it works, kept. Nothing is second-guessed before the bridge has
 * actually said no: a pinned token on a loopback bridge stays a pinned token.
 */
export function readBridgeToken(cfgToken, tokenPath = DEFAULT_TOKEN_PATH) {
  const file = fileToken(tokenPath);
  if (!cfgToken) return file;
  if (preferFileToken && file && file !== cfgToken) return file;
  return cfgToken;
}

/**
 * Called with the token the bridge just refused. Returns the file's token when it is a
 * different one worth trying — and from then on `readBridgeToken` prefers it — or '' when
 * there is nothing else to try.
 */
export function bridgeTokenRejected(rejected, tokenPath = DEFAULT_TOKEN_PATH) {
  const file = fileToken(tokenPath);
  if (!file || file === rejected) return '';
  if (!preferFileToken) {
    preferFileToken = true;
    console.warn('[gateway] the bridge rejected bridge.token from gateway.config.json; using ~/.chatpanel/bridge-token (the bridge wrote it). Clear the config value to silence this.');
  }
  return file;
}

/** Test seam. */
export function resetBridgeTokenPreference() { preferFileToken = false; }

const isAuthFailure = (status) => status === 401 || status === 403;

// One POST to /chat, retried once with the file's token when the bridge refuses the one
// it was given — the stale-copy case above.
async function postChat(bridgeUrl, token, body, signal, tokenPath) {
  const send = (t) => fetch(`${bridgeUrl.replace(/\/$/, '')}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body,
    signal,
  });
  // A caller hands over the token it resolved; once a rejection has flipped the
  // preference, the file's token goes first here too.
  const first = readBridgeToken(token, tokenPath);
  let res = await send(first);
  if (isAuthFailure(res.status)) {
    const alt = bridgeTokenRejected(first, tokenPath);
    if (alt) { await res.text().catch(() => {}); res = await send(alt); }
  }
  return res;
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
export async function openBridgeChat({ bridgeUrl, agent, token, messages, system, specs, options, signal, tokenPath }) {
  const res = await postChat(bridgeUrl, token, JSON.stringify({
    agent,
    messages: toBridgeMessages(messages),
    system: system || '',
    options: options || {},
    ...(Array.isArray(specs) && specs.length ? { pageTools: { specs } } : {}),
  }), signal, tokenPath);
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`bridge /chat HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res;
}

// Stream a turn through the bridge. Calls onText(restorableChunk) for each delta, and
// onActivity(event) for everything else the agent reports — status lines, the working
// directory, tool calls, reasoning.
// of model text and returns the full (un-restored) text. Throws on bridge error.
export async function streamBridgeChat({ bridgeUrl, agent, token, messages, system, options, signal, tokenPath }, onText, onActivity = null) {
  const res = await postChat(bridgeUrl, token, JSON.stringify({
    agent,
    messages: toBridgeMessages(messages),
    system: system || '',
    options: options || {},
  }), signal, tokenPath);

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
      } else if (onActivity) {
        // WHAT THE AGENT IS DOING, for a client that wants to show it.
        //
        // These used to be dropped with a comment calling them "the agent's local side
        // effects". They are — and they are also the ONLY thing that happens for the ten
        // seconds an agent spends reading files before it says a word. A client routed
        // through this gateway saw a spinner and nothing else, while one talking to the
        // bridge directly showed the work; that difference was pushing clients toward the
        // direct path, which is the one with no redaction in it.
        //
        // Passed through as-is. Deciding here which of a coding agent's events are worth
        // showing would be this file guessing at someone's UI.
        onActivity(evt);
      }
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
