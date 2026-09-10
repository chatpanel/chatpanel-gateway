// ChatPanel Privacy Gateway — a localhost server that redacts PII out of every
// LLM request, then restores the placeholders in the reply. The model only ever
// sees [[PERSON_1]] / [[EMAIL_2]] — the real values never leave the machine.
//
// Two backends (see config.js):
//   'bridge' — drive the ChatPanel bridge's subscription-authed CLI agents
//              (codex/claude/opencode/pi). This is the privacy-bridge-between-
//              agents path: opencode → gateway (redact) → bridge → codex → restore.
//   'api'    — forward redacted traffic to a native provider API (local models,
//              BYO keys). The client's own auth header is passed through verbatim.
//
//   GET  /health               → { ok, version, backend, tier }
//   GET  /v1/models            → list the agent(s) this gateway exposes
//   POST /v1/chat/completions   → OpenAI protocol
//   POST /v1/responses          → OpenAI Responses protocol (Codex)
//   POST /v1/messages           → Anthropic protocol
//
// Binds 127.0.0.1 only and enforces a loopback Host (anti DNS-rebinding).

import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { startEntitlementRefresh, maybeRevalidate } from './entitlement-refresh.js';
import { redactSegments, segment } from './redact.js';
import { pipeRestoredStream, pipeRestoredOpenAIStream, makeTokenRestorer, restoreDeep } from './stream.js';
import { restoreText, gatedDictionary, narrowSpecs, makeToolHarness, placeholderToolNote, assertEndpointUrl } from '@chatpanel/pii';
import { ensureGatewayToken, isAdminAuthorized } from './gateway-token.js';
import { secureFetch } from './secure-fetch.js';
import { streamBridgeChat, readBridgeToken, openBridgeChat } from './bridge.js';
import { createRelaySession, getRelaySession, endRelaySession, pumpBridgeStream, deliverToolResult, toolsToSpecs, parseToolCallId } from './toolrelay.js';
import { shaperFor } from './shape.js';
import { startNer } from './ner.js';
import { installTimestampedConsole } from './log.js';
import { saveBackupSecret, clearBackupSecret, loadBackupSecret, hasBackupSecret } from './history-store.js';
import { createMemoryStore } from './memory-store.js';
import { createHistoryStore } from './sqlite-store.js';
import { ingestBackups } from './backup-ingest.js';
import * as nerEngine from './ner-engine.js';
import * as sttEngine from './stt-engine.js';
import * as diarizeEngine from './diarize-engine.js';
import { MODEL_CATALOG, isKnownModel, isValidCustomModelId } from './models.js';
import { STT_MODEL_CATALOG, isKnownSttModel, isValidCustomSttId, DEFAULT_STT_MODEL, STT_DTYPES, isValidDtype } from './stt-models.js';
import * as ttsEngine from './tts-engine.js';
import { TTS_MODEL_CATALOG, TTS_VOICES, isKnownTtsModel, isValidCustomTtsId, isKnownVoice, isValidVoiceId, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, TTS_DTYPES, isValidTtsDtype, MAX_TTS_CHARS, ttsModelHasCustomVoices, ttsModelRequiresNative, resolveDefaultModel, POCKET_VOICES, DEFAULT_POCKET_VOICE, isPocketVoice, ttsModelEngine as ttsModelEngineOf } from './tts-models.js';
import { ttsDestination, synthesizeRemote, isValidRemoteVoice } from './tts-remote.js';
import { rawOrtAvailable } from './ort.js';
import * as ttsVoices from './tts-voices.js';
import { resolveTtsVoice } from './tts-voice-resolve.js';
import { resolvePro, checkQuota, consume, usage } from './freegate.js';
import { publicConfig, applyConfigPatch, applyNerModelSelection, persistConfig, configPath } from './configstore.js';
import { resolveDestination, aggregateModelsAsync, listDestinations } from './router.js';
import { makeAccessEvent } from './observability.js';
import { createPersistentAccessLog } from './access-log-store.js';
import { planQueries, multiSearch } from './rrf.js';
import * as openai from './openai.js';
import * as responses from './responses.js';
import * as anthropic from './anthropic.js';

export const VERSION = '0.6.64';

// WARM search tier — SQLite + FTS5 record store (falls back to an encrypted-JSON
// store if SQLite can't load), fed by the extension's ingest sync + backup-ingest.
// Persistent + memory-mapped, so a restart needs no re-ingest (no cold start).
// See docs/architecture-data-tiers.
const historyStore = await createHistoryStore();
const memoryStore = await createMemoryStore();

// OBSERVABILITY — a ring of "which agent read what, when", persisted across restarts (the
// gateway updates often; an empty panel after each restart reads as "nothing is set up").
// Populated by the MCP process (chatpanel-gateway mcp) reporting each tool call, so a person
// can SEE cross-agent access in ChatPanel's dashboard. Safe to persist: every event is
// metadata only — client/tool/ms + a REDACTED note (a search query's text is never in it).
const accessLog = createPersistentAccessLog();

const KNOWN_AGENTS = new Set(['codex', 'claude', 'opencode', 'pi', 'kiro', 'antigravity', 'hermes']);

// Auto-narrow: arm only the top-K most-relevant MCP tools per turn (speed). Mirrors
// the extension's AUTO mode via the SAME shared ranker. We narrow only tools whose
// name looks like an MCP tool (server-prefixed) so a client's CORE tools (bash,
// read, edit…) are never dropped — that would break agent clients like OpenCode.
const DEFAULT_GATEWAY_TOOL_CAP = 16;
const MCP_NAME_RE = /^mcp[_-]/i;
const toolName = (t) => (t && t.function && t.function.name) || (t && t.name) || '';
const toolDesc = (t) => (t && t.function && t.function.description) || (t && t.description) || '';

// Flatten message/content shapes to the latest user text — the query we rank tools against.
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join(' ');
  return '';
}
function latestUserText(body, kind) {
  if (!body) return '';
  if (kind === 'responses') {
    const inp = body.input;
    if (typeof inp === 'string') return inp;
    if (Array.isArray(inp)) return inp.map((x) => textFromContent(x && (x.content ?? x))).join(' ');
    return '';
  }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') return textFromContent(msgs[i].content);
  }
  return '';
}

const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'accept-encoding', 'content-encoding', 'keep-alive',
]);

