# ChatPanel — local NER helper (spaCy)

A ~30-line local service that lets ChatPanel **auto-redact names, organizations,
and locations** before anything is sent to a chat model. Detection runs entirely
on your machine; the model only ever sees placeholders like `[[PERSON_1]]`.

ChatPanel's redaction contract is simple — any local HTTP service works:

```
POST /ner   { "text": "..." }
→           { "entities": [ { "value": "Alex", "type": "PERSON" }, ... ] }
```

(spaCy's `{ "ents": [{ "text", "label" }] }` shape is also accepted, as is a
local OpenAI-compatible LLM — see "Other detectors" below.)

## Quick start

Most machines block installing Python packages globally, so use a virtual env:

```bash
cd helpers/ner-server

python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m spacy download en_core_web_sm

uvicorn server:app --port 9009       # the file is server.py → import path "server:app"
```

…or just run the bundled script (does all of the above):

```bash
./run.sh                             # PORT=9100 ./run.sh to change the port
```

Check it's up: `curl http://127.0.0.1:9009/health`

## Point ChatPanel at it

**Settings → Privacy** (or the 🛡 button in the chat composer):

| Field | Value |
|------|-------|
| Redaction | **On — + AI detection** |
| Detector | **Local NER service (spaCy / Presidio)** |
| Detector URL | `http://127.0.0.1:9009/ner` |
| Redact types | People / Organizations / Locations / Numbers (your choice) |

Now `my name is Alex from Denver` is sent to the model as
`my name is [[PERSON_1]] from [[LOCATION_1]]`, and the reply is restored to the
real values in your view.

> Turning **Locations** off keeps city names readable (useful for "how far is X
> from Y" questions) while still redacting people.

## Accuracy vs. speed

`en_core_web_sm` is small and fast (good default). For fewer misses:

```bash
python -m spacy download en_core_web_md     # or en_core_web_trf (best, heavier)
```

then change `MODEL` in `server.py`. Small models can over-tag short acronyms as
`ORG`; ChatPanel drops noisy short numerics/dates automatically and lets you turn
off whole categories.

## Other detectors

ChatPanel doesn't care what's behind the URL, as long as it returns the entity
shape above. Drop-in alternatives:

- **Microsoft Presidio** — `presidio-analyzer` behind a small FastAPI wrapper
  (returns `{ "results": [...] }`, also accepted).
- **A local LLM** — set the detector to **Local LLM (OpenAI-compatible)** and
  point it at Ollama / LM Studio / llama.cpp (e.g. `http://127.0.0.1:11434`);
  ChatPanel prompts it for strict JSON entities. Slower than spaCy, no extra
  service to run if you already have a local model. See `../local-model.md`.

Everything is local and latency-guarded (cached + timed out + fail-open): if the
detector is slow or down, ChatPanel falls back to deterministic redaction so chat
never blocks.
