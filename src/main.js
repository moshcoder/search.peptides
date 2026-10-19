import { config } from './config.js';
import { close } from './db.js';
import { buildDaemon } from './daemon.js';
import { startPitFooterRefresh } from './pit-footer.ts';
import { startRingRefresh } from './ring.ts';
import { loadSnapshotIfEmpty } from './sync.js';
import { app, setDaemon } from './web/app.jsx';

/** One process. ROLES decides what runs: web, worker (the updater daemon), or both. */
const loaded = loadSnapshotIfEmpty();
if (loaded) console.log(`[boot] loaded the register snapshot: ${loaded.vendors} vendors, ${loaded.offers} listings`);

const stopRing = startRingRefresh();
let daemon = null;
if (config.roles.includes('worker')) {
  daemon = buildDaemon().start();
  setDaemon(daemon);
}

let server = null;
if (config.roles.includes('web')) {
  startPitFooterRefresh('search.peptides');
  server = Bun.serve({ port: config.port, hostname: '127.0.0.1', fetch: app.fetch, idleTimeout: 60 });
  console.log(`[web] ${config.siteName} on 127.0.0.1:${config.port} at ${config.siteUrl} (${config.roles.join(',')})`);
}

async function shutdown(signal) {
  console.log(`[boot] ${signal}`);
  stopRing();
  server?.stop(true);
  await daemon?.stop({ graceMs: 5_000 });
  close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
