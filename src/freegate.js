// Free vs Pro for the gateway runtime. Without an entitlement token, full-tier
// redaction is available for a fixed lifetime number of redactions (FREE_TOTAL_CAP);
// a valid ChatPanel entitlement token unlocks unlimited redaction. The count is
// stored in cfg.pro.free.used (persisted via configstore.persistConfig).

import { isProEntitled } from './entitlement.js';

// The lifetime free allowance.
export const FREE_TOTAL_CAP = 100;

const proCache = { token: null, val: false };

// Lifetime free usage — for the gateway's /status (the extension's monitoring).
export function usage(cfg) {
  const used = Number(cfg.pro?.free?.used) || 0;
  return { used, cap: FREE_TOTAL_CAP, remaining: Math.max(0, FREE_TOTAL_CAP - used) };
}

export async function resolvePro(token) {
  if (!token) return false;
  if (proCache.token === token) return proCache.val;
  const val = await isProEntitled(token).catch(() => false);
  proCache.token = token;
  proCache.val = val;
  return val;
}

// May this request still redact? Pro = always; Free = allowed until the lifetime
// cap is reached. This only CHECKS — consume() advances the count after a
// redaction actually happens, so requests with nothing to redact don't consume
// allowance.
export function checkQuota(cfg, isPro) {
  if (isPro) return { allowed: true, remaining: Infinity, isPro: true };
  const used = Number(cfg.pro?.free?.used) || 0;
  if (used >= FREE_TOTAL_CAP) return { allowed: false, remaining: 0, used, cap: FREE_TOTAL_CAP, isPro: false };
  return { allowed: true, remaining: FREE_TOTAL_CAP - used, used, cap: FREE_TOTAL_CAP, isPro: false };
}

// Record one consumed free redaction (lifetime). No-op for Pro. Mutates cfg so
// the caller can persist it. Returns the new used count.
export function consume(cfg, isPro) {
  if (isPro) return Infinity;
  cfg.pro = cfg.pro || {};
  cfg.pro.free = cfg.pro.free || {};
  cfg.pro.free.used = (Number(cfg.pro.free.used) || 0) + 1;
  return cfg.pro.free.used;
}
