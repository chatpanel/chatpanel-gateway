// `chatpanel-gateway tools list | tools schema <tool> | call <tool> '<json>'` — the same
// tools the MCP server offers, reached from a shell.
//
// An MCP connection is a standing cost: every tool's schema sits in the agent's context on
// every turn, called or not. A shell verb costs nothing until it is used — `tools list`
// prints names and one-liners, `tools schema` pulls ONE schema at the moment of calling,
// `call` runs the tool. So an agent that has only a shell (a skill's `scripts/`, a CI job,
// a CLI with no MCP support) reaches history, memory and briefs at a cost that scales with
// use rather than with how many tools exist. The daemon's secrets never move: the CLI
// talks to the gateway exactly as the MCP server does, over loopback with the gateway
// token, and prints results.
//
// Exit codes, so a script can tell them apart: 0 the tool answered; 1 the tool itself
// reported an error (a real tool-level failure — the record was not found); 2 a usage or
// transport failure (bad JSON, unknown verb, gateway unreachable).

import { readFileSync } from 'node:fs';
import { handleRpc } from './mcp.js';

const USAGE = [
  'Usage:',
  '  chatpanel-gateway tools list                 names and one-liners (no schemas)',
  '  chatpanel-gateway tools schema <tool>        one tool\'s full input schema',
  '  chatpanel-gateway call <tool> [\'<json>\']     run a tool; arguments as a JSON object',
  '  chatpanel-gateway call <tool> --file <path>  arguments from a JSON file (no shell quoting)',
  '',
  'Exit codes: 0 ok · 1 the tool reported an error · 2 usage or transport failure',
].join('\n');

/** First sentence, whitespace collapsed, capped — enough to choose a tool, not to call it. */
export function oneLiner(description, max = 100) {
  const s = String(description || '').replace(/\s+/g, ' ').trim();
  const cut = s.search(/[.!?]\s/);
  const first = cut > 20 ? s.slice(0, cut + 1) : s;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

export function formatToolsList(tools) {
  const width = Math.min(24, Math.max(...tools.map((t) => t.name.length), 4));
  return tools.map((t) => {
    const req = Array.isArray(t.inputSchema?.required) && t.inputSchema.required.length ? `(${t.inputSchema.required.join(', ')})` : '()';
    return `${t.name.padEnd(width)}  ${req.padEnd(22)} ${oneLiner(t.description)}`;
  }).join('\n');
}

function parseArgs(argv) {
  const rest = [...argv];
  let file = null;
  const i = rest.indexOf('--file');
  if (i >= 0) { file = rest[i + 1]; rest.splice(i, 2); }
  return { rest, file };
}

/**
 * Run one CLI invocation. Returns the exit code; writes through `out`/`err` so a test can
 * capture without a process. `rpc` is the MCP dispatcher — `handleRpc` in production.
 */
export async function runMcpCli(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), rpc = handleRpc } = {}) {
  const [verb, ...more] = argv;
  const list = async () => (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))?.result?.tools || [];

  if (verb === 'tools') {
    const [sub, name] = more;
    if (sub === 'list') {
      out(`${formatToolsList(await list())}\n`);
      return 0;
    }
    if (sub === 'schema') {
      if (!name) { err(`tools schema: which tool?\n${USAGE}\n`); return 2; }
      const tool = (await list()).find((t) => t.name === name);
      if (!tool) { err(`no tool named "${name}". Run: chatpanel-gateway tools list\n`); return 2; }
      out(`${JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, null, 2)}\n`);
      return 0;
    }
    err(`${USAGE}\n`);
    return 2;
  }

  if (verb === 'call') {
    const { rest, file } = parseArgs(more);
    const [name, inline] = rest;
    if (!name) { err(`call: which tool?\n${USAGE}\n`); return 2; }
    let args = {};
    try {
      const text = file ? readFileSync(file, 'utf8') : (inline ?? '{}');
      args = JSON.parse(text);
    } catch (e) {
      err(`call: arguments must be a JSON object (${e.message})\n`);
      return 2;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) { err('call: arguments must be a JSON object\n'); return 2; }
    let reply;
    try {
      reply = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    } catch (e) {
      err(`call: ${e.message}\n`);
      return 2;
    }
    if (reply?.error) { err(`call: ${reply.error.message}\n`); return 2; }
    const text = (reply?.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (reply?.result?.isError) {
      // The gateway being down looks like a tool error from the MCP layer; it is transport.
      const transport = /fetch failed|ECONNREFUSED|not running|unreachable/i.test(text);
      err(`${text}\n`);
      return transport ? 2 : 1;
    }
    out(`${text}\n`);
    return 0;
  }

  err(`${USAGE}\n`);
  return 2;
}
