#!/usr/bin/env node
// CLI entry for the ChatPanel Privacy Gateway.
//
//   chatpanel-gateway              start the gateway (foreground)
//   chatpanel-gateway mcp          stdio MCP server exposing warm history as tools
//   chatpanel-gateway local        show the local runtime — bridge + gateway, one view
//   chatpanel-gateway connect      point your CLI agents (Codex, Claude Code, …) at this server
//   chatpanel-gateway --install    register login auto-start + start now
//   chatpanel-gateway --uninstall  remove login auto-start
//   chatpanel-gateway --status     is auto-start registered?
//   chatpanel-gateway --version    print version
//
// Config comes from gateway.config.json / env (see src/config.js).
export {}; // mark as an ES module (all imports below are dynamic)

const arg = process.argv[2];

try {
  if (arg === 'mcp') {
    // Its own path: proxies to the running gateway over HTTP and must NOT import
    // server.js (which would open a second handle on the warm SQLite store).
    const { runMcpServer } = await import('../src/mcp.js');
    await runMcpServer();
  } else if (arg === 'local') {
    // Read-only unified view of both services. No server.js import — just HTTP probes.
    const { localStatus, formatLocalStatus } = await import('../src/local-status.js');
    process.stdout.write(formatLocalStatus(await localStatus()));
  } else if (arg === 'connect') {
    const { connectAgents, formatConnect } = await import('../src/connect-agents.js');
    const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');
    process.stdout.write(formatConnect(connectAgents({ dryRun }), { dryRun }));
  } else {
    const { start, VERSION } = await import('../src/server.js');
    const { installService, uninstallService, serviceStatus } = await import('../src/service.js');
    switch (arg) {
      case '--version':
      case '-v':
        console.log(VERSION);
        break;
      case '--install':
        installService();
        console.log('ChatPanel Privacy Gateway: installed login auto-start and started it.');
        break;
      case '--uninstall':
        uninstallService();
        console.log('ChatPanel Privacy Gateway: removed login auto-start.');
        break;
      case '--status':
        console.log(serviceStatus() ? 'installed (auto-start registered)' : 'not installed');
        break;
      case undefined:
        start();
        break;
      default:
        console.error(`unknown option: ${arg}\nUsage: chatpanel-gateway [mcp|--install|--uninstall|--status|--version]`);
        process.exit(2);
    }
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
