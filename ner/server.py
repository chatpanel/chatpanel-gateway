"""
ChatPanel local NER helper — a tiny on-device entity detector for PII redaction.

ChatPanel's Privacy → "AI detection" can point at any LOCAL service that accepts
    POST {"text": "..."}
and returns
    {"entities": [{"value": "...", "type": "PERSON|ORG|GPE|EMAIL|PHONE|..."}]}

This wraps spaCy (people / organizations / locations) AND adds a regex pass for
the structured identifiers spaCy doesn't emit (emails, phone numbers, SSNs, cards,
IPs), so the detector is comprehensive on its own. Only the redacted placeholders
(e.g. [[PERSON_1]]) ever reach the chat model — the raw text never leaves your box.

--------------------------------------------------------------------------------
Setup  (most machines block global pip installs, so use a virtual env)

    python3 -m venv .venv
    source .venv/bin/activate          # Windows: .venv\\Scripts\\activate
    pip install -r requirements.txt
    python -m spacy download en_core_web_sm

Run  (the file is server.py, so the uvicorn import path is "server:app")

    uvicorn server:app --port 9009

Then in ChatPanel → Settings → Privacy:
    Redaction : On — + AI detection
    Detector  : Local NER service (spaCy / Presidio)
    URL       : http://127.0.0.1:9009/ner

Tip: en_core_web_sm is small + fast. For better accuracy use en_core_web_md or
en_core_web_trf (download the same way, then change the load below).
--------------------------------------------------------------------------------
"""
from fastapi import FastAPI

import re
import spacy

MODEL = "en_core_web_sm"
nlp = spacy.load(MODEL)

app = FastAPI(title="ChatPanel NER helper")

# spaCy's NER emits names / orgs / locations but NOT structured identifiers, so add
# a regex pass for those. (ChatPanel also catches these on-device, but emitting them
# here keeps the detector self-contained — what you test is what you get.) Order
# matters: more specific patterns run first so a card / SSN isn't re-matched as a
# phone number.
_PATTERNS = [
    ("EMAIL", re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")),
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("CREDIT_CARD", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    ("IP", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("PHONE", re.compile(r"(?<!\d)(?:\+?\d{1,2}[ .\-]?)?\(?\d{3}\)?[ .\-]?\d{3}[ .\-]?\d{4}(?!\d)")),
]


def _regex_entities(text):
    out, taken = [], []
    for label, rx in _PATTERNS:
        for m in rx.finditer(text):
            start, end = m.start(), m.end()
            if any(start < te and ts < end for ts, te in taken):
                continue  # span already claimed by a more specific pattern
            taken.append((start, end))
            out.append({"value": m.group(0).strip(), "type": label})
    return out


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


@app.post("/ner")
def ner(payload: dict):
    """Return spaCy entities + regex identifiers in ChatPanel's expected shape.

    ChatPanel maps common labels itself (PER→PERSON, GPE→LOCATION, …) and keeps
    only the categories you enable in the Privacy tab, so it's fine to return all
    of them here.
    """
    text = (payload or {}).get("text", "") or ""
    doc = nlp(text)
    ents = [{"value": ent.text, "type": ent.label_} for ent in doc.ents]
    ents.extend(_regex_entities(text))
    # De-dup identical value+type (spaCy and a regex can both surface the same span).
    seen, out = set(), []
    for e in ents:
        key = (e["type"], e["value"].lower())
        if e["value"] and key not in seen:
            seen.add(key)
            out.append(e)
    return {"entities": out}
