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
export function resolveDestination(model, cfg, kind) {
  const dests = listDestinations(cfg);
  const wantsAnthropic = kind === 'anthropic';
  const protoOk = (d) => (wantsAnthropic ? d.protocol === 'anthropic' : d.protocol !== 'anthropic');
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
export function aggregateModels(cfg) {
  const data = [];
  const seen = new Set();
  const add = (id, owner) => { if (id && !seen.has(id)) { seen.add(id); data.push({ id, object: 'model', owned_by: owner }); } };
  for (const d of listDestinations(cfg)) {
    if (d.type === 'agent') for (const m of (d.models?.length ? d.models : [d.id])) add(m, 'chatpanel-bridge');
    else for (const m of (d.models || [])) add(m, d.id);
  }
  return { object: 'list', data };
}

// Async variant: also PROXIES each API destination's own /v1/models to discover
// real model ids (using its saved key). Fail-open per destination.
export async function aggregateModelsAsync(cfg, { timeoutMs = 4000 } = {}) {
  const base = aggregateModels(cfg);
  const seen = new Set(base.data.map((m) => m.id));
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
      const res = await fetch(`${d.baseUrl.replace(/\/$/, '')}/models`, { headers, signal: ctrl.signal });
      if (!res.ok) return;
      const j = await res.json();
      const list = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.models) ? j.models : []);
      for (const m of list) {
        const id = typeof m === 'string' ? m : m?.id;
        if (id && !seen.has(id)) { seen.add(id); base.data.push({ id, object: 'model', owned_by: d.id }); }
      }
    } catch { /* fail-open */ } finally { clearTimeout(t); }
  }));
  return base;
}
