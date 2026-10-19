import { slugify } from './core/normalize.js';
import { open } from './db.js';

/**
 * Prices straight from each vendor's own shop, now that the register's source serves
 * decoy data (2026-10-19). Most peptide shops are WooCommerce or Shopify, and both
 * publish their catalogue as public JSON for their own storefront to use:
 *
 *   WooCommerce  /wp-json/wc/store/v1/products?type=simple|variation   (the Store API)
 *   Shopify      /products.json  (+ /cart.js for the shop's currency)
 *
 * No login, no key, no checkout: the same documents the shop's pages fetch. Read through
 * the daemon's fetcher (robots.txt, one request at a time per shop, public addresses only).
 *
 * A product becomes a listing when its name matches a peptide we know (longest name
 * first) and it states an amount (mg, mcg, IU, ml, g). A vendor with shop listings shows
 * those and not the register's (frozen) ones.
 */

// USD per unit of each currency, for ranking. Shown prices stay in the shop's own currency.
export const USD = { USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.66, HKD: 0.128, NZD: 0.6, CHF: 1.13, SGD: 0.75, CNY: 0.14 };
const MAX_PAGES = 20;
const toMg = { mg: 1, mcg: 0.001, g: 1000 };

const norm = (s) =>
  ` ${String(s ?? '')
    .toLowerCase()
    .replace(/&#8211;|&#8212;|–|—/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim()} `;

/** Known peptides, longest name first, with their normalised form. */
export function peptideMatcher(names) {
  const list = [...new Set(names)]
    .filter((n) => n && n.length >= 3)
    .map((name) => ({ name, key: norm(name), slug: slugify(name) }))
    .filter((p) => p.key.trim().length >= 3)
    .sort((a, b) => b.key.length - a.key.length);
  return (text) => {
    const t = norm(text);
    return list.find((p) => t.includes(p.key)) ?? null;
  };
}

/**
 * "Dosage: 10 MG", "BPC-157 10mg x 10 vials", "Glutathione 1200mg x 10vials, 12000mg" →
 * { amount (per vial), unit, pack, parts }. Only a blend's amounts add up ("5 MG / 5 MG");
 * otherwise the first amount is the vial and a later one is a pack total, not more peptide. Pure.
 */
export function readAmount(text, { blend = false } = {}) {
  const t = String(text ?? '')
    .toLowerCase()
    // "1,000mg" is a thousand; "2,5mg" is two and a half.
    .replace(/(\d),(\d{3})(?!\d)/g, '$1$2')
    .replace(/(\d),(\d)/g, '$1.$2');
  const parts = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|iu|ml|g)\b/g)].map((m) => ({ amount: Number(m[1]), unit: m[2] === 'µg' || m[2] === 'ug' ? 'mcg' : m[2] }));
  if (!parts.length) return null;
  const pack = Number(t.match(/(?:x|×|\*)\s*(\d{1,3})\s*(?:vials?|pcs|pieces|kits?)?\b/)?.[1] ?? t.match(/\b(\d{1,3})\s*(?:vials?|pcs|pieces)\b/)?.[1] ?? 1) || 1;
  const mass = parts.filter((p) => toMg[p.unit] !== undefined);
  if (mass.length) {
    const blendParts = blend || /\d\s*(?:mg|mcg|g)\s*\/\s*\d/.test(t);
    const use = blendParts ? mass : [mass[0]];
    const mg = use.reduce((n, p) => n + p.amount * toMg[p.unit], 0);
    return { amount: +mg.toFixed(4), unit: 'mg', pack, parts: use.length };
  }
  return { amount: parts[0].amount, unit: parts[0].unit, pack, parts: 1 };
}

/** One shop product (or variation) → a listing row, or null when it is not a peptide we can price. Pure. */
export function toOffer({ vendor, id, name, label, price, currency, inStock, url, match }) {
  const pep = match(`${name} ${label ?? ''}`);
  if (!pep) return null;
  // Read the label first (the variation's own size), then the name; a blend's amounts add up.
  const amt = readAmount(`${label ?? ''} ${name}`, { blend: /\+|\/|blend/i.test(pep.name) });
  const p = Number(price);
  if (!amt || !Number.isFinite(p) || p <= 0) return null;
  const cur = String(currency ?? 'USD').toUpperCase();
  const fx = USD[cur];
  const priceUsd = fx ? +(p * fx).toFixed(2) : null;
  const total = amt.amount * amt.pack;
  return {
    id,
    vendor,
    peptide: pep.name,
    peptide_slug: pep.slug,
    name: label ? `${name} ${String(label).replace(/^[^:]+:\s*/, '')}`.trim() : name,
    form: 'vial',
    unit: amt.unit,
    amount: amt.amount,
    pack_qty: amt.pack,
    price: p,
    currency: cur,
    price_usd: priceUsd,
    total_mg: amt.unit === 'mg' ? total : null,
    usd_per_mg: priceUsd !== null && total > 0 ? +(priceUsd / total).toFixed(4) : null,
    usd_per_unit: priceUsd !== null && amt.pack > 0 ? +(priceUsd / amt.pack).toFixed(2) : null,
    in_stock: inStock === true ? 1 : inStock === false ? 0 : null,
    url: url ?? null,
    blend: null,
  };
}

