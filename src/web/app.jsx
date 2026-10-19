import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { normalize, resolve } from 'node:path';
import { config } from '../config.js';
import { handle, TOOLS } from '../mcp.js';
import { RING_PLACEHOLDER, ringBar, visitorOnMoshpit } from '../ring.ts';
import { DISCLOSURE, getPeptide, getVendor, listPeptides, parse, PRICE_NOTE, publicOffer, searchOffers, searchVendors, stats } from '../service.js';
import { payConfigured, settle, startSponsor, verifyWebhook } from '../sponsor.js';
import { open } from '../db.js';
import { version } from '../version.js';
import { Docs, ListingsPage, MessagePage, PeptidesPage, SponsorPage, VendorPage, VendorsPage } from './views/pages.jsx';

export const app = new Hono();
const PUBLIC = resolve(new URL('../../public', import.meta.url).pathname);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id' };
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://crawlproof.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://crawlproof.com; frame-src https://crawlproof.com; form-action 'self' https://coinpayportal.com; base-uri 'none'; frame-ancestors 'none'",
};

app.use('*', compress());
app.use('*', async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
});

// The ring bar: direct links for a visitor on Moshpit DNS, relay links for everyone else.
const html = (c, node, status = 200) => {
  const direct = visitorOnMoshpit(config.moshpitName, c.req.header('host'), c.req.header('x-moshpit-name'));
  return c.html(`<!doctype html>${String(node).replace(RING_PLACEHOLDER, ringBar(config.moshpitName, direct))}`, status);
};
const json = (c, body, status = 200) => c.json(body, status, CORS);
const qs = (c) => new URL(c.req.url).searchParams;

app.get('/', (c) => {
  const input = parse(qs(c));
  return html(c, <ListingsPage result={searchOffers(input, { facets: true })} stats={stats()} text={input.text} />);
});
app.get('/p/:slug', (c) => {
  const peptide = getPeptide(c.req.param('slug'));
  if (!peptide) return html(c, <MessagePage title="No such peptide" message="That peptide is not in the register." />, 404);
  const input = parse(qs(c));
  input.filters.peptide = peptide.slug;
  return html(c, <ListingsPage result={searchOffers(input, { facets: true })} stats={stats()} text="" peptide={peptide} base={`/p/${peptide.slug}`} />);
});
app.get('/vendors', (c) => {
  const input = parse(qs(c));
  return html(c, <VendorsPage result={searchVendors(input, { facets: true })} text={input.text} />);
});
app.get('/v/:slug', (c) => {
  const v = getVendor(c.req.param('slug'));
  return v ? html(c, <VendorPage v={v} />) : html(c, <MessagePage title="No such vendor" message="That vendor is not in the register." />, 404);
});
app.get('/peptides', (c) => html(c, <PeptidesPage peptides={listPeptides().filter((p) => p.offers || p.tests)} q={c.req.query('q')} />));
app.get('/docs', (c) => html(c, <Docs stats={stats()} />));

/* ---------- sponsor (CoinPay) ---------- */

const sponsorVendors = () => open().query('SELECT slug, name FROM vendors ORDER BY name').all();
app.get('/sponsor', (c) => html(c, <SponsorPage vendors={sponsorVendors()} picked={c.req.query('vendor')} open={payConfigured()} cancelled={!!c.req.query('cancelled')} />));
app.post('/sponsor', async (c) => {
  const form = await c.req.parseBody();
  try {
    const { payUrl } = await startSponsor({ vendor: form.vendor, email: form.email });
    return c.redirect(payUrl, 303);
  } catch (err) {
    return html(c, <SponsorPage vendors={sponsorVendors()} picked={String(form.vendor ?? '')} open={payConfigured()} error={err.message} />, 400);
  }
});
app.get('/sponsor/thanks', (c) => html(c, <MessagePage title="Thank you" message="Your sponsorship starts as soon as the payment confirms on chain, usually within a few minutes. The vendor is then pinned, labelled Sponsored." />));
app.post('/hooks/coinpay', async (c) => {
  const raw = await c.req.text();
  if (!verifyWebhook(raw, c.req.header('x-coinpay-signature') ?? c.req.header('coinpay-signature'))) return c.json({ error: 'bad signature' }, 401);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  const r = settle(payload);
  console.log(`[coinpay] ${JSON.stringify(r)}`);
  return c.json(r);
});
app.post('/api/v1/sponsor', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const { ref, payUrl } = await startSponsor(body);
    return json(c, { ref, pay_url: payUrl, usd: config.sponsorUsd, days: config.sponsorDays });
  } catch (err) {
    return json(c, { error: err.message }, 400);
  }
});

