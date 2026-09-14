#!/usr/bin/env bash
# ChatPanel Gateway installer — THE one thing to install. Downloads the standalone
# binary for your OS and sets it to start at login. No Node.js required.
#
#   curl -fsSL https://dl.chatpanel.net/install.sh | bash
#
# The gateway carries the bridge: it starts the embedded bridge itself (or adopts one
# already running — the desktop app's, or a standalone you installed), so local coding
# agents (Claude Code, Codex, …) work without a second installer. Log into those CLIs
# as you normally would.
#
# Downloading via curl means the file is NOT quarantined, so macOS won't show the
# "damaged / unidentified developer" prompt that browser downloads trigger.
set -euo pipefail

os="$(uname -s)"
arch="$(uname -m)"
asset=""

case "$os" in
  Darwin)
    if [ "$arch" = "arm64" ]; then asset="gateway/macos-arm64"; else asset="gateway/macos-x64"; fi ;;
  Linux)
    asset="gateway/linux-x64" ;;
  *)
    echo "Unsupported OS ($os). Use:  npx @chatpanel/gateway  (needs Node.js 18+)"; exit 1 ;;
esac

# Served (and counted) by dl.chatpanel.net, which proxies the GitHub release.
url="https://dl.chatpanel.net/${asset}"
dest="${HOME}/.local/bin"
bin="${dest}/chatpanel-gateway"
mkdir -p "$dest"
tmp="$(mktemp "${dest}/.chatpanel-gateway.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

echo "Downloading ChatPanel Gateway (~80-100 MB, bridge included)..."
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
echo "ChatPanel Gateway is running and will start at login — with the bridge for local"
echo "coding agents (Claude Code, Codex, …) started alongside it. Nothing else to install."
echo "The extension and the desktop app find it at http://127.0.0.1:4320."
echo "Point OpenCode / Pi at  http://127.0.0.1:4320/v1  (model: codex or claude)."

case ":${PATH}:" in
  *":${dest}:"*) : ;;
  *) echo "Tip: add it to your PATH ->  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac