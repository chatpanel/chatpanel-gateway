// Managed local NER server. When cfg.ner.autostart is on, launching the gateway
// also spins up the bundled spaCy detector (./ner) and wires redaction.detection
// at it — so name/org redaction works with a single command, no second terminal.
//
// Fail-open by design: if Python/spaCy isn't set up, we log a one-line hint and
// the gateway keeps running with deterministic-only redaction (the detector layer
// is already cached + fail-open per request).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import os from 'node:os';

const NER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ner');

// A login service (LaunchAgent / systemd) inherits a MINIMAL PATH — not your
// shell's — so `bash` and a pyenv/homebrew `python3` aren't found. Resolve bash
// absolutely and enrich PATH with the usual locations so run.sh + python3 work.
function resolveBash() {
  for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
    if (existsSync(p)) return p;
  }
  return 'bash';
}

function enrichedPath(home = os.homedir(), base = process.env.PATH || '') {
  const extra = [
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    join(home, '.pyenv', 'shims'), join(home, '.pyenv', 'bin'),
    join(home, '.local', 'bin'),
  ];
  return [...new Set([...base.split(':').filter(Boolean), ...extra])].join(':');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Probe the ACTUAL /ner contract (POST {text} -> {entities}), not /health: many
// NER servers (incl. a user's own) expose only /ner. If anything answers here, we
// can use it as the detector.
async function nerReachable(port, signal) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ping' }),
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Launch + supervise the NER server (or adopt one already on the port). Returns
// { stop() } or null if not started. Mutates cfg.redaction once NER answers.
export function startNer(cfg) {
  const n = cfg.ner;
  if (!n || !n.autostart) return null;

  // Respect an explicitly-configured detector — don't relaunch — but still apply
  // the full-tier bump (else a persisted config with detection-on but tier:basic
  // would never redact entities even though a detector is available).
  const det = cfg.redaction?.detection;
  if (det && det.backend && det.backend !== 'off') {
    if (n.enableFullTier && cfg.redaction.tier !== 'full') cfg.redaction.tier = 'full';
    console.log(`[ner] detection already configured (${det.backend}) — full tier ${cfg.redaction.tier === 'full' ? 'on' : 'off'}`);
    return null;
  }

  const port = n.port || 9009;
  let stopped = false;
  let child = null;
  const ac = new AbortController();

  const wire = (how) => {
    cfg.redaction.detection = { backend: 'endpoint', url: `http://127.0.0.1:${port}/ner`, timeoutMs: 1500, maxChars: 8000 };
    if (n.enableFullTier && cfg.redaction.tier !== 'full') cfg.redaction.tier = 'full';
    console.log(`[ner] ${how} on http://127.0.0.1:${port}/ner — entity detection active (tier: ${cfg.redaction.tier})`);
  };

  (async () => {
    // 1) Adopt an existing NER already serving on the port (e.g. the user's own).
    if (await nerReachable(port, ac.signal)) { wire('using existing NER'); return; }

    // 2) Otherwise launch the bundled spaCy server.
    try {
      child = spawn(resolveBash(), ['run.sh'], {
        cwd: NER_DIR,
        env: {
          ...process.env,
          PORT: String(port),
          PATH: enrichedPath(),
          // Force official PyPI: a machine pinned to a private/corp index (in
          // pip.conf) can't reach it off-VPN, which breaks the one-time install.
          PIP_INDEX_URL: process.env.CHATPANEL_PIP_INDEX_URL || 'https://pypi.org/simple',
          PIP_EXTRA_INDEX_URL: '',
          PIP_DISABLE_PIP_VERSION_CHECK: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      console.log(`[ner] could not launch bundled NER (${e.message}) — deterministic redaction only`);
      return;
    }
    let firstRun = true;
    child.stdout?.on('data', (b) => {
      if (firstRun && /installing dependencies/i.test(b.toString())) {
        firstRun = false;
        console.log('[ner] first run: creating venv + installing spaCy (one-time, may take a minute)…');
      }
    });
    child.stderr?.on('data', () => { /* uvicorn logs to stderr; swallow */ });
    child.on('error', (e) => console.log(`[ner] failed to start (${e.message}). Is python3 installed? Falling back to deterministic redaction.`));
    child.on('exit', (code) => {
      if (code && code !== 0 && !stopped) {
        // The bundled one couldn't bind (often the port is taken by another NER).
        // If SOMETHING answers /ner there, adopt it instead of giving up.
        nerReachable(port, ac.signal).then((ok) => { if (ok && !stopped) wire('adopted NER'); else if (!stopped) console.log(`[ner] server exited (code ${code}); deterministic-only.`); });
      }
    });

    // 3) Poll for readiness; wire detection when up.
    const deadline = Date.now() + 120_000; // generous: first run installs deps
    while (Date.now() < deadline && !stopped) {
      if (await nerReachable(port, ac.signal)) { wire('ready'); return; }
      await sleep(1000);
    }
    if (!stopped) console.log('[ner] not ready after 120s — continuing deterministic-only (run ./ner/run.sh manually to debug).');
  })();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    ac.abort();
    try { child?.kill('SIGTERM'); } catch { /* ignore */ }
  };
  return { stop };
}