/* ---------- API ---------- */

app.get('/api/v1/search', (c) => {
  const limit = Number(c.req.query('limit') ?? 50);
  return json(c, searchOffers(parse(qs(c)), { facets: true, limit: Number.isFinite(limit) ? limit : 50 }));
});
app.get('/api/v1/vendors', (c) => {
  const limit = Number(c.req.query('limit') ?? 100);
  return json(c, searchVendors(parse(qs(c)), { facets: true, limit: Number.isFinite(limit) ? limit : 100 }));
});
app.get('/api/v1/vendors/:slug', (c) => {
  const v = getVendor(c.req.param('slug'));
  return v ? json(c, v) : json(c, { error: 'no such vendor' }, 404);
});
app.get('/api/v1/peptides', (c) => json(c, { ...stats(), peptides: listPeptides() }));
app.get('/api/v1/peptides/:slug', (c) => {
  const p = getPeptide(c.req.param('slug'));
  return p ? json(c, p) : json(c, { error: 'no such peptide' }, 404);
});
app.get('/api/v1/stats', (c) => json(c, stats()));
// The whole register in one document: nichedb.dev's `peptides` collection reads this daily.
app.get('/api/v1/export', (c) => {
  const vendors = searchVendors({ filters: {}, understood: [], text: '' }, { all: true }).vendors;
  const listings = searchOffers({ filters: {}, understood: [], text: '' }, { all: true }).offers;
  return json(c, { site: config.siteUrl, generated_at: new Date().toISOString(), disclosure: DISCLOSURE, note: PRICE_NOTE, stats: stats(), peptides: listPeptides(), vendors, listings });
});
// The updater daemon, when this process runs it (ROLES includes worker).
let daemon = null;
export const setDaemon = (d) => {
  daemon = d;
};
app.get('/api/v1/daemon', async (c) => (daemon ? json(c, await daemon.status()) : json(c, { running: false, note: 'this process does not run the daemon' })));
app.get('/health', async (c) => {
  const d = daemon ? await daemon.status() : null;
  return c.json({ ok: true, version, ...stats(), daemon: d && { running: d.running, stalled: d.tasks.filter((t) => t.stalled).map((t) => t.name), tasks: Object.fromEntries(d.tasks.map((t) => [t.name, t.kind === 'queue' ? { items: t.items, due: t.due, failing: t.failing } : { lastOk: t.lastOk, fails: t.fails }])) } });
});

/* ---------- MCP + agent discovery ---------- */

for (const path of ['/mcp', '/api/mcp']) {
  app.get(path, (c) => c.json({ name: config.siteName, transport: 'streamable-http', post: `${config.siteUrl}/mcp`, tools: TOOLS.map((t) => t.name) }, 200, CORS));
  app.post(path, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean);
      return out.length ? c.json(out, 200, CORS) : c.body(null, 202, CORS);
    }
    const reply = await handle(body);
    return reply ? c.json(reply, 200, CORS) : c.body(null, 202, CORS);
  });
}
app.options('*', (c) => c.body(null, 204, { ...CORS, 'access-control-allow-methods': 'GET, POST, OPTIONS' }));
app.get('/.well-known/openmcp.json', (c) =>
  json(c, { name: config.siteName, description: 'Research-peptide vendors and listings: price per mg, independent lab results, payment, shipping and vendor contact details.', transport: 'streamable-http', url: `${config.siteUrl}/mcp`, stdio: 'bunx searchpeptides mcp', tools: TOOLS.map(({ name, description }) => ({ name, description })) }),
);
app.get('/llms.txt', (c) => c.text(llms(), 200, { 'content-type': 'text/plain; charset=utf-8' }));
app.get('/skill.md', (c) => c.text(skill(), 200, { 'content-type': 'text/markdown; charset=utf-8' }));
app.get('/robots.txt', (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /sponsor/\nDisallow: /hooks/\nSitemap: ${config.siteUrl}/sitemap.xml\n`));
app.get('/sitemap.xml', (c) => {
  const urls = ['/', '/vendors', '/peptides', '/docs', '/sponsor', ...listPeptides().filter((p) => p.offers).map((p) => `/p/${p.slug}`), ...open().query('SELECT slug FROM vendors').all().map((v) => `/v/${v.slug}`)];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${config.siteUrl}${u.replace(/&/g, '&amp;')}</loc></url>`).join('')}</urlset>`;
  return c.body(body, 200, { 'content-type': 'application/xml; charset=utf-8' });
});

app.get('/*', async (c) => {
  const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^\/+/, '');
  const path = resolve(PUBLIC, rel);
  if (!path.startsWith(`${PUBLIC}/`)) return c.notFound();
  const file = Bun.file(path);
  if (!(await file.exists())) return html(c, <MessagePage title="Not found" message="Nothing lives at that address." />, 404);
  return new Response(file, { headers: { 'cache-control': rel.startsWith('fonts/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' } });
});

function llms() {
  const s = stats();
  return `# ${config.siteName}

> Every research-peptide vendor and listing, compared: ${s.listings} listings from ${s.vendors_with_prices} vendors across ${s.peptides} peptides, ranked by USD per mg, with independent lab results for ${s.vendors} vendors and each vendor's contact details (email, phone, WhatsApp, Telegram, socials, websites).

${DISCLOSURE}

## Search
- [Listings](${config.siteUrl}/?text=bpc-157+in+stock): faceted search; free text like "retatrutide lab tested under $1/mg"
- [Vendors](${config.siteUrl}/vendors): score, lab pass rate, payment, ships from, contact
- [Peptides](${config.siteUrl}/peptides): every peptide with vendors and lowest $/mg

## API (JSON, no key)
- ${config.siteUrl}/api/v1/search?text=...  (filters: peptide vendor max_per_mg max_price min_score in_stock tested passed payment ships_from ordering form sort page)
- ${config.siteUrl}/api/v1/vendors?contact=email&min_score=80
- ${config.siteUrl}/api/v1/vendors/{slug}
- ${config.siteUrl}/api/v1/peptides/{slug}
- ${config.siteUrl}/api/v1/export  (the whole register)

## MCP
- Streamable HTTP: POST ${config.siteUrl}/mcp
- stdio: bunx searchpeptides mcp
- Tools: ${TOOLS.map((t) => t.name).join(', ')}

## Data
- Also mirrored to https://nichedb.dev/c/peptides
- Source: https://github.com/moshcoder/search.peptides
`;
}

function skill() {
  return `---
name: search-peptides
description: Find research-peptide vendors and listings by price per mg, independent lab results, payment and shipping, and get a vendor's contact details. Use when someone asks where to buy a peptide, which vendor is tested, or how to reach a vendor.
---

# search.peptides

Ask the API; no key needed.

\`\`\`sh
curl -s '${config.siteUrl}/api/v1/search?text=tirzepatide+lab+tested+under+$1/mg&limit=10'
curl -s '${config.siteUrl}/api/v1/vendors?contact=email&min_score=80'
curl -s '${config.siteUrl}/api/v1/vendors/<slug>'   # contact card, lab tests, listings
\`\`\`

Or add the MCP server: \`claude mcp add peptides -- bunx searchpeptides mcp\`.

Prices are USD; \`usd_per_mg\` is the ranking number. \`passed_test\` means the vendor passed an independent lab test for that peptide. ${DISCLOSURE}
`;
}
