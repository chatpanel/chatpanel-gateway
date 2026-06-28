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
import { redactSegments } from './redact.js';
import { pipeRestoredStream, makeTokenRestorer } from './stream.js';
import { restoreText } from '@chatpanel/pii';
import { streamBridgeChat, readBridgeToken } from './bridge.js';
import { shaperFor } from './shape.js';
import { startNer } from './ner.js';
import { resolvePro, meter, usage } from './freegate.js';
import { publicConfig, applyConfigPatch, persistConfig, configPath } from './configstore.js';
import * as openai from './openai.js';
import * as responses from './responses.js';
import * as anthropic from './anthropic.js';

export const VERSION = '0.1.6';

const KNOWN_AGENTS = new Set(['codex', 'claude', 'opencode', 'pi', 'kiro', 'antigravity']);

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

// Classify a request: which protocol kind + adapter, whether it's a redactable
// chat endpoint, and (api backend) which upstream base URL.
function route(pathname, headers, cfg) {
  if (anthropic.matches(pathname) || 'anthropic-version' in headers) {
    return { kind: 'anthropic', adapter: anthropic, redactable: anthropic.matches(pathname), base: cfg.upstreams.anthropic.baseUrl };
  }
  if (responses.matches(pathname)) {
    return { kind: 'responses', adapter: responses, redactable: true, base: cfg.upstreams.openai.baseUrl };
  }
  return { kind: 'openai', adapter: openai, redactable: openai.matches(pathname), base: cfg.upstreams.openai.baseUrl };
}

