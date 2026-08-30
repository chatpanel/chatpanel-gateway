// local-status.js — one view of ChatPanel's local runtime: the bridge and the gateway.
//
// U3 of docs/bridge-gateway-unification.md: a person should be able to ask "what's running
// locally?" once and get a straight answer, without knowing there are two services on two
// ports. This is the read side of that — it probes both over HTTP and reports. It does NOT
// control either service (start/stop stays with each module's own installer, which owns its
// launchd/systemd unit); managing another module's service from here would duplicate the
// knowledge of how to do it and drift.
//
// The bridge is OPTIONAL from the gateway's side and the gateway is OPTIONAL from the
// bridge's — so a missing one is reported plainly, never as an error.

import { loadConfig } from './config.js';

function gatewayUrl() {
  try {
    return `http://127.0.0.1:${loadConfig().port || 4320}`;
  } catch {
    return 'http://127.0.0.1:4320';
  }
}

function bridgeUrl() {
  try {
    return String(loadConfig().bridge?.url || 'http://127.0.0.1:4319').replace(/\/+$/, '');
  } catch {
    return 'http://127.0.0.1:4319';
  }
}

async function probe(url, path = '/health') {
  try {
    const res = await fetch(url + path, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, data: await res.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, reason: e?.name === 'TimeoutError' ? 'no response' : (e?.message || 'unreachable') };
  }
}

/**
 * A structured picture of the local runtime — for the `local` command and for the gateway
 * to log at startup. Pure except the two probes; the caller decides how to render it.
 */
export async function localStatus() {
  const gwUrl = gatewayUrl();
  const brUrl = bridgeUrl();
  const [gw, br] = await Promise.all([probe(gwUrl), probe(brUrl)]);
  const skills = br.ok ? await probe(brUrl, '/skills').then((r) => (r.ok ? (r.data.skills || []).length : null)).catch(() => null) : null;
  return {
    gateway: {
      url: gwUrl,
      running: gw.ok,
      version: gw.ok ? gw.data.version : null,
      tier: gw.ok ? gw.data.tier : null,
      reason: gw.ok ? null : gw.reason,
    },
    bridge: {
      url: brUrl,
      running: br.ok,
      version: br.ok ? br.data.version : null,
      agents: br.ok ? (br.data.agents || []).filter((a) => a.available).length : null,
      skills: skills ?? (br.ok ? br.data.skills?.count ?? null : null),
      reason: br.ok ? null : br.reason,
    },
  };
}

/** Human-readable block for the CLI. */
export function formatLocalStatus(s) {
  const line = (name, m, extra) => {
    const dot = m.running ? '●' : '○';
    const head = m.running ? `${name}  running · v${m.version}` : `${name}  not running${m.reason ? ` (${m.reason})` : ''}`;
    return `  ${dot} ${head}\n      ${extra}`;
  };
  const gw = line('Gateway', s.gateway, s.gateway.running
    ? `Privacy layer: redaction, routing, voice. ${s.gateway.url}`
    : `Optional upgrade (redaction, routing, voice). Start with: chatpanel-gateway --install`);
  const brExtra = s.bridge.running
    ? `Local agents & skills${s.bridge.agents != null ? ` · ${s.bridge.agents} agent(s)` : ''}${s.bridge.skills != null ? ` · ${s.bridge.skills} skill(s)` : ''}. ${s.bridge.url}`
    : `Runs your local coding agents and skills. Start with: curl -fsSL https://dl.chatpanel.net/bridge/install.sh | bash`;
  const br = line('Bridge', s.bridge, brExtra);
  const summary = s.bridge.running && s.gateway.running
    ? 'Both running — local traffic can route through the gateway\'s privacy layer.'
    : s.bridge.running
      ? 'Bridge up. The gateway is an optional upgrade.'
      : s.gateway.running
        ? 'Gateway up. Start the bridge to use local agents and skills.'
        : 'Neither running.';
  return `ChatPanel local\n\n${gw}\n\n${br}\n\n  ${summary}\n`;
}

/**
 * One-line note for the gateway to log at startup, so the operator sees the unified picture
 * without running anything. Never throws; a probe failure just says "not detected".
 */
export async function bridgePresenceNote() {
  const br = await probe(bridgeUrl());
  if (br.ok) {
    const n = (br.data.skills?.count ?? null);
    return `bridge detected at ${bridgeUrl()} (v${br.data.version}${n != null ? `, ${n} skills` : ''}) — its agents and skills are available through this gateway.`;
  }
  return `bridge not detected at ${bridgeUrl()} — local agents/skills are unavailable until it runs (curl -fsSL https://dl.chatpanel.net/bridge/install.sh | bash). The gateway runs fine without it.`;
}
