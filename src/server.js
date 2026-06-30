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
import { redactSegments } from './redact.js';
import { pipeRestoredStream, pipeRestoredOpenAIStream, makeTokenRestorer } from './stream.js';
import { restoreText, gatedDictionary, narrowSpecs, makeToolHarness, placeholderToolNote } from '@chatpanel/pii';
import { streamBridgeChat, readBridgeToken, openBridgeChat } from './bridge.js';
import { createRelaySession, getRelaySession, endRelaySession, pumpBridgeStream, deliverToolResult, toolsToSpecs, parseToolCallId } from './toolrelay.js';
import { shaperFor } from './shape.js';
import { startNer } from './ner.js';
import { installTimestampedConsole } from './log.js';
import * as nerEngine from './ner-engine.js';
import { MODEL_CATALOG, isKnownModel } from './models.js';
import { resolvePro, checkQuota, consume, usage } from './freegate.js';
import { publicConfig, applyConfigPatch, persistConfig, configPath } from './configstore.js';
import { resolveDestination, aggregateModelsAsync } from './router.js';
import * as openai from './openai.js';
import * as responses from './responses.js';
import * as anthropic from './anthropic.js';

export const VERSION = '0.6.11';

const KNOWN_AGENTS = new Set(['codex', 'claude', 'opencode', 'pi', 'kiro', 'antigravity']);

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
    const r = await fetch(url.replace(/\/ner\/?$/, '') + '/health', { signal: AbortSignal.timeout(2000) });
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
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
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
  // Full tier for everyone here (the free allowance is enforced by the quota gate
  // in the main handler), but the custom dictionary stays capped for free.
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
    });
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
    upstream = await fetch(base.replace(/\/$/, '') + pathname + search, {
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

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, version: VERSION, backend: cfg.backend, tier: cfg.redaction.tier });
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
          const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
          const text = await r.text();
          res.writeHead(r.status, { 'content-type': 'application/json' });
          return res.end(text);
        } catch (e) {
          return sendJson(res, 502, { error: { message: `NER unreachable: ${e.message}`, type: 'ner_unreachable' } });
        }
      }
    }
    // Model manager (the extension's Gateway settings drive these). GET lists the
    // catalog with install state + live download progress; POST switches the active
    // model (downloading it first if needed) and persists the choice.
    if (pathname === '/ner/models') {
      if (req.method === 'GET') {
        const available = MODEL_CATALOG.map((m) => ({ ...m, installed: nerEngine.modelOnDisk(m.id) }));
        return sendJson(res, 200, {
          active: nerEngine.health().model || cfg.ner?.model || null,
          state: nerEngine.state(),
          progress: nerEngine.progress(),
          available,
        });
      }
      if (req.method === 'POST') {
        let body = null;
        try { body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8')); } catch { body = null; }
        const id = body && typeof body.id === 'string' ? body.id : null;
        if (!id || !isKnownModel(id)) return sendJson(res, 400, { error: { message: 'unknown model id', type: 'bad_model' } });
        // Persist first so a restart keeps the choice, then (re)load. Don't block the
        // response on a possibly-long download — the client polls GET for progress.
        if (cfg.ner) cfg.ner.model = id; else cfg.ner = { autostart: true, model: id, allowDownload: true, enableFullTier: true };
        try { persistConfig(cfg, configPath()); } catch { /* best effort */ }
        nerEngine.setModel(id, { onLog: (m) => console.log(m) }).then((ok) => {
          if (ok && cfg.ner?.enableFullTier && cfg.redaction.tier !== 'full') cfg.redaction.tier = 'full';
        });
        return sendJson(res, 202, { accepted: true, active: id, state: nerEngine.state(), progress: nerEngine.progress() });
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

    // Model discovery — aggregate every destination's models.
    if (req.method === 'GET' && /\/models$/.test(pathname)) {
      return sendJson(res, 200, await aggregateModelsAsync(cfg));
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
        // Free/Pro gate: free users get the REAL thing (full-tier redaction), but
        // only for a fixed lifetime allowance — checked here, consumed below once a
        // redaction actually happens. Over the cap → 402 upsell.
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
        // Redact at the configured tier for everyone (free users get genuine
        // name/org redaction within their allowance, not a downgraded preview);
        // the custom dictionary stays capped for free (isPro decides that inside).
        const { vault: v, count, sanitized } = await redactSegments(segs, cfg.redaction, { signal: ac.signal, isPro });
        if (trace) trace.lap('redact', rd0);
        vault = v;
        redactedCount = count;
        sanitizedCount = sanitized || 0;
        // Burn one lifetime free credit only when we actually redacted something,
        // then persist so the count survives a restart. (No-op / no write for Pro.)
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
    const dest = resolveDestination(body?.model, cfg, r.kind);
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
  const server = createGateway(cfg);
  const ner = startNer(cfg); // may mutate cfg.redaction when it comes up
  // Re-validate the stored Pro entitlement online on an interval, so a refunded /
  // revoked subscription drops the gateway to Free instead of riding the offline
  // token to its exp (see entitlement-refresh.js).
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
    console.log(`  redaction: ${cfg.redaction.tier}` + (cfg.redaction.detection?.backend && cfg.redaction.detection.backend !== 'off'
      ? ` + ${cfg.redaction.detection.backend} detector` : (cfg.ner?.autostart ? ' (+ NER starting…)' : '')));
  });
  const shutdown = () => { ner?.stop(); entitlement.stop(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}
