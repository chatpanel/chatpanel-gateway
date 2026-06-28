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

// Back-compat: if no destinations are configured, synthesize them from the legacy
// backend/upstreams config so existing installs keep working unchanged.
export function listDestinations(cfg) {
  if (Array.isArray(cfg.destinations) && cfg.destinations.length) return cfg.destinations;
  if (cfg.backend === 'api') {
    return [
      { id: 'openai', type: 'api', protocol: 'openai', baseUrl: cfg.upstreams?.openai?.baseUrl, models: [] },
      { id: 'anthropic', type: 'api', protocol: 'anthropic', baseUrl: cfg.upstreams?.anthropic?.baseUrl, models: [] },
    ];
  }
  const agents = [...new Set([cfg.bridge?.agent || 'codex', 'codex', 'claude', 'opencode', 'pi'])];
  return agents.map((a) => ({ id: a, type: 'agent', agent: a, models: [a] }));
}

// Pick the destination that serves `model` (explicit membership → id/agent match →
// a same-protocol fallback → the first destination).
export function resolveDestination(model, cfg, kind) {
  const dests = listDestinations(cfg);
  const wantsAnthropic = kind === 'anthropic';
  return (
    (model && dests.find((d) => Array.isArray(d.models) && d.models.includes(model)))
    || (model && dests.find((d) => d.id === model || d.agent === model))
    || dests.find((d) => d.type === 'agent' || (wantsAnthropic ? d.protocol === 'anthropic' : d.protocol !== 'anthropic'))
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
