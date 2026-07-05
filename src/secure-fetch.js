// Node-side SSRF-hardened fetch (M1). The shared @chatpanel/pii/net.js classifier is
// browser-safe and can only match on the URL's HOSTNAME string — so a public name
// whose A/AAAA record resolves to a private/metadata IP (DNS-rebinding at the fetch
// layer) slips past it. Node CAN resolve DNS, so here we additionally validate every
// RESOLVED address against the same policy, and revalidate on each redirect hop.
//
// Policy defaults to the ENDPOINT context (loopback + LAN allowed — Ollama / a LAN
// model box are legitimate gateway upstreams — but cloud metadata never). So in
// practice the DNS check blocks a hostname that resolves to cloud metadata; the
// redirect revalidation blocks a public upstream that 3xx-redirects to a blocked host.
//
// Residual (documented): we validate the resolved IPs but do NOT pin the socket to
// them, so a sub-second TOCTOU window between lookup and connect remains. Closing it
// fully needs a custom undici dispatcher; the resolved-IP check already removes the
// easy DNS-rebinding cases, which is the point of M1.

import { lookup as dnsLookup } from 'node:dns/promises';
import { assertEndpointUrl, isBlockedHost } from '@chatpanel/pii';

const ENDPOINT_POLICY = { allowLoopback: true, allowPrivate: true };
const isLiteralIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

// Reject if ANY resolved address is blocked under `policy`. A literal-IP host is
// already covered by the URL check, so skip DNS for it. A resolution failure is left
// for fetch() to surface (don't mask a real network error as a security error).
async function assertResolvedIps(hostname, policy, lookupFn) {
  if (isLiteralIp(hostname)) return;
  let addrs;
  try { addrs = await lookupFn(hostname, { all: true }); } catch { return; }
  for (const { address } of addrs) {
    if (isBlockedHost(address, policy)) {
      throw new Error(`refusing to reach ${hostname} — it resolves to a blocked address (${address})`);
    }
  }
}

// secureFetch(url, { policy?, maxRedirects?, lookupFn?, fetchFn?, ...init })
// Validates the URL (scheme + host policy) AND its resolved IPs before each request,
// following redirects manually so every hop is re-checked. Returns the final Response.
// `...init` forwards any standard fetch options (method, headers, body, signal, …).
/**
 * @param {string|URL} url
 * @param {any} [opts]
 */
export async function secureFetch(url, {
  policy = ENDPOINT_POLICY, maxRedirects = 5, lookupFn = dnsLookup, fetchFn = fetch, ...init
} = {}) {
  let current = assertEndpointUrl(url, policy);
  for (let hop = 0; ; hop++) {
    await assertResolvedIps(current.hostname, policy, lookupFn);
    const res = await fetchFn(current.toString(), { ...init, redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return res;
    if (hop >= maxRedirects) throw new Error('too many redirects');
    current = assertEndpointUrl(new URL(loc, current).toString(), policy); // revalidate the hop
    try { res.body?.cancel?.(); } catch { /* free the redirect body */ }
  }
}
