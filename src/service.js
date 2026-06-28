// Background auto-start for the ChatPanel Privacy Gateway — same approach as the
// bridge, so it can run as an always-on login process with no terminal.
//
//   chatpanel-gateway --install     register login auto-start + start now
//   chatpanel-gateway --uninstall   remove it
//   chatpanel-gateway --status      is it registered?
//
// macOS → LaunchAgent · Windows → HKCU Run (hidden VBS) · Linux → systemd user.

import os from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const LABEL = 'net.chatpanel.gateway';
const DISPLAY = 'ChatPanel Privacy Gateway';

// The command that launches THIS gateway. A compiled single-file binary launches
// itself; running under node launches the interpreter + the bin entry.
export function resolveLaunch() {
  const exe = process.execPath;
  const base = path.basename(exe).toLowerCase();
  const underInterpreter = base.startsWith('node') || base.startsWith('bun');
  if (underInterpreter && process.argv[1]) {
    return { program: exe, args: [path.resolve(process.argv[1])] };
  }
  return { program: exe, args: [] };
}

function logPaths() {
  const dir = path.join(os.homedir(), '.chatpanel');
  mkdirSync(dir, { recursive: true });
  return { out: path.join(dir, 'gateway.log'), err: path.join(dir, 'gateway.err.log') };
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

// ---------------------------------------------------------------- macOS
const macPlist = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function macInstall() {
  const { program, args } = resolveLaunch();
  const { out, err } = logPaths();
  const progArgs = [program, ...args].map((a) => `      <string>${a}</string>`).join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${progArgs}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${out}</string>
    <key>StandardErrorPath</key><string>${err}</string>
  </dict>
</plist>
`;
  const p = macPlist();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, plist);
  run('launchctl', ['unload', p]);
  const r = run('launchctl', ['load', '-w', p]);
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || 'launchctl load failed');
}
function macUninstall() {
  const p = macPlist();
  run('launchctl', ['unload', '-w', p]);
  if (existsSync(p)) rmSync(p);
}
function macStatus() {
  return (run('launchctl', ['list']).stdout || '').includes(LABEL);
}

// ---------------------------------------------------------------- Windows
const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_RUN_NAME = 'ChatPanelGateway';
const winVbs = () => path.join(os.homedir(), '.chatpanel', 'gateway-launch.vbs');

function winInstall() {
  const { program, args } = resolveLaunch();
  const parts = [program, ...args].map((p) => `""${p}""`).join(' ');
  const vbs = winVbs();
  mkdirSync(path.dirname(vbs), { recursive: true });
  writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${parts}", 0, False\r\n`);
  const r = run('reg', ['add', WIN_RUN_KEY, '/v', WIN_RUN_NAME, '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f']);
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || 'reg add failed');
  run('wscript.exe', [vbs]);
}
function winUninstall() {
  run('reg', ['delete', WIN_RUN_KEY, '/v', WIN_RUN_NAME, '/f']);
  run('taskkill', ['/IM', 'chatpanel-gateway.exe', '/F']);
}
function winStatus() {
  return run('reg', ['query', WIN_RUN_KEY, '/v', WIN_RUN_NAME]).status === 0;
}

// ---------------------------------------------------------------- Linux (systemd user)
const linUnit = () => path.join(os.homedir(), '.config', 'systemd', 'user', 'chatpanel-gateway.service');

function linInstall() {
  const { program, args } = resolveLaunch();
  const exec = [program, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const unit = `[Unit]
Description=${DISPLAY}
After=network.target

[Service]
ExecStart=${exec}
Restart=on-failure

[Install]
WantedBy=default.target
`;
  const p = linUnit();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, unit);
  run('systemctl', ['--user', 'daemon-reload']);
  const r = run('systemctl', ['--user', 'enable', '--now', 'chatpanel-gateway']);
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || 'systemctl enable failed');
}
function linUninstall() {
  run('systemctl', ['--user', 'disable', '--now', 'chatpanel-gateway']);
  const p = linUnit();
  if (existsSync(p)) rmSync(p);
}
function linStatus() {
  return (run('systemctl', ['--user', 'is-enabled', 'chatpanel-gateway']).stdout || '').trim() === 'enabled';
}

// ---------------------------------------------------------------- dispatch
function byPlatform(mac, win, lin) {
  if (process.platform === 'darwin') return mac();
  if (process.platform === 'win32') return win();
  if (process.platform === 'linux') return lin();
  throw new Error(`Auto-start isn't supported on ${process.platform} yet — run the gateway directly.`);
}

export function installService() { return byPlatform(macInstall, winInstall, linInstall); }
export function uninstallService() { return byPlatform(macUninstall, winUninstall, linUninstall); }
export function serviceStatus() { return byPlatform(macStatus, winStatus, linStatus); }