function pickAgent(model, cfg) {
  return KNOWN_AGENTS.has(model) ? model : cfg.bridge.agent;
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

async function handleBridge(req, res, { kind, adapter, redactable, pathname }, body, vault, cfg) {
  if (!redactable) {
    if (/\/models$/.test(pathname)) {
      const agents = [...new Set([cfg.bridge.agent, 'codex', 'claude', 'opencode', 'pi'])];
      return sendJson(res, 200, { object: 'list', data: agents.map((id) => ({ id, object: 'model', owned_by: 'chatpanel-bridge' })) });
    }
    return sendJson(res, 404, { error: `endpoint ${pathname} not supported by the bridge backend` });
  }

  const { messages, system } = adapter.toTurn(body);
  const agent = pickAgent(body?.model, cfg);
  const wantStream = body?.stream === true;
  const shaper = shaperFor(kind, body?.model || agent);
  const token = readBridgeToken(cfg.bridge.token);
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const turn = { bridgeUrl: cfg.bridge.url, agent, token, messages, system, signal: ac.signal };

  if (!wantStream) {
    try {
      let full = '';
      await streamBridgeChat(turn, (t) => { full += t; });
      res.writeHead(200, { 'content-type': shaper.contentType });
      return res.end(shaper.full(restoreText(full, vault)));
    } catch (e) {
      return sendJson(res, 502, { error: { message: `bridge backend failed: ${e.message}`, type: 'bridge_error' } });
    }
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(shaper.sseHead());
  const restorer = makeTokenRestorer(vault);
  try {
    await streamBridgeChat(turn, (chunk) => {
      const restored = restorer.push(chunk);
      if (restored) res.write(shaper.sseDelta(restored));
    });
    const tail = restorer.flush();
    if (tail) res.write(shaper.sseDelta(tail));
    res.write(shaper.sseTail());
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'bridge_error' } })}\n\n`);
  }
  res.end();
}

// ---- backend: api ----------------------------------------------------------

async function handleApi(req, res, { adapter, pathname, search, base }, outBody, vault) {
  let upstream;
  try {
    upstream = await fetch(base.replace(/\/$/, '') + pathname + search, {
      method: req.method,
      headers: forwardHeaders(req.headers, base),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : outBody,
    });
  } catch (e) {
    return sendJson(res, 502, { error: `upstream fetch failed: ${e.message}` });
  }

  const ct = upstream.headers.get('content-type') || '';
  const resHeaders = {};
  upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v; });

  if (ct.includes('text/event-stream') && upstream.body) {
    res.writeHead(upstream.status, resHeaders);
    return pipeRestoredStream(upstream.body, res, vault);
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  if (vault && ct.includes('application/json')) {
    try {
      const json = adapter.restoreResponse(JSON.parse(buf.toString('utf8')), vault);
      res.writeHead(upstream.status, { ...resHeaders, 'content-type': 'application/json' });
      return res.end(Buffer.from(JSON.stringify(json), 'utf8'));
    } catch { /* fall through */ }
  }
  res.writeHead(upstream.status, resHeaders);
  res.end(buf);
}

// ---- server ----------------------------------------------------------------

export function createGateway(cfg = loadConfig()) {
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
      const proUnlocked = await resolvePro(cfg.pro?.entitlementToken);
      const nerOn = cfg.redaction?.detection?.backend && cfg.redaction.detection.backend !== 'off';
      return sendJson(res, 200, {
        ok: true, version: VERSION, backend: cfg.backend, tier: cfg.redaction.tier,
        ner: { autostart: !!cfg.ner?.autostart, ready: !!nerOn },
        pro: { unlocked: proUnlocked }, usage: usage(cfg),
        uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      });
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
      const proUnlocked = await resolvePro(cfg.pro?.entitlementToken);
      return sendJson(res, 200, publicConfig(cfg, { proUnlocked }));
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
    if (r.redactable && req.method === 'POST' && raw.length) {
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
      if (body) {
        // Free/Pro gate: meter the request and pick the effective tier.
        const isPro = await resolvePro(cfg.pro?.entitlementToken);
        const allow = meter(cfg, isPro);
        if (!allow.allowed) {
          return sendJson(res, 402, { error: {
            message: `ChatPanel Gateway free limit reached (${allow.cap}/day). Add a ChatPanel Pro entitlement token to unlock unlimited usage + full-tier redaction (names/orgs).`,
            type: 'free_limit_reached',
          } });
        }
        const segs = r.adapter.collectSegments(body, cfg.redaction);
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        const { vault: v, count } = await redactSegments(segs, cfg.redaction, { signal: ac.signal, isPro });
        vault = v;
        outBody = Buffer.from(JSON.stringify(body), 'utf8');
        if (cfg.logRequests) console.log(`[gateway] ${req.method} ${pathname} · redacted ${count}/${segs.length} segment(s) · ${cfg.backend}`);
      }
    } else if (cfg.logRequests) {
      console.log(`[gateway] ${req.method} ${pathname} · ${cfg.backend}`);
    }

    if (cfg.backend === 'bridge') {
      return handleBridge(req, res, { ...r, pathname }, body, vault, cfg);
    }
    if (!r.base) return sendJson(res, 502, { error: 'no upstream configured' });
    return handleApi(req, res, { ...r, pathname, search: url.search }, outBody, vault);
  });
}

export function start(cfg = loadConfig()) {
  const server = createGateway(cfg);
  const ner = startNer(cfg); // may mutate cfg.redaction when it comes up
  server.listen(cfg.port, cfg.host, () => {
    console.log(`ChatPanel Privacy Gateway v${VERSION} on http://${cfg.host}:${cfg.port}`);
    console.log(`  backend  : ${cfg.backend}` + (cfg.backend === 'bridge' ? ` (agent: ${cfg.bridge.agent}, via ${cfg.bridge.url})` : ''));
    console.log(`  redaction: ${cfg.redaction.tier}` + (cfg.redaction.detection?.backend && cfg.redaction.detection.backend !== 'off'
      ? ` + ${cfg.redaction.detection.backend} detector` : (cfg.ner?.autostart ? ' (+ NER starting…)' : '')));
  });
  const shutdown = () => { ner?.stop(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}
