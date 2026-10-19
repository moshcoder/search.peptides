import { slugify } from './normalize.js';

/**
 * One filter vocabulary for the page, the API, the CLI and MCP. A search arrives as
 * URL params (or an MCP argument object); `text` is free text, read into filters
 * where a phrase is unambiguous ("under $50", "in stock", "lab tested", "crypto")
 * and left as a word search otherwise.
 */
const NUM = ['min_price', 'max_price', 'max_per_mg', 'min_per_mg', 'min_mg', 'max_mg', 'min_score', 'min_pass', 'page'];
const BOOL = ['in_stock', 'tested', 'passed', 'coupon', 'priced', 'single', 'blend'];
const STR = ['q', 'peptide', 'vendor', 'form', 'payment', 'ships_from', 'ordering', 'contact', 'sort'];
export const PARAMS = [...STR, ...NUM, ...BOOL];

const truthy = (v) => v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v ?? ''));
const PAY_WORDS = { crypto: 'crypto', bitcoin: 'crypto', btc: 'crypto', usdt: 'crypto', usdc: 'crypto', zelle: 'zelle', paypal: 'paypal', venmo: 'venmo', cashapp: 'cashapp', card: 'card' };

/** Free text → { filters, understood }. Whatever is not understood stays as q. */
export function readText(text, known = {}) {
  const f = {};
  const understood = [];
  let s = ` ${String(text ?? '').toLowerCase()} `;
  const take = (re, fn) => {
    s = s.replace(re, (...m) => {
      fn(...m);
      return ' ';
    });
  };
  take(/\b(?:under|below|less than|max|<)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:\/|per)\s*mg\b/g, (_, n) => {
    f.max_per_mg = Number(n);
    understood.push(`under $${n}/mg`);
  });
  take(/\b(?:under|below|less than|max|<)\s*\$\s*(\d+(?:\.\d+)?)\b|\b(?:under|below)\s+(\d+(?:\.\d+)?)\s*(?:usd|dollars)\b/g, (_, a, b) => {
    f.max_price = Number(a ?? b);
    understood.push(`under $${a ?? b}`);
  });
  take(/\bin[ -]stock\b/g, () => {
    f.in_stock = true;
    understood.push('in stock');
  });
  take(/\b(?:lab[ -]?tested|tested|third[ -]party tested|coa)\b/g, () => {
    f.tested = true;
    understood.push('lab-tested vendor');
  });
  take(/\b(?:passed|pass(?:es|ing)? (?:tests?|coa))\b/g, () => {
    f.passed = true;
    understood.push('passed a lab test for it');
  });
  take(/\b(?:coupon|discount code|promo)\b/g, () => {
    f.coupon = true;
    understood.push('has a coupon');
  });
  take(/\bships? from (us|usa|china|cn|hk|hong kong|canada|ca|uk|eu|au)\b|\b(us|usa|domestic) (?:vendor|shipping|stock)\b/g, (_, a, b) => {
    const m = { us: 'US', usa: 'US', domestic: 'US', china: 'CN', cn: 'CN', hk: 'HK', 'hong kong': 'HK', canada: 'CA', ca: 'CA', uk: 'GB', eu: 'EU', au: 'AU' }[a ?? b];
    f.ships_from = m;
    understood.push(`ships from ${m}`);
  });
  take(/\b(?:pay(?:ing)? (?:with|by) )?(crypto|bitcoin|btc|usdt|usdc|zelle|paypal|venmo|cashapp)\b/g, (_, w) => {
    f.payment = PAY_WORDS[w];
    understood.push(`pays by ${f.payment}`);
  });
  take(/\b(\d+(?:\.\d+)?)\s*mg\b/g, (_, n) => {
    f.min_mg = Number(n);
    f.max_mg = Number(n);
    understood.push(`${n} mg`);
  });
  take(/\b(?:cheapest|best price|lowest)\b/g, () => {
    f.sort = 'per_mg';
  });
  // A known peptide named in full becomes the peptide filter (longest name first: "BPC-157 + TB-500" before "BPC-157").
  const rest = s.replace(/\s+/g, ' ').trim();
  if (rest && known.peptides) {
    for (const p of known.peptides) {
      const name = p.name.toLowerCase();
      const i = ` ${rest} `.indexOf(` ${name} `);
      if (i >= 0) {
        f.peptide = p.slug;
        understood.push(p.name);
        s = ` ${rest} `.replace(` ${name} `, ' ');
        break;
      }
    }
  }
  const q = s.replace(/\s+/g, ' ').trim();
  if (q) f.q = q;
  return { filters: f, understood };
}

/** URLSearchParams or a plain object → { filters, understood, text }. */
export function fromParams(input, known = {}) {
  const get = (k) => (input instanceof URLSearchParams ? (input.get(k) ?? undefined) : input?.[k]);
  const text = String(get('text') ?? '').trim();
  const { filters, understood } = text ? readText(text, known) : { filters: {}, understood: [] };
  for (const k of STR) {
    const v = get(k);
    if (v !== undefined && v !== null && String(v).trim() !== '') filters[k] = String(v).trim();
  }
  for (const k of NUM) {
    const v = get(k);
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) filters[k] = Number(v);
  }
  for (const k of BOOL) if (truthy(get(k))) filters[k] = true;
  if (filters.peptide) filters.peptide = slugify(filters.peptide);
  if (filters.ships_from) filters.ships_from = String(filters.ships_from).toUpperCase();
  if (filters.payment) filters.payment = String(filters.payment).toLowerCase();
  return { filters, understood, text };
}

/** Filters → URLSearchParams in a stable order, so a facet link and the canonical URL agree. */
export function toParams(f) {
  const p = new URLSearchParams();
  for (const k of PARAMS) {
    const v = f[k];
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (k === 'page' && Number(v) <= 1) continue;
    p.set(k, v === true ? '1' : String(v));
  }
  return p;
}
