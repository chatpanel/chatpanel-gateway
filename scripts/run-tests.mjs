// Run the gateway test suite with the config path isolated from the user's real one.
//
// A test that starts a gateway (createGateway) and makes a free-tier request triggers
// freegate to persist config to configPath() — which defaults to ~/.chatpanel/gateway.config.json.
// Without isolation that OVERWRITES the user's real gateway config with the test fixture
// (it did: a run left bridge.url pointing at an ephemeral test port). Point every test
// process at a throwaway file instead. A single shared temp is fine — the goal is only to
// keep the real config untouched — and it is removed after the run.
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
  env: { ...process.env, CHATPANEL_GATEWAY_CONFIG: join(dir, 'gateway.config.json') },
});
child.on('close', (code) => {
  rmSync(dir, { recursive: true, force: true });
  process.exit(code || 0);
});
