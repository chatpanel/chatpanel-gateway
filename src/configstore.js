// Read/write the gateway's on-disk config so the extension's "Gateway" tab can
// configure it live over the localhost API (GET/POST /config). The gateway stays
// authoritative — the extension is just a UI client.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';

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
    bridge: cfg.bridge, upstreams: cfg.upstreams, redaction: cfg.redaction,
    ner: cfg.ner, allowedOrigins: cfg.allowedOrigins, maxBodyBytes: cfg.maxBodyBytes,
    pro: cfg.pro, logRequests: cfg.logRequests,
  };
  writeFileSync(path, JSON.stringify(out, null, 2));
}

// Safe view for GET /config — never leak secrets (the entitlement + bridge tokens
// are write-only; the UI shows whether Pro is unlocked, not the token).
export function publicConfig(cfg, { proUnlocked = false } = {}) {
  return {
    backend: cfg.backend,
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
    pro: { unlocked: proUnlocked, hasToken: !!cfg.pro?.entitlementToken, free: cfg.pro?.free },
    logRequests: !!cfg.logRequests,
  };
}

// Merge an editable patch into the live cfg. Only known fields; ignores the rest.
export function applyConfigPatch(cfg, patch = {}) {
  if (patch.backend === 'bridge' || patch.backend === 'api') cfg.backend = patch.backend;
  if (patch.bridge && typeof patch.bridge === 'object') {
    if (typeof patch.bridge.url === 'string') cfg.bridge.url = patch.bridge.url;
    if (typeof patch.bridge.agent === 'string') cfg.bridge.agent = patch.bridge.agent;
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
    const cap = patch.pro.free?.maxRequestsPerDay;
    if (Number.isFinite(cap) && cap >= 0) cfg.pro.free.maxRequestsPerDay = cap;
  }
  if (typeof patch.logRequests === 'boolean') cfg.logRequests = patch.logRequests;
  return cfg;
}
