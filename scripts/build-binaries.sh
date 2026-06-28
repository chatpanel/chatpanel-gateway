#!/usr/bin/env bash
# Compile the gateway into standalone, single-file binaries (no Node required to
# run them). Needs Bun: https://bun.sh
#
# Note: the bundled spaCy NER server (ner/) is NOT embedded in the binary — NER
# autostart fails open to deterministic redaction in a compiled binary. Source/npm
# installs get the bundled NER.
set -euo pipefail
cd "$(dirname "$0")/.."
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