import { config } from './config.js';
import { open } from './db.js';

/**
 * Contact details for every vendor: emails, phones, socials and websites, from two
 * places, each kept as its own set in vendor_contacts (a register sync never touches it):
 *
 *   site      the vendor's own site: the homepage and the usual contact/about pages,
 *             plus the links the register already holds (WhatsApp numbers, Telegram…)
 *   finnrick  Finnrick's public vendor record, which lists the contacts it has vouched for
 *
 * Both run as queues on the scraper daemon (src/daemon.js), one vendor at a time per
 * host, through its fetcher: robots.txt honoured, public addresses only, every
 * redirect re-checked, time and size capped.
 */
const PATHS = ['/', '/contact', '/contact-us', '/pages/contact', '/pages/contact-us', '/about', '/about-us', '/pages/about-us'];
export const FINNRICK = 'https://www.finnrick.com';

const SOCIAL = [
  ['instagram', /^(?:www\.)?instagram\.com$/],
  ['x', /^(?:www\.|mobile\.)?(?:twitter|x)\.com$/],
  ['facebook', /^(?:www\.|m\.|web\.)?facebook\.com$|^fb\.com$/],
  ['telegram', /^(?:www\.)?(?:t\.me|telegram\.me|telegram\.org)$/],
  ['discord', /^(?:www\.)?(?:discord\.gg|discord\.com)$/],
  ['tiktok', /^(?:www\.)?tiktok\.com$/],
  ['youtube', /^(?:www\.|m\.)?(?:youtube\.com|youtu\.be)$/],
  ['reddit', /^(?:www\.|old\.)?reddit\.com$/],
  ['linkedin', /^(?:[a-z]{2,3}\.)?linkedin\.com$/],
  ['whatsapp', /^(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)$/],
  ['signal', /^signal\.(?:me|group)$/],
];
// Share buttons and platform chrome, not the vendor's own account.
const SOCIAL_NOISE = /\/(sharer|share|intent|dialog|plugins|tr|hashtag|login|signup|policies|privacy|about|help|legal|watch\?|embed)\b|\/(home|explore)\/?$|^\/?$/i;
// Hosts where the "website" is a listing on someone else's site; we read socials from them but never crawl them.
const NO_CRAWL = /(^|\.)(echemi\.com|alibaba\.com|globalsources\.com|chemicalbook\.com|made-in-china\.com|facebook\.com|instagram\.com|discord\.gg|discord\.com|t\.me|wa\.me|whatsapp\.com|beacons\.ai|linktr\.ee|reddit\.com|x\.com|twitter\.com|tiktok\.com|youtube\.com|glp1forum\.com|peptide\.chat|finnrick\.com)$/;

export function socialKind(url) {
  try {
    const u = new URL(url);
    for (const [kind, re] of SOCIAL) if (re.test(u.hostname.toLowerCase())) return kind === 'whatsapp' || !SOCIAL_NOISE.test(u.pathname + u.search) ? kind : null;
  } catch {}
  return null;
}

const EMAIL = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|domain|email|sentry|wixpress|sentry-next|yourdomain|company)\.|^(name|user|your|email|you)@|@\dx\./i;

export function emailsIn(html) {
  const out = new Set();
  const text = html.replace(/&#64;|&commat;|\s*\[at\]\s*|\s*\(at\)\s*/gi, '@').replace(/&#46;|\s*\[dot\]\s*/gi, '.');
  for (const m of text.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    try {
      out.add(decodeURIComponent(m[1]).toLowerCase());
    } catch {}
  }
  for (const m of text.matchAll(EMAIL)) out.add(m[0].toLowerCase());
  return [...out].filter((e) => !BAD_EMAIL.test(e) && /^[^@]+@[^@]+\.[a-z]{2,}$/.test(e));
}

/** +1 (555) 010-9999 → +15550109999; anything under 7 digits is not a phone. */
export function normalizePhone(s) {
  let raw;
  try {
    raw = decodeURIComponent(String(s));
  } catch {
    raw = String(s);
  }
  raw = raw.replace(/^tel:/i, '').trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return raw.startsWith('+') || digits.length > 10 ? `+${digits}` : digits;
}

export function phonesIn(html) {
  const out = new Set();
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
    const p = normalizePhone(m[1]);
    if (p) out.add(p);
  }
  return [...out];
}

/** The number a WhatsApp link opens a chat with, or null (group invites carry none). */
export function whatsappNumber(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'wa.me') return normalizePhone(`+${u.pathname.slice(1)}`);
    if (u.hostname === 'api.whatsapp.com') return normalizePhone(`+${u.searchParams.get('phone') ?? ''}`);
  } catch {}
  return null;
}

export function linksIn(html, base) {
  const out = [];
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    try {
      out.push(new URL(m[1].replace(/&amp;/g, '&'), base).toString());
    } catch {}
  }
  return out;
}

/** Everything one page says about how to reach the vendor. Pure. */
export function contactsIn(html, base) {
  const found = [];
  for (const e of emailsIn(html)) found.push({ kind: 'email', value: e });
  for (const p of phonesIn(html)) found.push({ kind: 'phone', value: p });
  for (const l of linksIn(html, base)) {
    const k = socialKind(l);
    if (!k) continue;
    found.push({ kind: k, value: l });
    if (k === 'whatsapp') {
      const n = whatsappNumber(l);
      if (n) found.push({ kind: 'phone', value: n });
    }
  }
  return found;
}

