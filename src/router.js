// Model router: the gateway exposes one localhost endpoint, and routes each
// request to a DESTINATION by the model name the client asks for. A destination
// is either a CLI agent (driven via the bridge, subscription login) or an API
// (forwarded to a provider/local server, client brings the key).
//
//   destination = {
//     id,                       unique name (also a valid model alias)
//     type: 'agent' | 'api',
//     agent,                    (agent) bridge agent id: codex/claude/opencode/pi
//     baseUrl, protocol,        (api) where to forward + 'openai'|'anthropic'
//     models: [..],             models this destination serves (for /v1/models)
//   }

import { secureFetch } from './secure-fetch.js';
import { readBridgeToken } from './bridge.js';
//
// /v1/models aggregates every destination's models so clients can discover them.

// The CLI agents the bridge can drive. A request for any of these ALWAYS routes to
// the bridge relay — the agent runs under ITS OWN login (subscription / enterprise /
// api, however it's configured), so the gateway never needs an API key for it. This
// is the whole point: an OpenAI/Anthropic endpoint fronting already-logged-in
// codex / claude code via the bridge.
const KNOWN_AGENTS = ['codex', 'claude', 'opencode', 'pi', 'kiro', 'antigravity'];

// Build the destination list: explicitly-configured destinations + the known agents
// (always available as bridge destinations, even with zero saved config) + API
// fallbacks for non-agent models on the api backend.
export function listDestinations(cfg) {
  const configured = (Array.isArray(cfg.destinations) ? cfg.destinations : []).filter(Boolean);
  const haveId = new Set(configured.map((d) => d.id));
  const out = [...configured];
  for (const a of KNOWN_AGENTS) {
    if (!haveId.has(a)) out.push({ id: a, type: 'agent', agent: a, models: [a] });
  }
  if (cfg.backend === 'api' && !configured.some((d) => d.type === 'api')) {
    out.push({ id: 'openai', type: 'api', protocol: 'openai', baseUrl: cfg.upstreams?.openai?.baseUrl, models: [] });
    out.push({ id: 'anthropic', type: 'api', protocol: 'anthropic', baseUrl: cfg.upstreams?.anthropic?.baseUrl, models: [] });
  }
  return out;
}

// Pick the destination that serves `model` (explicit membership → id/agent match →
// a same-protocol fallback → the first destination).
export function resolveDestination(model, cfg, kind, { destination = '' } = {}) {
  const dests = listDestinations(cfg);
  const wantsAnthropic = kind === 'anthropic';
  const protoOk = (d) => (wantsAnthropic ? d.protocol === 'anthropic' : d.protocol !== 'anthropic');
  // An explicit destination wins outright and never falls through: the caller named the
  // provider it means, so guessing a different one would be worse than failing. The caller
  // checks that what came back is what it asked for.
  if (destination) return dests.find((d) => d.id === destination) || null;
  return (
    // Explicit: a destination that serves this exact model (a known agent like codex
    // matches its own agent destination here — so it ALWAYS goes to the bridge).
    (model && dests.find((d) => Array.isArray(d.models) && d.models.includes(model)))
    || (model && dests.find((d) => d.id === model || d.agent === model))
    // No match: fall back to the BACKEND's natural default — an API destination on the
    // api backend, an agent on the bridge backend. Never silently send an unknown
    // model name to a CLI agent (that's why gemma must not hit codex).
    || dests.find((d) => (cfg.backend === 'bridge' ? d.type === 'agent' : (d.type === 'api' && protoOk(d))))
    || dests.find((d) => (cfg.backend === 'bridge' ? d.type === 'agent' : d.type === 'api'))
    || dests[0]
    || null
  );
}

// Aggregate every destination's models for GET /v1/models. Agents expose their
// own name as the model; APIs expose ONLY real model ids (never the destination
// id — that's a provider name, not a model).
/**
 * WHICH API SHAPE A MODEL WANTS TO BE CALLED WITH.
 *
 * `owned_by` names the destination, which is a routing fact, not a calling convention — and
 * a client needs the second one to build a request. Anthropic models take the Messages API;
 * OpenAI-compatible ones take chat/completions (and the Responses API where the destination
 * offers it); an agent takes neither, because the gateway synthesises the response itself
 * from the bridge's stream.
 *
 * Stated here rather than inferred from the id in every client. Guessing from the name is
 * how `claude` the local CLI agent gets called as if it were Anthropic's hosted API.
 */
function apiShapeOf(d) {
  if (d.type === 'agent') return { api: 'agent', endpoints: ['/v1/chat/completions'] };
  if (d.protocol === 'anthropic') return { api: 'anthropic', endpoints: ['/v1/messages'] };
  return { api: 'openai', endpoints: ['/v1/chat/completions', '/v1/responses'] };
}

export function aggregateModels(cfg) {
  const data = [];
  const seen = new Set();
  const add = (id, owner, d) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const shape = apiShapeOf(d);
    data.push({
      id,
      object: 'model',
      owned_by: owner,
      // Additive fields an OpenAI client ignores and a ChatPanel client uses to decide how
      // to call, and to group a picker by provider instead of by a flat list of ids.
      provider: d.id,
      provider_type: d.type === 'agent' ? 'agent' : (d.protocol === 'anthropic' ? 'anthropic' : 'openai'),
      api: shape.api,
      endpoints: shape.endpoints,
    });
  };
  for (const d of listDestinations(cfg)) {
    if (d.type === 'agent') for (const m of (d.models?.length ? d.models : [d.id])) add(m, 'chatpanel-bridge', d);
    else for (const m of (d.models || [])) add(m, d.id, d);
  }
  return { object: 'list', data };
}

