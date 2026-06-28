#!/usr/bin/env bash
# One-shot: create the venv (if needed), install deps + the spaCy model, and serve.
# Usage:  ./run.sh        (defaults to port 9009)
#         PORT=9100 ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "→ creating virtual env (.venv)…"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "→ installing dependencies…"
pip install -q --upgrade pip
pip install -q -r requirements.txt
python -c "import en_core_web_sm" >/dev/null 2>&1 || python -m spacy download en_core_web_sm

echo "→ serving on http://127.0.0.1:${PORT:-9009}/ner  (Ctrl-C to stop)"
exec uvicorn server:app --port "${PORT:-9009}"
