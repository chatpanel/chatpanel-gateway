// Gateway configuration.
//
// Loads, in order of precedence: a JSON file (CHATPANEL_GATEWAY_CONFIG or
// ./gateway.config.json) < environment variables. The gateway forwards the
// CLIENT's own auth header upstream (it stores no provider keys), so config here
// is only routing + the redaction policy.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DEFAULT_MODEL as DEFAULT_NER_MODEL } from './models.js';
import { DEFAULT_STT_MODEL } from './stt-models.js';

// Exported so tests can assert that every section here survives persistConfig's
// allowlist — a new section that is not persisted reverts on restart, and that
// reads as a broken feature rather than an unsaved setting.
export const DEFAULTS = {
  host: '127.0.0.1',
  port: 4320,

  // 'bridge' = drive the ChatPanel bridge's subscription-authed CLI agents
  //            (codex/claude/opencode/pi) — the privacy-bridge-between-agents use
  //            case (opencode → gateway → codex). No API keys; uses your login.
  // 'api'    = forward redacted traffic to a native provider API (local models,
  //            BYO keys, OpenRouter, …). Client passes its own auth through.
  backend: 'bridge',

  // Model router: the gateway routes each request to a destination by the model
  // name the client asks for. Empty = derive destinations from backend/bridge/
  // upstreams below (back-compat). Each entry:
  //   { id, type:'agent'|'api', agent?, baseUrl?, protocol?, models:[..] }
  destinations: [],

  // Security: legitimate clients (opencode/pi/codex/SDKs) are local processes that
  // send NO Origin header. A browser always attaches one. So we REJECT any request
  // bearing an Origin not in this allowlist — this stops a malicious web page from
  // POSTing to the gateway and driving codex (drive-by / CSRF). Leave empty to
  // block all browser-origin traffic. `maxBodyBytes` caps request size (DoS guard).
  allowedOrigins: [],
  maxBodyBytes: 26214400,

  // `free.used` is the running lifetime redaction count for the free allowance
  // (freegate.FREE_TOTAL_CAP redactions at full tier), persisted here. A valid
  // ChatPanel entitlement token unlocks unlimited use.
  pro: {
    entitlementToken: '',
    free: {
      used: 0,
    },
  },

  bridge: {
    url: 'http://127.0.0.1:4319',
    // Default agent the bridge drives. A request's `model` field may also name an
    // agent (codex/claude/opencode/pi) to override per-call.
    agent: 'codex',
    // Bearer token for the bridge's privileged /chat route. Empty = read the
    // per-install token from ~/.chatpanel/bridge-token.
    token: '',
    // What a CLI agent driven THROUGH the gateway may do — the same three modes the
    // extension offers per agent: 'default' (read-only, asks before writing),
    // 'acceptEdits' (edits files in its workspace on its own), 'bypassPermissions' (full
    // access and shell). Absent, the bridge ran every gateway turn read-only and told the
    // model to "set Permissions" in a settings page the desktop did not have.
    permissionMode: 'default',
    // Where the agent works. Empty = the bridge's ChatPanel workspace.
    workingDir: '',
  },

  upstreams: {
    // Used only when backend === 'api'. Override to point OpenAI-protocol traffic
    // at a local model, Azure, OpenRouter, etc. Auth is passed through from the
    // client, so no key lives here.
    openai: { baseUrl: 'https://api.openai.com' },
    anthropic: { baseUrl: 'https://api.anthropic.com' },
  },
  redaction: {
    // 'basic' = deterministic regex (emails/phones/cards/SSNs/keys/IPs).
    // 'full'  = basic + entity detection (names/orgs via the local detector below)
    //           + the custom dictionary.
    tier: 'basic',
    // { value|pattern, type, alias? } — see pii-redact.js. `alias` pseudonymizes
    // permanently (upstream + the agent both see the alias).
    dictionary: [],
    // Local entity detector, passed straight to pii-detect.detectEntities.
    //   backend: 'off' | 'endpoint' (POST {text}->{entities}) | 'openai' (local LLM)
    //   url, model, timeoutMs, maxChars
    // Leave this `off` to use the bundled in-process NER (see `ner` below). Set it
    // only to point at YOUR OWN external detector (a custom NER or local LLM); that
    // takes precedence over the bundled engine.
    detection: { backend: 'off' },
    // Per-request convenience: also redact the system prompt / system blocks.
    redactSystem: true,
  },
  // Bundled IN-PROCESS NER (ONNX via transformers.js). When autostart is on, the
  // gateway loads the entity detector in-process — no Python, no second port — so
  // name/org redaction works out of the box. The model loads from
  // ~/.chatpanel/models and is downloaded once on first run if absent. Larger /
  // alternative models can be installed from the extension's Gateway settings.
  // Fails open: if the model can't load, the gateway runs deterministic-only.
  ner: {
    autostart: true,
    // One definition, in models.js. It lived here, in models.js and in ner-engine.js at
    // once — three constants for one default, which is three chances to move two of them.
    model: DEFAULT_NER_MODEL,
    allowDownload: true,
    // Auto-bump redaction.tier to 'full' once the detector is ready (names/orgs).
    enableFullTier: true,
  },

  // Local speech-to-text (dictation) — the in-process ONNX engine and model dir shared
  // with NER (stt-engine.js). No autostart on purpose: the model downloads on FIRST
  // dictation, never on gateway boot (first-run load time). The default is Parakeet, which
  // is multilingual and several times faster than Whisper — see stt-models.js for what
  // that costs on a first run.
  stt: {
    enabled: true,
    model: DEFAULT_STT_MODEL,
    allowDownload: true,
    // Speaker diarization ("who said what") is an OPT-IN per-session stage (its
    // model loads only when a session asks). Set false to disable it gateway-wide.
    diarize: true,
  },

  // Local text-to-speech (read-aloud / voice out) — Kokoro via the same in-process
  // ONNX engine and model dir as NER/STT (tts-engine.js). No autostart, same reason
  // as stt: the model downloads on FIRST synthesis, never on gateway boot.
  tts: {
    enabled: true,
    // 'local' = Kokoro in this process, nothing leaves the machine (the default).
    // 'openai' | 'elevenlabs' = a remote voice. Auth is passed through from the
    // client as everywhere else here; no key is stored. See src/tts-remote.js for
    // why remote synthesis redacts by default and what that costs.
    provider: 'local',
    // Empty = decide at runtime. Pocket TTS is the better default (fastest here,
    // and the only engine that can speak as you) but needs the native onnxruntime,
    // which the standalone binary does not carry — so hardcoding either one is
    // wrong for half the installs. resolveDefaultModel() picks per runtime, and an
    // explicit choice here always wins.
    model: '',
    voice: '',
    allowDownload: true,
    remote: {
      baseUrl: '',   // '' = the provider's own default endpoint
      model: '',
      voice: '',
      // Redact before the text leaves this machine. Audio cannot be un-redacted,
      // so this genuinely means the voice says "PERSON_1" — set false only if you
      // accept sending real values to the vendor.
      redact: true,
    },
  },

  // Log one line per request (method, tokens redacted) without any raw values.
  logRequests: true,

  // Optional per-request redaction breakdown attached to each log entry (shown
  // expandable in the extension). Memory-only — never persisted to disk with the
  // captured values; only the MODE is saved.
  //   'off'    — counts only (default; the privacy-safe baseline)
  //   'types'  — entity types + placeholder tokens (e.g. PERSON_1), no real values
  //   'values' — real → placeholder mapping (the actual PII; opt-in, debugging)
  logDetail: 'off',
};

