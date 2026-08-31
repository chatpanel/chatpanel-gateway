// Persist the observability access ring across gateway restarts.
//
// The pure ring (createAccessLog, @chatpanel/events) is in-memory by design. But the gateway
// restarts often — every update — and an empty "which agent read what" panel after each
// restart reads as "nothing is set up" when plenty is. So we back the ring with a tiny file:
// load it at start, debounce-write it on change. This is SAFE to persist because every event
// is already metadata only — client, tool, ms, and a REDACTED note (a search query's text is
// never in it). 0600, capped, under ~/.chatpanel.
//
// Kept out of the pure events module on purpose: persistence is a platform concern (node:fs),
// and the shared contract must stay dependency-free and runnable in a browser.

import { createAccessLog, ACCESS_LOG_MAX } from './observability.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';

const PATH = process.env.CHATPANEL_ACCESS_LOG || join(os.homedir(), '.chatpanel', 'access-log.json');

export function createPersistentAccessLog({ max = ACCESS_LOG_MAX, path = PATH, persistMs = 1000 } = {}) {
  const log = createAccessLog(max);

  // Load prior events, oldest-first, so the ring keeps chronological order.
  try {
    const arr = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(arr)) for (const e of arr) if (e && typeof e === 'object') log.push(e);
  } catch { /* no prior log, or unreadable — start empty */ }

  let timer = null;
  const persist = () => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // snapshot() is newest-first; store oldest-first so a reload preserves order.
      writeFileSync(path, JSON.stringify(log.snapshot().reverse()), { mode: 0o600 });
    } catch { /* best effort — telemetry must never break the gateway */ }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(persist, persistMs); if (timer.unref) timer.unref(); };

  return {
    push(evt) { const e = log.push(evt); schedule(); return e; },
    snapshot: (n) => log.snapshot(n),
    get size() { return log.size; },
    clear() { log.clear(); persist(); },
  };
}
