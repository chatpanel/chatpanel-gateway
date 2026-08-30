// Run the gateway test suite with EVERY on-disk path isolated from the user's real data.
//
// Two ways a test can clobber real data, both fixed here by redirecting the paths to a
// throwaway temp dir:
//   1. CONFIG — createGateway + a free-tier request makes freegate persist to configPath()
//      (~/.chatpanel/gateway.config.json). A run once left bridge.url pointing at an
//      ephemeral test port.
//   2. WARM STORE — createHistoryStore opens ~/.chatpanel/history.db (+ the JSON fallback
//      and key files). A test that ingests would inject fixture records into the user's
//      real warm index (it did: a stray "secret note" landed in a 1061-record store).
// Isolating both keeps the suite hermetic: it can never read or write the real corpus.
// The temp dir is removed after the run.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'cp-gw-test-'));
const files = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.js')).map((f) => `tests/${f}`);

const child = spawn(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CHATPANEL_GATEWAY_CONFIG: join(dir, 'gateway.config.json'),
    CHATPANEL_HISTORY_DB: join(dir, 'history.db'),
    CHATPANEL_HISTORY_STORE: join(dir, 'history-store.enc'),
    CHATPANEL_HISTORY_KEY: join(dir, 'history-key'),
    CHATPANEL_HISTORY_SECRET: join(dir, 'history-secret.enc'),
  },
});
child.on('close', (code) => {
  rmSync(dir, { recursive: true, force: true });
  process.exit(code || 0);
});
