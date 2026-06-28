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

const NER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy(port, signal) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal });
    return res.ok;
  } catch {
    return false;
  }
}

// Launch + supervise the NER server. Returns { stop() } or null if not started.
// Mutates cfg.redaction once the server answers /health.
export function startNer(cfg) {
  const n = cfg.ner;
  if (!n || !n.autostart) return null;

  // Respect an explicitly-configured detector — don't double-launch.
  const det = cfg.redaction?.detection;
  if (det && det.backend && det.backend !== 'off') {
    console.log(`[ner] detection already configured (${det.backend}) — not autostarting bundled server`);
    return null;
  }

  const port = n.port || 9009;
  let child;
  try {
    child = spawn('bash', ['run.sh'], {
      cwd: NER_DIR,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.log(`[ner] could not launch bundled NER (${e.message}) — deterministic redaction only`);
    return null;
  }

  let firstRun = true;
  child.stdout?.on('data', (b) => {
    const s = b.toString();
    if (firstRun && /installing dependencies/i.test(s)) {
      firstRun = false;
      console.log('[ner] first run: creating venv + installing spaCy (one-time, may take a minute)…');
    }
  });
  child.stderr?.on('data', () => { /* uvicorn logs to stderr; swallow */ });
  child.on('error', (e) => {
    console.log(`[ner] failed to start (${e.message}). Is python3 installed? Falling back to deterministic redaction.`);
  });
  child.on('exit', (code) => {
    if (code && code !== 0 && !stopped) {
      console.log(`[ner] server exited (code ${code}); redaction continues deterministic-only.`);
    }
  });

  // Poll for readiness without blocking server start; wire detection when up.
  const ac = new AbortController();
  (async () => {
    const deadline = Date.now() + 120_000; // generous: first run installs deps
    while (Date.now() < deadline && !stopped) {
      if (await healthy(port, ac.signal)) {
        cfg.redaction.detection = {
          backend: 'endpoint',
          url: `http://127.0.0.1:${port}/ner`,
          timeoutMs: 1500,
          maxChars: 8000,
        };
        if (n.enableFullTier && cfg.redaction.tier !== 'full') cfg.redaction.tier = 'full';
        console.log(`[ner] ready on http://127.0.0.1:${port}/ner — entity redaction active (tier: ${cfg.redaction.tier})`);
        return;
      }
      await sleep(1000);
    }
    if (!stopped) console.log('[ner] not ready after 120s — continuing deterministic-only (run ./ner/run.sh manually to debug).');
  })();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    ac.abort();
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  };
  return { stop };
}
