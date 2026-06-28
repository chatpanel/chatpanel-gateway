#!/usr/bin/env bash
# Compile the gateway into standalone, single-file binaries (no Node required to
# run them). Needs Bun: https://bun.sh
#
# The spaCy NER server (ner/) IS embedded — base64'd into src/ner-assets.js — so a
# compiled binary materializes a runnable ner/ to ~/.chatpanel/ner at startup and
# autostarts NER (venv + install + serve) just like the npm install.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/gen-ner-assets.mjs   # keep embedded NER in lockstep with ner/
mkdir -p dist
rm -f dist/chatpanel-gateway-*

targets=(
  "bun-darwin-arm64:chatpanel-gateway-macos-arm64"
  "bun-darwin-x64:chatpanel-gateway-macos-x64"
  "bun-linux-x64:chatpanel-gateway-linux-x64"
  "bun-windows-x64:chatpanel-gateway-windows-x64.exe"
)
for t in "${targets[@]}"; do
  target="${t%%:*}"; out="${t##*:}"
  echo "→ building dist/$out ($target)"
  bun build bin/chatpanel-gateway.js --compile --target="$target" --outfile "dist/$out"
done
echo "✓ binaries in dist/"
ls -la dist