/**
 * The source writes the same thing many ways ("USDT", "Bitcoin", "bank transfer (T/T)",
 * "US (Flower Mound, TX)"). These fold them into the few values a facet can offer.
 */

export const slugify = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const PAY_RULES = [
  ['crypto', /crypto|bitcoin|\bbtc\b|usdt|usdc|\beth\b|ethereum|\bltc\b|litecoin|xmr|monero|\bsol\b|solana|tether|nowpayments|coinbase/],
  ['card', /card|visa|mastercard|amex|apple pay|google pay|stripe|\bnmi\b|debit/],
  ['paypal', /paypal/],
  ['zelle', /zelle/],
  ['venmo', /venmo/],
  ['cashapp', /cash ?app/],
  ['bank', /bank|wire|t\/t|\bach\b|sepa|wise|\bswift\b|e-?transfer|interac/],
  ['western-union', /western union|moneygram|\bria\b/],
  ['alipay', /alipay|wechat/],
  ['marketplace', /alibaba|l\/c|trade assurance|globalsources|made-in-china/],
];
export const PAYMENT_LABELS = { crypto: 'Crypto', card: 'Card', paypal: 'PayPal', zelle: 'Zelle', venmo: 'Venmo', cashapp: 'Cash App', bank: 'Bank transfer', 'western-union': 'Western Union / MoneyGram', alipay: 'Alipay / WeChat', marketplace: 'Marketplace escrow' };

export function paymentClasses(list) {
  const out = new Set();
  for (const raw of list ?? []) {
    const s = String(raw).toLowerCase();
    for (const [k, re] of PAY_RULES) if (re.test(s)) out.add(k);
  }
  return [...out];
}

const COUNTRY_ALIASES = { UK: 'GB', 'US-CA': 'US', USA: 'US', CHINA: 'CN', 'HONG KONG': 'HK' };
export const COUNTRY_NAMES = { US: 'United States', CN: 'China', HK: 'Hong Kong', CA: 'Canada', EU: 'European Union', GB: 'United Kingdom', AU: 'Australia', DE: 'Germany', RO: 'Romania', PH: 'Philippines', FR: 'France', RU: 'Russia', LU: 'Luxembourg', SG: 'Singapore', TH: 'Thailand', VN: 'Vietnam', PL: 'Poland', MX: 'Mexico', IN: 'India', NL: 'Netherlands', ES: 'Spain', IT: 'Italy', JP: 'Japan', KR: 'South Korea', TW: 'Taiwan', NZ: 'New Zealand', AE: 'United Arab Emirates', TR: 'Turkey', BR: 'Brazil', IL: 'Israel' };
export const countryName = (c) => COUNTRY_NAMES[c] ?? c;

/** "CN/HK" → [CN, HK]; "US (Flower Mound, TX)" → [US]; "multiple warehouses (unspecified)" → []. */
export function countries(list) {
  const out = new Set();
  for (const raw of list ?? []) {
    for (const part of String(raw).split(/[\/,]/)) {
      const head = part.trim().replace(/\s*\(.*$/, '').toUpperCase();
      const code = COUNTRY_ALIASES[head] ?? head;
      if (/^[A-Z]{2}$/.test(code)) out.add(code);
    }
  }
  return [...out];
}

/** The vendor's free-text location ("china", "US: FL", "Nanjing, Jiangsu, China") as a country code, or null. */
export function locationCountry(s) {
  const t = String(s ?? '').toLowerCase();
  if (!t) return null;
  if (/hong kong/.test(t)) return 'HK';
  if (/china|shenzhen|guangzhou|nanjing|qingdao|shanghai|hubei|jinan|wuhan/.test(t)) return 'CN';
  if (/^us\b|united states|usa/.test(t)) return 'US';
  if (/canada/.test(t)) return 'CA';
  if (/\buk\b|united kingdom|england|london/.test(t)) return 'GB';
  return null;
}

// Query parameters that only exist to credit someone for the click. Our links carry none.
const TRACKING = /^(ref|aff|affiliate|affid|aff_id|referral|via|utm_.*|spm|spm_prev|tracelog|ckvia|from|fbclid|gclid|share)$/i;

/** A vendor link with the source's referral parameters (and any other tracking) taken off. */
export function cleanUrl(url, params = {}) {
  if (!url) return null;
  try {
    const u = new URL(url);
    // WhatsApp prefill text names whichever directory the link came from.
    if (/^(wa\.me|api\.whatsapp\.com)$/.test(u.hostname)) u.searchParams.delete('text');
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k) || k in params) u.searchParams.delete(k);
    return u.toString().replace(/\?$/, '');
  } catch {
    return null;
  }
}

/** "23 Apr 2026" → "2026-04-23"; anything unreadable stays as given. */
export function isoDate(s) {
  if (!s) return null;
  const t = Date.parse(`${s} UTC`);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : String(s);
}
