#!/usr/bin/env node
// CLI entry for the ChatPanel Privacy Gateway.
//
//   chatpanel-gateway              start the gateway (foreground)
//   chatpanel-gateway --install    register login auto-start + start now
//   chatpanel-gateway --uninstall  remove login auto-start
//   chatpanel-gateway --status     is auto-start registered?
//   chatpanel-gateway --version    print version
//
// Config comes from gateway.config.json / env (see src/config.js).
import { start, VERSION } from '../src/server.js';
import { installService, uninstallService, serviceStatus } from '../src/service.js';

const arg = process.argv[2];

try {
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
      console.error(`unknown option: ${arg}\nUsage: chatpanel-gateway [--install|--uninstall|--status|--version]`);
      process.exit(2);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
