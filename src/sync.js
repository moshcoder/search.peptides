import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { config } from './config.js';
import { getMeta, open, setMeta } from './db.js';
import { cleanUrl, countries, isoDate, locationCountry, paymentClasses, slugify } from './core/normalize.js';

/**
 * The register is read from one public JSON document (peptidecompare.net/data.json,
 * itself compiled from Finnrick lab results and each vendor's own shop). Products
 * arrive column-packed: every column is an array, and the low-cardinality ones
 * (vendor, peptide, unit, currency, form) are indexes into `tables`.
 *
 * A sync replaces everything in one transaction. A document with less than half the
 * vendors we already hold is refused, so a broken upstream never empties the site.
 */
const SNAPSHOT = new URL('../data/snapshot.json.gz', import.meta.url);

export function unpackProducts(p) {
  if (!p?.cols) return Array.isArray(p) ? p : [];
  const { cols, tables = {} } = p;
  const n = p.n ?? cols.id?.length ?? 0;
  const keys = Object.keys(cols);
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = {};
    for (const k of keys) {
      const v = cols[k][i];
      r[k] = tables[k] && v !== null && v !== undefined ? tables[k][v] : v;
    }
    rows[i] = r;
  }
  return rows;
}

const fin = (n) => (Number.isFinite(n) ? n : null);
const J = JSON.stringify;
// Coupon codes the source holds as its own referral (PEPTIDECOMPARE, AFF-…) credit them, not the buyer.
const theirCode = (c) => /peptidecompare|^aff-/i.test(String(c?.code ?? ''));

function blendOf(raw) {
  if (!raw) return null;
  try {
    const b = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(b?.parts) ? b.parts.map(([peptide, mg]) => ({ peptide, mg: fin(mg) })) : null;
  } catch {
    return null;
  }
}

/** The source document → rows for every table. Pure, so tests feed it fixtures. */
export function transform(doc) {
  const aff = doc.affiliates ?? {};
  const products = unpackProducts(doc.products);
  const origin = doc.products?.origin ?? {};
  const scraped = doc.products?.scraped ?? {};
  const totals = Object.fromEntries((doc.test_totals ?? []).map((t) => [t.vendor_slug, t]));
  const runs = Object.fromEntries((doc.runs ?? []).map((r) => [r.vendor_slug, r]));
  const contacts = {};
  for (const c of doc.contacts ?? []) {
    const url = cleanUrl(c.url);
    if (url) (contacts[c.vendor_slug] ??= []).push({ kind: c.kind, url });
  }

  const offers = [];
  const perVendor = {};
  for (const p of products) {
    if (!p.vendor_slug || !p.peptide) continue;
    const params = aff[p.vendor_slug]?.params ?? {};
    const base = origin[p.vendor_slug];
    const abs = p.url ? (p.url.startsWith('/') && base ? `${base}${p.url}` : p.url) : null;
    const o = {
      id: p.id,
      vendor: p.vendor_slug,
      peptide: p.peptide,
      peptide_slug: slugify(p.peptide),
      name: p.name ?? null,
      form: p.form ?? null,
      unit: p.unit ?? null,
      amount: fin(p.amount),
      pack_qty: fin(p.pack_qty),
      price: fin(p.price),
      currency: p.currency ?? null,
      price_usd: fin(p.price_usd),
      total_mg: fin(p.total_mg),
      usd_per_mg: fin(p.usd_per_mg),
      usd_per_unit: fin(p.usd_per_unit),
      in_stock: p.in_stock === 1 ? 1 : p.in_stock === 0 ? 0 : null,
      url: cleanUrl(abs, params),
      blend: blendOf(p.components),
    };
    offers.push(o);
    const v = (perVendor[o.vendor] ??= { offers: 0, peptides: new Set(), min: null });
    v.offers++;
    v.peptides.add(o.peptide_slug);
    if (o.usd_per_mg !== null && o.unit === 'mg' && (v.min === null || o.usd_per_mg < v.min)) v.min = o.usd_per_mg;
  }

  const vendors = (doc.vendors ?? []).filter((v) => v.slug && v.name).map((v) => {
    const t = doc.terms?.[v.slug] ?? {};
    const ord = doc.ordering?.[v.slug] ?? {};
    const tot = totals[v.slug] ?? {};
    const pv = perVendor[v.slug];
    const params = aff[v.slug]?.params ?? {};
    return {
      slug: v.slug,
      name: v.name,
      website: cleanUrl(v.website, params),
      shop_url: origin[v.slug] ?? null,
      location: v.location ?? null,
      country: locationCountry(v.location) ?? (countries(t.ships_from).length === 1 ? countries(t.ships_from)[0] : null),
      score: fin(v.score),
      rank: fin(v.rank),
      tests: tot.tests ?? fin(v.tests) ?? 0,
      tests_pass: tot.pass ?? 0,
      tests_fail: tot.fail ?? 0,
      latest_test: isoDate(v.latest_test),
      cost_per_mg: fin(v.cost_per_mg),
      ordering: ord.method ?? t.order_method ?? null,
      ordering_evidence: ord.evidence ?? t.order_evidence ?? null,
      payments: paymentClasses(t.payment),
      payments_raw: t.payment ?? [],
      ships_from: countries(t.ships_from),
      ships_to: t.ships_to ? (Array.isArray(t.ships_to) ? t.ships_to.join(', ') : String(t.ships_to)) : null,
      shipping: t.shipping ?? [],
      min_order: t.min_order === null || t.min_order === undefined ? null : typeof t.min_order === 'string' ? t.min_order : J(t.min_order),
      discounts: t.discounts ?? [],
      coupons: (doc.coupons?.[v.slug] ?? []).filter((c) => !theirCode(c)),
      contacts: contacts[v.slug] ?? [],
      terms_source: t.source ?? null,
      notes: runs[v.slug]?.notes ?? null,
      offers: pv?.offers ?? 0,
      peptides: pv?.peptides.size ?? 0,
      min_usd_per_mg: pv?.min ?? null,
      checked_at: scraped[v.slug] ?? v.scraped_at ?? null,
    };
  });

  const tests = (doc.tests ?? []).filter((t) => t.vendor_slug && t.peptide).map((t) => ({ vendor: t.vendor_slug, peptide: t.peptide, peptide_slug: slugify(t.peptide), tested_on: isoDate(t.test_date), result: String(t.result ?? '').toLowerCase() || 'unknown' }));
  const ratings = (doc.ratings ?? []).filter((r) => r.vendor_slug && r.peptide).map((r) => ({ vendor: r.vendor_slug, peptide: r.peptide, peptide_slug: slugify(r.peptide), rating: fin(r.rating), n_tests: fin(r.n_tests), cost_per_mg: fin(r.cost_per_mg) }));
  return { vendors, offers, tests, ratings };
}

