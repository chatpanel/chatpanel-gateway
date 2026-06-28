// Free vs Pro for the gateway runtime — the "taste" gate.
//
// Free (no entitlement token): deterministic redaction only (basic tier) + a
// capped number of metered requests per day, so anyone can try it. Pro (a valid
// ChatPanel entitlement token — the same offline-signed token the extension and
// bridge use) unlocks full-tier redaction (names/orgs via NER + full dictionary)
// and unlimited usage. The cryptographic check (entitlement.js) means a forked UI
// can't unlock it — only the configured/paid token does.

import { isProEntitled } from './entitlement.js';

const proCache = { token: null, val: false };
const counts = { day: '', n: 0 };

// Today's metered usage — for the gateway's /status (the extension's monitoring).
export function usage(cfg) {
  return { day: counts.day, used: counts.n, cap: cfg.pro?.free?.maxRequestsPerDay ?? 25 };
}

export async function resolvePro(token) {
  if (!token) return false;
  if (proCache.token === token) return proCache.val;
  const val = await isProEntitled(token).catch(() => false);
  proCache.token = token;
  proCache.val = val;
  return val;
}

// UTC day bucket. (Runtime — Date is available here, unlike workflow scripts.)
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Meter one redactable request. Pro = always allowed. Free = allowed until the
// daily cap, then refused so the client gets a clear upsell.
export function meter(cfg, isPro) {
  if (isPro) return { allowed: true, remaining: Infinity, isPro: true };
  const cap = cfg.pro?.free?.maxRequestsPerDay ?? 25;
  const d = dayKey();
  if (counts.day !== d) { counts.day = d; counts.n = 0; }
  if (counts.n >= cap) return { allowed: false, remaining: 0, cap, isPro: false };
  counts.n += 1;
  return { allowed: true, remaining: cap - counts.n, cap, isPro: false };
}
