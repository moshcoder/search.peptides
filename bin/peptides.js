#!/usr/bin/env bun
/**
 * search.peptides CLI. Same query as the page and the API.
 *
 *   peptides search "retatrutide lab tested under $1/mg" [--json] [--in-stock] [--ships-from US] [--sort price] …
 *   peptides vendors [--contact email] [--min-score 80] [--json]
 *   peptides vendor <slug> [--json]          contact card, lab tests, listings
 *   peptides peptide <slug> [--json]         lab results by vendor
 *   peptides peptides [--json]
 *   peptides stats
 *   peptides tui                 interactive search
 *   peptides mcp                 stdio MCP server (the site's, or the local database with --local)
 *   peptides serve | sync | enrich
 *
 * Talks to PEPTIDES_URL (default https://search.peptides.pit.world); --local reads the SQLite file directly.
 */
const BASE = (process.env.PEPTIDES_URL ?? 'https://search.peptides.pit.world').replace(/\/$/, '');
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[k] = true;
    else flags[k] = argv[++i];
  } else pos.push(a);
}
const local = flags.local || process.env.PEPTIDES_LOCAL === '1';

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { g: (s) => `\x1b[38;5;155m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` }
  : { g: String, d: String, b: String, c: String };

async function api(path, params = {}) {
  if (local) return localCall(path, params);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== false && v !== '') qs.set(k, v === true ? '1' : String(v));
  const res = await fetch(`${BASE}${path}${qs.size ? `?${qs}` : ''}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function localCall(path, params) {
  const s = await import('../src/service.js');
  (await import('../src/sync.js')).loadSnapshotIfEmpty();
  const input = s.parse(params);
  if (path === '/api/v1/search') return s.searchOffers(input, { facets: true, limit: Number(params.limit ?? 25) });
  if (path === '/api/v1/vendors') return s.searchVendors(input, { facets: true, limit: Number(params.limit ?? 50) });
  if (path.startsWith('/api/v1/vendors/')) return s.getVendor(path.split('/').pop()) ?? { error: 'no such vendor' };
  if (path === '/api/v1/peptides') return { ...s.stats(), peptides: s.listPeptides() };
  if (path.startsWith('/api/v1/peptides/')) return s.getPeptide(path.split('/').pop()) ?? { error: 'no such peptide' };
  if (path === '/api/v1/stats') return s.stats();
  throw new Error(`no local route ${path}`);
}

const pad = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
};
const usd = (n) => (Number.isFinite(n) ? `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}` : '—');
const mg = (o) => (Number.isFinite(o.usd_per_mg) ? `$${o.usd_per_mg.toFixed(o.usd_per_mg < 1 ? 3 : 2)}/${o.unit ?? 'mg'}` : '—');

export function renderOffers(list, sponsored = []) {
  const out = [c.d(`${pad('listing', 40)}${pad('vendor', 24)}${pad('size', 13)}${pad('price', 8)}${pad('per mg', 12)}score`)];
  const line = (o, tag = '') => `${tag}${pad(o.name ?? o.peptide, 40 - tag.length)}${pad(o.vendor_name, 24)}${pad(`${o.amount ?? ''}${o.unit ?? ''}${o.pack_qty > 1 ? `×${o.pack_qty}` : ''}`, 13)}${pad(usd(o.price_usd), 8)}${pad(mg(o), 12)}${o.vendor_score ?? '—'}${o.passed_test ? c.g(' ✓') : ''}`;
  for (const o of sponsored) out.push(c.b(line(o, '★ ')));
  for (const o of list) out.push(line(o));
  if (!list.length) out.push(c.d('no listing matches every filter'));
  if (sponsored.length) out.push(c.d('\n★ sponsored: paid placement, labelled'));
  return out.join('\n');
}

const reach = (v) => [v.contact.emails[0], v.contact.phones[0], ...Object.keys(v.contact.socials)].filter(Boolean).join(' ');

export function renderVendors(list) {
  const out = [c.d(`${pad('vendor', 32)}${pad('score', 7)}${pad('lab', 14)}${pad('listings', 10)}${pad('from', 12)}contact`)];
  for (const v of list) {
    const lab = v.tests_pass + v.tests_fail ? `${v.tests_pass}/${v.tests_pass + v.tests_fail} pass` : '—';
    out.push(`${v.sponsored ? '★ ' : ''}${pad(v.name, v.sponsored ? 30 : 32)}${pad(v.score ?? '—', 7)}${pad(lab, 14)}${pad(v.offers || '—', 10)}${pad(Number.isFinite(v.min_usd_per_mg) ? `$${v.min_usd_per_mg}/mg` : '—', 12)}${c.d(reach(v))}`);
  }
  if (!list.length) out.push(c.d('no vendor matches every filter'));
  return out.join('\n');
}

function printVendor(v) {
  if (v.error) return console.log(v.error);
  console.log(`${c.b(v.name)} ${v.sponsored ? c.g('(sponsored)') : ''} ${c.d(v.ships_from.join(', ') || v.location || '')}`);
  console.log(`score ${v.score ?? '—'} · lab ${v.tests_pass}/${v.tests_pass + v.tests_fail} passed · ${v.offers} listings · ${v.ordering ?? ''}\n`);
  for (const e of v.contact.emails) console.log(`  email     ${e}`);
  for (const p of v.contact.phones) console.log(`  phone     ${p}`);
  for (const w of v.contact.websites) console.log(`  website   ${w}`);
  for (const [k, l] of Object.entries(v.contact.socials)) for (const u of l) console.log(`  ${pad(k, 9)} ${u}`);
  console.log(`\n  pay ${v.payments_raw.join(', ') || '—'}`);
  for (const cp of v.coupons) console.log(`  coupon ${cp.code} ${cp.discount ?? ''}`);
  if (v.lab_tests.length) console.log(`\n${c.d('lab tests')}\n${v.lab_tests.slice(0, 20).map((t) => `  ${pad(t.peptide, 30)} ${pad(t.result, 6)} ${t.tested_on ?? ''}`).join('\n')}`);
  if (v.listings.length) console.log(`\n${c.d('listings')}\n${v.listings.slice(0, 30).map((o) => `  ${pad(o.name ?? o.peptide, 44)} ${pad(usd(o.price_usd), 8)} ${mg(o)}`).join('\n')}${v.listings.length > 30 ? c.d(`\n  … ${v.listings.length - 30} more (--json)`) : ''}`);
  console.log(`\n  ${c.c(v.page)}`);
}

function printPeptide(p) {
  if (p.error) return console.log(p.error);
  console.log(`${c.b(p.name)}  ${p.offers} listings · ${p.vendors} vendors · from ${Number.isFinite(p.min_usd_per_mg) ? `$${p.min_usd_per_mg}/mg` : '—'} · lab ${p.tests_pass}/${p.tests} passed\n`);
  for (const r of p.lab_results) console.log(`  ${pad(r.vendor_name, 34)} ${pad(`${r.pass}/${r.n} pass`, 12)} ${r.latest ?? ''}`);
  console.log(`\n  ${c.c(p.page)}`);
}

const out = (data, render) => console.log(flags.json ? JSON.stringify(data, null, 2) : render(data));
const searchFlags = () => {
  const { json, local: _l, ...rest } = flags;
  return rest;
};

async function main() {
  switch (cmd) {
    case 'search': {
      const r = await api('/api/v1/search', { text: pos.join(' ') || undefined, limit: 25, ...searchFlags() });
      return out(r, (d) => [d.query.understood.length ? c.d(`read as: ${d.query.understood.join(' · ')}${d.query.filters.q ? ` · words "${d.query.filters.q}"` : ''}`) : '', c.d(`${d.total} listings${d.pages > 1 ? `, page ${d.page} of ${d.pages} (--page N)` : ''}\n`), renderOffers(d.offers, d.sponsored)].filter(Boolean).join('\n'));
    }
    case 'vendors': {
      const r = await api('/api/v1/vendors', { q: pos.join(' ') || undefined, limit: 50, ...searchFlags() });
      return out(r, (d) => `${c.d(`${d.total} vendors\n`)}\n${renderVendors(d.vendors)}`);
    }
    case 'vendor':
      return out(await api(`/api/v1/vendors/${pos[0]}`), printVendor);
    case 'peptide':
      return out(await api(`/api/v1/peptides/${pos[0]}`), printPeptide);
    case 'peptides':
      return out(await api('/api/v1/peptides'), (d) => d.peptides.filter((p) => p.offers).map((p) => `${pad(p.name, 40)} ${pad(`${p.vendors} vendors`, 12)} ${pad(`${p.offers} listings`, 14)} ${Number.isFinite(p.min_usd_per_mg) ? `$${p.min_usd_per_mg}/mg` : ''}`).join('\n'));
    case 'stats':
      return out(await api('/api/v1/stats'), (d) => Object.entries(d).map(([k, v]) => `${pad(k, 22)} ${v}`).join('\n'));
    case 'tui':
      return (await import('./tui.js')).runTui({ api });
    case 'mcp':
      return mcpStdio();
    case 'serve':
      return import('../src/main.js');
    case 'sync':
      return (await import('../src/sync.js')).sync({ force: !!flags.force });
    case 'enrich':
      return (await import('../src/enrich.js')).enrich({ only: flags.vendor });
    default:
      console.log(`search.peptides: every research-peptide vendor and listing, compared

  peptides search "retatrutide lab tested under $1/mg"
  peptides search --peptide bpc-157 --in-stock --ships-from US --sort price
  peptides vendors --contact email --min-score 80
  peptides vendor <slug>       contact card, lab tests, listings
  peptides peptide <slug>      lab results by vendor
  peptides peptides | stats
  peptides tui                 interactive
  peptides mcp                 stdio MCP (claude mcp add peptides -- bunx searchpeptides mcp)
  peptides serve | sync | enrich

  --json  raw output    --local  read the local database    PEPTIDES_URL=${BASE}`);
  }
}

/** stdio MCP: newline-delimited JSON-RPC. Answers locally with --local, otherwise forwards to the site. */
async function mcpStdio() {
  if (local) (await import('../src/sync.js')).loadSnapshotIfEmpty();
  const handle = local ? (await import('../src/mcp.js')).handle : async (msg) => {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(msg) });
    return res.status === 202 ? null : res.json();
  };
  let buf = '';
  for await (const chunk of process.stdin) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
        continue;
      }
      const reply = await handle(msg).catch((err) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: err.message } }));
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`peptides: ${err.message}`);
    process.exit(1);
  });
}
