import { config } from './config.js';
import { activeChips, buildFacets, omit, priceOptions } from './core/facets.js';
import { countryName, PAYMENT_LABELS } from './core/normalize.js';
import { fromParams, toParams } from './core/parse.js';
import { getMeta, open } from './db.js';

/**
 * Everything the site answers comes through here, for the page, the API, the CLI
 * and MCP alike. The register is small (a few hundred vendors, ~20k listings), so it
 * lives in memory after the first read and every facet count is an exact in-memory
 * recount; `invalidate()` after a sync or a paid sponsorship drops the copy.
 */
const J = (s, d = []) => {
  try {
    return JSON.parse(s ?? 'null') ?? d;
  } catch {
    return d;
  }
};

let cache = null;
export function invalidate() {
  cache = null;
}

/** vendor_contacts rows → { emails, phones, websites, socials: { telegram: [...] } }. */
function contactCard(rows = []) {
  const card = { emails: [], phones: [], websites: [], socials: {} };
  for (const r of rows) {
    if (r.kind === 'email') card.emails.push(r.value);
    else if (r.kind === 'phone') card.phones.push(r.value);
    else if (r.kind === 'website') card.websites.push(r.value);
    else (card.socials[r.kind] ??= []).push(r.value);
  }
  return card;
}

function shapeVendor(r, sponsored, contactRows) {
  const tested = r.tests_pass + r.tests_fail;
  return {
    slug: r.slug,
    name: r.name,
    website: r.website,
    shop_url: r.shop_url,
    location: r.location,
    country: r.country,
    score: r.score,
    rank: r.rank,
    tests: r.tests,
    tests_pass: r.tests_pass,
    tests_fail: r.tests_fail,
    pass_rate: tested ? Math.round((100 * r.tests_pass) / tested) : null,
    latest_test: r.latest_test,
    cost_per_mg: r.cost_per_mg,
    ordering: r.ordering,
    ordering_evidence: r.ordering_evidence,
    payments: J(r.payments),
    payments_raw: J(r.payments_raw),
    ships_from: J(r.ships_from),
    ships_to: r.ships_to,
    shipping: J(r.shipping),
    min_order: r.min_order,
    discounts: J(r.discounts),
    coupons: J(r.coupons),
    contact: contactCard(contactRows),
    terms_source: r.terms_source,
    notes: r.notes,
    offers: r.offers,
    peptides: r.peptides,
    min_usd_per_mg: r.min_usd_per_mg,
    checked_at: r.checked_at,
    sponsored: sponsored.has(r.slug),
    // 'register' (prices and lab results) or 'finnrick' (found by discovery; lab counts and contacts only).
    origin: r.origin ?? 'register',
    status: r.status ?? null,
    page: `${config.siteUrl}/v/${r.slug}`,
  };
}

