import { open } from './db.js';
import { FINNRICK } from './enrich.js';
import { locationCountry } from './core/normalize.js';

/**
 * New vendors, from Finnrick's public vendor list (about 2,000 names against the few
 * hundred the price register carries; it allows crawling its v1 read API). A vendor
 * already in the register keeps every register field; one that is not is added with
 * origin 'finnrick', its website, location, test count and trading status, and gets
 * its contacts and lab results from the other queues. Register syncs never remove
 * these rows.
 */
export function finnrickRows(doc) {
  const items = Array.isArray(doc?.items) ? doc.items : [];
  return items
    .filter((v) => v?.slug && v?.name)
    .map((v) => ({
      slug: String(v.slug),
      name: String(v.name).trim(),
      website: /^https?:\/\//.test(v.contact_url ?? '') && v.contact_kind !== 'email' ? v.contact_url : null,
      location: v.location ?? null,
      country: locationCountry(v.location),
      tests: Number.isFinite(v.test_count) ? v.test_count : 0,
      latest_test: v.latest_test_display ?? null,
      status: v.status ?? null,
    }));
}

/** Upsert the list. Returns how many vendors were new. */
export function saveDiscovered(rows) {
  const db = open();
  const exists = db.query('SELECT origin FROM vendors WHERE slug = ?');
  const add = db.query("INSERT INTO vendors (slug, name, website, location, country, tests, latest_test, status, origin, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finnrick', ?)");
  const refresh = db.query("UPDATE vendors SET name = ?, website = coalesce(website, ?), location = coalesce(location, ?), country = coalesce(country, ?), tests = ?, status = ?, checked_at = ? WHERE slug = ? AND origin = 'finnrick'");
  const status = db.query('UPDATE vendors SET status = ? WHERE slug = ?');
  const now = new Date().toISOString();
  let added = 0;
  db.transaction(() => {
    for (const r of rows) {
      const have = exists.get(r.slug);
      if (!have) {
        add.run(r.slug, r.name, r.website, r.location, r.country, r.tests, r.latest_test, r.status, now);
        added++;
      } else if (have.origin === 'finnrick') refresh.run(r.name, r.website, r.location, r.country, r.tests, r.status, now, r.slug);
      else status.run(r.status, r.slug);
    }
  })();
  return added;
}

export async function discoverFinnrick(fetcher) {
  const doc = await fetcher.json(`${FINNRICK}/api/v1/vendors`);
  const rows = finnrickRows(doc);
  if (rows.length < 100) throw new Error(`Finnrick listed only ${rows.length} vendors; refusing to treat that as the list`);
  return { listed: rows.length, added: saveDiscovered(rows) };
}
