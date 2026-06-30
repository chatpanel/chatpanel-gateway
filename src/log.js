// Timestamped console. Gateway logs (NER lifecycle, per-request redaction lines,
// entitlement refresh) are useless for debugging without a clock — prefix every
// console line with a local YYYY-MM-DD HH:MM:SS stamp. Call once at startup,
// before anything logs. Idempotent (won't double-wrap if called twice).

let installed = false;

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function installTimestampedConsole() {
  if (installed) return;
  installed = true;
  for (const method of ['log', 'info', 'warn', 'error']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => orig(`[${stamp()}]`, ...args);
  }
}
