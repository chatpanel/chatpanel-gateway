#!/usr/bin/env bash
# ChatPanel Privacy Gateway installer — downloads the standalone binary for your
# OS and sets it to start at login. No Node.js required.
#
#   curl -fsSL https://raw.githubusercontent.com/chatpanel/chatpanel-gateway/main/scripts/install.sh | bash
#
# Downloading via curl means the file is NOT quarantined, so macOS won't show the
# "damaged / unidentified developer" prompt that browser downloads trigger.
#
# Needs the ChatPanel Bridge running + logged into codex/claude (backend: bridge).
set -euo pipefail

REPO="chatpanel/chatpanel-gateway"
os="$(uname -s)"
arch="$(uname -m)"
asset=""

case "$os" in
  Darwin)
    if [ "$arch" = "arm64" ]; then asset="chatpanel-gateway-macos-arm64"; else asset="chatpanel-gateway-macos-x64"; fi ;;
  Linux)
    asset="chatpanel-gateway-linux-x64" ;;
  *)
    echo "Unsupported OS ($os). Use:  npx chatpanel-gateway  (needs Node.js 18+)"; exit 1 ;;
esac

url="https://github.com/${REPO}/releases/latest/download/${asset}"
dest="${HOME}/.local/bin"
bin="${dest}/chatpanel-gateway"
mkdir -p "$dest"
tmp="$(mktemp "${dest}/.chatpanel-gateway.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

echo "Downloading ChatPanel Privacy Gateway (~60-95 MB)..."
curl -fL --progress-bar "$url" -o "$tmp"
chmod +x "$tmp"
xattr -c "$tmp" 2>/dev/null || true

# Clean upgrade: stop a running gateway so the new install replaces it in place.
pkill -f 'chatpanel-gateway' 2>/dev/null || true
sleep 1
rm -f "$bin"
mv "$tmp" "$bin"
trap - EXIT

echo "Installed to ${bin}"
"$bin" --install
echo
echo "ChatPanel Privacy Gateway is running and will start at login."
echo "Point OpenCode / Pi at  http://127.0.0.1:4320/v1  (model: codex or claude)."

case ":${PATH}:" in
  *":${dest}:"*) : ;;
  *) echo "Tip: add it to your PATH ->  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac