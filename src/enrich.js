import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from './config.js';
import { open, setMeta } from './db.js';
import { invalidate } from './service.js';

/**
 * Contact details for every vendor: emails, phones, socials and websites, read from
 * the vendor's own site (the homepage and the usual contact/about paths) plus the
 * links the register already holds (WhatsApp numbers, Telegram, Discord, Instagram).
 *
 * Kept in vendor_contacts, which a register sync never touches, and refreshed every
 * ENRICH_DAYS. Each fetch: http(s) on 80/443, every resolved address public, every
 * redirect re-checked, robots.txt honoured, 10 s and 1 MB caps.
 */
const UA = `Mozilla/5.0 (compatible; search.peptides/0.1; +${config.siteUrl}/about)`;
const PATHS = ['/', '/contact', '/contact-us', '/pages/contact', '/pages/contact-us', '/about', '/about-us', '/pages/about-us'];
const MAX = 1_000_000;

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
const NO_CRAWL = /(^|\.)(echemi\.com|alibaba\.com|globalsources\.com|chemicalbook\.com|made-in-china\.com|facebook\.com|instagram\.com|discord\.gg|discord\.com|t\.me|wa\.me|whatsapp\.com|beacons\.ai|linktr\.ee|reddit\.com|x\.com|twitter\.com|tiktok\.com|youtube\.com|glp1forum\.com|peptide\.chat)$/;

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
  for (const m of text.matchAll(/mailto:([^"'?>\s]+)/gi)) out.add(decodeURIComponent(m[1]).toLowerCase());
  for (const m of text.matchAll(EMAIL)) out.add(m[0].toLowerCase());
  return [...out].filter((e) => !BAD_EMAIL.test(e) && /^[^@]+@[^@]+\.[a-z]{2,}$/.test(e));
}

/** +1 (555) 010-9999 → +15550109999; anything under 7 digits is not a phone. */
export function normalizePhone(s) {
  const raw = decodeURIComponent(String(s)).replace(/^tel:/i, '').trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return raw.trim().startsWith('+') || digits.length > 10 ? `+${digits}` : digits;
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
    const u = new URL(l);
    u.hash = '';
    if (k !== 'whatsapp') u.search = '';
    found.push({ kind: k, value: u.toString().replace(/\/$/, '') });
    if (k === 'whatsapp') {
      const n = whatsappNumber(l);
      if (n) found.push({ kind: 'phone', value: n });
    }
  }
  return found;
}

const privateV4 = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};
function isPublic(ip) {
  if (isIP(ip) === 4) return !privateV4(ip);
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !privateV4(mapped[1]);
  return !(v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('64:ff9b'));
}

async function safeUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || (u.port && !['80', '443'].includes(u.port))) return false;
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true }).catch(() => []);
  return addrs.length > 0 && addrs.every((a) => isPublic(a.address));
}

/** GET with manual redirects, each hop re-checked. Returns { url, text } or null. */
export async function fetchText(url, hops = 4) {
  let at = url;
  for (let i = 0; i <= hops; i++) {
    if (!(await safeUrl(at))) return null;
    const res = await fetch(at, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' }, signal: AbortSignal.timeout(10_000) }).catch(() => null); // threatcrush-ignore: ssrf (safeUrl checks every hop)
    if (!res) return null;
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      at = new URL(res.headers.get('location'), at).toString();
      continue;
    }
    if (!res.ok || !/text|html|xml/.test(res.headers.get('content-type') ?? 'text/html')) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    let size = 0;
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > MAX) {
        reader.cancel().catch(() => {});
        break;
      }
    }
    return { url: at, text: new TextDecoder().decode(Buffer.concat(chunks)) };
  }
  return null;
}

/** A robots.txt path pattern (`*` any run, trailing `$` end) as a prefix regex. */
const robotsRe = (pattern) => new RegExp(`^${pattern.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\?\$$/, '$')}`);

