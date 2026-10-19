import { config } from '../../config.js';
import { countryName, PAYMENT_LABELS } from '../../core/normalize.js';
import { toParams } from '../../core/parse.js';
import { Layout } from './Layout.jsx';
import { ActiveChips, Chips, ContactCard, FacetRail, ORDERING, OfferRow, Pager, passText, perMg, ResultsHead, scoreText, size, usd, VendorRow } from './parts.jsx';

const OFFER_SORTS = [['', 'Cheapest per mg'], ['price', 'Lowest price'], ['score', 'Best vendor score'], ['size', 'Largest size'], ['name', 'Peptide A–Z']];
const VENDOR_SORTS = [['', 'Best score'], ['pass_rate', 'Lab pass rate'], ['tests', 'Most lab tests'], ['per_mg', 'Cheapest per mg'], ['listings', 'Most listings'], ['name', 'Name']];
const EXAMPLES = ['retatrutide lab tested under $1/mg', 'bpc-157 in stock', 'tirzepatide ships from us', 'ghk-cu crypto', 'semaglutide 10mg', 'nad+ passed', 'mots-c zelle', 'tb-500 coupon'];

function ApiReadout({ result, tool }) {
  return (
    <div class="readout">
      {result.query.understood.length ? (
        <p>
          Read as: <Chips items={result.query.understood} />
          {result.query.filters.q ? <span> · words “{result.query.filters.q}”</span> : null}
        </p>
      ) : null}
      <details>
        <summary>This search as JSON, curl, CLI and MCP</summary>
        <pre>{`curl -s '${result.links.api}'
${result.links.cli}
claude mcp add peptides -- bunx searchpeptides mcp   # tool: ${tool}`}</pre>
      </details>
    </div>
  );
}

