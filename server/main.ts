import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { adoptLoginShellEnv, defaultStateDir } from './platform.ts';
import { writeHookFiles } from './agents.ts';
import { enabledAgentsFrom } from './cliRegistry.ts';
import { createApp } from './http.ts';
import { SessionManager } from './sessions.ts';
import { createFileStore } from './store.ts';
import { createUsage } from './usage.ts';

// Before anything resolves a CLI or spawns a child: a Finder-launched app has a minimal PATH.
await adoptLoginShellEnv();

const argIdx = process.argv.indexOf('--port');
const port = Number(argIdx > 0 ? process.argv[argIdx + 1] : process.env.WORKBENCH_PORT ?? 47800);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('invalid port');
  process.exit(2);
}

// Per-platform default (defaultStateDir in platform.ts); the desktop app passes its choice in WORKBENCH_STATE_DIR.
const stateDir = path.resolve(process.env.WORKBENCH_STATE_DIR ?? defaultStateDir());
fs.mkdirSync(stateDir, { recursive: true });
writeHookFiles(stateDir);

const token = crypto.randomBytes(24).toString('hex');
const sessions = new SessionManager({ port, token, stateDir });
const store = createFileStore(path.join(stateDir, 'state.json'));
sessions.restore(store.sessions());
const usage = createUsage({ stateDir, source: store });
const { server, mobile, refreshCliTools, refreshPiQuota } = createApp({ port, token, store, sessions, stateDir, usage, onShutdown: () => shutdown() });

server.listen(port, '127.0.0.1', () => {
  console.log(`Shoal on http://127.0.0.1:${port}`);
  console.log(`agents: ${enabledAgentsFrom(store.settings()).join(', ') || '(none)'}  state: ${stateDir}`);
  void refreshCliTools();
  void refreshPiQuota();
  // Keeps the totals current even if nobody opens the stats tab, before the CLIs clean up old transcripts.
  setTimeout(() => usage.scan(), 1000).unref();
  setInterval(() => usage.scan(), 60_000).unref();
});

// Node still prints the error and exits; this adds when it happened, so server.err.log (kept one restart back as
// server.err.prev.log) says why the page lost its server.
process.on('uncaughtExceptionMonitor', (e, origin) => console.error(`[${new Date().toISOString()}] ${origin}:`, e));

// A second signal exits at once, without waiting for young claude sessions (see SessionManager.killAll).
let stopping = false;
const shutdown = () => {
  if (stopping) process.exit(0);
  stopping = true;
  server.close();
  setTimeout(() => process.exit(0), 12_000).unref();
  void Promise.allSettled([mobile.close(), sessions.killAll()]).then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