function load() {
  if (cache) return cache;
  const db = open();
  const now = new Date().toISOString();
  const sponsored = new Set(db.query("SELECT vendor FROM sponsors WHERE status = 'paid' AND until > ?").all(now).map((r) => r.vendor));
  const contacts = new Map();
  for (const c of db.query('SELECT vendor, kind, value FROM vendor_contacts ORDER BY kind, value').all()) (contacts.get(c.vendor) ?? contacts.set(c.vendor, []).get(c.vendor)).push(c);
  const vendors = db.query('SELECT * FROM vendors').all().map((r) => shapeVendor(r, sponsored, contacts.get(r.slug)));
  const bySlug = new Map(vendors.map((v) => [v.slug, v]));
  const passed = new Set(db.query("SELECT DISTINCT vendor, peptide_slug FROM lab_tests WHERE result = 'pass'").all().map((r) => `${r.vendor}|${r.peptide_slug}`));
  // A vendor whose own shop we read shows those prices, not the register's older ones.
  const fromShop = new Set(db.query("SELECT DISTINCT vendor FROM offers WHERE origin = 'shop'").all().map((r) => r.vendor));
  const offers = db
    .query('SELECT * FROM offers')
    .all()
    .filter((o) => bySlug.has(o.vendor) && (o.origin === 'shop' || !fromShop.has(o.vendor)))
    .map((o) => {
      const v = bySlug.get(o.vendor);
      const name = o.name ?? o.peptide;
      return { ...o, blend: J(o.blend, null), vendor_name: v.name, v, passed: passed.has(`${o.vendor}|${o.peptide_slug}`), hay: `${o.peptide} ${name} ${v.name} ${o.vendor}`.toLowerCase() };
    });
  const pep = new Map();
  for (const o of offers) {
    const p = pep.get(o.peptide_slug) ?? { slug: o.peptide_slug, name: o.peptide, offers: 0, vendors: new Set(), min_usd_per_mg: null };
    p.offers++;
    p.vendors.add(o.vendor);
    if (o.unit === 'mg' && Number.isFinite(o.usd_per_mg) && (p.min_usd_per_mg === null || o.usd_per_mg < p.min_usd_per_mg)) p.min_usd_per_mg = o.usd_per_mg;
    pep.set(o.peptide_slug, p);
  }
  for (const t of db.query("SELECT peptide_slug, peptide, sum(result = 'pass') pass, sum(result = 'fail') fail, count(*) n FROM lab_tests GROUP BY peptide_slug").all()) {
    const p = pep.get(t.peptide_slug) ?? { slug: t.peptide_slug, name: t.peptide, offers: 0, vendors: new Set(), min_usd_per_mg: null };
    Object.assign(p, { tests: t.n, tests_pass: t.pass, tests_fail: t.fail });
    pep.set(t.peptide_slug, p);
  }
  const peptides = [...pep.values()].map((p) => ({ slug: p.slug, name: p.name, offers: p.offers, vendors: p.vendors.size, min_usd_per_mg: p.min_usd_per_mg, tests: p.tests ?? 0, tests_pass: p.tests_pass ?? 0, tests_fail: p.tests_fail ?? 0 }));
  peptides.sort((a, b) => b.offers - a.offers || a.name.localeCompare(b.name));
  // Longest name first so "BPC-157 + TB-500" is read before "BPC-157".
  const known = { peptides: peptides.filter((p) => p.offers).toSorted((a, b) => b.name.length - a.name.length) };
  // Listings by peptide and by vendor: a facet count inside one peptide scans its few hundred rows, not all 20k.
  const offerIndex = { peptide: groupBy(offers, 'peptide_slug'), vendor: groupBy(offers, 'vendor') };
  // Facets per filter set, until the next invalidate(): a crawler asking for / again costs nothing.
  cache = { vendors, bySlug, offers, offerIndex, facetMemo: new Map(), peptides, pepBySlug: new Map(peptides.map((p) => [p.slug, p])), known };
  return cache;
}

export const knownTerms = () => load().known;
export const parse = (input) => fromParams(input ?? {}, load().known);

/* ---------- listings ---------- */

/** Does one listing pass every filter? Pure; the facet counts call it too, so a count never disagrees with its page. */
function offerMatches(o, f) {
  const v = o.v;
  if (f.peptide && o.peptide_slug !== f.peptide) return false;
  if (f.vendor && o.vendor !== f.vendor) return false;
  if (f.form && o.form !== f.form) return false;
  if (f.in_stock && o.in_stock !== 1) return false;
  if (f.tested && !v.tests) return false;
  if (f.passed && !o.passed) return false;
  if (f.coupon && !v.coupons.length) return false;
  if (f.single && o.blend) return false;
  if (f.blend && !o.blend) return false;
  if (f.min_score !== undefined && !(v.score >= f.min_score)) return false;
  if (f.payment && !v.payments.includes(f.payment)) return false;
  if (f.ships_from && !v.ships_from.includes(f.ships_from)) return false;
  if (f.ordering && v.ordering !== f.ordering) return false;
  if (f.max_price !== undefined && !(o.price_usd <= f.max_price)) return false;
  if (f.min_price !== undefined && !(o.price_usd >= f.min_price)) return false;
  if (f.max_per_mg !== undefined && !(o.unit === 'mg' && o.usd_per_mg <= f.max_per_mg)) return false;
  if (f.min_per_mg !== undefined && !(o.unit === 'mg' && o.usd_per_mg >= f.min_per_mg)) return false;
  if (f.min_mg !== undefined && !(o.unit === 'mg' && o.amount >= f.min_mg)) return false;
  if (f.max_mg !== undefined && !(o.unit === 'mg' && o.amount <= f.max_mg)) return false;
  if (f.q) for (const w of f.q.toLowerCase().split(/\s+/)) if (w && !o.hay.includes(w)) return false;
  return true;
}