/** A stable listing id for a shop item: well above the register's ids, the same on every read. */
export function shopOfferId(vendor, itemId) {
  let h = 2166136261;
  for (const c of `${vendor}|${itemId}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return 3_000_000_000 + (h >>> 1);
}

const minor = (v, digits) => Number(v) / 10 ** Number(digits ?? 2);

async function wooPages(fetcher, origin, type) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetcher.text(`${origin}/wp-json/wc/store/v1/products?type=${type}&per_page=100&page=${page}`, { accept: 'application/json' });
    let list;
    try {
      list = JSON.parse(r.text);
    } catch {
      break;
    }
    if (!Array.isArray(list) || !list.length) break;
    out.push(...list);
    const pages = Number(r.headers.get('x-wp-totalpages') ?? 0);
    if ((pages && page >= pages) || list.length < 100) break;
  }
  return out;
}

/** WooCommerce Store API: every simple product and every variation, with price, currency and stock. */
export async function readWoo(fetcher, origin) {
  const simple = await wooPages(fetcher, origin, 'simple');
  const variations = await wooPages(fetcher, origin, 'variation');
  return [...simple, ...variations].map((x) => ({
    id: x.id,
    name: x.name,
    label: x.variation || null,
    price: minor(x.prices?.price, x.prices?.currency_minor_unit),
    currency: x.prices?.currency_code,
    inStock: typeof x.is_in_stock === 'boolean' ? x.is_in_stock : null,
    url: x.permalink,
  }));
}

/** Shopify: /products.json (paged) and the shop's currency from /cart.js. */
export async function readShopify(fetcher, origin) {
  let currency = 'USD';
  try {
    currency = (await fetcher.json(`${origin}/cart.js`))?.currency ?? 'USD';
  } catch {}
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const doc = await fetcher.json(`${origin}/products.json?limit=250&page=${page}`);
    const products = Array.isArray(doc?.products) ? doc.products : [];
    if (!products.length) break;
    for (const p of products) {
      for (const v of p.variants ?? []) {
        out.push({
          id: `${p.id}-${v.id}`,
          name: p.title,
          label: v.title && v.title !== 'Default Title' ? v.title : null,
          price: Number(v.price),
          currency,
          inStock: typeof v.available === 'boolean' ? v.available : null,
          url: `${origin}/products/${p.handle}${v.id ? `?variant=${v.id}` : ''}`,
        });
      }
    }
    if (products.length < 250) break;
  }
  return out;
}

/**
 * Which feed a shop publishes: 'woo', 'shopify' or null. A shop that publishes neither is an
 * answer, not a failure. Other errors (the shop is down, 429) propagate so the daemon backs off.
 */
export async function detect(fetcher, origin) {
  try {
    const r = await fetcher.text(`${origin}/wp-json/wc/store/v1/products?per_page=1`, { accept: 'application/json' });
    if (Array.isArray(JSON.parse(r.text))) return 'woo';
  } catch (err) {
    if (err?.retryAfterMs || err?.code === 'blocked' || err?.code === 'network' || err?.code === 'timeout') throw err;
  }
  try {
    const doc = await fetcher.json(`${origin}/products.json?limit=1`);
    if (Array.isArray(doc?.products)) return 'shopify';
  } catch (err) {
    if (err?.retryAfterMs) throw err;
  }
  return null;
}

/** Replace one vendor's shop listings and recompute its listing count and cheapest price per mg. */
export function saveShopOffers(vendor, offers, now = new Date().toISOString()) {
  const db = open();
  const cols = ['id', 'vendor', 'peptide', 'peptide_slug', 'name', 'form', 'unit', 'amount', 'pack_qty', 'price', 'currency', 'price_usd', 'total_mg', 'usd_per_mg', 'usd_per_unit', 'in_stock', 'url', 'blend'];
  const add = db.query(`INSERT OR REPLACE INTO offers (${cols.join(', ')}, origin, checked_at) VALUES (${cols.map(() => '?').join(', ')}, 'shop', ?)`);
  db.transaction(() => {
    db.query("DELETE FROM offers WHERE vendor = ? AND origin = 'shop'").run(vendor);
    for (const o of offers) add.run(...cols.map((k) => o[k] ?? null), now);
  })();
  recomputeVendorStats([vendor]);
  return offers.length;
}

/**
 * A vendor's listing count, peptide count and cheapest mg price, from the listings it
 * shows: its shop's when it has any, the register's otherwise.
 */
export function recomputeVendorStats(vendors = null) {
  const db = open();
  const slugs = vendors ?? db.query('SELECT slug FROM vendors').all().map((r) => r.slug);
  const shown = db.query(`SELECT count(*) n, count(DISTINCT peptide_slug) p, min(CASE WHEN unit = 'mg' THEN usd_per_mg END) m
    FROM offers WHERE vendor = ?1 AND origin = (CASE WHEN EXISTS (SELECT 1 FROM offers WHERE vendor = ?1 AND origin = 'shop') THEN 'shop' ELSE 'register' END)`);
  const set = db.query('UPDATE vendors SET offers = ?, peptides = ?, min_usd_per_mg = ? WHERE slug = ?');
  db.transaction(() => {
    for (const s of slugs) {
      const r = shown.get(s);
      set.run(r.n, r.p, r.m, s);
    }
  })();
}

/** Read one vendor's shop into listings. Returns { platform, items, listings } (platform null = no feed). */
export async function readShop(fetcher, vendor, origin, match) {
  const platform = await detect(fetcher, origin);
  if (!platform) return { platform: null, items: 0, listings: [] };
  const items = platform === 'woo' ? await readWoo(fetcher, origin) : await readShopify(fetcher, origin);
  const listings = [];
  const seen = new Set();
  for (const it of items) {
    const o = toOffer({ vendor, ...it, id: shopOfferId(vendor, it.id), match });
    if (o && !seen.has(o.id)) {
      seen.add(o.id);
      listings.push(o);
    }
  }
  return { platform, items: items.length, listings };
}
