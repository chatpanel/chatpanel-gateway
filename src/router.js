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

// Aggregate every destination's models for GET /v1/models.
export function aggregateModels(cfg) {
  const data = [];
  const seen = new Set();
  for (const d of listDestinations(cfg)) {
    const models = (Array.isArray(d.models) && d.models.length) ? d.models : [d.id];
    for (const m of models) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      data.push({ id: m, object: 'model', owned_by: d.type === 'agent' ? 'chatpanel-bridge' : (d.id || 'api') });
    }
  }
  return { object: 'list', data };
}