function isLoopbackHost(host) {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

// Local CLI clients send no Origin; browsers always do. We allow the trusted
// local UIs (the ChatPanel extension + localhost) and anything the operator
// allowlists — and reject every other web origin, so a malicious page can't drive
// the gateway (and thus codex). Mirrors the bridge's origin model.
function originAllowed(origin, cfg) {
  if (!origin) return true; // no Origin → a local process (opencode/codex/SDK)
  if (/^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return true;
  return Array.isArray(cfg.allowedOrigins) && cfg.allowedOrigins.includes(origin);
}

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-ChatPanel-Token');
  res.setHeader('Vary', 'Origin');
}

const STARTED_AT = Date.now();

// Render a timings map as a compact one-liner for the console log.
function fmtTimings(t) {
  if (!t) return '';
  const label = { redact: 'redact', upstream: 'model', stream: 'stream', restore: 'restore', total: 'total' };
  return Object.keys(t).map((k) => `${label[k] || k} ${t[k]}ms`).join(' · ');
}

// Per-request timing + summary. Created ONLY when logging is on — when it's off
// the handler passes a null trace and every `trace?.…` call short-circuits, so we
// don't even read the clock: logging then adds zero latency. The committed entry
// is flushed to the in-memory ring via setImmediate, i.e. AFTER the response has
// been handed back, so recording (and the console line) never sits on the request
// path. `timings` are wall-clock ms per stage of the flow:
//   redact   prompt → harness[redact] → model input
//   upstream model input → model output. Non-stream: full call. Stream: time to
//            first token (model/connection latency). Shown as "model".
//   stream   first token → last token (generation), streaming responses only
//   restore  model output → harness[restore] → user response (non-stream; for
//            streams restore is inline per chunk, so it's folded into stream)
//   total    end-to-end through the gateway
function mkTrace(sink) {
  const start = performance.now();
  const timings = {};
  let done = false;
  const mark = (name, ms) => { timings[name] = Math.round(ms * 10) / 10; };
  return {
    meta: {}, timings, mark,
    // Stamp the duration of an already-completed stage (`t0` from clock()).
    lap(name, t0) { mark(name, performance.now() - t0); },
    clock() { return performance.now(); },
    commit() {
      if (done) return; done = true;
      mark('total', performance.now() - start);
      const entry = /** @type {any} */ ({ ...this.meta, timings });
      setImmediate(() => {
        sink(entry);
        console.log(`[gateway] model=${entry.model || '-'} → ${entry.dest ? `${entry.dest}(${entry.type})` : 'none'} · redacted ${entry.redacted || 0}${entry.sanitized ? ` · scrubbed ${entry.sanitized} hidden` : ''}${entry.narrowed ? ` · narrowed -${entry.narrowed}` : ''} · ${fmtTimings(timings)}`);
      });
    },
  };
}

// Build the optional per-request redaction breakdown from the request's vault.
// 'types'  → [{ token:'PERSON_1', type:'PERSON' }]            (no real values)
// 'values' → [{ token:'PERSON_1', type:'PERSON', value:'…' }] (the real PII; opt-in)
// Lives only in the in-memory ring — never written to disk by persistConfig.
function redactionDetail(vault, mode) {
  if (!vault || !vault.byToken || (mode !== 'types' && mode !== 'values')) return undefined;
  const out = [];
  for (const [token, value] of vault.byToken) {
    const m = /^\[\[([A-Z][A-Z0-9]*)_\d+\]\]$/.exec(token);
    const t = m ? m[1] : 'PII';
    const bare = token.replace(/^\[\[|\]\]$/g, '');
    out.push(mode === 'values' ? { token: bare, type: t, value } : { token: bare, type: t });
  }
  return out;
}

// Classify a request: which protocol kind + adapter, whether it's a redactable
// chat endpoint, and (api backend) which upstream base URL.
function route(pathname, headers, cfg) {
  if (anthropic.matches(pathname) || 'anthropic-version' in headers) {
    return { kind: 'anthropic', adapter: anthropic, redactable: anthropic.matches(pathname), base: cfg.upstreams?.anthropic?.baseUrl };
  }
  if (responses.matches(pathname)) {
    return { kind: 'responses', adapter: responses, redactable: true, base: cfg.upstreams?.openai?.baseUrl };
  }
  return { kind: 'openai', adapter: openai, redactable: openai.matches(pathname), base: cfg.upstreams?.openai?.baseUrl };
}

function pickAgent(model, cfg) {
  return KNOWN_AGENTS.has(model) ? model : cfg.bridge.agent;
}

// A follow-up request carrying a tool result for a PARKED relay session. Such a
// request must NOT be redacted here: the relay owns redaction/restore through its
// OWN (round-1) vault, so re-redacting with a fresh vault would put the tool
// result's new tokens in the wrong vault and leave them unrestored in the reply.
function isRelayResume(body, kind) {
  if (kind !== 'openai' || !body) return false;
  const tr = openai.extractLatestToolResult(body);
  if (!tr) return false;
  const parsed = parseToolCallId(tr.tool_call_id);
  return !!(parsed && getRelaySession(parsed.gwId));
}

// Guard against an api destination pointing back at THIS gateway (loopback host +
// our own port) — forwarding there would loop forever.
function isSelfUrl(baseUrl, cfg) {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const loop = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return loop && String(port) === String(cfg.port);
  } catch { return false; }
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (maxBytes && size > maxBytes) { const e = new Error('payload too large'); e.code = 413; throw e; }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// A USER-configured external detector's URL and its sibling /health. Returns null
// when no external detector is wired (the bundled in-process engine is handled
// separately in probeNerHealth / the /ner route).
function nerBaseUrl(cfg) {
  const url = cfg.redaction?.detection?.url;
  if (!url || cfg.redaction?.detection?.backend === 'off') return null;
  return url;
}

// Health of the detector for /status. The bundled IN-PROCESS engine takes
// precedence; its public contract URL is the gateway's own /ner (no second port).
// A user-configured external detector is probed over HTTP as before.
async function probeNerHealth(cfg) {
  if (nerEngine.state() !== 'off') {
    const h = nerEngine.health();
    return {
      configured: h.configured,
      ok: h.ok,
      state: h.state,
      model: h.model,
      error: h.error || null,
      url: h.configured ? `http://${cfg.host}:${cfg.port}/ner` : null,
    };
  }
  const url = nerBaseUrl(cfg);
  if (!url) return { configured: false, ok: false, url: null, model: null };
  try {
    // secureFetch: scheme + host policy AND resolved-IP validation (DNS-rebinding).
    const r = await secureFetch(url.replace(/\/ner\/?$/, '') + '/health', { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { configured: true, ok: false, url, model: null };
    const j = await r.json().catch(() => ({}));
    return { configured: true, ok: true, url, model: j.model || null };
  } catch {
    return { configured: true, ok: false, url, model: null };
  }
}

function forwardHeaders(headers, base) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    // ChatPanel's own routing metadata is for THIS hop and is not the provider's business.
    if (lower.startsWith('x-chatpanel-')) continue;
    if (!HOP_BY_HOP.has(lower)) out[k] = v;
  }
  out['accept-encoding'] = 'identity'; // must read plain text to restore tokens
  try { out.host = new URL(base).host; } catch { /* leave unset */ }
  return out;
}

// ---- backend: bridge -------------------------------------------------------

// Stream the bridge SSE through the OpenAI shaper, parking on a tool call.
// `trace` (when present) times the agent turn: 'upstream' = time to first token,
// 'stream' = first token → park/done. The turn ends at a tool-call (parked, the
// client runs the tool and POSTs back, resuming a fresh trace) or at onDone.
async function pumpRelay(res, s, shaper, trace) {
  const restorer = makeTokenRestorer(s.vault);
  const t0 = trace ? trace.clock() : 0;
  let sStart = t0;
  let first = true;
  const tick = () => { if (trace && first) { trace.lap('upstream', t0); sStart = trace.clock(); first = false; } };
  await pumpBridgeStream(s, {
    onText: (text) => { tick(); const r = restorer.push(text); if (r) res.write(shaper.sseDelta(r)); },
    onToolRequest: ({ name, restoredArgs, toolId }) => {
      tick();
      const tail = restorer.flush(); if (tail) res.write(shaper.sseDelta(tail));
      res.write(shaper.sseToolCalls([{ id: toolId, name, arguments: JSON.stringify(restoredArgs) }]));
      res.write(shaper.sseToolFinish());
      if (trace) trace.lap('stream', sStart);
      res.end(); trace?.commit(); // park: turn ends with tool_calls; the session stays alive for the follow-up
    },
    onDone: () => { const tail = restorer.flush(); if (tail) res.write(shaper.sseDelta(tail)); res.write(shaper.sseTail()); if (trace) trace.lap('stream', sStart); res.end(); endRelaySession(s.id); trace?.commit(); },
    onError: (e) => { res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'bridge_error' } })}\n\n`); res.end(); endRelaySession(s.id); trace?.commit(); },
  });
}

// New tool-enabled turn: open the bridge with the client's tools as MCP specs.
async function startRelay(req, res, { kind, adapter, agent }, body, vault, cfg, isPro, tools, harness = null, trace = null) {
  const { messages, system } = adapter.toTurn(body);
  const token = readBridgeToken(cfg.bridge.token);
  const shaper = shaperFor(kind, body?.model || agent);
  // Full tier for everyone here (the free allowance is enforced in the main
  // handler), but the custom dictionary stays capped for free.
  const redactOpts = { tier: cfg.redaction.tier === 'full' ? 'full' : 'basic', dictionary: gatedDictionary(cfg.redaction, isPro), entities: [] };
  const s = createRelaySession({ vault, redactOpts, bridgeUrl: cfg.bridge.url, token, harness });
  const ttl = setTimeout(() => endRelaySession(s.id), 135_000); // bridge tool-call timeout is 120s
  // The placeholder note is already in `system` (injected into the body after
  // redaction in the main handler), so toTurn() carried it here — nothing to add.
  let resp;
  try {
    resp = await openBridgeChat({ bridgeUrl: cfg.bridge.url, agent, token, messages, system, specs: toolsToSpecs(tools), options: {}, signal: undefined });
  } catch (e) { clearTimeout(ttl); endRelaySession(s.id); trace?.commit(); return sendJson(res, 502, { error: { message: `bridge: ${e.message}`, type: 'bridge_error' } }); }
  s.reader = resp.body.getReader();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(shaper.sseHead());
  return pumpRelay(res, s, shaper, trace);
}

// Follow-up turn carrying a tool result: feed it to the parked agent + resume.
// The relay redacts the tool result with ITS vault (the main handler skips
// redaction for a relay-resume), so time that here as the 'redact' leg.
async function resumeRelay(res, s, toolContent, model, trace = null) {
  try {
    const rd0 = trace ? trace.clock() : 0;
    await deliverToolResult(s, toolContent);
    if (trace) trace.lap('redact', rd0);
  } catch (e) { endRelaySession(s.id); trace?.commit(); return sendJson(res, 502, { error: { message: `tool-result: ${e.message}`, type: 'bridge_error' } }); }
  const shaper = shaperFor('openai', model || 'codex');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(shaper.sseHead());
  return pumpRelay(res, s, shaper, trace);
}

async function handleBridge(req, res, { kind, adapter, redactable, pathname, agentOverride, harness, trace }, body, vault, cfg, isPro) {
  if (!redactable) {
    trace?.commit();
    return sendJson(res, 404, { error: `endpoint ${pathname} not supported by the bridge backend` });
  }

  // Tool relay (OpenAI protocol + agent destinations). A follow-up request carries
  // a tool result for a parked session; a new request with `tools` starts one.
  // The relay streams its own multi-turn flow and commits the trace when its turn
  // ends (parked on a tool call, or done).
  if (kind === 'openai') {
    const toolResult = adapter.extractLatestToolResult(body);
    if (toolResult) {
      const parsed = parseToolCallId(toolResult.tool_call_id);
      const s = parsed && getRelaySession(parsed.gwId);
      if (s) return resumeRelay(res, s, toolResult.content, body?.model, trace);
    }
    const tools = adapter.extractTools(body);
    if (tools.length && body?.stream === true) {
      return startRelay(req, res, { kind, adapter, agent: agentOverride || pickAgent(body?.model, cfg) }, body, vault, cfg, isPro, tools, harness, trace);
    }
  }

  const { messages, system } = adapter.toTurn(body);
  const agent = agentOverride || pickAgent(body?.model, cfg);
  const wantStream = body?.stream === true;
  const shaper = shaperFor(kind, body?.model || agent);
  const token = readBridgeToken(cfg.bridge.token);
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const turn = { bridgeUrl: cfg.bridge.url, agent, token, messages, system, signal: ac.signal };

  if (!wantStream) {
    try {
      let full = '';
      const up0 = trace ? trace.clock() : 0;
      await streamBridgeChat(turn, (t) => { full += t; });
      if (trace) trace.lap('upstream', up0);
      const rs0 = trace ? trace.clock() : 0;
      const out = shaper.full(restoreText(full, vault));
      if (trace) trace.lap('restore', rs0);
      res.writeHead(200, { 'content-type': shaper.contentType });
      res.end(out);
      return trace?.commit();
    } catch (e) {
      trace?.commit();
      return sendJson(res, 502, { error: { message: `bridge backend failed: ${e.message}`, type: 'bridge_error' } });
    }
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(shaper.sseHead());
  const restorer = makeTokenRestorer(vault);
  const up0 = trace ? trace.clock() : 0;
  let sStart = up0;
  try {
    let first = true;
    await streamBridgeChat(turn, (chunk) => {
      if (trace && first) { trace.lap('upstream', up0); sStart = trace.clock(); first = false; } // time-to-first-token
      const restored = restorer.push(chunk);
      if (restored) res.write(shaper.sseDelta(restored));
    }, shaper.sseActivity ? (evt) => {
      // Activity is the agent describing its own work, so it can name a file it read — and
      // it was handed PLACEHOLDERS, so what it echoes contains them. It is restored like any
      // other text on the way back: a status line is not a side channel that skips the
      // round trip and shows the user "[[PERSON_1]].md".
      //
      // restoreDeep, NOT the streaming restorer above: that one holds a partial token across
      // chunks, and pushing an unrelated object through it would splice activity text into
      // the middle of the assistant's message.
      try {
        res.write(shaper.sseActivity(restoreDeep(evt, vault)));
      } catch { /* a client that hung up mid-turn is not a reason to fail the turn */ }
    } : null);
    const tail = restorer.flush();
    if (tail) res.write(shaper.sseDelta(tail));
    res.write(shaper.sseTail());
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'bridge_error' } })}\n\n`);
  }
  if (trace) trace.lap('stream', sStart);
  res.end();
  trace?.commit();
}

// ---- backend: api ----------------------------------------------------------

// Join a destination's base URL to the incoming path WITHOUT doubling the API version.
//
// Every OpenAI-compatible provider tells you to paste a base that already ends at the version
// — https://integrate.api.nvidia.com/v1, https://openrouter.ai/api/v1, https://router.hugging
// face.co/v1 — and the request arriving here carries the version too (/v1/chat/completions).
// Concatenating them produced /v1/v1/chat/completions, and what came back was the provider's
// own "404 page not found". That reads like a broken gateway, or a wrong model, or a dead
// channel — anything except the mis-joined URL it actually was.
//
// Matching on the leading segment rather than hardcoding "v1" so a provider on /v2 or a beta
// path is joined correctly too.
export function joinUpstream(base, pathname, search = '') {
  const b = String(base || '').replace(/\/+$/, '');
  const seg = String(pathname || '').split('/')[1];
  if (seg && b.endsWith(`/${seg}`)) return b.slice(0, -(seg.length + 1)) + pathname + search;
  return b + pathname + search;
}

// Paths this gateway serves ITSELF. Used only to tell "you asked for a local
// feature I do not have" apart from "you asked me to proxy something upstream" —
// without it, calling a route added in a newer version reports a provider failure.
// How long to wait for the speaker model before telling the caller to retry. Long
// enough to cover loading one already on disk (seconds) plus a slow first fetch,
// short enough that a stuck download does not hold a request open forever.
const EMBEDDER_WAIT_MS = 90_000;

// Linear resample. Good enough for a voice-print sample — the encoder cares about
// timbre, not the last decibel of fidelity — and it avoids a dependency for one
// rate conversion.
function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    const b = Math.min(input.length - 1, a + 1);
    const f = pos - a;
    out[i] = input[a] * (1 - f) + input[b] * f;
  }
  return out;
}

