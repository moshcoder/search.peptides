import { config } from './config.js';
import { DISCLOSURE, getPeptide, getVendor, listPeptides, parse, rulesReport, searchOffers, searchVendors, stats } from './service.js';
import { version } from './version.js';

/**
 * Stateless MCP over JSON-RPC. The HTTP route (/mcp) and the CLI's stdio bridge both
 * hand messages here, so an agent gets the same tools either way.
 */
const LISTING_FILTERS = {
  text: { type: 'string', description: 'Free text, e.g. "retatrutide lab tested under $1/mg in stock". Parsed into the filters below.' },
  q: { type: 'string', description: 'Words to match in the product name, peptide or vendor.' },
  peptide: { type: 'string', description: 'Peptide slug or name, e.g. "bpc-157", "Tirzepatide", "BPC-157 + TB-500".' },
  vendor: { type: 'string', description: 'Vendor slug.' },
  max_per_mg: { type: 'number', description: 'Maximum USD per mg.' },
  min_price: { type: 'number' },
  max_price: { type: 'number', description: 'Maximum listing price in USD.' },
  min_mg: { type: 'number', description: 'Minimum mg per vial.' },
  max_mg: { type: 'number', description: 'Maximum mg per vial.' },
  min_verification: { type: 'number', description: 'Minimum verification score (0-100, computed from checkable evidence; see get_rules). Unscored vendors never match.' },
  min_score: { type: 'number', description: 'Minimum Finnrick rating (0-100, as Finnrick publishes it).' },
  in_stock: { type: 'boolean' },
  tested: { type: 'boolean', description: 'Only vendors with independent lab tests.' },
  passed: { type: 'boolean', description: 'Only vendors that passed a lab test for this peptide.' },
  coupon: { type: 'boolean' },
  payment: { type: 'string', enum: ['crypto', 'card', 'paypal', 'zelle', 'venmo', 'cashapp', 'bank', 'western-union', 'alipay', 'marketplace'] },
  ships_from: { type: 'string', description: 'ISO-3166 alpha-2 (US, CN, HK, CA, GB, AU…) or EU.' },
  ordering: { type: 'string', enum: ['checkout', 'message', 'marketplace', 'login'] },
  form: { type: 'string', enum: ['vial', 'supply', 'liquid', 'spray', 'capsule', 'topical', 'pen'] },
  single: { type: 'boolean', description: 'Single peptides only (no blends).' },
  blend: { type: 'boolean', description: 'Blends only.' },
  sort: { type: 'string', enum: ['per_mg', 'price', 'verification', 'score', 'size', 'name'] },
  page: { type: 'integer' },
  limit: { type: 'integer', description: 'Listings to return (default 25, max 200).' },
};

const slimVendor = ({ shipping, discounts, payments_raw, ordering_evidence, terms_source, notes, ...v }) => v;

export const TOOLS = [
  {
    name: 'search_listings',
    description: 'Search every research-peptide listing (vendor × peptide × size) and rank by USD per mg, price, vendor verification score or size. Filter by lab testing, stock, payment method, where it ships from and more. Returns listings with the vendor verification score, Finnrick rating and lab-test flags, plus facet counts.',
    inputSchema: { type: 'object', properties: LISTING_FILTERS },
    run: (a) => {
      const r = searchOffers(parse(a), { facets: true, limit: Math.min(a.limit ?? 25, 200) });
      return { ...r, facets: r.facets.map((f) => ({ name: f.name, options: f.options.slice(0, 15).map(({ label, count, query }) => ({ label, count, query })) })) };
    },
  },
  {
    name: 'search_vendors',
    description: 'Search peptide vendors by verification score (default order; null = insufficient data or unscored, never guessed), Finnrick rating, lab pass rate, payment, where they ship from, how to order and how to contact them (email, phone, WhatsApp, Telegram, socials). Each vendor carries a contact card.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Vendor name words.' },
        peptide: { type: 'string', description: 'Only vendors that list this peptide (slug).' },
        min_verification: LISTING_FILTERS.min_verification,
        min_score: LISTING_FILTERS.min_score,
        min_pass: { type: 'number', description: 'Minimum lab pass rate in percent.' },
        tested: { type: 'boolean' },
        priced: { type: 'boolean', description: 'Only vendors with published prices.' },
        coupon: { type: 'boolean' },
        payment: LISTING_FILTERS.payment,
        ships_from: LISTING_FILTERS.ships_from,
        ordering: LISTING_FILTERS.ordering,
        contact: { type: 'string', enum: ['email', 'phone', 'website', 'whatsapp', 'telegram', 'instagram', 'x', 'facebook', 'discord', 'tiktok', 'youtube', 'reddit', 'linkedin', 'signal'] },
        sort: { type: 'string', enum: ['verification', 'score', 'pass_rate', 'tests', 'per_mg', 'listings', 'name'] },
        limit: { type: 'integer', description: 'Vendors to return (default 25).' },
      },
    },
    run: (a) => {
      const r = searchVendors(parse(a), { limit: Math.min(a.limit ?? 25, 200) });
      return { ...r, vendors: r.vendors.map(slimVendor), sponsored: r.sponsored.map(slimVendor) };
    },
  },
  {
    name: 'get_vendor',
    description: 'Everything about one vendor: verification score with every component (weight, points, evidence), score history, independent tests with lab, batch and public record link, contact card, every listing with price per mg, payment, shipping, coupons, how to order.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    run: (a) => {
      const v = getVendor(a.slug);
      if (!v) return { error: `no vendor ${a.slug}` };
      // The newest 50 tests; the API carries all of them.
      return { ...v, independent_tests: v.independent_tests.slice(0, 50), independent_tests_total: v.independent_tests.length };
    },
  },
  {
    name: 'get_rules',
    description: 'How the verification score is computed: what counts as a verifiable certificate, each component with its weight and rule, the scored/insufficient/unscored thresholds, and the latest score changes across vendors.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'Recent score changes to return (default 20).' } } },
    run: (a) => rulesReport(Math.min(a.limit ?? 20, 200)),
  },
  {
    name: 'get_peptide',
    description: 'One peptide: how many vendors list it, cheapest USD per mg, and independent lab results by vendor.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    run: (a) => getPeptide(a.slug) ?? { error: `no peptide ${a.slug}` },
  },
  {
    name: 'list_peptides',
    description: 'Every peptide in the register with vendor and listing counts, lowest USD per mg and lab pass counts.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ ...stats(), peptides: listPeptides() }),
  },
];

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id ?? null, -32600, 'Invalid Request');
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notification
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: config.siteName, version },
        instructions: `${config.siteName} compares research-peptide vendors and listings. Use search_listings for "where is X cheapest / tested" questions (prices in USD, ranked per mg), search_vendors to find or vet a vendor and how to contact them, get_vendor for one vendor's full record and the evidence behind its verification score, get_rules for how that score is computed. ${DISCLOSURE}`,
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const out = await tool.run(params.arguments ?? {});
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out });
      } catch (err) {
        return ok(id, { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