/**
 * The models each installed agent can be asked for.
 *
 * A CLI agent is not one model — Claude Code takes opus/sonnet/haiku, others enumerate their
 * own — and listing only the agent id meant a user picked `claude` and got whatever default
 * the CLI had. When that default is newer than the installed CLI, the answer is a version
 * error about a model the user never chose.
 *
 * Asked of the bridge, which is the only thing that knows what each CLI supports, and only
 * for agents that are actually INSTALLED: enumerating models for a CLI that is not there
 * spends a subprocess per agent to describe something unusable.
 */
async function bridgeAgentModels(cfg, installed, timeoutMs) {
  const base = String(cfg?.bridge?.url || '').replace(/\/$/, '');
  if (!base || !installed) return new Map();
  const token = readBridgeToken(cfg.bridge?.token);
  const ids = [...installed.entries()].filter(([, ok]) => ok).map(([id]) => id);
  const out = new Map();
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetch(`${base}/list-models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ agent: id }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return;
      const body = await res.json();
      const models = (Array.isArray(body?.models) ? body.models : [])
        .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || ''))
        .map((m) => String(m).trim())
        .filter(Boolean);
      if (models.length) out.set(id, models.slice(0, 40));
    } catch { /* an agent that will not enumerate still works under its bare id */ }
  }));
  return out;
}

/** id → installed, from the bridge's own /health. `null` when it could not be asked. */
async function bridgeAgentAvailability(cfg, timeoutMs) {
  const base = String(cfg?.bridge?.url || '').replace(/\/$/, '');
  if (!base) return null;
  try {
    const token = readBridgeToken(cfg.bridge?.token);
    const res = await fetch(`${base}/health`, {
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body?.agents)) return null;
    return new Map(body.agents.map((a) => [a.id, !!a.available]));
  } catch {
    return null; // not reachable — say nothing rather than saying "none"
  }
}

// Async variant: also PROXIES each API destination's own /v1/models to discover
// real model ids (using its saved key). Fail-open per destination.
export async function aggregateModelsAsync(cfg, { timeoutMs = 4000 } = {}) {
  const base = aggregateModels(cfg);
  const seen = new Set(base.data.map((m) => m.id));

  // WHICH AGENTS ARE ACTUALLY ON THIS MACHINE.
  //
  // The list above is the ROUTING TABLE: it names every agent the gateway would route to,
  // whether or not that CLI is installed. On a fresh machine that is a model picker full of
  // names that all fail on first use, which is the worst possible first five minutes.
  //
  // Only the bridge knows what is on disk, so the gateway asks it — once, here — rather than
  // every client asking separately. A client that had to check for itself would need the
  // bridge's address and token as well as ours, and the direct-to-bridge path is the one
  // with no policy in front of it; making it necessary is how it becomes the habit.
  //
  // `available` is left UNDEFINED when the bridge cannot be reached. Absent means "we did not
  // find out", which is not the same as false, and a picker that greys out every agent
  // because one health check timed out is worse than one that says nothing.
  const agentAvailability = await bridgeAgentAvailability(cfg, timeoutMs);
  if (agentAvailability) {
    for (const m of base.data) {
      if (m.owned_by === 'chatpanel-bridge') m.available = agentAvailability.get(m.id) ?? false;
    }
  }

  // Each installed agent's own models, listed as `agent/model` beside the bare id. The bare
  // id stays and still means "the agent's default", so nothing that already works breaks.
  const agentModels = await bridgeAgentModels(cfg, agentAvailability, timeoutMs);
  for (const [agent, models] of agentModels) {
    const parent = base.data.find((m) => m.id === agent);
    if (!parent) continue;
    for (const model of models) {
      const id = `${agent}/${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      base.data.push({
        ...parent,
        id,
        // `model` is what the picker shows under the agent's heading; the agent stays the
        // provider, so the grouping puts them together without any id parsing.
        model,
        available: true,
      });
    }
  }

  const dests = listDestinations(cfg).filter((d) => d.type === 'api' && d.baseUrl);
  await Promise.all(dests.map(async (d) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { 'content-type': 'application/json' };
      if (d.apiKey) {
        if (d.protocol === 'anthropic') { headers['x-api-key'] = d.apiKey; headers['anthropic-version'] = '2023-06-01'; }
        else headers.authorization = `Bearer ${d.apiKey}`;
      }
      // secureFetch: SSRF guard (scheme/host + resolved-IP); a blocked dest throws → skipped via the catch.
      const res = await secureFetch(`${d.baseUrl.replace(/\/$/, '')}/models`, { headers, signal: ctrl.signal });
      if (!res.ok) return;
      const j = await res.json();
      const list = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.models) ? j.models : []);
      for (const m of list) {
        const id = typeof m === 'string' ? m : m?.id;
        if (id && !seen.has(id)) {
          seen.add(id);
          const shape = apiShapeOf(d);
          base.data.push({
            id, object: 'model', owned_by: d.id, provider: d.id,
            provider_type: d.protocol === 'anthropic' ? 'anthropic' : 'openai',
            api: shape.api, endpoints: shape.endpoints,
          });
        }
      }
    } catch { /* fail-open */ } finally { clearTimeout(t); }
  }));
  return base;
}
