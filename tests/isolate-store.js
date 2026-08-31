// Import this FIRST in any test file that touches the warm store.
//
// node --test runs each test FILE in its own process, but they all inherited one
// CHATPANEL_HISTORY_DB path — so parallel files wrote to the same SQLite file and a test
// asserting "the store now holds 2 records" could be counting a neighbour's fixtures.
// Setting a unique path per process, before src/server.js is imported (it opens the store at
// module load), makes each file's store genuinely its own.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), `cp-store-${process.pid}-`));
process.env.CHATPANEL_HISTORY_DB = join(dir, 'history.db');
process.env.CHATPANEL_HISTORY_STORE = join(dir, 'history-store.enc');
process.env.CHATPANEL_HISTORY_KEY = join(dir, 'history-key');
process.env.CHATPANEL_HISTORY_SECRET = join(dir, 'history-secret.enc');
process.env.CHATPANEL_ACCESS_LOG = join(dir, 'access-log.json');
