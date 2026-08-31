// The access log survives a gateway restart (metadata only — safe to persist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersistentAccessLog } from '../src/access-log-store.js';
import { makeAccessEvent } from '../src/observability.js';

test('persists across restart, newest-first, and never writes the query text', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cp-al-')), 'access-log.json');
  const a = createPersistentAccessLog({ path, persistMs: 5 });
  a.push(makeAccessEvent({ ts: 1, client: 'Codex', tool: 'search_history', args: { query: 'my SSN 123-45-6789', limit: 3 } }));
  a.push(makeAccessEvent({ ts: 2, client: 'Claude Code', tool: 'get_record', args: { id: 'meeting:1' } }));
  await new Promise((r) => setTimeout(r, 30));

  const b = createPersistentAccessLog({ path }); // simulate a restart
  const snap = b.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].client, 'Claude Code', 'newest first');
  assert.equal(snap[1].client, 'Codex');
  assert.equal(snap[1].note, 'limit=3', 'safe filter kept');
  assert.ok(!JSON.stringify(snap).includes('123-45-6789'), 'PII query text never persisted');
});