const FORM_LABELS = { vial: 'Vial', supply: 'Supplies', liquid: 'Liquid', spray: 'Nasal spray', capsule: 'Capsule', topical: 'Topical', pen: 'Pen' };
const ORDERING_LABELS = { checkout: 'Online checkout', message: 'Order by message', marketplace: 'Marketplace', login: 'Members only' };

function tally(rows, pick) {
  const m = new Map();
  for (const r of rows) for (const k of [pick(r)].flat()) if (k !== null && k !== undefined) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.keys()];
}

function offerFacetDefs(c, f) {
  const { offers, pepBySlug, bySlug } = c;
  const peps = tally(offers, (o) => o.peptide_slug);
  const ships = tally(c.vendors, (v) => v.ships_from);
  if (f.ships_from && !ships.includes(f.ships_from)) ships.push(f.ships_from);
  return [
    { name: 'peptide', label: 'Peptide', open: true, sort: 'count', limit: 60, options: peps.map((p) => ({ key: p, label: pepBySlug.get(p)?.name ?? p, set: { peptide: p } })) },
    { name: 'per_mg', label: 'Price per mg', open: true, params: ['max_per_mg', 'min_per_mg'], options: [[0.1, 'under $0.10/mg'], [0.25, 'under $0.25/mg'], [0.5, 'under $0.50/mg'], [1, 'under $1/mg'], [2, 'under $2/mg'], [5, 'under $5/mg']].map(([n, label]) => ({ key: String(n), label, set: { max_per_mg: n } })) },
    { name: 'price', label: 'Price (USD)', open: true, params: ['min_price', 'max_price'], options: priceOptions([25, 50, 100, 200, 500], '$').filter((o) => o.key !== 'free') },
    { name: 'size', label: 'Size per vial', open: true, params: ['min_mg', 'max_mg'], options: [[0, 5, 'up to 5 mg'], [5, 10, '5 to 10 mg'], [10, 20, '10 to 20 mg'], [20, 50, '20 to 50 mg'], [50, undefined, '50 mg or more']].map(([lo, hi, label]) => ({ key: `${lo}-${hi ?? ''}`, label, set: { min_mg: lo || undefined, max_mg: hi } })) },
    { name: 'quality', label: 'Lab testing', open: true, independent: true, options: [{ key: 'tested', label: 'Vendor is lab-tested', set: { tested: true } }, { key: 'passed', label: 'Passed a test for this peptide', set: { passed: true } }, { key: 'in_stock', label: 'In stock', set: { in_stock: true } }, { key: 'coupon', label: 'Has a coupon', set: { coupon: true } }] },
    { name: 'score', label: 'Vendor score', open: true, options: [90, 80, 70, 60, 50].map((n) => ({ key: String(n), label: `${n} or better`, set: { min_score: n } })) },
    { name: 'payment', label: 'Pay with', open: true, sort: 'count', options: Object.entries(PAYMENT_LABELS).map(([k, label]) => ({ key: k, label, set: { payment: k } })) },
    { name: 'ships_from', label: 'Ships from', sort: 'count', limit: 30, options: ships.map((s) => ({ key: s, label: countryName(s), set: { ships_from: s } })) },
    { name: 'form', label: 'Form', sort: 'count', options: Object.entries(FORM_LABELS).map(([k, label]) => ({ key: k, label, set: { form: k } })) },
    { name: 'kind', label: 'Single or blend', options: [{ key: 'single', label: 'Single peptide', set: { single: true } }, { key: 'blend', label: 'Blend', set: { blend: true } }] },
    { name: 'ordering', label: 'How you order', sort: 'count', options: Object.entries(ORDERING_LABELS).map(([k, label]) => ({ key: k, label, set: { ordering: k } })) },
    { name: 'vendor', label: 'Vendor', sort: 'count', limit: 60, options: tally(offers, (o) => o.vendor).map((s) => ({ key: s, label: bySlug.get(s)?.name ?? s, set: { vendor: s } })) },
  ];
}