/** Longest matching rule for `*` (or our agent) wins, Allow on a tie; true when the path may be fetched. */
export function robotsAllows(robots, path) {
  let applies = false;
  let best = { len: -1, allow: true };
  for (const line of String(robots ?? '').split(/\r?\n/)) {
    const [k, ...rest] = line.replace(/#.*/, '').split(':');
    const key = k?.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') applies = val === '*' || /search\.peptides/i.test(val);
    else if (applies && (key === 'disallow' || key === 'allow') && val && robotsRe(val).test(path)) {
      if (val.length > best.len || (val.length === best.len && key === 'allow')) best = { len: val.length, allow: key === 'allow' };
    }
  }
  return best.allow;
}

/** One spelling per contact, so the same account found on three pages is one row. Null when it is not usable. */
export function normalizeContact(kind, value) {
  if (kind === 'email') return String(value).toLowerCase();
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

async function enrichVendor(v) {
  const found = [];
  const add = (list, source) => {
    for (const c of list) {
      const value = normalizeContact(c.kind, c.value);
      if (value) found.push({ kind: c.kind, value, source });
    }
  };
  // What the register already has.
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
    else add([{ kind: 'website', value: new URL(url).origin }], 'register');
  }
  const home = [v.shop_url, v.website].filter(Boolean).map((u) => new URL(u)).find((u) => !NO_CRAWL.test(u.hostname.replace(/^www\./, '')) && !socialKind(u.toString()));
  if (home) {
    const robots = (await fetchText(`${home.origin}/robots.txt`).catch(() => null))?.text ?? '';
    let pages = 0;
    for (const path of PATHS) {
      if (!robotsAllows(robots, path)) continue;
      const page = await fetchText(`${home.origin}${path}`).catch(() => null);
      if (!page) continue;
      pages++;
      add(contactsIn(page.text, page.url), page.url);
      if (path === '/' && new URL(page.url).origin !== home.origin) add([{ kind: 'website', value: new URL(page.url).origin }], page.url);
    }
    if (pages && !found.some((c) => c.kind === 'website' && c.value === home.origin)) add([{ kind: 'website', value: home.origin }], home.origin);
  }
  return found;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export async function enrich({ only, concurrency = 8 } = {}) {
  const db = open();
  const vendors = db.query('SELECT slug, website, shop_url, contacts FROM vendors').all().filter((v) => !only || v.slug === only);
  const now = new Date().toISOString();
  const put = db.query('INSERT INTO vendor_contacts (vendor, kind, value, source, found_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET source = excluded.source, found_at = excluded.found_at');
  let done = 0;
  let withAny = 0;
  await pool(vendors, concurrency, async (v) => {
    const found = await enrichVendor(v).catch(() => []);
    const seen = new Set();
    db.transaction(() => {
      // A vendor's set is replaced whole, so a removed email stops showing on the next run.
      db.query('DELETE FROM vendor_contacts WHERE vendor = ?').run(v.slug);
      for (const c of found) {
        const key = `${c.kind}|${c.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        put.run(v.slug, c.kind, c.value, c.source, now);
      }
    })();
    done++;
    if (seen.size) withAny++;
  });
  setMeta('enriched_at', now);
  invalidate();
  const summary = db.query('SELECT kind, count(DISTINCT vendor) vendors, count(*) n FROM vendor_contacts GROUP BY kind ORDER BY vendors DESC').all();
  console.log(`[enrich] ${done} vendors read, ${withAny} with contact details: ${summary.map((s) => `${s.kind} ${s.vendors}`).join(', ')}`);
  return { vendors: done, with_contacts: withAny, kinds: summary };
}

if (import.meta.main) {
  const only = process.argv.find((a, i) => process.argv[i - 1] === '--vendor');
  enrich({ only }).then(() => process.exit(0), (err) => {
    console.error(`[enrich] ${err.message}`);
    process.exit(1);
  });
}