function deepMerge(base, over) {
  if (Array.isArray(over)) return over;
  if (over && typeof over === 'object' && base && typeof base === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

export function loadConfig(env = process.env) {
  let cfg = DEFAULTS;

  // Writable per-user location by default (NOT cwd — a login service runs with
  // cwd "/", which is read-only). Same path persistConfig() writes to.
  const path = env.CHATPANEL_GATEWAY_CONFIG || join(os.homedir(), '.chatpanel', 'gateway.config.json');
  if (existsSync(path)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(readFileSync(path, 'utf8')));
    } catch (e) {
      throw new Error(`bad config file ${path}: ${e.message}`);
    }
  }

  // Env overrides (handy for Docker/CI where a file is awkward).
  if (env.CHATPANEL_GATEWAY_HOST) cfg = deepMerge(cfg, { host: env.CHATPANEL_GATEWAY_HOST });
  if (env.CHATPANEL_GATEWAY_PORT) cfg = deepMerge(cfg, { port: Number(env.CHATPANEL_GATEWAY_PORT) });
  if (env.OPENAI_BASE_URL) cfg = deepMerge(cfg, { upstreams: { openai: { baseUrl: env.OPENAI_BASE_URL } } });
  if (env.ANTHROPIC_BASE_URL) cfg = deepMerge(cfg, { upstreams: { anthropic: { baseUrl: env.ANTHROPIC_BASE_URL } } });
  if (env.CHATPANEL_REDACTION_TIER) cfg = deepMerge(cfg, { redaction: { tier: env.CHATPANEL_REDACTION_TIER } });

  // A persisted port of 0 means "let the OS pick a random port" — fatal for a
  // service that clients reach at a FIXED address: the extension, install.sh, and
  // OpenCode/Pi all hardcode 4320. A stale/corrupt config that wrote 0 would bind a
  // random ephemeral port and look "running but unreachable". Coerce 0 / NaN / out-
  // of-range back to the default so the gateway is always where clients expect it.
  const p = Number(cfg.port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    if (cfg.port !== DEFAULTS.port) console.warn(`[gateway] ignoring invalid port ${JSON.stringify(cfg.port)} — using ${DEFAULTS.port}`);
    cfg = deepMerge(cfg, { port: DEFAULTS.port });
  }

  return cfg;
}