const LOCAL_NAMESPACES = ['/tts', '/stt', '/ner', '/diarize', '/skills', '/redact', '/config', '/logs', '/status', '/admin'];

async function handleApi(req, res, { adapter, kind, pathname, search, base, destKey, destProtocol, harness, trace }, outBody, vault) {
  let upstream;
  const up0 = trace ? trace.clock() : 0;
  try {
    const headers = forwardHeaders(req.headers, base);
    // If the destination carries its own key (imported from a configured API),
    // forward WITH it instead of relying on the client's auth header.
    if (destKey) {
      if (destProtocol === 'anthropic') { headers['x-api-key'] = destKey; delete headers.authorization; }
      else { headers.authorization = `Bearer ${destKey}`; }
    }
    // SSRF guard on the config-supplied upstream: block cloud-metadata + non-http(s)
    // BEFORE the fetch. Loopback/LAN stay allowed (Ollama/LM Studio/homelab are the
    // point of a BYO gateway); only the credential-theft pivot is refused.
    const upstreamUrl = assertEndpointUrl(joinUpstream(base, pathname, search)).toString();
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : outBody,
    });
  } catch (e) {
    trace?.commit();
    return sendJson(res, 502, { error: `upstream fetch failed: ${e.message}` });
  }

  const ct = upstream.headers.get('content-type') || '';
  const resHeaders = {};
  upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v; });

  if (ct.includes('text/event-stream') && upstream.body) {
    if (trace) trace.lap('upstream', up0); // model latency to response headers
    const sStart = trace ? trace.clock() : 0;
    res.writeHead(upstream.status, resHeaders);
    // OpenAI streaming: restore tool-call args via the harness (real, or kept
    // redacted for remote MCP under redactRemote) while keeping visible text
    // pseudonymized. Other protocols: generic restore. The 'stream' leg spans
    // the body; commit once it finishes (total then covers the whole response).
    const piped = kind === 'openai'
      ? pipeRestoredOpenAIStream(upstream.body, res, vault, harness)
      : pipeRestoredStream(upstream.body, res, vault);
    return Promise.resolve(piped).finally(() => { if (trace) trace.lap('stream', sStart); trace?.commit(); });
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  if (trace) trace.lap('upstream', up0);
  if (vault && ct.includes('application/json')) {
    try {
      const rs0 = trace ? trace.clock() : 0;
      const json = adapter.restoreResponse(JSON.parse(buf.toString('utf8')), vault, harness);
      if (trace) trace.lap('restore', rs0);
      res.writeHead(upstream.status, { ...resHeaders, 'content-type': 'application/json' });
      res.end(Buffer.from(JSON.stringify(json), 'utf8'));
      return trace?.commit();
    } catch { /* fall through */ }
  }
  res.writeHead(upstream.status, resHeaders);
  res.end(buf);
  trace?.commit();
}

// ---- server ----------------------------------------------------------------

