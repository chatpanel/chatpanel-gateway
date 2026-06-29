#!/usr/bin/env bash
# Compile the gateway into standalone, single-file binaries (no Node required to
# run them). Needs Bun: https://bun.sh
#
# NER runs IN-PROCESS on the onnxruntime-web WASM runtime — no Python, no second
# port, no native addon. The actual build is scripts/build.mjs (it needs the
# Bun.build() API to alias the native onnxruntime-node/sharp imports to stubs and
# embed the ORT wasm files; the CLI `bun build --compile` can't take plugins).
# Model weights are NOT embedded; they download once to ~/.chatpanel/models on
# first run (or are placed there by the extension's model manager).
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun scripts/build.mjs "$@"
