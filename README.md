# ChatPanel Privacy Gateway

A localhost server that puts **ChatPanel's PII redaction / pseudonymization in the
middle of two CLI agents** — so you can use the privacy features outside the
ChatPanel extension. Point [opencode](https://opencode.ai) / pi at the gateway,
and it drives **codex / Claude Code behind your existing subscription login**
(via the [bridge](https://github.com/chatpanel/chatpanel-bridge)), redacting on
the way out and restoring on the way back. The model only ever sees opaque
placeholders like `[[PERSON_1]]` / `[[EMAIL_2]]` — **the real values never leave
your machine.**

```
  opencode / pi   (configured with a custom provider → the gateway)
        │   baseURL → http://127.0.0.1:4320/v1
        ▼
  ┌──────────────────────────────────────────────┐
  │  ChatPanel Privacy Gateway                    │
  │   1. detect + redact   →  [[PERSON_1]] …       │
  │   2. drive the agent behind your login        │
  │   3. restore placeholders in the reply         │
  └──────────────────────────────────────────────┘
        │   POST /chat  (bridge: subscription-authed CLI)
        ▼
  chatpanel-bridge ──spawns──▶ codex / claude   (your ChatGPT / enterprise / Claude login)
```

Two backends (config `backend`):

- **`bridge`** (default) — drive the bridge's subscription-authed CLI agents
  (`codex` / `claude` / `opencode` / `pi`). No API keys, uses your login. This is
  the "privacy bridge between two agents" path above.
- **`api`** — forward redacted traffic to a native OpenAI/Anthropic-compatible
  endpoint (local models, BYO keys). The client's own auth header passes through;
  the gateway stores no keys.

The redaction engine is the **same code** the ChatPanel extension runs — the
[`@chatpanel/pii`](https://github.com/chatpanel/chatpanel-pii) package is the
single source of truth, so a privacy feature added once is shared everywhere.

## Quick start (bridge backend)

You need the [ChatPanel bridge](https://github.com/chatpanel/chatpanel-bridge)
running and logged into codex/claude (the same bridge the extension uses).

```bash
npm install -g @chatpanel/gateway
chatpanel-gateway
# → ChatPanel Privacy Gateway v0.1.0 on http://127.0.0.1:4320
#     backend  : bridge (agent: codex, via http://127.0.0.1:4319)
```

Then point your front-end agent at it. **opencode** (`opencode.json`):

```jsonc
{
  "provider": {
    "chatpanel": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:4320/v1" },
      "models": { "codex": {}, "claude": {} }   // selects the agent behind the gateway
    }
  }
}
```

Now opencode talks to codex **through** the gateway — every prompt is redacted
before codex sees it, and the reply is restored before opencode renders it. The
request's `model` (`codex`/`claude`/`opencode`/`pi`) picks which agent the bridge
drives; otherwise the configured default (`codex`) is used.

### Using the api backend instead (local models / BYO keys)

Set `backend: "api"` (see config) and the gateway forwards redacted traffic to a
real provider endpoint, passing your `Authorization` / `x-api-key` through:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:4320/v1     # OpenAI / codex / aider / cursor
export ANTHROPIC_BASE_URL=http://127.0.0.1:4320     # Claude Code / Anthropic SDK
```

## Name/org redaction is built in (in-process NER, no Python)

Deterministic redaction (emails, phones, cards, SSNs, API keys, IPs) needs no
setup. To also blind **names, organizations and locations**, the gateway runs an
**in-process** entity detector — an ONNX transformer model via transformers.js —
with `ner.autostart` on (the default). There's **no Python, no second port, no
separate process**: the same model runs identically on macOS / Windows / Linux.
The model loads from `~/.chatpanel/models` and is downloaded once on first run if
absent (set `ner.allowDownload: false` to require it be pre-placed). It's
fail-open, so if the model can't load the gateway just runs deterministic-only.
Once the detector is ready, redaction switches to the `full` tier automatically.

The default model (`Xenova/bert-base-NER`) matches or beats spaCy's small model on
people/orgs/locations. Larger or alternative models can be installed from the
ChatPanel extension's **Gateway** settings.

Prefer a local LLM or your own external NER service? Set `redaction.detection`
yourself and the gateway won't load the bundled one (yours takes precedence).

## Configuration

Precedence: defaults < `gateway.config.json` (or `$CHATPANEL_GATEWAY_CONFIG`) <
env vars. See [`gateway.config.example.json`](gateway.config.example.json).

| Key | Env | Default | Meaning |
|-----|-----|---------|---------|
| `backend` | — | `bridge` | `bridge` (drive CLI agents via login) or `api` (forward to a provider) |
| `bridge.url` | — | `http://127.0.0.1:4319` | the ChatPanel bridge |
| `bridge.agent` | — | `codex` | default agent the bridge drives |
| `bridge.token` | — | _(auto)_ | bridge bearer token; empty = read `~/.chatpanel/bridge-token` |
| `host` / `port` | `CHATPANEL_GATEWAY_HOST` / `_PORT` | `127.0.0.1` / `4320` | bind address |
| `upstreams.openai.baseUrl` | `OPENAI_BASE_URL` | `https://api.openai.com` | api backend only |
| `upstreams.anthropic.baseUrl` | `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | api backend only |
| `redaction.tier` | `CHATPANEL_REDACTION_TIER` | `basic` | `basic` (regex) or `full` (+ NER + dictionary) |
| `redaction.detection` | — | _(off → bundled engine)_ | external detector; set to override the bundled in-process one |
| `redaction.dictionary` | — | `[]` | custom `{ value\|pattern, type, alias? }` entries |
| `ner.autostart` | — | `true` | load the bundled in-process NER on startup |
| `ner.model` | — | `Xenova/bert-base-NER` | model id under `~/.chatpanel/models` |
| `ner.allowDownload` | — | `true` | download the model on first run if absent |

## Endpoints

| Route | Behavior |
|-------|----------|
| `GET /health` | `{ ok, version, backend, tier }` |
| `GET /v1/models` | the agent(s) this gateway exposes |
| `POST /v1/chat/completions` | OpenAI protocol — redact → backend → restore |
| `POST /v1/responses` | OpenAI Responses protocol (Codex) |
| `POST /v1/messages` | Anthropic protocol (Claude Code) |

Streaming (SSE) is supported on all three: placeholders are restored on the fly,
holding back a tail so a token split across chunks (`[[PER` … `SON_1]]`) still
restores cleanly.

## How it fits with ChatPanel

The [extension](https://github.com/chatpanel/chatpanel-extension) redacts inside
the browser; the [bridge](https://github.com/chatpanel/chatpanel-bridge) lets the
browser drive local CLI agents. This gateway reuses the bridge to put the **same
redaction engine** ([`@chatpanel/pii`](https://github.com/chatpanel/chatpanel-pii))
in front of *any* agent — so non-browser tools get the privacy too, and the
agent's own multi-turn loop is blinded, not just the first prompt.

## Caveats

- **Reversibility** is best-effort: if the model paraphrases a placeholder instead
  of echoing it, that one reference shows the token. The privacy guarantee (the
  real value never left the device) always holds.
- A dictionary **alias** is a *permanent* pseudonym — the agent sees the alias,
  not the original, by design.
- **Code edits**: redacting values that appear inside source can affect round-trip
  edits. The default tier touches only structured secrets and (in `full`) detected
  entities — keep your dictionary prose-focused.

## License

Source-available under the same license as the ChatPanel extension and bridge —
see [LICENSE](LICENSE).