/**
 * Counting a 770-option facet one option at a time would rescan every listing per
 * option; for peptide and vendor one pass tallies the whole group instead.
 */
function counter(rows, match, grouped, index = {}) {
  const memo = new Map();
  return (g) => {
    // Pinned to one value of an indexed field: only that value's rows can match.
    for (const [param, field] of grouped) {
      const pool = g[param] !== undefined && index[param];
      if (!pool) continue;
      let n = 0;
      for (const r of pool.get(g[param]) ?? []) if (r[field] === g[param] && match(r, g)) n++;
      return n;
    }
    for (const [param, field] of grouped) {
      if (g[param] === undefined) continue;
      const base = omit(g, [param]);
      const key = `${param}:${JSON.stringify(base)}`;
      let m = memo.get(key);
      if (!m) {
        m = new Map();
        for (const r of rows) if (match(r, base)) m.set(r[field], (m.get(r[field]) ?? 0) + 1);
        memo.set(key, m);
      }
      return m.get(g[param]) ?? 0;
    }
    let n = 0;
    for (const r of rows) if (match(r, g)) n++;
    return n;
  };
}

function groupBy(rows, field) {
  const m = new Map();
  for (const r of rows) {
    const list = m.get(r[field]);
    if (list) list.push(r);
    else m.set(r[field], [r]);
  }
  return m;
}

const PAGE = 50;
const inf = Number.POSITIVE_INFINITY;
const OFFER_SORTS = {
  per_mg: (a, b) => (a.unit === 'mg' ? (a.usd_per_mg ?? inf) : inf) - (b.unit === 'mg' ? (b.usd_per_mg ?? inf) : inf) || (a.price_usd ?? inf) - (b.price_usd ?? inf),
  price: (a, b) => (a.price_usd ?? inf) - (b.price_usd ?? inf),
  score: (a, b) => (b.v.score ?? -1) - (a.v.score ?? -1) || (a.usd_per_mg ?? inf) - (b.usd_per_mg ?? inf),
  size: (a, b) => (b.total_mg ?? -1) - (a.total_mg ?? -1),
  name: (a, b) => a.peptide.localeCompare(b.peptide) || a.vendor_name.localeCompare(b.vendor_name),
};

export const publicOffer = (o) => ({
  id: o.id,
  peptide: o.peptide,
  peptide_slug: o.peptide_slug,
  name: o.name,
  vendor: o.vendor,
  vendor_name: o.vendor_name,
  vendor_score: o.v.score,
  vendor_tests: o.v.tests,
  passed_test: o.passed,
  form: o.form,
  amount: o.amount,
  unit: o.unit,
  pack_qty: o.pack_qty,
  price: o.price,
  currency: o.currency,
  price_usd: o.price_usd,
  total_mg: o.total_mg,
  usd_per_mg: o.usd_per_mg,
  in_stock: o.in_stock === 1 ? true : o.in_stock === 0 ? false : null,
  blend: o.blend,
  url: o.url,
  sponsored: o.v.sponsored,
  // 'shop': read from the vendor's own store on checked_at; 'register': the older compiled register.
  source: o.origin ?? 'register',
  checked_at: o.checked_at ?? null,
});