/** The home page and /p/:slug: every listing, faceted. */
export function ListingsPage({ result, stats, text, peptide = null, base = '/' }) {
  const f = result.query.filters;
  const searched = text || Object.keys(f).some((k) => k !== 'page');
  const title = peptide ? `${peptide.name}: prices per mg and lab results` : searched ? `Peptide listings${text ? `: ${text}` : ''}` : null;
  const params = toParams(peptide ? { ...f, peptide: undefined } : f);
  return (
    <Layout title={title} path={peptide ? `/p/${peptide.slug}` : '/'} q={peptide ? '' : text} description={peptide ? `${peptide.name} from ${peptide.vendors} vendors, ${peptide.offers} listings${Number.isFinite(peptide.min_usd_per_mg) ? ` from $${peptide.min_usd_per_mg}/mg` : ''}, with independent lab results.` : undefined}>
      {peptide ? (
        <>
          <p class="crumbs">
            <a href="/peptides">Peptides</a> / {peptide.name}
          </p>
          <h1>{peptide.name}</h1>
          <p class="lede">
            {peptide.offers} listings from {peptide.vendors} vendors
            {Number.isFinite(peptide.min_usd_per_mg) ? `, from $${peptide.min_usd_per_mg}/mg` : ''}.{' '}
            {peptide.tests ? `${peptide.tests_pass} of ${peptide.tests} independent lab tests passed.` : 'No independent lab tests on record.'}
          </p>
          {peptide.lab_results?.length ? (
            <details>
              <summary>Lab results by vendor ({peptide.lab_results.length})</summary>
              <div class="scroll">
                <table class="tbl">
                  <thead>
                    <tr><th>Vendor</th><th>Passed</th><th>Failed</th><th>Tests</th><th>Latest</th></tr>
                  </thead>
                  <tbody>
                    {peptide.lab_results.map((r) => (
                      <tr>
                        <td><a href={`/v/${r.vendor}`}>{r.vendor_name}</a></td>
                        <td class="mono">{r.pass}</td>
                        <td class="mono">{r.fail}</td>
                        <td class="mono">{r.n}</td>
                        <td>{r.latest ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <>
          <h1>{searched ? (text ? `Listings for “${text}”` : 'Peptide listings') : 'Every research peptide, every vendor, one search'}</h1>
          <p class="lede">
            {stats.listings.toLocaleString('en-US')} listings from {stats.vendors_with_prices} vendors across {stats.peptides} peptides, ranked by price per mg, with independent lab results for {stats.vendors} vendors and their contact details.
          </p>
          <form class="bigsearch" action="/" method="get" role="search">
            <input name="text" value={text} placeholder="retatrutide lab tested under $1/mg" autocomplete="off" autofocus={!searched} />
            <button class="btn primary" type="submit">Search</button>
          </form>
          {!searched ? (
            <p class="examples">
              Try:{' '}
              {EXAMPLES.map((e) => (
                <a class="chip link" href={`/?text=${encodeURIComponent(e)}`}>
                  {e}
                </a>
              ))}
            </p>
          ) : null}
          {searched ? <ApiReadout result={result} tool="search_listings" /> : null}
        </>
      )}
      <div class="results-layout">
        <FacetRail facets={result.facets} base={base} total={result.total} />
        <section class="results">
          <ResultsHead title={`${result.total.toLocaleString('en-US')} ${result.total === 1 ? 'listing' : 'listings'}`} base={base} params={params} sorts={OFFER_SORTS} sort={['price', 'score', 'size', 'name'].includes(f.sort) ? f.sort : ''} h1={false} />
          <ActiveChips chips={peptide ? result.chips.filter((c) => c.label !== peptide.name) : result.chips} base={base} />
          {result.sponsored.length && result.page === 1 ? (
            <div class="sb-list">
              {result.sponsored.map((o) => (
                <OfferRow o={o} sponsored />
              ))}
            </div>
          ) : null}
          {result.total ? (
            <div class="sb-list">
              {result.offers.map((o) => (
                <OfferRow o={o} />
              ))}
            </div>
          ) : (
            <p class="empty">
              Nothing matches every filter. Drop one, or <a href={base}>start over</a>.
            </p>
          )}
          <Pager base={base} params={params} page={result.page} pages={result.pages} />
        </section>
      </div>
    </Layout>
  );
}

export function VendorsPage({ result, text }) {
  const f = result.query.filters;
  const params = toParams(f);
  return (
    <Layout title="Peptide vendors: lab results, score, contact" path="/vendors" description={`${result.total} research-peptide vendors with independent lab pass rates, scores, payment methods, where they ship from and how to reach them.`}>
      <h1>Peptide vendors</h1>
      <p class="lede">Every vendor with independent lab results or published prices, with how to reach them: email, phone, WhatsApp, Telegram and socials read from the vendor’s own site.</p>
      <form class="bigsearch" action="/vendors" method="get" role="search">
        <input name="q" value={f.q ?? text ?? ''} placeholder="vendor name" autocomplete="off" />
        <button class="btn primary" type="submit">Search</button>
      </form>
      <div class="results-layout">
        <FacetRail facets={result.facets} base="/vendors" total={result.total} />
        <section class="results">
          <ResultsHead title={`${result.total} ${result.total === 1 ? 'vendor' : 'vendors'}`} base="/vendors" params={params} sorts={VENDOR_SORTS} sort={['pass_rate', 'tests', 'per_mg', 'listings', 'name'].includes(f.sort) ? f.sort : ''} h1={false} />
          <ActiveChips chips={result.chips} base="/vendors" />
          {result.page === 1 && result.sponsored.length ? (
            <div class="sb-list">
              {result.sponsored.map((v) => (
                <VendorRow v={v} />
              ))}
            </div>
          ) : null}
          <div class="sb-list">
            {result.vendors.filter((v) => !(result.page === 1 && v.sponsored)).map((v) => (
              <VendorRow v={v} />
            ))}
          </div>
          <Pager base="/vendors" params={params} page={result.page} pages={result.pages} />
        </section>
      </div>
    </Layout>
  );
}

export function VendorPage({ v }) {
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: v.name,
    ...(v.contact.websites[0] ? { url: v.contact.websites[0] } : {}),
    ...(v.contact.emails.length ? { email: v.contact.emails[0] } : {}),
    ...(v.contact.phones.length ? { telephone: v.contact.phones[0] } : {}),
    sameAs: Object.values(v.contact.socials).flat(),
  };
  const shipping = v.shipping.filter((s) => s && (s.to || s.cost !== null));
  return (
    <Layout title={`${v.name}: lab results, prices, contact`} path={`/v/${v.slug}`} jsonld={jsonld} description={`${v.name}: ${passText(v)}, score ${scoreText(v)}, ${v.offers} listings. Email, phone and socials, payment methods and shipping.`}>
      <p class="crumbs">
        <a href="/vendors">Vendors</a> / {v.name}
      </p>
      <h1>
        {v.name} {v.sponsored ? <span class="tag">Sponsored</span> : null}
      </h1>
      <dl class="facts">
        <div><dt>Score</dt><dd>{scoreText(v)}</dd></div>
        <div><dt>Lab tests</dt><dd>{passText(v)}{v.latest_test ? <span class="muted small"> · latest {v.latest_test}</span> : null}</dd></div>
        <div><dt>Listings</dt><dd>{v.offers ? `${v.offers} across ${v.peptides} peptides` : 'no published prices'}</dd></div>
        <div><dt>Cheapest</dt><dd>{Number.isFinite(v.min_usd_per_mg) ? `$${v.min_usd_per_mg}/mg` : '—'}</dd></div>
        <div><dt>Ships from</dt><dd>{v.ships_from.map(countryName).join(', ') || v.location || '—'}</dd></div>
        <div><dt>Ships to</dt><dd>{v.ships_to ?? '—'}</dd></div>
        <div><dt>Ordering</dt><dd>{ORDERING[v.ordering] ?? '—'}</dd></div>
        <div><dt>Pay with</dt><dd>{v.payments_raw.join(', ') || '—'}</dd></div>
        {v.min_order ? <div><dt>Minimum order</dt><dd>{v.min_order}</dd></div> : null}
      </dl>
      <h2>Contact</h2>
      <ContactCard c={v.contact} />
      {v.coupons.length || v.discounts.length ? (
        <>
          <h2>Coupons and discounts</h2>
          <ul>
            {v.coupons.map((c) => (
              <li>
                <b class="mono">{c.code ?? '—'}</b> {c.discount ?? ''} {c.conditions ? <span class="muted">({c.conditions})</span> : null}
              </li>
            ))}
            {v.discounts.map((d) => (
              <li>
                {d.method}: {d.pct ? `${d.pct}% off` : d.flat ? `$${d.flat} off` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {shipping.length ? (
        <>
          <h2>Shipping</h2>
          <ul>
            {shipping.map((s) => (
              <li>
                {s.to ?? 'anywhere'}: {s.method ?? ''} {Number.isFinite(s.cost) ? usd(s.cost) : ''} {s.free_over ? `· free over ${usd(s.free_over)}` : ''} {s.days ? `· ${s.days}${/day/i.test(String(s.days)) ? '' : ' days'}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {v.ordering_evidence || v.notes ? (
        <p class="notes">
          {v.ordering_evidence}
          {v.ordering_evidence && v.notes ? ' ' : ''}
          {v.notes}
        </p>
      ) : null}
      {v.lab_tests.length ? (
        <>
          <h2>Independent lab tests</h2>
          <div class="scroll">
            <table class="tbl">
              <thead>
                <tr><th>Peptide</th><th>Result</th><th>Tested</th></tr>
              </thead>
              <tbody>
                {v.lab_tests.map((t) => (
                  <tr>
                    <td><a href={`/p/${t.peptide_slug}`}>{t.peptide}</a></td>
                    <td>{t.result === 'pass' ? '✓ pass' : t.result === 'fail' ? '✗ fail' : t.result}</td>
                    <td>{t.tested_on ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {v.listings.length ? (
        <>
          <h2>Listings</h2>
          <div class="scroll">
            <table class="tbl">
              <thead>
                <tr><th>Product</th><th>Size</th><th>Price</th><th>Per mg</th><th>Stock</th></tr>
              </thead>
              <tbody>
                {v.listings.map((o) => (
                  <tr>
                    <td>{o.url ? <a href={o.url} rel="nofollow noopener" target="_blank">{o.name ?? o.peptide}</a> : (o.name ?? o.peptide)}</td>
                    <td>{size(o)}</td>
                    <td class="mono">{usd(o.price_usd)}</td>
                    <td class="mono">{perMg(o)}</td>
                    <td>{o.in_stock === true ? 'yes' : o.in_stock === false ? 'no' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <p class="muted small">
        Checked {v.checked_at ?? 'unknown'}. JSON: <a href={`/api/v1/vendors/${v.slug}`}>/api/v1/vendors/{v.slug}</a>. Is this your shop? <a href={`/sponsor?vendor=${v.slug}`}>Sponsor it</a> to be pinned, labelled, above matching listings.
      </p>
    </Layout>
  );
}

export function PeptidesPage({ peptides, q }) {
  const list = q ? peptides.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : peptides;
  return (
    <Layout title="Every peptide, by vendors and price per mg" path="/peptides" description={`${peptides.length} research peptides with how many vendors list them, the cheapest price per mg and independent lab pass counts.`}>
      <h1>Peptides</h1>
      <form class="bigsearch" action="/peptides" method="get" role="search">
        <input name="q" value={q ?? ''} placeholder="filter by name" autocomplete="off" />
        <button class="btn primary" type="submit">Filter</button>
      </form>
      <div class="scroll">
        <table class="tbl">
          <thead>
            <tr><th>Peptide</th><th>Vendors</th><th>Listings</th><th>From</th><th>Lab tests passed</th></tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr>
                <td><a href={`/p/${p.slug}`}>{p.name}</a></td>
                <td class="mono">{p.vendors}</td>
                <td class="mono">{p.offers}</td>
                <td class="mono">{Number.isFinite(p.min_usd_per_mg) ? `$${p.min_usd_per_mg}/mg` : '—'}</td>
                <td class="mono">{p.tests ? `${p.tests_pass}/${p.tests}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

export function SponsorPage({ vendors, picked, open, error, cancelled }) {
  return (
    <Layout title="Sponsor a vendor" path="/sponsor" description={`Pin a vendor above matching listings for ${config.sponsorDays} days, labelled Sponsored. $${config.sponsorUsd}, paid in crypto.`}>
      <h1>Sponsor a vendor</h1>
      <p class="lede">
        ${config.sponsorUsd} pins one vendor for {config.sponsorDays} days: its best matching listing shows first on every search it matches, and it heads the vendor list, always labelled <b>Sponsored</b>. Scores, lab results and the ranking of everything else stay exactly as they are. Paid in crypto through CoinPay.
      </p>
      {cancelled ? <p class="note">Payment cancelled. Nothing was charged.</p> : null}
      {error ? <p class="note">{error}</p> : null}
      {open ? (
        <form class="shop" method="post" action="/sponsor">
          <label class="field">
            Vendor
            <select name="vendor" required>
              {vendors.map((v) => (
                <option value={v.slug} selected={v.slug === picked}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            Your email (for the receipt)
            <input type="email" name="email" required autocomplete="email" />
          </label>
          <button class="btn primary" type="submit">Pay ${config.sponsorUsd} in crypto</button>
        </form>
      ) : (
        <p class="note">Sponsorships open shortly.</p>
      )}
    </Layout>
  );
}

export function MessagePage({ title, message, status }) {
  return (
    <Layout title={title} path="/" noindex>
      <h1>{title}</h1>
      <p class="lede">{message}</p>
      {status ? <p class="muted">{status}</p> : null}
      <p>
        <a class="btn" href="/">Back to the search</a>
      </p>
    </Layout>
  );
}

export function Docs({ stats }) {
  const base = config.siteUrl;
  return (
    <Layout title="API, CLI and MCP" path="/docs">
      <h1>API, CLI and MCP</h1>
      <p class="lede">The same search everywhere. No key, no account. {stats.listings.toLocaleString('en-US')} listings, {stats.vendors} vendors.</p>
      <h2>REST</h2>
      <pre>{`GET ${base}/api/v1/search?text=retatrutide+lab+tested+under+$1/mg
GET ${base}/api/v1/search?peptide=bpc-157&in_stock=1&max_per_mg=2&sort=per_mg
GET ${base}/api/v1/vendors?min_score=80&contact=email&ships_from=US
GET ${base}/api/v1/vendors/<slug>          lab tests, listings, contact card
GET ${base}/api/v1/peptides                 every peptide with vendors and lowest $/mg
GET ${base}/api/v1/peptides/<slug>          lab results by vendor
GET ${base}/api/v1/export                   the whole register (nichedb reads this)
GET ${base}/api/v1/stats`}</pre>
      <p>
        Filters: <code>text q peptide vendor form payment ships_from ordering contact min_price max_price min_per_mg max_per_mg min_mg max_mg min_score min_pass in_stock tested passed coupon single blend priced sort page</code>. Every search response carries <code>facets</code>: each option with the count it leads to and the query that applies it.
      </p>
      <h2>CLI and TUI</h2>
      <pre>{`bunx searchpeptides search "bpc-157 in stock under $1/mg"
bunx searchpeptides vendors --contact email --min-score 80
bunx searchpeptides vendor chimera-peptides
bunx searchpeptides peptide retatrutide
bunx searchpeptides tui`}</pre>
      <h2>MCP</h2>
      <pre>{`claude mcp add peptides -- bunx searchpeptides mcp
# or streamable HTTP: POST ${base}/mcp
# tools: search_listings, search_vendors, get_vendor, get_peptide, list_peptides`}</pre>
      <p class="muted small">
        Ask the site directly: <a href="/llms.txt">llms.txt</a>, <a href="/skill.md">skill.md</a>, <a href="/.well-known/openmcp.json">openmcp.json</a>.
      </p>
    </Layout>
  );
}

export { PAYMENT_LABELS };
