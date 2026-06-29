# ChatPanel Privacy Gateway installer (Windows) - no Node.js required.
#
#   irm https://dl.chatpanel.net/gateway/install.ps1 | iex
#
# Note: no `$ErrorActionPreference = 'Stop'` here, because native tools write
# progress/notices to stderr and that would be treated as fatal. We check exit
# codes explicitly instead.
$ProgressPreference = 'SilentlyContinue'

$url = 'https://dl.chatpanel.net/gateway/windows-x64.exe'
$dir = Join-Path $env:LOCALAPPDATA 'ChatPanel'
$bin = Join-Path $dir 'chatpanel-gateway.exe'
$tmp = "$bin.new"

Write-Host ""
Write-Host "Installing ChatPanel Privacy Gateway" -ForegroundColor Cyan

# Stop any running gateway for a clean in-place upgrade.
Get-Process -Name 'chatpanel-gateway' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "  Downloading the gateway (~110 MB)..." -ForegroundColor Gray
$ok = $false
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  & curl.exe -fL --progress-bar -o "$tmp" "$url"      # fast, real progress bar
  $ok = ($LASTEXITCODE -eq 0)
} else {
  try { Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing; $ok = $true } catch { $ok = $false }
}
if (-not $ok -or -not (Test-Path "$tmp")) {
  Write-Host "Download failed - check your connection and re-run." -ForegroundColor Red
  return
}

Unblock-File -Path "$tmp" -ErrorAction SilentlyContinue   # no SmartScreen mark-of-the-web
Move-Item -Force "$tmp" "$bin"

Write-Host "  Setting it to start at login..." -ForegroundColor Gray
& "$bin" --install
$installed = ($LASTEXITCODE -eq 0)

Write-Host ""
if ($installed) {
  Write-Host "Done. The ChatPanel Privacy Gateway is running on http://127.0.0.1:4320 and starts at login." -ForegroundColor Green
  Write-Host "First run downloads the redaction model (~100 MB, one-time) - name/org detection turns on once it's ready."
} else {
  Write-Host "Installed, but auto-start setup hit an issue. Start it manually with:" -ForegroundColor Yellow
  Write-Host "  `"$bin`""
}
Write-Host "Manage it:  `"$bin`" --status  |  --uninstall"
