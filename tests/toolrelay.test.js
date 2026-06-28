// Tool-relay: OpenCode's tools → codex (via the bridge) → back to OpenCode.
// A fake bridge emits a tool_request mid-/chat, parks until /tool-result, then
// finishes. We assert the gateway surfaces an OpenAI tool_call (with restored
// args), accepts the follow-up tool result, and streams the final reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGateway } from '../src/server.js';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

// Fake bridge: on /chat it streams a tool_request and waits; /tool-result resumes
// it to emit the final delta + done.
async function fakeBridge() {
  let resume; // resolve when /tool-result arrives
  let toolResultSeen = null;
  const s = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (req.url === '/chat') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // ask the caller to run a tool, with an arg referencing the redacted email
        const token = (body.messages.map((m) => m.content).join(' ').match(/\[\[EMAIL_1\]\]/) || ['[[EMAIL_1]]'])[0];
        res.write(`data: ${JSON.stringify({ type: 'tool_request', session: 'sess1', id: 't1', name: 'lookup', input: { q: token } })}\n\n`);
        await new Promise((r) => { resume = r; });
        res.write(`data: ${JSON.stringify({ type: 'delta', text: 'done looking up ' + token })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      } else if (req.url === '/tool-result') {
        toolResultSeen = body;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
        resume && resume();
      }
    });
  });
  const port = await listen(s);
  return { port, close: () => s.close(), get toolResult() { return toolResultSeen; } };
}

const cfg = (bridgeUrl) => ({
  host: '127.0.0.1', port: 0, backend: 'bridge',
  bridge: { url: bridgeUrl, agent: 'codex', token: '' },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' } },
  ner: { autostart: false }, allowedOrigins: [], maxBodyBytes: 1 << 20, logRequests: false,
});

async function readSSE(res) { return await res.text(); }

test('relay: tool_request → OpenAI tool_call (args restored), then result → final reply', async () => {
  const br = await fakeBridge();
  const gw = createGateway(cfg(`http://127.0.0.1:${br.port}`));
  const port = await listen(gw);
  const base = `http://127.0.0.1:${port}/v1/chat/completions`;

  // 1) initial turn with tools + a PII email in the prompt
  const r1 = await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'codex', stream: true, tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      messages: [{ role: 'user', content: 'look up alex@example.com' }] }),
  });
  const s1 = await readSSE(r1);
  // surfaced as an OpenAI tool_call, finish_reason tool_calls, with the email RESTORED in the args
  assert.match(s1, /"tool_calls"/);
  assert.match(s1, /"name":"lookup"/);
  assert.match(s1, /alex@example\.com/, 'tool args restored to the real value for the client');
  assert.doesNotMatch(s1, /\[\[EMAIL_1\]\]/);
  assert.match(s1, /"finish_reason":"tool_calls"/);
  const toolCallId = JSON.parse(s1.split('\n').find((l) => l.includes('tool_calls')).slice(6)).choices[0].delta.tool_calls[0].id;

  // 2) follow-up turn carrying the tool result
  const r2 = await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'codex', stream: true, tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      messages: [
        { role: 'user', content: 'look up alex@example.com' },
        { role: 'assistant', tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: toolCallId, content: 'found alex@example.com in records' },
      ] }),
  });
  const s2 = await readSSE(r2);
  assert.match(s2, /done looking up/, 'final reply streamed after the tool result');
  assert.match(s2, /data: \[DONE\]/);
  // the bridge received the tool result REDACTED (codex never sees the real email)
  assert.ok(br.toolResult, 'bridge got a /tool-result');
  assert.doesNotMatch(String(br.toolResult.result), /alex@example\.com/);
  assert.match(String(br.toolResult.result), /\[\[EMAIL_1\]\]/);

  gw.close(); br.close();
});
