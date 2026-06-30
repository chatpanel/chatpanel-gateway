// Online entitlement re-validation — closes the refund/revoke abuse window.
//
// The gateway stores ONE offline-signed entitlement token (pushed once from the
// extension via POST /config). Verified purely offline (entitlement.js), that token
// keeps unlocking Pro until its `exp` — up to 7 days — EVEN AFTER the subscription
// is refunded, cancelled, or the seat is revoked. The extension/bridge avoid this
// by re-polling the license worker; the gateway didn't, so a refund left unlimited
// redaction open for the rest of the token's life.
//
// So we also re-check ONLINE on an interval: poll the worker's /entitlement for the
// token's install_id and either
//   • REFRESH the stored token (still entitled) — so it never lapses while paid, and
//   • CLEAR it (worker says valid:false → refunded/cancelled/revoked) — dropping the
//     gateway to Free immediately instead of riding the offline exp.
// Network/worker errors NEVER revoke (fail-open for paying users); the offline `exp`
// still bounds the worst case. Bounds post-refund Pro to <= CHECK_INTERVAL_MS.

import { persistConfig, configPath } from './configstore.js';

// Same worker the extension/bridge use. Overridable for self-hosted/test.
const API_BASE = (process.env.CHATPANEL_API_BASE || 'https://api.chatpanel.net').replace(/\/+$/, '');
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h — the autonomous post-refund Pro window
const FIRST_CHECK_DELAY_MS = 30 * 1000;   // let the server settle before first poll
const MIN_RECHECK_MS = 2 * 60 * 1000;     // throttle on-demand (/status) re-checks

let lastCheckAt = 0;

// The token payload carries { typ, plan, install_id, sub, exp }; we only need the
// install_id to ask the worker whether that seat is still entitled.
function installIdFromToken(token) {
  try {
    const head = String(token).split('.')[0];
    const json = Buffer.from(head.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const p = JSON.parse(json);
    return typeof p.install_id === 'string' && p.install_id ? p.install_id : null;
  } catch {
    return null;
  }
}

async function revalidate(cfg) {
  lastCheckAt = Date.now();
  const token = cfg.pro?.entitlementToken;
  if (!token) return;
  const installId = installIdFromToken(token);
  if (!installId) return; // legacy/opaque token — leave the offline exp to bound it

  let data;
  try {
    const r = await fetch(`${API_BASE}/entitlement?install_id=${encodeURIComponent(installId)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return; // worker hiccup → fail-open, retry next interval
    data = await r.json();
  } catch {
    return; // offline / network error → fail-open (never revoke a paying user)
  }

  if (data && data.valid && typeof data.token === 'string' && data.token) {
    // Still entitled — adopt the freshly-signed token so Pro never lapses while paid.
    if (data.token !== token) {
      cfg.pro.entitlementToken = data.token;
      try { persistConfig(cfg, configPath()); } catch { /* best effort */ }
    }
  } else if (data && data.valid === false) {
    // Refunded / cancelled / seat revoked → drop Pro NOW (don't wait out the exp).
    cfg.pro.entitlementToken = '';
    try { persistConfig(cfg, configPath()); } catch { /* best effort */ }
    console.log('[gateway] entitlement no longer valid — Pro deactivated (refund/revoke/seat lost).');
  }
}

// On-demand, throttled re-check — fire-and-forget from a hot path (the extension's
// /status poll) so deactivation shows up within ~minutes of opening the gateway
// tab, not just on the hourly tick. Never awaited; safe to call often.
export function maybeRevalidate(cfg) {
  if (process.env.CHATPANEL_NO_REVALIDATE) return;
  if (!cfg.pro?.entitlementToken) return;
  if (Date.now() - lastCheckAt < MIN_RECHECK_MS) return;
  lastCheckAt = Date.now(); // claim the slot before the async hop (avoid stampede)
  revalidate(cfg).catch(() => {});
}

// Start the periodic re-check. Timers are unref'd so they never keep the process
// alive on their own. Returns a handle with stop() for clean shutdown.
export function startEntitlementRefresh(cfg) {
  if (process.env.CHATPANEL_NO_REVALIDATE) return { stop() {} };
  const tick = () => { revalidate(cfg).catch(() => {}); };
  const first = setTimeout(tick, FIRST_CHECK_DELAY_MS);
  const iv = setInterval(tick, CHECK_INTERVAL_MS);
  if (typeof first.unref === 'function') first.unref();
  if (typeof iv.unref === 'function') iv.unref();
  return { stop() { clearTimeout(first); clearInterval(iv); } };
}
