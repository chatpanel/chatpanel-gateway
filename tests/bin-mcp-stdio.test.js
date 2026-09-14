// THE GATEWAY BIN AS THE EMBEDDED BRIDGE'S PER-TURN TOOL PROXY.
//
// With the bridge embedded (0.6.92+), the stdio MCP server every CLI agent spawns for
// ChatPanel's per-turn tools is `chatpanel-gateway [--bridge] --mcp-stdio <url>`. The bin
// once answered "unknown option: --mcp-stdio" (exit 2): Claude Code saw the tools as
// "Connection closed", a saved team ran as one agent, the board stayed empty. Both spellings
// must reach the bridge's proxy — the older embedded bridge sends the bare flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'chatpanel-gateway.js');
// A port nothing listens on: the proxy must answer the request with a JSON-RPC error, which
// proves the flag reached the bridge's proxy rather than the gateway's usage line.
const DEAD_URL = 'http://127.0.0.1:1/mcp/none';

function runProxy(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }) + '\n');
  });
}

for (const args of [['--mcp-stdio', DEAD_URL], ['--bridge', '--mcp-stdio', DEAD_URL]]) {
  test(`${args.slice(0, -1).join(' ')} <url> runs the bridge's stdio proxy`, async () => {
    const r = await runProxy(args);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.err, /unknown option/);
    const reply = JSON.parse(r.out.trim().split('\n').pop());
    assert.equal(reply.id, 7);
    assert.ok(reply.error, 'a dead upstream answers as a JSON-RPC error, not silence');
  });
}
