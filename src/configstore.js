// Read/write the gateway's on-disk config so the extension's "Gateway" tab can
// configure it live over the localhost API (GET/POST /config). The gateway stays
// authoritative — the extension is just a UI client.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { usage } from './freegate.js';

// Default to a writable per-user location, NOT process.cwd(): when the gateway
// runs as a login service its cwd is "/" (read-only → EROFS on save).
export function configPath(env = process.env) {
  return env.CHATPANEL_GATEWAY_CONFIG || join(os.homedir(), '.chatpanel', 'gateway.config.json');
}

// Persist the user-editable subset (not derived runtime state).
export function persistConfig(cfg, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const out = {
    host: cfg.host, port: cfg.port, backend: cfg.backend,
    // Destinations (the configured agents + API models) MUST persist — otherwise a
    // restart drops them and every model falls back to the default OpenAI upstream.
    destinations: cfg.destinations,
    bridge: cfg.bridge, upstreams: cfg.upstreams, redaction: cfg.redaction,
    ner: cfg.ner, allowedOrigins: cfg.allowedOrigins, maxBodyBytes: cfg.maxBodyBytes,
    pro: cfg.pro, logRequests: cfg.logRequests, logDetail: cfg.logDetail, tools: cfg.tools,
  };
  writeFileSync(path, JSON.stringify(out, null, 2));
}

// Safe view for GET /config — never leak secrets (the entitlement + bridge tokens
// are write-only; the UI shows whether Pro is unlocked, not the token).
export function publicConfig(cfg, { proUnlocked = false } = {}) {
  return {
    backend: cfg.backend,
    // Strip per-destination apiKey (write-only).
    destinations: (Array.isArray(cfg.destinations) ? cfg.destinations : []).map((d) => { const { apiKey, ...rest } = d; return { ...rest, hasKey: !!apiKey }; }),
    bridge: { url: cfg.bridge?.url, agent: cfg.bridge?.agent, hasToken: !!cfg.bridge?.token },
    upstreams: cfg.upstreams,
    redaction: {
      tier: cfg.redaction?.tier,
      redactSystem: cfg.redaction?.redactSystem !== false,
      // Never echo the detector's apiKey back (write-only, like the tokens).
      detection: (() => { const { apiKey, ...d } = cfg.redaction?.detection || { backend: 'off' }; return d; })(),
      dictionary: Array.isArray(cfg.redaction?.dictionary) ? cfg.redaction.dictionary : [],
    },
    ner: cfg.ner,
    allowedOrigins: Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : [],
    // free = lifetime trial usage ({ used, cap, remaining }) — read-only; the cap
    // is fixed and the count is server-authoritative (never settable from the UI).
    pro: { unlocked: proUnlocked, hasToken: !!cfg.pro?.entitlementToken, free: usage(cfg) },
    logRequests: !!cfg.logRequests,
    logDetail: ['types', 'values'].includes(cfg.logDetail) ? cfg.logDetail : 'off',
    tools: {
      autoNarrow: cfg.tools?.autoNarrow !== false,
      maxPerTurn: Number(cfg.tools?.maxPerTurn) > 0 ? Number(cfg.tools.maxPerTurn) : 8,
      narrowAll: !!cfg.tools?.narrowAll,
      toolData: cfg.tools?.toolData === 'redactRemote' ? 'redactRemote' : 'real',
    },
  };
}

// Merge an editable patch into the live cfg. Only known fields; ignores the rest.
export function applyConfigPatch(cfg, patch = {}) {
  if (patch.backend === 'bridge' || patch.backend === 'api') cfg.backend = patch.backend;
  if (Array.isArray(patch.destinations)) {
    // Preserve a destination's apiKey when the patch omits it (it's write-only —
    // publicConfig strips it, so the UI never round-trips it back).
    const prev = new Map((Array.isArray(cfg.destinations) ? cfg.destinations : []).map((d) => [d.id, d]));
    cfg.destinations = patch.destinations
      .filter((d) => d && typeof d.id === 'string' && (d.type === 'agent' || d.type === 'api'))
      .map((d) => {
        const out = { id: d.id, type: d.type, models: Array.isArray(d.models) ? d.models.filter((m) => typeof m === 'string' && m) : [] };
        if (d.type === 'agent') out.agent = d.agent || d.id;
        if (d.type === 'api') {
          out.baseUrl = String(d.baseUrl || '');
          out.protocol = d.protocol === 'anthropic' ? 'anthropic' : 'openai';
          const key = (typeof d.apiKey === 'string' && d.apiKey) ? d.apiKey : prev.get(d.id)?.apiKey;
          if (key) out.apiKey = key;
        }
        return out;
      });
  }
  if (patch.bridge && typeof patch.bridge === 'object') {
    if (typeof patch.bridge.url === 'string') cfg.bridge.url = patch.bridge.url;
    if (typeof patch.bridge.agent === 'string') cfg.bridge.agent = patch.bridge.agent;
  }
  // api backend: where redacted traffic is forwarded (the client still picks the
  // model + sends its own key).
  if (patch.upstreams && typeof patch.upstreams === 'object') {
    for (const k of ['openai', 'anthropic']) {
      const u = patch.upstreams[k];
      if (u && typeof u.baseUrl === 'string' && u.baseUrl.trim()) {
        cfg.upstreams[k] = { ...cfg.upstreams[k], baseUrl: u.baseUrl.trim() };
      }
    }
  }
  if (patch.redaction && typeof patch.redaction === 'object') {
    const r = patch.redaction;
    if (r.tier === 'basic' || r.tier === 'full') cfg.redaction.tier = r.tier;
    if ('redactSystem' in r) cfg.redaction.redactSystem = !!r.redactSystem;
    if (Array.isArray(r.dictionary)) cfg.redaction.dictionary = r.dictionary;
    if (r.detection && typeof r.detection === 'object') cfg.redaction.detection = r.detection;
  }
  if (Array.isArray(patch.allowedOrigins)) cfg.allowedOrigins = patch.allowedOrigins;
  if (patch.pro && typeof patch.pro === 'object') {
    if (typeof patch.pro.entitlementToken === 'string') cfg.pro.entitlementToken = patch.pro.entitlementToken;
    // NOTE: the free trial is a FIXED lifetime cap (freegate.FREE_TOTAL_CAP) and
    // its `used` count is server-authoritative — neither is editable here, so a
    // client can't raise the cap or reset its own trial.
  }
  if (typeof patch.logRequests === 'boolean') cfg.logRequests = patch.logRequests;
  if (['off', 'types', 'values'].includes(patch.logDetail)) cfg.logDetail = patch.logDetail;
  if (patch.tools && typeof patch.tools === 'object') {
    cfg.tools = cfg.tools || {};
    if ('autoNarrow' in patch.tools) cfg.tools.autoNarrow = !!patch.tools.autoNarrow;
    if ('narrowAll' in patch.tools) cfg.tools.narrowAll = !!patch.tools.narrowAll;
    if (patch.tools.toolData === 'real' || patch.tools.toolData === 'redactRemote') cfg.tools.toolData = patch.tools.toolData;
    const cap = Number(patch.tools.maxPerTurn);
    if (Number.isFinite(cap) && cap >= 1) cfg.tools.maxPerTurn = Math.floor(cap);
  }
  return cfg;
}
