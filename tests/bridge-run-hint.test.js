// A team role's run options — grants, worktree, connection — travel from a client to the
// bridge through the gateway: in the X-ChatPanel-Run header (the body belongs to the
// provider), or the legacy body field; shaped on the way, and never on an API destination.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGateway } from '../src/server.js';

const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));

async function fakeBridge() {
  const seen = [];
  const s = createServer((req, res) => {
    if (req.url.startsWith('/health')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, version: '0.11.19', agents: [{ id: 'claude', available: true }] })); }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { seen.push(null); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'delta', text: 'ok' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', text: '' })}\n\n`);
      res.end();
    });
  });
  return { port: await listen(s), close: () => s.close(), seen };
}

const cfg = (bridgePort) => ({
  host: '127.0.0.1', port: 0, backend: 'bridge',
  bridge: { url: `http://127.0.0.1:${bridgePort}`, workingDir: '/home/me/default' },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true },
  logRequests: false,
});

test('the run hint reaches the bridge as options — header first, legacy body field too; plain and tool-using turns alike', async () => {
  const br = await fakeBridge();
  const gw = createGateway(cfg(br.port));
  const port = await listen(gw);
  const run = { grants: ['shell', 'scm:push'], workspace: { repo: '/repos/x', projectId: 'feature', jobId: 'run_1' }, connectionId: 'gh', token: 'must-not-pass' };
  try {
    // Header, plain turn.
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chatpanel-run': encodeURIComponent(JSON.stringify(run)) }, body: JSON.stringify({ model: 'claude/opus', messages: [{ role: 'user', content: 'hi' }], stream: true }) }).then((r) => r.text());
    let o = br.seen.at(-1).options;
    assert.deepEqual(o.grants, ['shell', 'scm:push']);
    assert.deepEqual(o.workspace, { repo: '/repos/x', projectId: 'feature', jobId: 'run_1' });
    assert.equal(o.connectionId, 'gh'); assert.equal(o.token, undefined, 'only the shaped fields pass');
    assert.equal(o.model, 'opus'); assert.equal(o.workingDir, '/home/me/default', 'the gateway’s own defaults still ride along');
    // Legacy body field, tool-using turn (the relay path).
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude/opus', messages: [{ role: 'user', content: 'hi' }], stream: true, tools: [{ type: 'function', function: { name: 'find', parameters: { type: 'object', properties: {} } } }], chatpanel: { run } }) }).then((r) => r.text());
    o = br.seen.at(-1).options;
    assert.deepEqual(o.grants, ['shell', 'scm:push']); assert.equal(o.workspace.repo, '/repos/x'); assert.equal(o.model, 'opus', 'the model half rides the relay path too');
    // No hint: nothing added.
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }], stream: true }) }).then((r) => r.text());
    o = br.seen.at(-1).options;
    assert.equal(o.grants, undefined); assert.equal(o.workspace, undefined);
  } finally { gw.close(); br.close(); }
});
