import { createDaemon, sqliteStore } from '@profullstack/scraper-daemon';
import { config } from './config.js';
import { open } from './db.js';
import { discoverFinnrick } from './discover.js';
import { crawlable, FINNRICK, finnrickContacts, saveContacts, siteContacts, userAgent } from './enrich.js';
import { invalidate } from './service.js';
import { sync } from './sync.js';

/**
 * The updater daemon (@profullstack/scraper-daemon, the same package every listing
 * site runs). Four tasks, all state in this site's SQLite file:
 *
 *   register           the price/lab register, hourly
 *   discover           Finnrick's vendor list: vendors the register lacks, every 6 h
 *   finnrick-contacts  each vendor's Finnrick record (vouched emails/websites), every 3 d
 *   site-contacts      each vendor's own site (emails, phones, socials), weekly
 *
 * The service cache is dropped after any task changes data, at most once a minute,
 * so pages see new rows without rebuilding the cache on every vendor.
 */
const intervals = {
  register: process.env.REGISTER_EVERY ?? '1h',
  discover: process.env.DISCOVER_EVERY ?? '6h',
  finnrick: process.env.FINNRICK_EVERY ?? '3d',
  site: process.env.SITE_EVERY ?? '7d',
};

let dirty = false;
setInterval(() => {
  if (dirty) {
    dirty = false;
    invalidate();
  }
}, 60_000).unref?.();
const changed = () => {
  dirty = true;
};

const vendorsFor = (where) => open().query(`SELECT slug, name, website, shop_url, contacts FROM vendors ${where}`).all();

export function buildDaemon({ log } = {}) {
  const daemon = createDaemon({
    name: config.siteName,
    // BullMQ on the site's own Redis (deploy/redis.sh): queue, run records and task state live there,
    // the listings stay in this site's SQLite. Without REDIS_URL (dev) the local engine runs.
    redis: process.env.REDIS_URL || null,
    store: process.env.REDIS_URL ? undefined : sqliteStore(open()),
    concurrency: Number(process.env.DAEMON_CONCURRENCY ?? 6),
    // The register document is ~5 MB; contact pages are capped well below that by the cap anyway.
    fetch: { userAgent, delayMs: 1500, timeoutMs: 20_000, maxBytes: 20_000_000 },
    log,
    onStall: ({ job, lastError }) => console.error(`[daemon] ${job} stalled${lastError ? `: ${lastError}` : ''}`),
  });

  daemon.job({
    name: 'register',
    every: intervals.register,
    staleAfter: '1d',
    timeout: '5m',
    run: async (ctx) => {
      const counts = await sync({ getJson: (url) => ctx.fetch.json(url, { signal: ctx.signal }) });
      changed();
      daemon.refreshItems('site-contacts');
      daemon.refreshItems('finnrick-contacts');
      return counts;
    },
  });

  daemon.job({
    name: 'discover',
    every: intervals.discover,
    staleAfter: '2d',
    run: async (ctx) => {
      const r = await discoverFinnrick(ctx.fetch);
      if (r.added) {
        ctx.log(`${r.added} new vendors`);
        changed();
        daemon.refreshItems('site-contacts');
        daemon.refreshItems('finnrick-contacts');
      }
      return r;
    },
  });

  daemon.queue({
    name: 'finnrick-contacts',
    every: intervals.finnrick,
    concurrency: 1,
    retireAfter: 20,
    host: () => new URL(FINNRICK).host,
    items: async () => vendorsFor('').map((v) => ({ key: v.slug })),
    run: async (item, ctx) => {
      try {
        const found = await finnrickContacts(item.key, ctx.fetch);
        if (saveContacts(item.key, 'finnrick', found)) changed();
        return { contacts: found.length };
      } catch (err) {
        // Not every register vendor has a Finnrick record; that is an answer, not a failure.
        if (err?.status === 404) return { nextIn: '30d' };
        throw err;
      }
    },
  });

  daemon.queue({
    name: 'site-contacts',
    every: intervals.site,
    concurrency: 4,
    retireAfter: 12,
    itemsEvery: '30m',
    items: async () =>
      vendorsFor('').map((v) => {
        const home = crawlable(v);
        return { key: v.slug, url: home?.origin ?? null, v };
      }),
    host: (item) => (item.url ? new URL(item.url).host : `none:${item.key}`),
    run: async (item, ctx) => {
      const fresh = open().query('SELECT slug, name, website, shop_url, contacts FROM vendors WHERE slug = ?').get(item.key) ?? item.v;
      const found = await siteContacts(fresh, ctx.fetch);
      if (saveContacts(item.key, 'site', found)) changed();
      return { contacts: found.length };
    },
  });

  return daemon;
}
