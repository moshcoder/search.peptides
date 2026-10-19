import { config } from './config.js';
import { close, getMeta } from './db.js';
import { enrich } from './enrich.js';
import { startRingRefresh } from './ring.ts';
import { invalidate } from './service.js';
import { loadSnapshotIfEmpty, sync } from './sync.js';
import { app } from './web/app.jsx';

/** One process. ROLES decides what runs: web, worker, or both. */
const loaded = loadSnapshotIfEmpty();
if (loaded) console.log(`[boot] loaded the register snapshot: ${loaded.vendors} vendors, ${loaded.offers} listings`);

const stopRing = startRingRefresh();
let timer = null;
if (config.roles.includes('worker')) {
  const older = (key, hours) => Date.now() - (Date.parse(getMeta(key) ?? 0) || 0) > hours * 3600_000;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (older('synced_at', config.syncHours)) {
        await sync();
        invalidate();
      }
      // Vendor sites change slowly: contacts are re-read weekly, after a sync has added any new vendor.
      if (older('enriched_at', Number(process.env.ENRICH_DAYS ?? 7) * 24)) await enrich();
    } catch (err) {
      console.error(`[worker] ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, 15 * 60_000);
  setTimeout(tick, 5_000);
}

let server = null;
if (config.roles.includes('web')) {
  server = Bun.serve({ port: config.port, hostname: '127.0.0.1', fetch: app.fetch, idleTimeout: 60 });
  console.log(`[web] ${config.siteName} on 127.0.0.1:${config.port} at ${config.siteUrl} (${config.roles.join(',')})`);
}

function shutdown(signal) {
  console.log(`[boot] ${signal}`);
  clearInterval(timer);
  stopRing();
  server?.stop(true);
  close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
