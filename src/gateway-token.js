// Per-install bearer token for the gateway's ADMIN routes (M2), mirroring the
// bridge's model. The gateway proxies model traffic for any local client (the /v1/*
// data plane stays open, no auth — that's the product), but its ADMIN surface
// (reconfigure via POST /config, read /logs) must not be reachable by every local
// process or by a drive-by localhost web page.
//
// Two ways to authenticate an admin call:
//   • the ChatPanel extension — recognised by its chrome-/moz-extension:// Origin
//     (a web page can't forge that; browsers set it honestly). The extension can't
//     read a local file, so Origin is how IT authenticates.
//   • a token — this 32-byte secret at ~/.chatpanel/gateway-token (0600), for a
//     non-browser admin client (a setup script/CLI). A random local process doesn't
//     have it.
// Residual (same as the bridge): a MALICIOUS local process could forge the
// extension Origin. A local attacker at that privilege level already owns much;
// this still blocks web drive-by and benign no-Origin processes from the admin API.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';

const TOKEN_PATH = process.env.CHATPANEL_GATEWAY_TOKEN_PATH || join(os.homedir(), '.chatpanel', 'gateway-token');
let TOKEN = '';

// Load-or-create the token. Best-effort: token auth is hardening, never fail startup.
export function ensureGatewayToken(path = TOKEN_PATH) {
  try {
    if (existsSync(path)) TOKEN = readFileSync(path, 'utf8').trim();
    if (!TOKEN) {
      TOKEN = randomBytes(32).toString('hex');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, TOKEN, { mode: 0o600 });
      try { chmodSync(path, 0o600); } catch { /* non-POSIX */ }
    }
  } catch (e) {
    console.warn(`[gateway] could not initialise admin token: ${e?.message || e}`);
  }
  return TOKEN;
}

export function isExtensionOrigin(origin) {
  return typeof origin === 'string' && (/^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin));
}

function tokenMatches(headers) {
  if (!TOKEN) return false;
  const h = String(headers?.authorization || '');
  const provided = (h.startsWith('Bearer ') ? h.slice(7) : String(headers?.['x-chatpanel-token'] || '')).trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// True when a request may reach an ADMIN route: the extension (by Origin) or a
// token-bearing client.
export function isAdminAuthorized(req) {
  return isExtensionOrigin(req.headers?.origin) || tokenMatches(req.headers);
}
