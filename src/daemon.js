import { createDaemon, sqliteStore } from '@profullstack/scraper-daemon';
import { config } from './config.js';
import { open } from './db.js';
import { discoverFinnrick } from './discover.js';
import { ratingFromRecord, readTests, saveRating, saveTests } from './finnrick.js';
import { crawlable, FINNRICK, finnrickRecord, finnrickToContacts, saveContacts, siteContacts, userAgent } from './enrich.js';
import { recomputeScores } from './score.js';
import { invalidate, listPeptides } from './service.js';
import { peptideMatcher, readShop, recomputeVendorStats, saveShopOffers } from './shops.js';
import { sync } from './sync.js';

/**
 * The updater daemon (@profullstack/scraper-daemon, the same package every listing
 * site runs). Four tasks, all state in this site's SQLite file:
 *
 *   register           the price/lab register, hourly
 *   discover           Finnrick's vendor list: vendors the register lacks, every 6 h
 *   finnrick-vendors   each vendor's Finnrick record (vouched emails/websites, rating), every 3 d
 *   site-contacts      each vendor's own site (emails, phones, socials), weekly
 *   shop-prices        each vendor's own shop catalogue, daily
 *   finnrick-tests     every independent test record (lab, certificate, batch), daily
 *   scores             the verification score (src/score.js), every 6 h as tests age
 *
 * After any task changes data, at most once a minute, every vendor's verification score
 * is recomputed (changes logged to score_log) and the service cache is dropped, so pages
 * see new rows without rebuilding the cache on every vendor.
 */
const intervals = {
  register: process.env.REGISTER_EVERY ?? '1h',
  discover: process.env.DISCOVER_EVERY ?? '6h',
  finnrick: process.env.FINNRICK_EVERY ?? '3d',
  site: process.env.SITE_EVERY ?? '7d',
  tests: process.env.FINNRICK_TESTS_EVERY ?? '1d',
  scores: process.env.SCORES_EVERY ?? '6h',
};

let dirty = false;
const rescore = () => {
  try {
    return recomputeScores();
  } catch (err) {
    console.error(`[score] ${err.message}`);
    return null;
  }
};
setInterval(() => {
  if (dirty) {
    dirty = false;
    rescore();
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
      // The register rewrote vendor rows; the ones priced from their own shop keep those numbers.
      recomputeVendorStats();
      changed();
      daemon.refreshItems('site-contacts');
      daemon.refreshItems('finnrick-vendors');
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
        daemon.refreshItems('finnrick-vendors');
      }
      return r;
    },
  });

  // Was 'finnrick-contacts' until the record's rating fed the verification score; the new name
  // made every vendor due at once, so all ratings arrived within an hour of that deploy.
  daemon.queue({
    name: 'finnrick-vendors',
    every: intervals.finnrick,
    concurrency: 1,
    retireAfter: 20,
    host: () => new URL(FINNRICK).host,
    items: async () => vendorsFor('').map((v) => ({ key: v.slug })),
    run: async (item, ctx) => {
      try {
        const doc = await finnrickRecord(item.key, ctx.fetch);
        const found = finnrickToContacts(doc?.vendor);
        const rating = ratingFromRecord(doc);
        // Either a new rating or new contacts moves the score; both are re-read on the next flush.
        if (saveRating(item.key, rating) | Boolean(saveContacts(item.key, 'finnrick', found))) changed();
        return { contacts: found.length, rating: rating?.rating ?? null };
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

  // Every independent test record: the verification score's evidence. ~125 pages of 100, one host, politely.
  daemon.job({
    name: 'finnrick-tests',
    every: intervals.tests,
    staleAfter: '3d',
    timeout: '45m',
    run: async (ctx) => {
      const r = saveTests(await readTests(ctx.fetch, { signal: ctx.signal }));
      const s = rescore();
      invalidate();
      return { ...r, scores: s };
    },
  });

  // Recency moves with the calendar, not only with new data.
  daemon.job({
    name: 'scores',
    every: intervals.scores,
    staleAfter: '1d',
    run: async () => {
      const s = recomputeScores();
      if (s.changed) invalidate();
      return s;
    },
  });

  // Prices from each vendor's own shop (WooCommerce Store API or Shopify products.json; see src/shops.js).
  // The peptide names come from what the site already knows, re-read with the items.
  let match = null;
  daemon.queue({
    name: 'shop-prices',
    every: process.env.SHOP_EVERY ?? '1d',
    concurrency: 4,
    retireAfter: 10,
    itemsEvery: '30m',
    items: async () => {
      match = peptideMatcher(listPeptides().map((p) => p.name));
      return vendorsFor('').map((v) => {
        const home = crawlable(v);
        return { key: v.slug, url: home?.origin ?? null };
      }).filter((x) => x.url);
    },
    host: (item) => new URL(item.url).host,
    run: async (item, ctx) => {
      match ??= peptideMatcher(listPeptides().map((p) => p.name));
      const r = await readShop(ctx.fetch, item.key, item.url, match);
      // No public catalogue feed: an answer, asked again in a month.
      if (!r.platform) return { platform: null, nextIn: '30d' };
      saveShopOffers(item.key, r.listings);
      changed();
      return { platform: r.platform, items: r.items, listings: r.listings.length };
    },
  });

  return daemon;
}
