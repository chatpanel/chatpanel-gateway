// `chatpanel-gateway connect` — wire the local agents to the ChatPanel MCP server, safely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAgents, formatConnect, resolveServerCommand } from '../src/connect-agents.js';

const CMD = '/opt/chatpanel-gateway';
const noClaude = () => null; // pretend the claude CLI is absent, so no child process is spawned

function home(agents = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-connect-'));
  for (const a of agents) mkdirSync(join(dir, a), { recursive: true });
  return dir;
}

test('Codex gets the server block AND the per-tool approval blocks', () => {
  const h = home(['.codex']);
  try {
    const { results } = connectAgents({ cmd: CMD, home: h, which: noClaude });
    const codex = results.find((r) => r.id === 'codex');
    assert.equal(codex.status, 'configured');
    const toml = readFileSync(join(h, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /\[mcp_servers\.chatpanel\]/);
    assert.match(toml, /command = "\/opt\/chatpanel-gateway"/);
    // every read-only tool is pre-approved — the corporate-guardian fix, baked in
    for (const t of ['search_history', 'list_skills', 'read_skill_file']) {
      assert.match(toml, new RegExp(`\\[mcp_servers\\.chatpanel\\.tools\\.${t}\\]\\s*\\napproval_mode = "approve"`));
    }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('running it twice changes nothing the second time (idempotent)', () => {
  const h = home(['.codex']);
  try {
    connectAgents({ cmd: CMD, home: h, which: noClaude });
    const first = readFileSync(join(h, '.codex', 'config.toml'), 'utf8');
    const { results } = connectAgents({ cmd: CMD, home: h, which: noClaude });
    assert.equal(results.find((r) => r.id === 'codex').status, 'already');
    assert.equal(readFileSync(join(h, '.codex', 'config.toml'), 'utf8'), first, 'the file is untouched on a second run');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('an existing Codex config is preserved and backed up', () => {
  const h = home(['.codex']);
  try {
    writeFileSync(join(h, '.codex', 'config.toml'), '[mcp_servers.jira]\nurl = "https://x"\n');
    connectAgents({ cmd: CMD, home: h, which: noClaude });
    const toml = readFileSync(join(h, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /mcp_servers\.jira/, 'the existing server survives');
    assert.match(toml, /mcp_servers\.chatpanel/, 'and ChatPanel is added');
    assert.ok(existsSync(join(h, '.codex', 'config.toml.bak.chatpanel')), 'a backup was written before editing');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('Gemini settings.json is merged, not clobbered', () => {
  const h = home(['.gemini']);
  try {
    writeFileSync(join(h, '.gemini', 'settings.json'), JSON.stringify({ selectedAuthType: 'oauth', mcpServers: { other: { command: 'x' } } }, null, 2));
    connectAgents({ cmd: CMD, home: h, which: noClaude });
    const cfg = JSON.parse(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8'));
    assert.equal(cfg.selectedAuthType, 'oauth', 'existing settings survive');
    assert.deepEqual(cfg.mcpServers.other, { command: 'x' }, 'existing MCP servers survive');
    assert.deepEqual(cfg.mcpServers.chatpanel, { command: CMD, args: ['mcp'] });
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('a malformed Gemini config is left untouched, not overwritten', () => {
  const h = home(['.gemini']);
  try {
    writeFileSync(join(h, '.gemini', 'settings.json'), '{ not valid json');
    const { results } = connectAgents({ cmd: CMD, home: h, which: noClaude });
    assert.equal(results.find((r) => r.id === 'gemini').status, 'error');
    assert.equal(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8'), '{ not valid json', 'the bad file is not rewritten');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('agents with an unverified/JSONC format are given an exact snippet, not auto-written', () => {
  const h = home(['.opencode', '.copilot', '.pi']);
  try {
    const { results } = connectAgents({ cmd: CMD, home: h, which: noClaude });
    for (const id of ['opencode', 'copilot', 'pi']) {
      const r = results.find((x) => x.id === id);
      assert.equal(r.status, 'manual', `${id} is manual`);
      assert.match(r.snippet, /chatpanel/);
      assert.match(r.snippet, /mcp/);
    }
    // nothing was written for them
    assert.ok(!existsSync(join(h, '.opencode', 'opencode.json')));
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('an agent that is not installed is silent, not listed', () => {
  const h = home([]); // empty home — nothing installed
  try {
    const out = formatConnect(connectAgents({ cmd: CMD, home: h, which: noClaude }));
    assert.doesNotMatch(out, /Codex|Gemini|OpenCode/, 'absent agents are not mentioned');
    assert.match(out, /Nothing to change/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('dry run writes nothing', () => {
  const h = home(['.codex', '.gemini']);
  try {
    const out = formatConnect(connectAgents({ cmd: CMD, home: h, which: noClaude, dryRun: true }), { dryRun: true });
    assert.match(out, /dry run/);
    assert.ok(!existsSync(join(h, '.codex', 'config.toml')), 'no Codex file written');
    assert.ok(!existsSync(join(h, '.gemini', 'settings.json')), 'no Gemini file written');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('resolveServerCommand prefers an absolute path, falls back to the bare name', () => {
  assert.equal(resolveServerCommand(() => '/usr/local/bin/chatpanel-gateway'), '/usr/local/bin/chatpanel-gateway');
  assert.equal(resolveServerCommand(() => null), 'chatpanel-gateway');
});