export function searchOffers(input, opts = {}) {
  const c = load();
  const { filters: f, understood, text } = input?.filters ? input : parse(input);
  const sort = OFFER_SORTS[f.sort] ? f.sort : 'per_mg';
  const rows = c.offers.filter((o) => offerMatches(o, f)).sort(OFFER_SORTS[sort]);
  const limit = opts.all ? Math.max(rows.length, 1) : Math.min(opts.limit ?? PAGE, 500);
  const page = Math.max(1, Math.floor(f.page ?? 1));
  // Sponsored vendors: their best matching listing is shown first, labelled. Nothing else is reordered.
  const sponsored = [];
  for (const v of c.vendors) {
    if (!v.sponsored) continue;
    const best = rows.find((o) => o.vendor === v.slug);
    if (best) sponsored.push(best);
  }
  const out = {
    query: { text, filters: f, understood },
    total: rows.length,
    page,
    pages: Math.max(1, Math.ceil(rows.length / limit)),
    sponsored: sponsored.slice(0, 2).map(publicOffer),
    offers: rows.slice((page - 1) * limit, page * limit).map(publicOffer),
  };
  if (opts.facets) {
    // The page number changes no count and no facet link (buildFacets drops it), so it is not part of the key.
    const key = JSON.stringify(omit(f, ['page']));
    let facets = c.facetMemo.get(key);
    if (!facets) {
      const count = counter(c.offers, offerMatches, [['peptide', 'peptide_slug'], ['vendor', 'vendor']], c.offerIndex);
      facets = buildFacets(offerFacetDefs(c, f), f, count, toParams);
      if (c.facetMemo.size >= 500) c.facetMemo.delete(c.facetMemo.keys().next().value);
      c.facetMemo.set(key, facets);
    }
    out.facets = facets;
    out.chips = activeChips(out.facets, f, toParams, [
      { param: 'q', label: (v) => `“${v}”` },
      { param: 'peptide', label: (v) => c.pepBySlug.get(v)?.name ?? v },
      { param: 'vendor', label: (v) => c.bySlug.get(v)?.name ?? v },
      { param: 'max_per_mg', label: (v) => `under $${v}/mg` },
      { param: 'max_price', label: (v) => `under $${v}` },
    ]).filter((chip, i, all) => all.findIndex((x) => x.label === chip.label) === i);
  }
  const params = toParams(f);
  out.links = {
    page: `${config.siteUrl}/?${params}`,
    api: `${config.siteUrl}/api/v1/search?${params}`,
    cli: `peptides search${text ? ` ${JSON.stringify(text)}` : ''}${[...toParams(omit(f, Object.keys(readOnlyText(text))))].map(([k, v]) => ` --${k.replace(/_/g, '-')}${v === '1' ? '' : ` ${v}`}`).join('')}`,
  };
  out.disclosure = DISCLOSURE;
  return out;
}

// Filters the free text already says, so the CLI line does not repeat them as flags.
const readOnlyText = (text) => (text ? parse({ text }).filters : {});

// Anthony's wording, 2026-10-19. PRICE_NOTE is ours: where prices and contacts come from, and what Sponsored means.
export const DISCLOSURE = "Scores and test counts come from Finnrick's independent lab testing; COA findings are from documents the vendor publishes. Not affiliated with Finnrick or any vendor. For research use; not medical advice.";
export const PRICE_NOTE = "Prices are each vendor's own, converted to USD on the date shown. Contact details are read from each vendor's own site. Sponsored vendors are labelled; nothing else is paid placement.";

/* ---------- vendors ---------- */

