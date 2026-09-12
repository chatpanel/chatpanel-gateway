import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrefsStore } from '../src/prefs-store.js';

const fresh = () => createPrefsStore({ storePath: join(mkdtempSync(join(tmpdir(), 'cp-prefs-')), 'prefs-store.enc') });

test('a newer stamp wins, an older one is kept and handed back, and the file is ciphertext', () => {
  const s = fresh();
  let r = s.put({ mcpServers: { value: [{ id: 'jira', headers: { Authorization: 'Bearer SECRET' } }], updatedAt: 100 } }, { by: 'extension' });
  assert.deepEqual(r.applied, ['mcpServers']);
  r = s.put({ mcpServers: { value: [{ id: 'linear' }], updatedAt: 50 } }, { by: 'desktop' });
  assert.deepEqual(r.kept, ['mcpServers']);
  assert.equal(r.sections.mcpServers.value[0].id, 'jira', 'the loser gets the held copy back');
  assert.equal(r.sections.mcpServers.by, 'extension');
  r = s.put({ mcpServers: { value: [{ id: 'linear' }], updatedAt: 200 } }, { by: 'desktop' });
  assert.deepEqual(r.applied, ['mcpServers']);
  assert.equal(s.get('mcpServers').mcpServers.value[0].id, 'linear');
  assert.equal(s.revision, 2);
  const raw = readFileSync(s.path, 'utf8');
  assert.ok(!raw.includes('SECRET') && !raw.includes('jira'), 'nothing readable at rest');
  const again = createPrefsStore({ storePath: s.path });
  assert.equal(again.get().mcpServers.updatedAt, 200);
  assert.equal(again.revision, 2);
});

test('bad section ids, missing stamps and oversize values are refused without touching the rest', () => {
  const s = fresh();
  const r = s.put({
    'evil/../x': { value: 1, updatedAt: 1 },
    nostamp: { value: 1 },
    huge: { value: 'x'.repeat(600 * 1024), updatedAt: 1 },
    tools: { value: { maxToolsPerTurn: 8 }, updatedAt: 1 },
  });
  assert.deepEqual(r.applied, ['tools']);
  assert.deepEqual(Object.keys(s.get()), ['tools']);
  assert.deepEqual(s.stamps(), { tools: 1 });
  assert.equal(s.remove('tools'), true);
  assert.equal(s.remove('tools'), false);
  assert.ok(existsSync(s.path));
});

test('values are copies — mutating what you got back changes nothing', () => {
  const s = fresh();
  s.put({ skills: { value: [{ id: 'a' }], updatedAt: 1 } });
  const got = s.get('skills').skills.value;
  got.push({ id: 'b' });
  assert.equal(s.get('skills').skills.value.length, 1);
});

// ---- the route ----
import './isolate-store.js';
import { createGateway } from '../src/server.js';
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const ADMIN = { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'content-type': 'application/json' };
const start = async () => {
  const gw = createGateway({ host: '127.0.0.1', port: 0, redaction: { tier: 'basic', detection: { backend: 'off' } }, ner: { autostart: false }, logRequests: false });
  const port = await listen(gw);
  return { gw, url: `http://127.0.0.1:${port}` };
};

test('/v1/prefs is admin-gated for READS as well as writes', async () => {
  const { gw, url } = await start();
  assert.equal((await fetch(`${url}/v1/prefs`)).status, 403);
  assert.equal((await fetch(`${url}/v1/prefs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  gw.close();
});

test('two clients converge through /v1/prefs: push, lose, take the winner', async () => {
  const { gw, url } = await start();
  const push = (sections, by) => fetch(`${url}/v1/prefs`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ sections, by }) }).then((r) => r.json());
  const ext = await push({ webSearch: { value: { enabled: true }, updatedAt: 1000 } }, 'extension');
  assert.deepEqual(ext.applied, ['webSearch']);
  const desk = await push({ webSearch: { value: { enabled: false }, updatedAt: 900 }, tools: { value: { maxToolsPerTurn: 8 }, updatedAt: 1200 } }, 'desktop');
  assert.deepEqual(desk.applied, ['tools']);
  assert.deepEqual(desk.kept, ['webSearch']);
  assert.equal(desk.sections.webSearch.value.enabled, true, 'the desktop is handed the extension\'s copy');
  const all = await (await fetch(`${url}/v1/prefs`, { headers: ADMIN })).json();
  assert.deepEqual(Object.keys(all.sections).sort(), ['tools', 'webSearch']);
  assert.equal(all.sections.tools.by, 'desktop');
  const stamps = await (await fetch(`${url}/v1/prefs?stamps=1`, { headers: ADMIN })).json();
  assert.deepEqual(stamps.stamps, { webSearch: 1000, tools: 1200 });
  const one = await (await fetch(`${url}/v1/prefs?section=tools`, { headers: ADMIN })).json();
  assert.deepEqual(Object.keys(one.sections), ['tools']);
  const del = await (await fetch(`${url}/v1/prefs?section=tools`, { method: 'DELETE', headers: ADMIN })).json();
  assert.equal(del.removed, true);
  gw.close();
});