export function createGateway(cfg = loadConfig()) {
  // Per-gateway ring of recent request summaries for the extension's monitoring
  // view (newest last). Counts + optional redaction detail + per-stage timings —
  // see mkTrace. Lives only here, never persisted to disk.
  const recentRequests = [];
  const recordRequest = (entry) => {
    recentRequests.push(entry);
    if (recentRequests.length > 50) recentRequests.shift();
  };
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (!isLoopbackHost(req.headers.host)) return sendJson(res, 403, { error: 'loopback only' });
    if (!originAllowed(req.headers.origin, cfg)) return sendJson(res, 403, { error: 'origin not allowed' });

    // CORS for the trusted local UIs (extension/localhost). Preflight ends here.
    if (req.headers.origin) setCors(res, req.headers.origin);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    // Admin-token handshake. The extension authenticates admin routes by its
    // chrome-extension:// Origin, but Chrome OMITS Origin on GET requests to a host the
    // extension has permission for — so config READS (GET /config) would fail. A POST
    // still carries the Origin, so the extension POSTs here (authorized by Origin) to get
    // the token, then sends it as `Authorization: Bearer` on the GET admin routes. A
    // drive-by web page can't reach this: its Origin isn't chrome-extension:// (Origin
    // check) and it has no token. Additive route — old extensions ignore it.
    if (pathname === '/admin/token' && req.method === 'POST') {
      if (!isAdminAuthorized(req)) return sendJson(res, 403, { error: 'admin: extension origin or gateway token required' });
      return sendJson(res, 200, { token: ensureGatewayToken() });
    }

    // M2: ADMIN routes reconfigure the gateway (POST /config) or expose its in-memory
    // logs (GET /logs). Unlike the /v1 data plane (open to any local client — the
    // product), these must not be reachable by a no-Origin local process or a drive-by
    // localhost web page. Require the extension Origin or the gateway token.
    if ((pathname === '/config' || pathname === '/logs') && !isAdminAuthorized(req)) {
      return sendJson(res, 403, { error: 'admin route: extension origin or gateway token required' });
    }
    if ((pathname === '/v1/history/key' || pathname === '/v1/history/ingest-backup')
      && req.method === 'POST' && !isAdminAuthorized(req)) {
      return sendJson(res, 403, { error: { message: 'history key route: extension origin or gateway token required', type: 'forbidden' } });
    }
    // Reads of the warm index are open (that's the product — Codex/OpenCode query it).
    // WRITES are not: a drive-by localhost page or a random local process must not be
    // able to inject records the model then trusts as the user's real history. Ingest
    // requires the extension Origin (which its POST always carries) or the gateway token.
    if ((pathname === '/v1/history/ingest' || pathname === '/v1/history/clear') && req.method === 'POST' && !isAdminAuthorized(req)) {
      return sendJson(res, 403, { error: { message: 'history write — extension origin or gateway token required', type: 'forbidden' } });
    }
    // Memory WRITES follow the same rule as history ingest, for a stronger reason: a memory is
    // carried into every future turn on every model, so a drive-by localhost page that could
    // POST one would be installing a standing instruction, not injecting a single record.
    // Reads stay open — that IS the product (Codex and Claude Code recall through it).
    if ((pathname === '/v1/memory/remember' || pathname === '/v1/memory/forget'
      || pathname === '/v1/memory/sync' || pathname === '/v1/memory/clear')
      && req.method === 'POST' && !isAdminAuthorized(req)) {
      return sendJson(res, 403, { error: { message: 'memory write — extension origin or gateway token required', type: 'forbidden' } });
    }
    // The access log is who-read-what — sensitive, and writable only by the local MCP
    // process (which sends the gateway token). Extension Origin or token for both the
    // read (dashboard) and the report (MCP child); a drive-by page has neither.
    if (pathname.startsWith('/v1/observability') && !isAdminAuthorized(req)) {
      return sendJson(res, 403, { error: { message: 'observability: extension origin or gateway token required', type: 'forbidden' } });
    }

    if (req.method === 'GET' && pathname === '/health') {
      // `stt` is ADDITIVE (Tesla rule): old clients ignore it, new clients use it
      // to auto-detect local dictation. `enabled` reflects config; the model only
      // downloads on first use, so state may be 'off' while still available.
      const stt = sttEngine.health();
      const tts = ttsEngine.health();
      return sendJson(res, 200, {
        ok: true, version: VERSION, backend: cfg.backend, tier: cfg.redaction.tier,
        // `runtime` = 'native' (npm, fast quantized) | 'wasm' (binary, slow fp32) —
        // the extension uses it to advise the far-faster native gateway.
        stt: { enabled: cfg.stt?.enabled !== false, state: stt.state, ready: stt.ok, model: stt.model || cfg.stt?.model || DEFAULT_STT_MODEL, runtime: stt.runtime, dtype: stt.dtype },
        // `tts` is ADDITIVE the same way: an older extension ignores it, a newer
        // one uses it to offer local read-aloud instead of browser speech.
        tts: { enabled: cfg.tts?.enabled !== false, state: tts.state, ready: tts.ok, model: tts.model || cfg.tts?.model || DEFAULT_TTS_MODEL, voice: cfg.tts?.voice || DEFAULT_TTS_VOICE, runtime: tts.runtime, dtype: tts.dtype },
      });
    }

    // --- Config API (the extension's "Gateway" tab is a client of these) ---
    if (pathname === '/status' && req.method === 'GET') {
      maybeRevalidate(cfg); // throttled, fire-and-forget: reflect a refund/revoke quickly
      const proUnlocked = await resolvePro(cfg.pro?.entitlementToken);
      const health = await probeNerHealth(cfg); // live GET /health on the detector
      return sendJson(res, 200, {
        ok: true, version: VERSION, backend: cfg.backend, tier: cfg.redaction.tier,
        ner: {
          autostart: !!cfg.ner?.autostart,
          configured: health.configured,
          ready: health.ok,            // the detector actually answered /health
          model: health.model,         // e.g. "en_core_web_sm"
          url: health.url,
        },
        pro: { unlocked: proUnlocked }, usage: usage(cfg),
        uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      });
    }
    // --- WARM search tier. The extension pushes its DECRYPTED records to this LOCAL
    // process (on-device, loopback- + origin-gated above) which holds a BM25 index off
    // the browser thread and answers full-corpus search — for the panel AND other local
    // tools. Ranks identically to the browser hot tier (shared tokenizer/BM25).
    //   POST /v1/history/ingest  { upserts:[{id,text,title,type,date}], removes:[id] } → { size }
    //   POST /v1/history/search  { query, limit } → { results }
    //   GET  /v1/history/status  → { size }
    //   GET  /v1/history/list?limit&offset → { total, items:[{id,title,type,date,chars}] }
    //   GET  /v1/history/get?id=… → { record:{id,title,type,date,text} }  (for external UIs)
    if (pathname === '/v1/history/ingest' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')) || {};
        const size = historyStore.bulk({
          upserts: Array.isArray(body.upserts) ? body.upserts : [],
          removes: Array.isArray(body.removes) ? body.removes : [],
        });
        return sendJson(res, 200, { ok: true, size });
      } catch (e) {
        return sendJson(res, 400, { error: { message: `ingest failed: ${e.message}`, type: 'ingest_error' } });
      }
    }
    // --- MEMORY. Small, durable facts about the user, reachable by every local agent.
    //   GET  /v1/memory/list                      → { memories }
    //   POST /v1/memory/recall  { text, scopes }  → { memories, block }
    //   POST /v1/memory/remember { text, kind, … }→ { action, record }
    //   POST /v1/memory/forget  { query }         → { removed }
    //   POST /v1/memory/sync    { upserts, removes } → { size, merged, memories }
    if (pathname === '/v1/memory/list' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, size: memoryStore.size, memories: memoryStore.list() });
    }
    if (pathname === '/v1/memory/recall' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')) || {};
        const got = memoryStore.recall({
          text: String(body.text || ''),
          scopes: Array.isArray(body.scopes) && body.scopes.length ? body.scopes.map(String) : ['global'],
          limit: Number(body.limit) || 0,
          maxChars: Number(body.maxChars) || 0,
        });
        return sendJson(res, 200, { ok: true, size: memoryStore.size, ...got });
      } catch (e) {
        return sendJson(res, 400, { error: { message: `recall failed: ${e.message}`, type: 'memory_error' } });
      }
    }
    if (pathname === '/v1/memory/remember' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')) || {};
        const out = memoryStore.remember({
          text: String(body.text || ''),
          kind: body.kind ? String(body.kind) : 'fact',
          scope: body.scope ? String(body.scope) : 'global',
          tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
          // WHO PROPOSED IT, always recorded. There is no confirm dialog on a CLI, so
          // attribution plus an inspectable list in the extension IS the accountability —
          // see the MCP server's note on why writes are allowed but never anonymous.
          source: {
            via: String(body.source?.via || 'mcp'),
            surface: String(body.source?.surface || 'mcp'),
            agent: String(body.source?.agent || ''),
            ref: String(body.source?.ref || ''),
          },
        });
        return sendJson(res, 200, { ok: true, action: out.action, record: out.record, replaced: out.replaces || null, size: memoryStore.size });
      } catch (e) {
        return sendJson(res, 400, { error: { message: e.message, type: 'memory_error' } });
      }
    }
    if (pathname === '/v1/memory/forget' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')) || {};
        const { removed } = memoryStore.forget(String(body.query || ''));
        return sendJson(res, 200, { ok: true, removed, size: memoryStore.size });
      } catch (e) {
        return sendJson(res, 400, { error: { message: e.message, type: 'memory_error' } });
      }
    }
    if (pathname === '/v1/memory/sync' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')) || {};
        const out = memoryStore.bulk({
          upserts: Array.isArray(body.upserts) ? body.upserts : [],
          removes: Array.isArray(body.removes) ? body.removes : [],
        });
        // The full set comes BACK, so one round trip is the whole two-way merge: the client
        // pushes what it has and receives what the agents wrote. Convergent because both
        // sides reconcile with the same function.
        return sendJson(res, 200, { ok: true, ...out, memories: memoryStore.list() });
      } catch (e) {
        return sendJson(res, 400, { error: { message: `memory sync failed: ${e.message}`, type: 'memory_error' } });
      }
    }
    if (pathname === '/v1/memory/clear' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, dropped: memoryStore.clear(), size: memoryStore.size });
    }

    if (pathname === '/v1/history/clear' && req.method === 'POST') {
      const dropped = historyStore.clear();
      return sendJson(res, 200, { ok: true, dropped, size: historyStore.size });
    }
    if (pathname === '/v1/history/search' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')) || {};
        const results = historyStore.search(String(body.query || ''), {
          limit: Number(body.limit) || 10,
          offset: Math.max(0, Number(body.offset) || 0),
          type: body.type ? String(body.type) : null,
          since: body.since != null ? Number(body.since) : null,
          before: body.before != null ? Number(body.before) : null,
        });
        return sendJson(res, 200, { ok: true, size: historyStore.size, newest: historyStore.newest, results });
      } catch (e) {
        return sendJson(res, 400, { error: { message: `search failed: ${e.message}`, type: 'search_error' } });
      }
    }
    // SMART SEARCH — one round trip that expands the question into several complementary
    // queries, runs them all, and RRF-fuses the results. A natural-language question is a
    // poor BM25 query; asking three ways and fusing beats asking once, and doing it here
    // means the agent pays one call instead of probing repeatedly.
    if (pathname === '/v1/history/smart-search' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')) || {};
        const question = String(body.question || body.query || '');
        // The agent's own formulations lead (it understands the domain); planQueries adds
        // deterministic variants and dedupes.
        const queries = planQueries(question, {
          extra: Array.isArray(body.queries) ? body.queries.map(String) : [],
          max: Math.min(6, Math.max(1, Number(body.maxQueries) || 4)),
        });
        const filters = {
          type: body.type ? String(body.type) : null,
          since: body.since != null ? Number(body.since) : null,
          before: body.before != null ? Number(body.before) : null,
        };
        const perQuery = Math.min(30, Math.max(5, Number(body.limit) || 10) * 2);
        const fused = await multiSearch(
          queries,
          (q) => historyStore.search(q, { limit: perQuery, ...filters }),
          { limit: Math.min(50, Math.max(1, Number(body.limit) || 10)) },
        );
        // BRIEFS LEAD. A brief is the compaction: when one matches, it answers with what a
        // dozen records say, with a citation to each, and reading it saves an agent opening
        // the dozen. Stable-partitioned to the front rather than re-scored, so rank among
        // briefs and rank among records are both untouched — and only when the caller has
        // not asked for one type, which is a question about records, not about briefs.
        const results = filters.type
          ? fused
          : [...fused.filter((r) => r.type === 'brief'), ...fused.filter((r) => r.type !== 'brief')];
        return sendJson(res, 200, {
          ok: true, size: historyStore.size, newest: historyStore.newest, queries, results,
        });
      } catch (e) {
        return sendJson(res, 400, { error: { message: `smart search failed: ${e.message}`, type: 'search_error' } });
      }
    }
    // Graph navigation — records most connected to a given one.
    if (pathname === '/v1/history/related' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || '');
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 5));
      return sendJson(res, 200, { ok: true, results: historyStore.related(id, { limit }) });
    }
    if (pathname === '/v1/history/status' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, size: historyStore.size, newest: historyStore.newest, bytes: historyStore.bytes });
    }

    // OBSERVABILITY (admin-gated above).
    //   GET  /v1/observability            → { storage:{warm:{records,bytes,newest}}, access:[…] }
    //   POST /v1/observability/access     ← the MCP process reports one tool call
    if (pathname === '/v1/observability' && req.method === 'GET') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      return sendJson(res, 200, {
        ok: true,
        storage: { warm: { records: historyStore.size, bytes: historyStore.bytes, newest: historyStore.newest } },
        access: accessLog.snapshot(limit),
      });
    }
    if (pathname === '/v1/observability/access' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')) || {};
        const evt = accessLog.push(makeAccessEvent({ ts: Date.now(), ...body }));
        return sendJson(res, 200, { ok: true, event: evt });
      } catch (e) {
        return sendJson(res, 400, { error: { message: `access log failed: ${e.message}`, type: 'observability_error' } });
      }
    }
    if (pathname === '/v1/history/list' && req.method === 'GET') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const type = url.searchParams.get('type') || null;
      return sendJson(res, 200, { ok: true, ...historyStore.list({ limit, offset, type }) });
    }
    if (pathname === '/v1/history/get' && req.method === 'GET') {
      const maxChars = url.searchParams.get('maxChars') != null ? Math.max(1, Number(url.searchParams.get('maxChars')) || 0) : null;
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const record = historyStore.get(String(url.searchParams.get('id') || ''), { maxChars, offset });
      if (!record) return sendJson(res, 404, { error: { message: 'no such record', type: 'not_found' } });
      return sendJson(res, 200, { ok: true, record });
    }
    // Key-handoff (loopback only): store the user's backup passphrase so the gateway
    // can decrypt their daily backups unattended. Encrypted at rest with the local
    // key. { passphrase } → stores it and does one immediate ingest. { passphrase:'' }
    // forgets it. GET → whether a key is held (never returns the key itself).
    if (pathname === '/v1/history/key' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, hasKey: hasBackupSecret() });
    }
    if (pathname === '/v1/history/key' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')) || {};
        if (body.passphrase) saveBackupSecret(String(body.passphrase)); else clearBackupSecret();
        const result = body.passphrase ? await ingestBackups(historyStore, String(body.passphrase)) : { ok: true, ingested: 0 };
        return sendJson(res, 200, { ok: true, hasKey: !!body.passphrase, ...result });
      } catch (e) {
        return sendJson(res, 400, { error: { message: `key handoff failed: ${e.message}`, type: 'key_error' } });
      }
    }
    // Trigger an encrypted archive refresh now using the stored key. Every rotating
    // weekday snapshot that matches the key contributes records; newest values win.
    if (pathname === '/v1/history/ingest-backup' && req.method === 'POST') {
      try {
        const result = await ingestBackups(historyStore, loadBackupSecret());
        return sendJson(res, result.ok ? 200 : 409, result);
      } catch (e) {
        return sendJson(res, 400, { error: { message: `backup ingest failed: ${e.message}`, type: 'ingest_error' } });
      }
    }

    // The detector, on the gateway's own port (no second port). GET → health;
    // POST {text} → {entities}. The bundled engine runs IN-PROCESS; a user's own
    // external detector (if configured) is proxied for back-compat.
    if (pathname === '/ner') {
      if (req.method === 'GET') {
        const health = await probeNerHealth(cfg);
        return sendJson(res, health.ok ? 200 : 503, health);
      }
      if (req.method === 'POST') {
        // In-process engine path.
        if (nerEngine.state() !== 'off') {
          try {
            const body = await readBody(req, cfg.maxBodyBytes);
            let text = '';
            try { text = JSON.parse(body.toString('utf8'))?.text || ''; } catch { /* empty */ }
            const entities = await nerEngine.detect(text);
            return sendJson(res, 200, { entities });
          } catch (e) {
            return sendJson(res, 500, { error: { message: `NER error: ${e.message}`, type: 'ner_error' } });
          }
        }
        // External detector proxy (user-configured endpoint).
        const url = nerBaseUrl(cfg);
        if (!url) return sendJson(res, 503, { error: { message: 'NER not configured — deterministic-only redaction', type: 'ner_off' } });
        try {
          const body = await readBody(req, cfg.maxBodyBytes);
          // secureFetch: scheme/host policy + resolved-IP check before POSTing raw text to the detector.
          const r = await secureFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
          const text = await r.text();
          res.writeHead(r.status, { 'content-type': 'application/json' });
          return res.end(text);
        } catch (e) {
          return sendJson(res, 502, { error: { message: `NER unreachable: ${e.message}`, type: 'ner_unreachable' } });
        }
      }
    }
    // WHAT THE MODEL WOULD RECEIVE. A client asks "if I sent this, what leaves the
    // machine?" and gets back the redacted text plus the token→type map.
    //
    // WHY THIS IS A GATEWAY ROUTE AND NOT A CLIENT FUNCTION. A preview computed in the
    // client is a SECOND redactor, and the day the two disagree the client is confidently
    // showing the user something other than what was sent — which is worse than showing
    // nothing, because it is believed. This runs the SAME redactSegments over the SAME
    // config, tier, dictionary and detector as a real request, so it cannot drift: if the
    // preview is wrong, the redaction is wrong too, and that is one bug rather than two.
    //
    // Real values NEVER appear in the response. The mapping is token→type only ('types'),
    // never the 'values' detail an operator can opt into for their own logs: this answer
    // crosses a process boundary to a UI, and the client already has the original text.
    // The vault is discarded when this returns, so these tokens are not reusable.
    if (pathname === '/redact' && req.method === 'POST') {
      let text = '';
      try { text = String(JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8'))?.text || ''); }
      catch { text = ''; }
      if (!text) return sendJson(res, 200, { text: '', count: 0, sanitized: 0, entities: [] });
      try {
        let out = text;
        const isPro = await resolvePro(cfg.pro?.entitlementToken);
        const r = await redactSegments(
          [segment(() => out, (v) => { out = v; })],
          cfg.redaction,
          { isPro },
        );
        return sendJson(res, 200, {
          text: out,
          count: r.count || 0,
          sanitized: r.sanitized || 0,
          tier: cfg.redaction?.tier === 'full' ? 'full' : 'basic',
          entities: redactionDetail(r.vault, 'types') || [],
        });
      } catch (e) {
        // Fail LOUD. A preview that silently returns the original text would tell the user
        // "nothing here is sensitive" at the exact moment redaction is broken.
        return sendJson(res, 500, { error: { message: `redaction preview failed: ${e.message}`, type: 'redact_error' } });
      }
    }

    // Model manager (the extension's Gateway settings drive these). GET lists the
    // catalog with install state + live download progress; POST switches the active
    // model (downloading it first if needed) and persists the choice.
    if (pathname === '/ner/models') {
      if (req.method === 'GET') {
        const active = nerEngine.health().model || cfg.ner?.model || null;
        const available = /** @type {any[]} */ (MODEL_CATALOG.map((m) => ({ ...m, installed: nerEngine.modelOnDisk(m.id) })));
        // Surface an active BYO (non-catalog) model so the UI shows it too.
        if (active && !available.some((m) => m.id === active)) {
          available.push({ id: active, label: active, lang: '—', custom: true, installed: nerEngine.modelOnDisk(active), note: 'Custom model (from Hugging Face).' });
        }
        return sendJson(res, 200, {
          active,
          state: nerEngine.state(),
          progress: nerEngine.progress(),
          available,
        });
      }
      if (req.method === 'POST') {
        let body = null;
        try { body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')); } catch { body = null; }
        const id = body && typeof body.id === 'string' ? body.id.trim() : null;
        // Curated catalog OR a strictly-validated BYO id (org/name, from HF).
        if (!id || !(isKnownModel(id) || isValidCustomModelId(id))) return sendJson(res, 400, { error: { message: 'unknown or invalid model id', type: 'bad_model' } });
        // Persist first so a restart keeps the choice, then (re)load. Don't block the
        // response on a possibly-long download — the client polls GET for progress.
        applyNerModelSelection(cfg, id);
        try { persistConfig(cfg, configPath()); } catch { /* best effort */ }
        nerEngine.setModel(id, { onLog: (m) => console.log(m) }).then((ok) => {
          if (ok && cfg.ner?.enableFullTier && cfg.redaction.tier !== 'full') cfg.redaction.tier = 'full';
        });
        return sendJson(res, 202, { accepted: true, active: id, state: nerEngine.state(), progress: nerEngine.progress() });
      }
    }
    // --- Local speech-to-text (dictation). Whisper runs IN-PROCESS (stt-engine.js,
    // same ONNX engine + model dir as NER); audio arrives as 16 kHz mono Float32 PCM
    // chunks over loopback and ONLY TEXT ever leaves this process. Wire contract
    // (additive; see docs in the hub repo):
    //   POST   /stt/sessions               {lang?} → 201 { id }   (ensures the model)
    //   POST   /stt/sessions/:id/audio     binary Float32 PCM chunk → { ok }
    //   GET    /stt/sessions/:id/events    SSE: progress | interim | final | error | end
    //   DELETE /stt/sessions/:id           flush tail → { ok }
    //   GET/POST /stt/models               catalog + progress / switch (mirrors /ner/models)
    if (pathname === '/stt/models') {
      if (req.method === 'GET') {
        const active = sttEngine.health().model || cfg.stt?.model || DEFAULT_STT_MODEL;
        const available = /** @type {any[]} */ (STT_MODEL_CATALOG.map((m) => ({ ...m, installed: sttEngine.modelOnDisk(m.id) })));
        // Surface an active CUSTOM (non-catalog) model so the UI can show it too.
        if (active && !available.some((m) => m.id === active)) {
          available.push({ id: active, label: active, lang: '—', tier: 'custom', custom: true, installed: sttEngine.modelOnDisk(active), note: 'Custom model (from Hugging Face).' });
        }
        return sendJson(res, 200, {
          active,
          state: sttEngine.state(),
          progress: sttEngine.progress(),
          available,
          // Precision (quantization) picker: current choice + selectable options +
          // the dtype actually loaded. On WASM only fp32 loads (see runtimeDtype).
          dtype: cfg.stt?.dtype || 'auto',
          loadedDtype: sttEngine.health().dtype,
          runtime: sttEngine.health().runtime,
          dtypes: STT_DTYPES,
        });
      }
      if (req.method === 'POST') {
        let body = null;
        try { body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')); } catch { body = null; }
        const id = body && typeof body.id === 'string' ? body.id.trim() : null;
        // Curated catalog OR a strictly-validated custom whisper id (Advanced).
        if (!id || !(isKnownSttModel(id) || isValidCustomSttId(id))) return sendJson(res, 400, { error: { message: 'unknown or invalid model id', type: 'bad_model' } });
        // Optional precision override (q8/q4/fp16/…); 'auto' clears it.
        const dtype = typeof body.dtype === 'string' && isValidDtype(body.dtype) ? body.dtype : undefined;
        if (cfg.stt) cfg.stt.model = id; else cfg.stt = { enabled: true, model: id, allowDownload: true };
        if (dtype) cfg.stt.dtype = dtype === 'auto' ? null : dtype;
        try { persistConfig(cfg, configPath()); } catch { /* best effort */ }
        sttEngine.setModel(id, { onLog: (m) => console.log(m), dtype: dtype || cfg.stt.dtype || 'auto' });
        return sendJson(res, 202, { accepted: true, active: id, dtype: cfg.stt.dtype || 'auto', state: sttEngine.state(), progress: sttEngine.progress() });
      }
    }
    // Speaker (diarization) model manager — the "who said what" x-vector model.
    // GET → status + install state; POST → force-download it (ignores the
    // allowDownload config flag; explicit user action from the Gateway tab).
    if (pathname === '/diarize/model') {
      if (req.method === 'GET') {
        const h = diarizeEngine.health();
        return sendJson(res, 200, {
          active: diarizeEngine.DIARIZE_MODEL,
          state: h.state,
          progress: diarizeEngine.progress(),
          available: [{ id: diarizeEngine.DIARIZE_MODEL, label: 'Speaker embeddings (wavlm)', lang: 'any', approxMB: 100, note: 'Tells voices apart for meeting transcription (who said what).', installed: diarizeEngine.modelOnDisk() }],
        });
      }
      if (req.method === 'POST') {
        diarizeEngine.download({ onLog: (m) => console.log(m) });
        return sendJson(res, 202, { accepted: true, active: diarizeEngine.DIARIZE_MODEL, state: diarizeEngine.state(), progress: diarizeEngine.progress() });
      }
    }
    // --- Local text-to-speech (voice out). Kokoro runs IN-PROCESS (tts-engine.js),
    // so audio is synthesized on this machine and never leaves it. Phase 4 of
    // docs/voice-pipeline.md. Model manager first, then synthesis.
    if (pathname === '/tts/models') {
      if (req.method === 'GET') {
        const active = ttsEngine.health().model || cfg.tts?.model || resolveDefaultModel(rawOrtAvailable());
        // A model needing the native runtime is still LISTED on the binary, with the
        // reason — hiding it makes "why can't I clone my voice?" unanswerable.
        const nativeOk = rawOrtAvailable();
        const available = /** @type {any[]} */ (TTS_MODEL_CATALOG.map((m) => ({
          ...m,
          installed: ttsEngine.modelOnDisk(m.id),
          unavailable: m.requiresNative && !nativeOk
            ? 'needs the npm gateway — the standalone binary cannot load this engine'
            : undefined,
        })));
        if (active && !available.some((m) => m.id === active)) {
          available.push({ id: active, label: active, lang: '—', tier: 'custom', custom: true, installed: ttsEngine.modelOnDisk(active), note: 'Custom model (from Hugging Face).' });
        }
        return sendJson(res, 200, {
          active,
          state: ttsEngine.state(),
          progress: ttsEngine.progress(),
          available,
          // The default voice belongs to the model's own namespace: Kokoro's
          // af_heart means nothing to Pocket, and vice versa.
          voice: cfg.tts?.voice || (ttsModelEngineOf(active) === 'pocket-tts' ? DEFAULT_POCKET_VOICE : DEFAULT_TTS_VOICE),
          // Architecture decides whether voices mean anything: Kokoro picks one from
          // a style bank, VITS/MMS is single-speaker. An empty list tells the UI to
          // hide the picker rather than offer choices that cannot take effect.
          arch: ttsEngine.arch(),
          supportsVoices: ttsEngine.supportsVoices(),
          supportsCustomVoices: ttsEngine.supportsCustomVoices(),
          sampleRate: ttsEngine.sampleRate(),
          // Built-in voices belong to Kokoro alone. VITS is single-speaker and
          // SpeechT5 speaks only in a RECORDED voice, so offering Kokoro's list
          // for either would be offering choices that cannot take effect.
          voices: (ttsEngine.isPocket() || (!ttsEngine.arch() && ttsModelEngineOf(active) === 'pocket-tts'))
            // Pocket ships eight speakers in an optional 52 MB file; report what is
            // actually loaded rather than the catalog's aspiration.
            ? (ttsEngine.builtinVoices().length ? ttsEngine.builtinVoices() : POCKET_VOICES)
              .map((n) => ({ id: n, label: n[0].toUpperCase() + n.slice(1), lang: 'en', installed: ttsEngine.builtinVoices().includes(n) }))
            : ttsEngine.arch() && ttsEngine.arch() !== 'style-tts2'
              ? []
              : TTS_VOICES.map((v) => ({ ...v, installed: ttsEngine.voiceOnDisk(v.id, active) })),
          dtype: cfg.tts?.dtype || 'auto',
          loadedDtype: ttsEngine.health().dtype,
          runtime: ttsEngine.health().runtime,
          dtypes: TTS_DTYPES,
        });
      }
      if (req.method === 'POST') {
        let body = null;
        try { body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')); } catch { body = null; }
        const id = body && typeof body.id === 'string' ? body.id.trim() : null;
        if (id && !(isKnownTtsModel(id) || isValidCustomTtsId(id))) return sendJson(res, 400, { error: { message: 'unknown or invalid model id', type: 'bad_model' } });
        // A voice id becomes a filename, so it is checked against the catalog AND
        // its shape before it is ever persisted.
        // A default voice may be a built-in Kokoro one OR a saved custom one; both
        // live in the same field, so both shapes are accepted and both validated.
        const voice = body && typeof body.voice === 'string' ? body.voice.trim() : null;
        if (voice) {
          const cid = ttsVoices.parseCustomVoice(voice);
          const okVoice = cid ? !!ttsVoices.getVoice(cid) : (isPocketVoice(voice) || (isKnownVoice(voice) && isValidVoiceId(voice)));
          if (!okVoice) return sendJson(res, 400, { error: { message: 'unknown or invalid voice', type: 'bad_voice' } });
        }
        const dtype = body && typeof body.dtype === 'string' && isValidTtsDtype(body.dtype) ? body.dtype : undefined;
        if (!cfg.tts) cfg.tts = { enabled: true, model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE, allowDownload: true };
        if (id) cfg.tts.model = id;
        if (voice) cfg.tts.voice = voice;
        // Switching model must revalidate the voice, or the config ends up naming a
        // Kokoro voice for SpeechT5 (which then has nothing to speak in) or a
        // recorded voice for Kokoro (which cannot use one). Both states look like
        // "text-to-speech is broken" from the outside, and both are reachable with
        // two clicks. Only rewrite when the CURRENT voice cannot work for the new
        // model — never override a voice the caller just set.
        if (id && !voice) {
          const wantsCustom = ttsModelHasCustomVoices(id);
          // "Is it a custom voice" is not enough — it must be one that still
          // EXISTS. A config naming a deleted voice is exactly the state that made
          // every later request fail with "no such saved voice".
          const curId = ttsVoices.parseCustomVoice(cfg.tts.voice || '');
          const isCustom = !!(curId && ttsVoices.getVoice(curId));
          if (wantsCustom && !isCustom) {
            // Switching to a cloning model does not mean "start speaking as the user".
            // A model with built-in speakers gets its default speaker; only SpeechT5,
            // which has no built-ins, falls back to a saved voice.
            if (ttsModelEngineOf(id) === 'pocket-tts') {
              cfg.tts.voice = DEFAULT_POCKET_VOICE;
            } else {
              const saved = ttsVoices.listVoices();
              cfg.tts.voice = saved.length ? `custom:${saved[0].id}` : '';
            }
          } else if (!wantsCustom && isCustom) {
            cfg.tts.voice = DEFAULT_TTS_VOICE;
          }
          // Kokoro and Pocket name their speakers differently; carrying one over
          // leaves a voice the new model has never heard of.
          const toPocket = ttsModelEngineOf(id) === 'pocket-tts';
          if (toPocket && !ttsVoices.parseCustomVoice(cfg.tts.voice || '') && !isPocketVoice(cfg.tts.voice)) cfg.tts.voice = DEFAULT_POCKET_VOICE;
          if (!toPocket && isPocketVoice(cfg.tts.voice)) cfg.tts.voice = DEFAULT_TTS_VOICE;
        }
        if (dtype) cfg.tts.dtype = dtype === 'auto' ? null : dtype;
        try { persistConfig(cfg, configPath()); } catch { /* best effort */ }
        if (id) ttsEngine.setModel(id, { onLog: (m) => console.log(m), dtype: dtype || cfg.tts.dtype || 'auto' });
        return sendJson(res, 202, { accepted: true, active: cfg.tts.model, voice: cfg.tts.voice, dtype: cfg.tts.dtype || 'auto', state: ttsEngine.state(), progress: ttsEngine.progress() });
      }
    }

    // --- Custom voices: a speaker embedding derived from a sample the user
    // recorded. The AUDIO is embedded in-process and then discarded; only the 512
    // floats are stored, under ~/.chatpanel, and they never leave this machine.
    // See src/tts-voices.js for why the rules here are tighter than elsewhere.
    if (pathname === '/tts/voices') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          voices: ttsVoices.listVoices(),
          // Whether a saved voice can actually be USED right now depends on the
          // active model — only SpeechT5 takes an embedding. Saying so here stops
          // the UI offering voices that would be silently ignored.
          usable: ttsEngine.supportsCustomVoices(),
          embedder: diarizeEngine.DIARIZE_MODEL,
          embedderReady: diarizeEngine.isReady(),
        });
      }
      if (req.method === 'POST') {
        let body = null;
        try { body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')); } catch { body = null; }
        const name = body && typeof body.name === 'string' ? body.name.trim() : '';
        const pcm = body && Array.isArray(body.pcm) ? body.pcm : null;
        // An `id` means UPDATE an existing voice rather than create one. The id is
        // preserved either way, because `custom:<id>` is what the config and every
        // client hold — a rename or a re-record must not orphan those.
        const editId = body && typeof body.id === 'string' ? body.id.trim() : '';
        if (editId) {
          if (!ttsVoices.getVoice(editId)) return sendJson(res, 404, { error: { message: 'no such saved voice', type: 'bad_voice' } });
          // Rename only — no new audio, so the prints are left exactly as they are.
          if (!pcm) {
            if (!name) return sendJson(res, 400, { error: { message: 'a name is required', type: 'bad_request' } });
            try {
              return sendJson(res, 200, { ...ttsVoices.renameVoice(editId, name), usable: ttsEngine.supportsCustomVoices() });
            } catch (e) { return sendJson(res, 400, { error: { message: e.message, type: 'rename_failed' } }); }
          }
          // Re-record: same rules as a fresh take, then swap the prints in place.
          if (pcm.length < 16000) {
            return sendJson(res, 400, { error: { message: 'need at least 1 second of 16 kHz mono audio', type: 'sample_too_short' } });
          }
        } else if (!name) {
          return sendJson(res, 400, { error: { message: 'a name is required', type: 'bad_request' } });
        }
        if (!pcm || pcm.length < 16000) {
          // Under a second of audio produces an embedding dominated by whatever
          // noise happened to be in it, and the resulting voice is arbitrary.
          return sendJson(res, 400, { error: { message: 'need at least 1 second of 16 kHz mono audio', type: 'sample_too_short' } });
        }
        try {
          // The embedder is the speaker model diarization already uses. WAIT for it
          // rather than bailing: it is usually already on disk, where loading takes
          // a couple of seconds — and the caller is holding a recording someone
          // just made, so returning early means they lose it and record again.
          // Only a genuine first-time download can outlast the ceiling, and that is
          // the one case worth reporting as "come back in a moment".
          if (!diarizeEngine.isReady()) {
            const load = diarizeEngine.download({ onLog: (m) => console.log(m) });
            const timedOut = Symbol('timeout');
            const raced = await Promise.race([
              load.then(() => null).catch((e) => e),
              new Promise((r) => setTimeout(() => r(timedOut), EMBEDDER_WAIT_MS)),
            ]);
            if (raced === timedOut || !diarizeEngine.isReady()) {
              return sendJson(res, 503, {
                error: {
                  message: raced === timedOut
                    ? 'the speaker model is still downloading (~100 MB) — your recording was kept, press Save again shortly'
                    : `the speaker model failed to load: ${diarizeEngine.health().error || 'unknown error'}`,
                  type: 'embedder_not_ready',
                },
                progress: diarizeEngine.progress(),
              });
            }
          }
          const audio = Float32Array.from(pcm);
          const vec = await diarizeEngine.embed(audio);

          // A voice print is engine-specific and the SAMPLE is about to be thrown
          // away, so anything this voice might later need must be derived now.
          // Pocket TTS is the engine that actually reproduces a speaker, so its
          // conditioning is computed whenever its bundle is present — failing that
          // is not fatal, it just means this voice works only with SpeechT5.
          let pocket = null;
          try {
            const pt = await ttsEngine.pocketForEncoding({ allowDownload: cfg.tts?.allowDownload !== false, log: (m) => console.log(m) });
            // The recorder sends 16 kHz; Mimi wants 24 kHz.
            if (pt) pocket = await pt.encodeVoice(resample(audio, 16000, 24000));
          } catch (e) {
            console.log(`[tts] pocket conditioning unavailable for this voice (${e.message})`);
          }

          const saved = editId
            ? ttsVoices.replaceVoice(editId, { vec, pocket })
            : ttsVoices.saveVoice({ name, vec, pocket });
          // A rename may ride along with a re-record, so apply it after the swap.
          const final = editId && name && name !== saved.name ? ttsVoices.renameVoice(editId, name) : saved;
          console.log(`[tts] ${editId ? 're-recorded' : 'saved'} custom voice "${final.name}" (${(saved.kinds || []).join(' + ')}, sample discarded)`);
          return sendJson(res, editId ? 200 : 201, { ...saved, ...final, usable: ttsEngine.supportsCustomVoices() });
        } catch (e) {
          return sendJson(res, 400, { error: { message: e.message, type: 'save_failed' } });
        }
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') || '';
        // Deleting someone's voice print is not a soft delete — the file is gone.
        const deleted = ttsVoices.deleteVoice(id);
        // …and the config must not keep NAMING it. A stored voice that no longer
        // exists makes every later request fail with "no such saved voice", which
        // is a confusing way to be told "you deleted that one".
        if (deleted && cfg.tts?.voice === `custom:${id}`) {
          const left = ttsVoices.listVoices();
          cfg.tts.voice = left.length ? `custom:${left[0].id}` : DEFAULT_TTS_VOICE;
          try { persistConfig(cfg, configPath()); } catch { /* best effort */ }
        }
        return sendJson(res, 200, { deleted, voice: cfg.tts?.voice });
      }
    }

    // POST /tts — { text, voice?, speed? } → audio/wav — and its OpenAI-compatible
    // twin POST /v1/audio/speech ({ input, voice, speed, response_format }), so any
    // OpenAI client or tunnel can drive local speech with no ChatPanel-specific code.
    // Both go through ONE handler: two routes must never drift into two behaviours.
    //
    // Deliberately NOT redacted. Every other stage in the voice pipeline redacts at
    // the model-send chokepoint because the text is about to leave the machine;
    // synthesis is local, so there is nothing to protect it from — and reading
    // "[[PERSON_1]]" aloud to the person who wrote it is a bug, not privacy.
    if ((pathname === '/tts' || pathname === '/v1/audio/speech') && req.method === 'POST') {
      if (cfg.tts?.enabled === false) return sendJson(res, 503, { error: { message: 'tts is disabled in gateway config', type: 'tts_disabled' } });
      let body = null;
      try { body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')); } catch { body = null; }
      // `input` is OpenAI's field name, `text` is ours — accept either on both routes.
      const text = body && typeof (body.input ?? body.text) === 'string' ? String(body.input ?? body.text).trim() : '';
      if (!text) return sendJson(res, 400, { error: { message: 'text is required', type: 'bad_request' } });
      if (text.length > MAX_TTS_CHARS) return sendJson(res, 413, { error: { message: `text too long (max ${MAX_TTS_CHARS} chars)`, type: 'too_long' } });
      const speed = Number.isFinite(body.speed) ? Math.min(2, Math.max(0.5, body.speed)) : 1;
      const dest = ttsDestination(cfg);
      // A remote destination has its own voice namespace (an ElevenLabs voice id is
      // not a Kokoro one), so the local catalog check would reject every valid id.
      const rawVoice = body && typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : null;
      const voice = rawVoice || (dest ? dest.voice : (cfg.tts?.voice || DEFAULT_TTS_VOICE));
      // A REMOTE destination has its own voice namespace, so it is validated here;
      // local voices cannot be resolved until the model is loaded, because which
      // KIND of voice is valid depends on the architecture. See below.
      if (dest && !isValidRemoteVoice(voice)) {
        return sendJson(res, 400, { error: { message: 'unknown or invalid voice', type: 'bad_voice' } });
      }
      // We synthesize WAV only. Say so rather than returning WAV bytes under an mp3
      // content-type — a client that trusts the header would play noise.
      const fmt = body && typeof body.response_format === 'string' ? body.response_format.toLowerCase() : 'wav';
      if (fmt !== 'wav' && fmt !== 'pcm') return sendJson(res, 400, { error: { message: `unsupported response_format "${fmt}" — this gateway synthesizes wav`, type: 'bad_format' } });
      try {
        // Remote destination: the caller's own auth goes upstream, the text is
        // redacted first unless this destination explicitly opted out, and the
        // vendor's own audio format is passed straight through rather than
        // re-wrapped — we did not synthesize it and must not claim its container.
        if (dest) {
          const { audio, contentType, redacted } = await synthesizeRemote({
            dest, text, voice, speed,
            auth: req.headers.authorization || req.headers['xi-api-key'] || '',
            redaction: cfg.redaction,
            isPro: await resolvePro(cfg.pro?.entitlementToken),
          });
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': String(audio.length),
            'Cache-Control': 'no-store',
            // Say what actually left. A caller that asked for privacy can verify it,
            // and one that turned it off can see that it is off.
            'X-Tts-Provider': dest.kind,
            'X-Tts-Redacted': String(redacted),
          });
          return res.end(audio);
        }
        const ok = await ttsEngine.ready({
          onLog: (m) => console.log(m),
          allowDownload: cfg.tts?.allowDownload !== false,
          model: cfg.tts?.model || resolveDefaultModel(rawOrtAvailable()),
          dtype: cfg.tts?.dtype || 'auto',
        });
        if (!ok) return sendJson(res, 503, { error: { message: ttsEngine.health().error || 'tts model not ready', type: 'tts_unavailable' } });
        // Voices are resolved AFTER the model is up, because what counts as a valid
        // voice is a property of the architecture: Kokoro takes a style-bank name,
        // SpeechT5 takes a recorded embedding, VITS takes neither. Resolving first
        // meant a `custom:` voice could reach a freshly-loaded Kokoro and fail deep
        // in the engine with "invalid voice id".
        const picked = resolveTtsVoice({
          requested: rawVoice, configured: voice, engine: ttsEngine, voices: ttsVoices,
          isPocketVoice, isKnownVoice, isValidVoiceId,
          defaultVoice: DEFAULT_TTS_VOICE, defaultPocketVoice: DEFAULT_POCKET_VOICE,
        });
        if (!picked.ok) return sendJson(res, picked.status, { error: { message: picked.message, type: picked.type } });
        const { voice: useVoice, customId, speakerEmbedding } = picked;

        const pcm = await ttsEngine.synth(text, { voice: useVoice, speed, speakerEmbedding });
        // The ACTIVE model's rate, not the constant: a VITS/MMS model emits 16 kHz
        // and writing it into a 24 kHz header plays it fast and chipmunked.
        const rate = ttsEngine.sampleRate();
        const out = fmt === 'pcm' ? Buffer.from(new Float32Array(pcm).buffer) : ttsEngine.toWav(pcm, rate);
        res.writeHead(200, {
          'Content-Type': fmt === 'pcm' ? 'application/octet-stream' : 'audio/wav',
          'Content-Length': String(out.length),
          'Cache-Control': 'no-store',
          'X-Tts-Sample-Rate': String(rate),
          // Say which voice actually spoke, so a caller (or a person debugging one)
          // can check the setting took. Single-speaker models have nothing to say.
          ...(customId || ttsEngine.isPocket() || ttsEngine.supportsVoices() ? { 'X-Tts-Voice': useVoice } : {}),
        });
        return res.end(out);
      } catch (e) {
        return sendJson(res, 500, { error: { message: e.message, type: 'tts_failed' } });
      }
    }

    if (pathname === '/stt/sessions' && req.method === 'POST') {
      if (cfg.stt?.enabled === false) return sendJson(res, 403, { error: { message: 'STT disabled in gateway config', type: 'stt_disabled' } });
      let body = null;
      try { body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8') || '{}'); } catch { body = null; }
      // Kick the model load on first use (single-flight; downloads once). The
      // client follows progress on the session's SSE stream.
      if (!sttEngine.isReady()) {
        sttEngine.init({ model: cfg.stt?.model || DEFAULT_STT_MODEL, allowDownload: cfg.stt?.allowDownload !== false, dtype: cfg.stt?.dtype || undefined, onLog: (m) => console.log(m) });
      }
      // Diarization is another OPTIONAL stage: load its model only when a session
      // asks for it (never on the dictation path).
      const wantDiarize = body?.diarize === true && cfg.stt?.diarize !== false;
      if (wantDiarize && !diarizeEngine.isReady()) {
        diarizeEngine.init({ allowDownload: cfg.stt?.allowDownload !== false, onLog: (m) => console.log(m) });
      }
      try {
        // `redact: true` chains the OPTIONAL redaction hop onto finals (STT → NER,
        // same composable model as everything else: any stage, with or without).
        // `diarize: true` (+ optional `speakerLabel` to pin the mic channel to a
        // name) attaches a speaker to each final.
        // `endSilenceMs` (additive) lets a voice conversation wait longer for a
        // sentence to finish than dictation into a text box needs to.
        const { id } = sttEngine.createSession({ lang: body?.lang, redact: body?.redact === true, diarize: wantDiarize, speakerLabel: body?.speakerLabel, endSilenceMs: body?.endSilenceMs });
        return sendJson(res, 201, { id, state: sttEngine.state() });
      } catch (e) {
        return sendJson(res, e.code === 'too_many_sessions' ? 429 : 500, { error: { message: e.message, type: e.code || 'stt_error' } });
      }
    }
    {
      const m = pathname.match(/^\/stt\/sessions\/([0-9a-f-]{36})(\/audio|\/events)?$/);
      if (m) {
        const sid = m[1];
        if (m[2] === '/audio' && req.method === 'POST') {
          try {
            const raw = await readBody(req, cfg.maxBodyBytes);
            sttEngine.pushAudio(sid, sttEngine.toFloat32(raw));
            return sendJson(res, 200, { ok: true, state: sttEngine.state() });
          } catch (e) {
            return sendJson(res, e.code === 'no_session' ? 404 : 400, { error: { message: e.message, type: e.code || 'stt_error' } });
          }
        }
        if (m[2] === '/events' && req.method === 'GET') {
          const sess = sttEngine.getSession(sid);
          if (!sess) return sendJson(res, 404, { error: { message: 'no such session', type: 'no_session' } });
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
          // Optional STT → NER hop: redact FINALS through the same shared guard as
          // chat traffic (one implementation, composed — never a second redactor).
          // Interims stay raw (transient, loopback-only). NOTE: the vault is
          // discarded, so these placeholders are permanent — that's the point.
          const sttIsPro = sess.redact ? await resolvePro(cfg.pro?.entitlementToken) : true;
          const maybeRedact = async (ev) => {
            if (ev.type !== 'final' || !sess.redact) return ev;
            try {
              let t = ev.text;
              await redactSegments([segment(() => t, (v) => { t = v; })], cfg.redaction, { isPro: sttIsPro });
              return { ...ev, text: t };
            } catch { return ev; } // fail-open: raw text is still local-only
          };
          // While the model is loading/downloading, stream progress so the UI can
          // show "downloading 43%" instead of dead air on first-ever dictation.
          send({ type: 'state', state: sttEngine.state() });
          const progressTimer = setInterval(() => {
            const st = sttEngine.state();
            if (st === 'downloading' || st === 'loading') { send({ type: 'progress', state: st, ...(sttEngine.progress() || {}) }); return; }
            if (st === 'error') { send({ type: 'error', code: 'model_failed', message: sttEngine.health().error || 'model failed to load', fatal: true }); clearInterval(progressTimer); return; }
            // STT ready — if diarization is on, surface ITS one-time download too, so
            // "who said what" doesn't silently lag while the speaker model fetches.
            if (sess.diarize) {
              const ds = diarizeEngine.state();
              if (ds === 'downloading' || ds === 'loading') { send({ type: 'diarize-progress', state: ds, ...(diarizeEngine.progress() || {}) }); return; }
            }
            send({ type: 'state', state: st }); clearInterval(progressTimer);
          }, 500);
          progressTimer.unref?.();
          // Redaction is async — chain events so finals can't overtake interims.
          let evChain = Promise.resolve();
          const unsub = sttEngine.subscribe(sid, (ev) => {
            evChain = evChain.then(async () => {
              send(await maybeRedact(ev));
              if (ev.type === 'end') { clearInterval(progressTimer); res.end(); }
            }).catch(() => {});
          });
          req.on('close', () => { clearInterval(progressTimer); unsub?.(); });
          return;
        }
        if (!m[2] && req.method === 'DELETE') {
          await sttEngine.endSession(sid);
          return sendJson(res, 200, { ok: true });
        }
      }
    }
    if (pathname === '/logs' && req.method === 'GET') {
      return sendJson(res, 200, { entries: [...recentRequests].reverse() }); // newest first; counts only, unless logDetail enriches each entry
    }
    if (pathname === '/config' && req.method === 'GET') {
      const proUnlocked = await resolvePro(cfg.pro?.entitlementToken);
      return sendJson(res, 200, publicConfig(cfg, { proUnlocked }));
    }
    if (pathname === '/config' && req.method === 'POST') {
      let patch = null;
      try { patch = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')); } catch { patch = null; }
      if (!patch || typeof patch !== 'object') return sendJson(res, 400, { error: 'invalid config patch' });
      applyConfigPatch(cfg, patch);
      try { persistConfig(cfg, configPath()); } catch (e) { return sendJson(res, 500, { error: `could not persist config: ${e.message}` }); }
      // The bundled NER engine only auto-loads at startup. If the user just switched
      // detection BACK to the bundled engine (or it never loaded because an external
      // detector was configured at boot), load it now so it doesn't stay "not running"
      // until a restart. (An external detector needs no engine.) Fire-and-forget.
      const det = cfg.redaction?.detection;
      const usingBundled = !det || !det.backend || det.backend === 'off';
      const st = nerEngine.state();
      if (cfg.ner?.autostart && usingBundled && st !== 'ready' && st !== 'loading' && st !== 'downloading') {
        nerEngine.setModel(cfg.ner.model, { onLog: (m) => console.log(m) }).then((ok) => {
          if (ok && cfg.ner?.enableFullTier && cfg.redaction.tier !== 'full') cfg.redaction.tier = 'full';
        });
      }
      const proUnlocked = await resolvePro(cfg.pro?.entitlementToken);
      return sendJson(res, 200, publicConfig(cfg, { proUnlocked }));
    }

    // THE SKILLS ON THIS MACHINE, asked of the gateway rather than the bridge.
    //
    // The bridge is what reads the user's disk, so this proxies it — but a client should
    // have ONE address for everything. A client that talks to the gateway for models and the
    // bridge for skills has to know both are up, hold both tokens, and handle two failure
    // modes for one screen; and the direct-to-bridge path is the one with no policy in front
    // of it, so making it necessary for a feature is how it becomes the habit.
    if (req.method === 'GET' && pathname === '/skills') {
      const base = String(cfg.bridge?.url || '').replace(/\/$/, '');
      if (!base) return sendJson(res, 503, { error: { message: 'no bridge is configured', type: 'no_bridge' } });
      const token = readBridgeToken(cfg.bridge?.token);
      try {
        const r = await fetch(`${base}/skills`, {
          headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          signal: AbortSignal.timeout(8000),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return sendJson(res, r.status, { error: { message: data?.error || `bridge ${r.status}`, type: 'bridge_error' } });
        return sendJson(res, 200, { skills: Array.isArray(data?.skills) ? data.skills : [] });
      } catch (e) {
        return sendJson(res, 502, { error: { message: `bridge unreachable: ${e.message}`, type: 'bridge_unreachable' } });
      }
    }

    // Model discovery — aggregate every destination's models.
    if (req.method === 'GET' && /\/models$/.test(pathname)) {
      return sendJson(res, 200, await aggregateModelsAsync(cfg));
    }

    // Anything under a LOCAL namespace that reached here matched no route, which
    // almost always means the caller is newer than this gateway. Falling through to
    // the model proxy makes that arrive as "upstream fetch failed", pointing the
    // user at their model provider for a feature their gateway simply does not
    // have yet — so these 404 with the actual reason instead.
    if (LOCAL_NAMESPACES.some((ns) => pathname === ns || pathname.startsWith(`${ns}/`))) {
      return sendJson(res, 404, {
        error: {
          message: `this gateway (${VERSION}) has no ${pathname} — update it to use this feature`,
          type: 'unknown_endpoint',
        },
      });
    }

    const r = route(pathname, req.headers, cfg);
    let raw;
    try {
      raw = await readBody(req, cfg.maxBodyBytes);
    } catch (e) {
      sendJson(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'payload too large' : 'bad request' });
      req.destroy(); // stop reading an oversized/aborted upload; don't leave the socket half-open
      return;
    }

    // Redact the request body for the known chat endpoints.
    let vault = null;
    let body = null;
    let outBody = raw;
    let redactedCount = 0;
    let sanitizedCount = 0;
    let narrowedTools = 0;
    let isPro = true;
    // Off the hot path: only build a trace when logging is on, so it adds nothing
    // when off (no clock reads, no record, no console line).
    const trace = (cfg.logRequests && r.redactable && req.method === 'POST') ? mkTrace(recordRequest) : null;
    if (r.redactable && req.method === 'POST' && raw.length) {
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
      if (body && isRelayResume(body, r.kind)) {
        // Relay tool-result follow-up: do NOT redact here — the parked session
        // redacts the tool result + restores the reply with ITS vault. Pass raw.
        outBody = raw;
      } else if (body) {
        // Auto-narrow tools to the top-K most relevant for this turn (speed) —
        // same shared ranker as the extension's AUTO mode. Only MCP-named tools
        // are narrowed; the client's core tools (bash/read/edit…) are always kept,
        // unless tools.narrowAll is set. Mutates body.tools BEFORE redaction so
        // both the API forward and the bridge relay see the trimmed set.
        const tcfg = cfg.tools || {};
        if (tcfg.autoNarrow !== false && Array.isArray(body.tools) && body.tools.length) {
          const cap = Number(tcfg.maxPerTurn) > 0 ? Number(tcfg.maxPerTurn) : DEFAULT_GATEWAY_TOOL_CAP;
          const keep = tcfg.narrowAll ? null : (t) => !MCP_NAME_RE.test(toolName(t));
          const before = body.tools.length;
          body.tools = narrowSpecs(body.tools, latestUserText(body, r.kind), { cap, keep, name: toolName, description: toolDesc });
          narrowedTools = before - body.tools.length;
        }
        // Free users get full-tier redaction within a fixed lifetime allowance —
        // checked here, consumed below once a redaction actually happens. Over the
        // cap returns 402.
        isPro = await resolvePro(cfg.pro?.entitlementToken);
        const allow = checkQuota(cfg, isPro);
        if (!allow.allowed) {
          return sendJson(res, 402, { error: {
            message: `ChatPanel Gateway free trial used up (${allow.cap} redactions). Add a ChatPanel Pro entitlement token to unlock unlimited full-tier redaction (names/orgs).`,
            type: 'free_limit_reached',
          } });
        }
        const segs = r.adapter.collectSegments(body, cfg.redaction);
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        const rd0 = trace ? trace.clock() : 0;
        // Redact at the configured tier for everyone (free users get name/org
        // redaction within their allowance); the custom dictionary stays capped for
        // free (isPro decides that inside).
        const { vault: v, count, sanitized } = await redactSegments(segs, cfg.redaction, {
          signal: ac.signal,
          isPro,
          // A detector is the only hop that sees the request BEFORE redaction. It is guarded
          // (SSRF) but was not visible: /v1/observability/access is where a user answers
          // "what left my machine", and this was the one thing missing from it.
          onEgress: (e) => accessLog.push(makeAccessEvent({
            ts: Date.now(),
            client: 'redaction',
            tool: `detect:${e.backend}@${e.host || 'local'}`,
            ok: e.ok,
            ms: e.ms,
            error: e.error,
          })),
        });
        if (trace) trace.lap('redact', rd0);
        vault = v;
        redactedCount = count;
        sanitizedCount = sanitized || 0;
        // Consume one lifetime free credit only when we actually redacted
        // something, then persist. (No-op / no write for Pro.)
        if (!isPro && count > 0) {
          consume(cfg, isPro);
          try { persistConfig(cfg, configPath()); } catch { /* best effort — usage is advisory */ }
        }
        // When tools are armed, tell the model placeholders are auto-restored for
        // tools (so privacy-aware models USE them instead of refusing). Injected
        // AFTER redaction so the note isn't itself redacted. Covers BOTH the API
        // forward and the relay (which reads system from this same body).
        if (Array.isArray(body.tools) && body.tools.length && typeof r.adapter.injectSystemNote === 'function') {
          r.adapter.injectSystemNote(body, placeholderToolNote({ toolData: cfg.tools?.toolData }));
        }
        outBody = Buffer.from(JSON.stringify(body), 'utf8');
      }
    }

    // THE shared tool harness — same one the extension uses. The gateway only needs
    // ② (tool args): restore to real for the client to run, or keep the redacted
    // token for remote MCP tools when tools.toolData is "redactRemote". Results are
    // re-redacted by the NEXT request's normal redaction, so ③ isn't needed here.
    const harness = makeToolHarness({ vault, toolData: cfg.tools?.toolData });

    // Route by the requested model → a destination (agent via the bridge, or an
    // API we forward to). Falls back to the legacy backend when none configured.
    // ChatPanel's own routing envelope, never the provider's business. A caller that knows
    // WHICH destination it means says so here instead of hoping a model id is unique — 39 ids
    // on a three-provider machine already collide once you ignore case, and two providers
    // offering the same id exactly is ordinary. Without this, `dests.find(...)` picks whichever
    // destination happens to come first and the call goes out on the wrong provider's key.
    // ChatPanel's routing metadata travels in HEADERS, not in the request body.
    //
    // It started as a `chatpanel` field on the JSON body, and NVIDIA answered "unsupported
    // parameters" — OpenAI-compatible providers validate the body strictly and reject fields
    // they do not know, while ignoring headers they do not know. A body field also breaks
    // against any gateway older than the one that strips it, which is every gateway already
    // installed. The body belongs to the provider; this hop gets its own channel.
    //
    // The legacy body field is still honoured (and removed) so a client that has not updated
    // yet keeps working instead of 400ing at the provider.
    const legacy = (body && typeof body.chatpanel === 'object' && body.chatpanel) || null;
    if (legacy) {
      delete body.chatpanel;
      outBody = Buffer.from(JSON.stringify(body), 'utf8');
    }
    const hint = {
      destination: String(req.headers['x-chatpanel-destination'] || legacy?.destination || '').trim(),
      reach: String(req.headers['x-chatpanel-reach'] || legacy?.reach || '').trim(),
    };
    const dest = resolveDestination(body?.model, cfg, r.kind, { destination: hint.destination });
    // An EXPLICIT destination that does not resolve is an error, not an invitation to fall
    // back. Falling back would send a credential-bearing call to a provider the user did not
    // choose — the silent-misroute version of the bug this field exists to prevent.
    if (hint.destination && (!dest || dest.id !== hint.destination)) {
      trace?.commit();
      return sendJson(res, 404, {
        error: {
          message: `no destination "${hint.destination}" is configured on this gateway`,
          type: 'unknown_destination',
          known: listDestinations(cfg).map((d) => d.id),
        },
      });
    }
    if (trace) {
      trace.meta = { t: Date.now(), model: body?.model || null, dest: dest ? dest.id : null, type: dest ? dest.type : null, redacted: redactedCount, sanitized: sanitizedCount, narrowed: narrowedTools, detail: redactionDetail(vault, cfg.logDetail) };
    }
    if (dest && dest.type === 'api') {
      if (!dest.baseUrl) { trace?.commit(); return sendJson(res, 502, { error: `destination "${dest.id}" has no baseUrl` }); }
      if (isSelfUrl(dest.baseUrl, cfg)) {
        trace?.commit();
        return sendJson(res, 508, { error: { message: `destination "${dest.id}" points back at the gateway (${dest.baseUrl}) — refusing to forward (would loop).`, type: 'loop_detected' } });
      }
      return handleApi(req, res, { ...r, pathname, search: url.search, base: dest.baseUrl, destKey: dest.apiKey, destProtocol: dest.protocol, harness, trace }, outBody, vault);
    }
    return handleBridge(req, res, { ...r, pathname, agentOverride: dest?.agent, harness, trace }, body, vault, cfg, isPro);
  });
}

export function start(cfg = loadConfig()) {
  installTimestampedConsole(); // every gateway log line gets a clock — before anything logs
  ensureGatewayToken(); // M2: load/create the admin-route token (best-effort)
  const server = createGateway(cfg);
  const ner = startNer(cfg); // may mutate cfg.redaction when it comes up
  // Re-validate the stored entitlement online on an interval; clears it and drops
  // the gateway to Free when the worker reports it invalid (see
  // entitlement-refresh.js).
  const entitlement = startEntitlementRefresh(cfg);
  // Fail LOUD on a port clash instead of crashing with a raw stack trace. We bind a
  // FIXED port (4320) so the extension / install.sh / OpenCode can always find us; if
  // something else already holds it, tell the user exactly how to recover (pick a new
  // port, restart, and point the extension's Gateway tab at it) rather than silently
  // dying or drifting to a random port.
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`Port ${cfg.port} is already in use — another app (or a second gateway) has it.`);
      console.error(`Fix: free the port, or set a different one — edit "port" in ${configPath()} (or the extension's Gateway tab) and restart. The extension must point at the same port.`);
      process.exit(1);
    }
    console.error(`Gateway server error: ${e?.message || e}`);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`ChatPanel Privacy Gateway v${VERSION} on http://${cfg.host}:${cfg.port}`);
    console.log(`  backend  : ${cfg.backend}` + (cfg.backend === 'bridge' ? ` (agent: ${cfg.bridge.agent}, via ${cfg.bridge.url})` : ''));
    // U3: report the bridge at startup so the operator sees the unified picture without
    // running anything. Detect only — never force-spawn a managed service. Best-effort and
    // non-fatal: a probe failure just logs "not detected".
    import('./local-status.js')
      .then((m) => m.bridgePresenceNote())
      .then((note) => console.log(`  bridge   : ${note}`))
      .catch(() => {});
    console.log(`  redaction: ${cfg.redaction.tier}` + (cfg.redaction.detection?.backend && cfg.redaction.detection.backend !== 'off'
      ? ` + ${cfg.redaction.detection.backend} detector` : (cfg.ner?.autostart ? ' (+ NER starting…)' : '')));
    // M7: a non-loopback bind exposes the gateway on the LAN, where the per-request
    // loopback Host check is trivially satisfied by a spoofed `Host: 127.0.0.1`. The
    // /v1 data plane forwards with the client's own key, but make the exposure LOUD.
    if (!isLoopbackHost(cfg.host)) {
      console.error(`⚠ SECURITY: gateway bound to NON-LOOPBACK host ${cfg.host}. It is reachable off-machine, and the loopback Host-header check is spoofable from the LAN. Admin routes still need the token/extension, but prefer binding 127.0.0.1 unless you intend LAN exposure on a trusted network.`);
    }
  });
  // If the user handed off a backup key, refresh the warm store from the encrypted
  // rotating archive in the background — so the gateway stays current even when the
  // extension never runs. Best-effort; never blocks startup or crashes it.
  if (hasBackupSecret()) {
    ingestBackups(historyStore, loadBackupSecret())
      .then((r) => { if (r?.ok) console.log(`  warm     : seeded ${r.ingested} records from ${r.file}`); })
      .catch(() => {});
  }
  const shutdown = () => { ner?.stop(); entitlement.stop(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}