function vendorMatches(v, f) {
  if (f.min_score !== undefined && !(v.score >= f.min_score)) return false;
  if (f.min_pass !== undefined && !(v.pass_rate >= f.min_pass)) return false;
  if (f.tested && !v.tests) return false;
  if (f.priced && !v.offers) return false;
  if (f.coupon && !v.coupons.length) return false;
  if (f.payment && !v.payments.includes(f.payment)) return false;
  if (f.ships_from && !v.ships_from.includes(f.ships_from)) return false;
  if (f.ordering && v.ordering !== f.ordering) return false;
  if (f.contact && !hasContact(v, f.contact)) return false;
  if (f.peptide && !v._peps?.has(f.peptide)) return false;
  if (f.q) {
    const hay = `${v.name} ${v.slug} ${v.location ?? ''} ${v.website ?? ''}`.toLowerCase();
    for (const w of f.q.toLowerCase().split(/\s+/)) if (w && !hay.includes(w)) return false;
  }
  return true;
}

const hasContact = (v, kind) => (kind === 'email' ? v.contact.emails.length > 0 : kind === 'phone' ? v.contact.phones.length > 0 : kind === 'website' ? v.contact.websites.length > 0 : (v.contact.socials[kind]?.length ?? 0) > 0);
export const CONTACT_LABELS = { email: 'Email', phone: 'Phone', website: 'Website', whatsapp: 'WhatsApp', telegram: 'Telegram', instagram: 'Instagram', x: 'X (Twitter)', facebook: 'Facebook', discord: 'Discord', tiktok: 'TikTok', youtube: 'YouTube', reddit: 'Reddit', linkedin: 'LinkedIn', signal: 'Signal' };

