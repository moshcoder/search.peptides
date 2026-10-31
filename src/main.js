import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { close } from './db.js';
import { buildDaemon } from './daemon.js';
import { startRingFooterRefresh } from './ring-footer.ts';
import { startRingRefresh } from './ring.ts';
import { loadSnapshotIfEmpty } from './sync.js';
import { app, setDaemon } from './web/app.jsx';

/** ROLES decides what runs: web, worker (the updater daemon), or both; WEB_WORKERS web processes share the port. */
const loaded = loadSnapshotIfEmpty();
if (loaded) console.log(`[boot] loaded the register snapshot: ${loaded.vendors} vendors, ${loaded.offers} listings`);

const stopRing = startRingRefresh();
// The daemon runs in one process; it answers status on a unix socket beside the database, so
// /health and /api/v1/daemon say the same thing whichever web process takes the request.
const STATUS_SOCKET = join(dirname(config.dbPath === ':memory:' ? tmpdir() : config.dbPath), 'daemon-status.sock');
let daemon = null;
let statusServer = null;
if (config.roles.includes('worker')) {
  daemon = buildDaemon().start();
  setDaemon(daemon);
  rmSync(STATUS_SOCKET, { force: true });
  statusServer = Bun.serve({ unix: STATUS_SOCKET, fetch: async () => Response.json(await daemon.status()) });
} else if (process.env.SP_WEB_CHILD) {
  setDaemon({
    status: () =>
      fetch('http://daemon/status', { unix: STATUS_SOCKET, signal: AbortSignal.timeout(3_000) })
        .then((r) => r.json())
        .catch((err) => ({ running: false, tasks: [], error: `daemon process did not answer: ${err.message}` })),
  });
}

let server = null;
const children = new Set();
let stopping = false;
if (config.roles.includes('web')) {
  startRingFooterRefresh();
  // Every web process listens on the same port (SO_REUSEPORT) and the kernel spreads connections,
  // so a crawler fanning out over hundreds of filter URLs is not queued behind one thread.
  server = Bun.serve({ port: config.port, hostname: '127.0.0.1', fetch: app.fetch, idleTimeout: 60, reusePort: config.webWorkers > 1 });
  console.log(`[web] ${config.siteName} on 127.0.0.1:${config.port} at ${config.siteUrl} (${config.roles.join(',')}${process.env.SP_WEB_CHILD ? ', child' : ''})`);
  // The first process starts the rest: web only, no daemon. One that dies is started again.
  if (!process.env.SP_WEB_CHILD) for (let i = 1; i < config.webWorkers; i++) spawnWeb();
}

function spawnWeb() {
  const child = Bun.spawn([process.execPath, import.meta.path], { env: { ...process.env, ROLES: 'web', SP_WEB_CHILD: '1' }, stdout: 'inherit', stderr: 'inherit' });
  children.add(child);
  child.exited.then((code) => {
    children.delete(child);
    if (stopping) return;
    console.log(`[web] child ${child.pid} exited (${code}); starting another`);
    setTimeout(spawnWeb, 1_000);
  });
}

async function shutdown(signal) {
  console.log(`[boot] ${signal}`);
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  stopRing();
  server?.stop(true);
  statusServer?.stop(true);
  await daemon?.stop({ graceMs: 5_000 });
  close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