/** One spelling per contact, so the same account found on three pages is one row. Null when it is not usable. */
export function normalizeContact(kind, value) {
  if (kind === 'email') return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(value)) ? String(value).toLowerCase() : null;
  if (kind === 'phone') return normalizePhone(value);
  try {
    const u = new URL(value);
    u.hostname = u.hostname.toLowerCase();
    if (kind === 'website') return u.origin;
    if (kind === 'whatsapp') {
      const n = whatsappNumber(u.toString());
      return n ? `https://wa.me/${n.replace(/^\+/, '')}` : `${u.origin}${u.pathname.replace(/\/$/, '')}`;
    }
    u.hostname = u.hostname.replace(/^(m|mobile|web|old)\./, 'www.');
    if (kind === 'x') u.hostname = 'x.com';
    if (kind === 'telegram') u.hostname = 't.me';
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Replace one origin's set of contacts for a vendor. */
export function saveContacts(vendor, origin, found, now = new Date().toISOString()) {
  const db = open();
  const put = db.query('INSERT INTO vendor_contacts (vendor, kind, value, source, found_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET source = excluded.source, found_at = excluded.found_at');
  const seen = new Set();
  db.transaction(() => {
    // Rows are tagged "<origin>:<page>"; a vendor's set from one origin is replaced whole, so a removed email stops showing.
    db.query("DELETE FROM vendor_contacts WHERE vendor = ? AND (source = ? OR source LIKE ? || ':%')").run(vendor, origin, origin);
    for (const c of found) {
      const value = normalizeContact(c.kind, c.value);
      if (!value) continue;
      const key = `${c.kind}|${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      put.run(vendor, c.kind, value, c.source ? `${origin}:${c.source}` : origin, now);
    }
  })();
  return seen.size;
}

/** The register's own links for a vendor plus whatever its site's pages say. */
export async function siteContacts(v, fetcher) {
  const found = [];
  const add = (list, source) => {
    for (const c of list) found.push({ ...c, source });
  };
  for (const c of JSON.parse(v.contacts ?? '[]')) {
    const k = socialKind(c.url);
    if (k) add([{ kind: k, value: c.url }], 'register');
    const n = whatsappNumber(c.url);
    if (n) add([{ kind: 'phone', value: n }], 'register');
    if (c.kind === 'vendor_website' && !k) add([{ kind: 'website', value: c.url }], 'register');
  }
  for (const url of [v.website, v.shop_url].filter(Boolean)) {
    const k = socialKind(url);
    if (k) add([{ kind: k, value: url }], 'register');
    else add([{ kind: 'website', value: url }], 'register');
  }
  const home = crawlable(v);
  if (home) {
    let pages = 0;
    let lastErr = null;
    for (const path of PATHS) {
      try {
        const page = await fetcher.text(`${home.origin}${path}`, { accept: 'text/html' });
        pages++;
        add(contactsIn(page.text, page.url), page.url);
        if (path === '/' && new URL(page.url).origin !== home.origin) add([{ kind: 'website', value: page.url }], page.url);
      } catch (err) {
        lastErr = err;
        // A site that refuses the homepage refuses the rest; stop asking.
        if (path === '/' && err?.code !== 'status') break;
        if (err?.retryAfterMs) throw err;
      }
    }
    if (!pages && lastErr && lastErr.code !== 'robots') throw lastErr;
  }
  return found;
}

export function crawlable(v) {
  for (const u of [v.shop_url, v.website]) {
    if (!u) continue;
    try {
      const url = new URL(u);
      if (!NO_CRAWL.test(url.hostname.replace(/^www\./, '')) && !socialKind(url.toString())) return url;
    } catch {}
  }
  return null;
}

/** Finnrick's public record for a vendor: the contacts it lists, kept when vouched for or confident. */
export async function finnrickContacts(slug, fetcher) {
  return finnrickToContacts((await finnrickRecord(slug, fetcher))?.vendor);
}

export const finnrickRecord = (slug, fetcher) => fetcher.json(`${FINNRICK}/api/v1/vendors/${encodeURIComponent(slug)}`);

export function finnrickToContacts(vendor) {
  const found = [];
  for (const c of vendor?.contacts ?? []) {
    if (!(c?.vouched || (c?.confidence ?? 0) >= 0.6)) continue;
    const kind = String(c.kind ?? '').toLowerCase();
    if (kind === 'email') found.push({ kind: 'email', value: c.value ?? String(c.url ?? '').replace(/^mailto:/, '') });
    else if (kind === 'phone' || kind === 'tel') found.push({ kind: 'phone', value: c.value ?? c.url });
    else if (c.url) {
      const k = socialKind(c.url);
      found.push({ kind: k ?? 'website', value: c.url });
      if (k === 'whatsapp') {
        const n = whatsappNumber(c.url);
        if (n) found.push({ kind: 'phone', value: n });
      }
    }
  }
  if (vendor?.contact_url && !found.some((f) => f.kind === 'website')) {
    const k = socialKind(vendor.contact_url);
    found.push({ kind: k ?? 'website', value: vendor.contact_url });
  }
  return found;
}

export const userAgent = `search.peptides/0.3 (+${config.siteUrl}/docs)`;