const VENDOR_SORTS = {
  score: (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.tests - a.tests || a.name.localeCompare(b.name),
  tests: (a, b) => b.tests - a.tests || (b.score ?? -1) - (a.score ?? -1),
  pass_rate: (a, b) => (b.pass_rate ?? -1) - (a.pass_rate ?? -1) || b.tests - a.tests,
  per_mg: (a, b) => (a.min_usd_per_mg ?? inf) - (b.min_usd_per_mg ?? inf),
  listings: (a, b) => b.offers - a.offers,
  name: (a, b) => a.name.localeCompare(b.name),
};

export function searchVendors(input, opts = {}) {
  const c = load();
  if (!c.vendors[0]?._peps) {
    const peps = new Map();
    for (const o of c.offers) (peps.get(o.vendor) ?? peps.set(o.vendor, new Set()).get(o.vendor)).add(o.peptide_slug);
    for (const v of c.vendors) Object.defineProperty(v, '_peps', { value: peps.get(v.slug) ?? new Set(), enumerable: false });
  }
  const { filters: f, understood, text } = input?.filters ? input : parse(input);
  const sort = VENDOR_SORTS[f.sort] ? f.sort : 'score';
  const rows = c.vendors.filter((v) => vendorMatches(v, f)).sort(VENDOR_SORTS[sort]);
  const pinned = rows.filter((v) => v.sponsored).slice(0, 2);
  const limit = opts.all ? Math.max(rows.length, 1) : Math.min(opts.limit ?? 100, 500);
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const out = { query: { text, filters: f, understood }, total: rows.length, page, pages: Math.max(1, Math.ceil(rows.length / limit)), sponsored: pinned, vendors: rows.slice((page - 1) * limit, page * limit) };
  if (opts.facets) {
    const ships = tally(c.vendors, (v) => v.ships_from);
    const defs = [
      { name: 'score', label: 'Vendor score', open: true, options: [90, 80, 70, 60, 50].map((n) => ({ key: String(n), label: `${n} or better`, set: { min_score: n } })) },
      { name: 'pass', label: 'Lab pass rate', open: true, options: [100, 90, 75, 50].map((n) => ({ key: String(n), label: n === 100 ? 'Every test passed' : `${n}% or more passed`, set: { min_pass: n } })) },
      { name: 'has', label: 'Has', open: true, independent: true, options: [{ key: 'tested', label: 'Lab test results', set: { tested: true } }, { key: 'priced', label: 'Published prices', set: { priced: true } }, { key: 'coupon', label: 'A coupon', set: { coupon: true } }] },
      { name: 'payment', label: 'Pay with', open: true, sort: 'count', options: Object.entries(PAYMENT_LABELS).map(([k, label]) => ({ key: k, label, set: { payment: k } })) },
      { name: 'ships_from', label: 'Ships from', open: true, sort: 'count', limit: 30, options: ships.map((s) => ({ key: s, label: countryName(s), set: { ships_from: s } })) },
      { name: 'contact', label: 'Contact by', open: true, sort: 'count', options: Object.entries(CONTACT_LABELS).map(([k, label]) => ({ key: k, label, set: { contact: k } })) },
      { name: 'ordering', label: 'How you order', sort: 'count', options: Object.entries(ORDERING_LABELS).map(([k, label]) => ({ key: k, label, set: { ordering: k } })) },
    ];
    const count = (g) => c.vendors.reduce((n, v) => n + (vendorMatches(v, g) ? 1 : 0), 0);
    out.facets = buildFacets(defs, f, count, toParams);
    out.chips = activeChips(out.facets, f, toParams, [
      { param: 'q', label: (v) => `“${v}”` },
      { param: 'peptide', label: (v) => `sells ${c.pepBySlug.get(v)?.name ?? v}` },
    ]);
  }
  const params = toParams(f);
  out.links = { page: `${config.siteUrl}/vendors?${params}`, api: `${config.siteUrl}/api/v1/vendors?${params}`, cli: `peptides vendors${[...params].map(([k, v]) => ` --${k.replace(/_/g, '-')}${v === '1' ? '' : ` ${v}`}`).join('')}` };
  out.disclosure = DISCLOSURE;
  return out;
}

export function getVendor(slug) {
  const c = load();
  const v = c.bySlug.get(slug);
  if (!v) return null;
  const db = open();
  return {
    ...v,
    lab_tests: db.query('SELECT peptide, peptide_slug, tested_on, result FROM lab_tests WHERE vendor = ? ORDER BY tested_on DESC').all(slug),
    ratings: db.query('SELECT peptide, peptide_slug, rating, n_tests, cost_per_mg FROM ratings WHERE vendor = ? ORDER BY rating DESC').all(slug),
    listings: c.offers.filter((o) => o.vendor === slug).sort(OFFER_SORTS.name).map(publicOffer),
  };
}

export function listPeptides() {
  return load().peptides;
}

export function getPeptide(slug) {
  const c = load();
  const p = c.pepBySlug.get(slug);
  if (!p) return null;
  const db = open();
  const byVendor = db
    .query("SELECT vendor, sum(result = 'pass') pass, sum(result = 'fail') fail, count(*) n, max(tested_on) latest FROM lab_tests WHERE peptide_slug = ? GROUP BY vendor ORDER BY pass DESC, n DESC")
    .all(slug)
    .map((r) => ({ ...r, vendor_name: c.bySlug.get(r.vendor)?.name ?? r.vendor }));
  return { ...p, lab_results: byVendor, page: `${config.siteUrl}/p/${slug}` };
}

// The day the register was last read; a database loaded from the bundled snapshot has only a 1970 placeholder.
export const syncedDay = (s) => (s.synced_at && !String(s.synced_at).startsWith('1970') ? String(s.synced_at).slice(0, 10) : null);

export function stats() {
  const c = load();
  return {
    vendors: c.vendors.length,
    vendors_with_prices: c.vendors.filter((v) => v.offers).length,
    listings: c.offers.length,
    peptides: c.peptides.filter((p) => p.offers).length,
    lab_tests: c.vendors.reduce((n, v) => n + v.tests, 0),
    vendors_with_email: c.vendors.filter((v) => v.contact.emails.length).length,
    vendors_with_phone: c.vendors.filter((v) => v.contact.phones.length).length,
    enriched_at: getMeta('enriched_at'),
    synced_at: getMeta('synced_at'),
    source: getMeta('synced_from'),
  };
}