export function write(rows, { force = false } = {}) {
  const db = open();
  const have = db.query("SELECT count(*) n FROM vendors WHERE origin = 'register'").get().n;
  if (!force && have && rows.vendors.length < have / 2) throw new Error(`refusing a register of ${rows.vendors.length} vendors over the ${have} we hold`);
  const vcols = ['slug', 'name', 'website', 'shop_url', 'location', 'country', 'score', 'rank', 'tests', 'tests_pass', 'tests_fail', 'latest_test', 'cost_per_mg', 'ordering', 'ordering_evidence', 'payments', 'payments_raw', 'ships_from', 'ships_to', 'shipping', 'min_order', 'discounts', 'coupons', 'contacts', 'terms_source', 'notes', 'offers', 'peptides', 'min_usd_per_mg', 'checked_at'];
  const ocols = ['id', 'vendor', 'peptide', 'peptide_slug', 'name', 'form', 'unit', 'amount', 'pack_qty', 'price', 'currency', 'price_usd', 'total_mg', 'usd_per_mg', 'usd_per_unit', 'in_stock', 'url', 'blend'];
  const ins = (table, cols, verb = 'INSERT') => db.query(`${verb} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  // A register row replaces a vendor discovery added earlier under the same slug.
  const addV = ins('vendors', vcols, 'INSERT OR REPLACE');
  const addO = ins('offers', ocols);
  const addT = ins('lab_tests', ['vendor', 'peptide', 'peptide_slug', 'tested_on', 'result']);
  const addR = ins('ratings', ['vendor', 'peptide', 'peptide_slug', 'rating', 'n_tests', 'cost_per_mg']);
  const val = (v) => (v !== null && typeof v === 'object' ? J(v) : v ?? null);
  db.transaction(() => {
    // Vendors discovery added (origin 'finnrick') stay; everything the register owns is replaced.
    db.exec("DELETE FROM vendors WHERE origin = 'register'; DELETE FROM offers; DELETE FROM lab_tests; DELETE FROM ratings;");
    for (const v of rows.vendors) addV.run(...vcols.map((k) => val(v[k])));
    for (const o of rows.offers) addO.run(...ocols.map((k) => val(o[k])));
    for (const t of rows.tests) addT.run(t.vendor, t.peptide, t.peptide_slug, t.tested_on, t.result);
    for (const r of rows.ratings) addR.run(r.vendor, r.peptide, r.peptide_slug, r.rating, r.n_tests, r.cost_per_mg);
  })();
  return { vendors: rows.vendors.length, offers: rows.offers.length, tests: rows.tests.length, ratings: rows.ratings.length };
}

const plainJson = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': `${config.siteName} (+${config.siteUrl})` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};

/** `getJson` is the daemon's polite fetcher when it runs the sync; plain fetch from the CLI. */
export async function sync({ url = config.sourceUrl, force = false, getJson = plainJson } = {}) {
  const counts = write(transform(await getJson(url)), { force });
  setMeta('synced_at', new Date().toISOString());
  setMeta('synced_from', url);
  console.log(`[sync] ${counts.vendors} vendors, ${counts.offers} offers, ${counts.tests} lab tests, ${counts.ratings} ratings`);
  return counts;
}

/** First boot with no network still has a register: the snapshot committed with the code. */
export function loadSnapshotIfEmpty() {
  if (open().query("SELECT count(*) n FROM vendors WHERE origin = 'register'").get().n) return null;
  const doc = JSON.parse(gunzipSync(readFileSync(SNAPSHOT)).toString('utf8'));
  const counts = write(transform(doc));
  if (!getMeta('synced_at')) setMeta('synced_at', '1970-01-01T00:00:00.000Z');
  setMeta('synced_from', 'snapshot');
  return counts;
}

if (import.meta.main) {
  sync({ force: process.argv.includes('--force') }).catch((err) => {
    console.error(`[sync] ${err.message}`);
    process.exit(1);
  });
}
