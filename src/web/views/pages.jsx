import { config } from '../../config.js';
import { countryName, PAYMENT_LABELS } from '../../core/normalize.js';
import { toParams } from '../../core/parse.js';
import { syncedDay } from '../../service.js';
import { RULES_HISTORY } from '../../score.js';
import { Layout, REPO } from './Layout.jsx';
import { ActiveChips, Chips, FacetRail, ORDERING, OfferRow, Pager, passText, perMg, ResultsHead, scoreText, size, usd, VendorRow, VerifyBadge, verifyText } from './parts.jsx';

const OFFER_SORTS = [['', 'Cheapest per mg'], ['price', 'Lowest price'], ['verification', 'Best verification score'], ['score', 'Best Finnrick rating'], ['size', 'Largest size'], ['name', 'Peptide A–Z']];
const VENDOR_SORTS = [['', 'Best verification score'], ['score', 'Best Finnrick rating'], ['pass_rate', 'Lab pass rate'], ['tests', 'Most lab tests'], ['per_mg', 'Cheapest per mg'], ['listings', 'Most listings'], ['name', 'Name']];
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


/** Plain-words answers from the data, shown on an unfiltered peptide page and repeated as FAQPage JSON-LD. */
function peptideFaq(peptide, offers, stats) {
  const day = syncedDay(stats);
  const asOf = day ? ` as of ${day}` : '';
  const cheapest = offers.find((o) => o.unit === 'mg' && Number.isFinite(o.usd_per_mg));
  const tested = peptide.lab_results ?? [];
  const passed = tested.filter((r) => r.pass > 0);
  const names = (rows) => rows.slice(0, 12).map((r) => r.vendor_name).join(', ') + (rows.length > 12 ? `, and ${rows.length - 12} more` : '');
  const faq = [];
  if (cheapest)
    faq.push([
      `What is the cheapest ${peptide.name} per mg?`,
      `${cheapest.vendor_name}, at ${perMg(cheapest)}: ${usd(cheapest.price_usd)} for ${size(cheapest)}${asOf}. Prices are the vendor’s own, converted to USD.`,
    ]);
  faq.push([
    `Which ${peptide.name} vendors passed an independent lab test?`,
    !tested.length
      ? `None on record: no vendor has an independent lab test for ${peptide.name} yet.`
      : passed.length
        ? `${passed.length} of ${tested.length} tested vendors passed at least one test: ${names(passed)}.`
        : tested.length === 1
          ? `None has yet: the one tested vendor, ${tested[0].vendor_name}, has only failed tests on record.`
          : `None has yet: all ${tested.length} tested vendors (${names(tested)}) have only failed tests on record.`,
  ]);
  faq.push([`How many vendors sell ${peptide.name}?`, `${peptide.vendors} vendors, with ${peptide.offers} listings between them${asOf}.`]);
  faq.push(['Where do the lab results and vendor scores come from?', "From Finnrick's independent lab testing; this site is not affiliated with Finnrick or any vendor. The methodology page explains the score, what “passed” means and how price per mg is worked out."]);
  return faq;
}

/** BreadcrumbList on every peptide page; the listings as an ItemList of Offers and the answers as FAQPage on the plain one. */
function peptideJsonld(peptide, result, faq) {
  const crumbs = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Peptides', item: `${config.siteUrl}/peptides` },
      { '@type': 'ListItem', position: 2, name: peptide.name, item: `${config.siteUrl}/p/${peptide.slug}` },
    ],
  };
  if (!faq.length) return [crumbs];
  const offer = (o) => ({
    '@type': 'Offer',
    price: o.price_usd,
    priceCurrency: 'USD',
    ...(o.url ? { url: o.url } : {}),
    ...(o.in_stock === true ? { availability: 'https://schema.org/InStock' } : o.in_stock === false ? { availability: 'https://schema.org/OutOfStock' } : {}),
    seller: { '@type': 'Organization', name: o.vendor_name, url: `${config.siteUrl}/v/${o.vendor}` },
  });
  return [
    crumbs,
    {
      '@type': 'ItemList',
      name: `${peptide.name} listings, cheapest per mg first`,
      numberOfItems: result.total,
      itemListElement: result.offers.filter((o) => Number.isFinite(o.price_usd)).map((o, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'Product', name: o.name ?? o.peptide, offers: offer(o) } })),
    },
    { '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ];
}

/** The home page and /p/:slug: every listing, faceted. */
export function ListingsPage({ result, stats, text, peptide = null, base = '/', related = [] }) {
  const f = result.query.filters;
  const searched = text || Object.keys(f).some((k) => k !== 'page');
  // A peptide page with no filter beyond the peptide is the canonical one: it carries the answers and the structured data.
  const plain = peptide && result.page === 1 && Object.keys(f).every((k) => k === 'peptide' || k === 'page');
  const faq = plain ? peptideFaq(peptide, result.offers, stats) : [];
  const title = peptide ? `${peptide.name}: prices per mg and lab results` : searched ? `Peptide listings${text ? `: ${text}` : ''}` : null;
  const params = toParams(peptide ? { ...f, peptide: undefined } : f);
  return (
    <Layout title={title} noindex={peptide ? Object.keys(f).some((k) => k !== 'peptide' && k !== 'page') : searched} path={peptide ? `/p/${peptide.slug}` : '/'} jsonld={peptide ? peptideJsonld(peptide, result, faq) : undefined} api={peptide ? `${config.siteUrl}/api/v1/peptides/${peptide.slug}` : undefined} q={peptide ? '' : text} adClaim={peptide ? '' : config.adNetworkClaim} description={peptide ? `${peptide.name} from ${peptide.vendors} vendors, ${peptide.offers} listings${Number.isFinite(peptide.min_usd_per_mg) ? ` from $${peptide.min_usd_per_mg}/mg` : ''}, with independent lab results.` : undefined}>
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
            {syncedDay(stats) ? (
              <>
                {' '}
                Prices checked <time datetime={syncedDay(stats)}>{syncedDay(stats)}</time>.
              </>
            ) : null}
          </p>
          {plain ? (
            <p class="prose muted">
              Built for researchers comparing {peptide.name} vendors before they buy. It is sold for research in many vial sizes and pack counts, so the listings below are ranked by US dollars per milligram rather than sticker price. A low price per mg says nothing about what is in the vial: the lab column shows whether each vendor has passed an independent test, and the <a href="/methodology">methodology</a> explains what a pass means. Published research on {peptide.name}: <a href={`https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(peptide.name)}`} rel="noopener" target="_blank">PubMed</a>. For research use only; not medical advice.
            </p>
          ) : null}
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
            {searched ? null : ' Built for researchers comparing research-peptide vendors before they buy.'}
            {!searched && syncedDay(stats) ? (
              <>
                {' '}
                Prices checked <time datetime={syncedDay(stats)}>{syncedDay(stats)}</time>.
              </>
            ) : null}
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
          {!searched ? (
            <p class="cta">
              <a class="btn" href="/docs">Use the free API, CLI or MCP</a>
              <a class="btn ghost" href="/sponsor">Sponsor your shop</a>
              <a class="btn ghost" href="/rules">How vendors are scored</a>
            </p>
          ) : null}
          {searched ? <ApiReadout result={result} tool="search_listings" /> : null}
        </>
      )}
      <div class="results-layout">
        <FacetRail facets={result.facets} base={base} total={result.total} peptidePage={!!peptide} />
        <section class="results">
          <ResultsHead title={`${result.total.toLocaleString('en-US')} ${result.total === 1 ? 'listing' : 'listings'}`} base={base} params={params} sorts={OFFER_SORTS} sort={['price', 'verification', 'score', 'size', 'name'].includes(f.sort) ? f.sort : ''} h1={false} />
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
      {faq.length ? (
        <section class="faq">
          <h2>{peptide.name}: quick answers</h2>
          {faq.map(([q, a]) => (
            <>
              <h3>{q}</h3>
              <p>{a}</p>
            </>
          ))}
          <p class="muted small">
            <a href="/methodology">How scores, lab results and price per mg work</a>
          </p>
        </section>
      ) : null}
      {related.length ? (
        <p class="related">
          Related:{' '}
          {related.map((r) => (
            <a class="chip link" href={`/p/${r.slug}`}>
              {r.name}
            </a>
          ))}
        </p>
      ) : null}
    </Layout>
  );
}

export function VendorsPage({ result, text }) {
  const f = result.query.filters;
  const params = toParams(f);
  return (
    <Layout title="Peptide vendors: lab results, score, contact" path="/vendors" noindex={Object.keys(f).some((k) => k !== 'page')} description={`${result.total} research-peptide vendors with a transparent verification score, independent lab pass rates, payment methods, where they ship from and how to reach them.`}>
      <h1>Peptide vendors</h1>
      <p class="lede">Every vendor with independent lab results or published prices, ranked by a verification score built only from evidence you can check (<a href="/rules">the rules</a>), with how to reach them: email, phone, WhatsApp, Telegram and socials read from the vendor’s own site.</p>
      <form class="bigsearch" action="/vendors" method="get" role="search">
        <input name="q" value={f.q ?? text ?? ''} placeholder="vendor name" autocomplete="off" />
        <button class="btn primary" type="submit">Search</button>
      </form>
      <div class="results-layout">
        <FacetRail facets={result.facets} base="/vendors" total={result.total} />
        <section class="results">
          <ResultsHead title={`${result.total} ${result.total === 1 ? 'vendor' : 'vendors'}`} base="/vendors" params={params} sorts={VENDOR_SORTS} sort={['score', 'pass_rate', 'tests', 'per_mg', 'listings', 'name'].includes(f.sort) ? f.sort : ''} h1={false} />
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
  const site = v.contact.websites[0];
  const otherContacts = [
    ...v.contact.websites.slice(1).map((w) => [w, w.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')]),
    ...v.contact.emails.map((e) => [`mailto:${e}`, e]),
    ...v.contact.phones.map((p) => [`tel:${p}`, p]),
    ...Object.values(v.contact.socials).flat().map((u) => [u, u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')]),
  ];
  const shipText = shipping.map((s) => `${s.to ?? 'anywhere'} ${Number.isFinite(s.cost) ? (s.cost === 0 ? 'free' : usd(s.cost)) : ''}${s.free_over ? `, free over ${usd(s.free_over)}` : ''}${s.days ? `, ${s.days}${/day/i.test(String(s.days)) ? '' : ' days'}` : ''}`.trim()).join(' · ');
  const tests = Object.values(
    v.lab_tests.reduce((acc, t) => {
      const g = (acc[t.peptide_slug] ??= { peptide: t.peptide, slug: t.peptide_slug, pass: 0, fail: 0, latest: null });
      if (t.result === 'pass') g.pass++;
      else if (t.result === 'fail') g.fail++;
      if (t.tested_on && (!g.latest || t.tested_on > g.latest)) g.latest = t.tested_on;
      return acc;
    }, {}),
  );
  const listings = [...v.listings].sort((a, b) => (a.peptide ?? '').localeCompare(b.peptide ?? '') || (a.total_mg ?? 0) - (b.total_mg ?? 0) || (a.price_usd ?? 0) - (b.price_usd ?? 0));
  const notes = [v.terms_source, v.ordering_evidence, v.notes].filter(Boolean);
  return (
    <Layout title={`${v.name}: lab results, prices, contact`} path={`/v/${v.slug}`} jsonld={jsonld} description={`${v.name}: verification score ${verifyText(v.verification_score, v.verification.status)}, ${passText(v)}, ${v.offers} listings. Email, phone and socials, payment methods and shipping.`}>
      <p class="crumbs">
        <a href="/vendors">Vendors</a> / {v.name}
      </p>
      <header class="vhead">
        <div>
          <h1>
            {v.name} {v.sponsored ? <span class="tag">Sponsored</span> : null}
          </h1>
          <p class="vbadges">
            <a class="chip strong" href="#score">verification {verifyText(v.verification_score, v.verification.status)}</a>
            <span class="chip" title="Finnrick's rating as published">Finnrick {scoreText(v)}</span>
            <span class={`chip ${v.tests_fail ? 'bad' : v.tests ? 'good' : ''}`}>{v.tests ? `${v.tests_pass}/${v.tests} lab tests passed` : 'no lab tests'}</span>
            {ORDERING[v.ordering] ? <span class="chip">{ORDERING[v.ordering]}</span> : null}
            {v.ships_from.length ? <span class="chip">from {v.ships_from.map(countryName).join(', ')}</span> : null}
          </p>
        </div>
        {site ? (
          <a class="btn primary" href={site} rel={v.sponsored ? 'sponsored nofollow noopener' : 'nofollow noopener'} target="_blank">
            {site.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')} ↗
          </a>
        ) : null}
      </header>
      {otherContacts.length ? (
        <p class="vcontact muted small">
          Also:{' '}
          {otherContacts.map(([href, text], i) => (
            <>
              {i ? ' · ' : ''}
              <a href={href} rel="nofollow noopener" target="_blank">{text}</a>
            </>
          ))}
        </p>
      ) : !site ? <p class="muted small">No contact details found on the vendor’s own pages.</p> : null}
      <dl class="strip">
        <div><dt>Listings</dt><dd>{v.offers ? `${v.offers} · ${v.peptides} peptides` : 'none published'}</dd></div>
        <div><dt>Cheapest</dt><dd>{Number.isFinite(v.min_usd_per_mg) ? `$${v.min_usd_per_mg}/mg` : '—'}</dd></div>
        <div><dt>Ships to</dt><dd>{v.ships_to ?? '—'}</dd></div>
        <div><dt>Shipping</dt><dd>{shipText || '—'}</dd></div>
        <div><dt>Pay with</dt><dd>{v.payments_raw.join(', ') || '—'}</dd></div>
        {v.min_order ? <div><dt>Minimum</dt><dd>{v.min_order}</dd></div> : null}
      </dl>
      {v.coupons.length || v.discounts.length ? (
        <p class="vbadges">
          {v.coupons.map((c) => (
            <span class="chip">
              <b class="mono">{c.code ?? '—'}</b> {c.discount ?? ''} {c.conditions ? `(${c.conditions})` : ''}
            </span>
          ))}
          {v.discounts.map((d) => (
            <span class="chip">
              {d.method}: {d.pct ? `${d.pct}% off` : d.flat ? `$${d.flat} off` : ''}
            </span>
          ))}
        </p>
      ) : null}
      <ScoreSection v={v} />
      {v.independent_tests.length ? <TestsSection v={v} /> : null}
      {tests.length && !v.independent_tests.length ? (
        <section class="vsec">
          <h2>Independent lab tests</h2>
          <table class="tbl tight fit">
            <thead>
              <tr><th>Peptide</th><th>Result</th><th>Latest</th></tr>
            </thead>
            <tbody>
              {tests.map((t) => (
                <tr>
                  <td><a href={`/p/${t.slug}`}>{t.peptide}</a></td>
                  <td>{t.pass ? <span class="ok">✓ {t.pass} passed</span> : null}{t.pass && t.fail ? ' · ' : ''}{t.fail ? <span class="no">✗ {t.fail} failed</span> : null}</td>
                  <td class="mono">{t.latest ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {listings.length ? (
        <section class="vsec">
          <div class="vsec-head">
            <h2>Listings <span class="muted small">{listings.length}</span></h2>
            <input id="vfilter" type="search" placeholder="Filter, e.g. bpc or 10mg" aria-label="Filter listings" autocomplete="off" />
          </div>
          <div class="scroll">
            <table class="tbl tight" id="vlist">
              <thead>
                <tr><th>Peptide</th><th>Size</th><th class="num">Price</th><th class="num">Per mg</th><th class="stock" title="In stock">Stock</th></tr>
              </thead>
              <tbody>
                {listings.map((o) => (
                  <tr class={o.in_stock === false ? 'out' : ''} data-q={`${o.peptide ?? ''} ${o.name ?? ''} ${size(o)}`.toLowerCase()}>
                    <td>
                      {o.peptide_slug ? <a href={`/p/${o.peptide_slug}`}>{o.peptide}</a> : o.peptide}
                      {o.url ? (
                        <a class="ext" href={o.url} rel="nofollow noopener" target="_blank" title={o.name ?? ''}>
                          ↗
                        </a>
                      ) : null}
                    </td>
                    <td class="mono">{size(o)}</td>
                    <td class="mono num">{usd(o.price_usd)}</td>
                    <td class="mono num">{perMg(o)}</td>
                    <td class="stock">{o.in_stock === true ? <span class="ok" title="In stock">●</span> : o.in_stock === false ? <span class="muted" title="Out of stock">✕</span> : <span class="muted" title="Unknown">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {notes.length ? (
        <details class="vnotes">
          <summary>How we read this shop</summary>
          {notes.map((n) => (
            <p>{n}</p>
          ))}
        </details>
      ) : null}
      <p class="muted small">
        Checked {v.checked_at ? v.checked_at.slice(0, 10) : 'unknown'} · <a href={`/api/v1/vendors/${v.slug}`}>JSON</a> · Is this your shop? <a href={`/sponsor?vendor=${v.slug}`}>Sponsor it</a> to be pinned above matching listings.
      </p>
    </Layout>
  );
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');
const pts = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The vendor's verification score, every component with its weight, points and evidence. */
function ScoreSection({ v }) {
  const s = v.verification;
  return (
    <section class="vsec" id="score">
      <h2>Verification score</h2>
      <div class="scorebox">
        <p>
          <span class="big">{verifyText(s.score, s.status)}</span>{' '}
          <span class="muted small">
            last verified {day(s.verified_at)} · score changed {day(s.changed_at)} · rules v{s.rules_version} · <a href="/rules">how it is worked out</a>
          </span>
        </p>
        {s.note ? <p class="muted">{s.note} The components below show what is on record; none of it is filled in by guessing.</p> : null}
        {s.components.length ? (
          <div class="scroll">
            <table class="tbl tight">
              <thead>
                <tr><th>Component</th><th class="num">Points</th><th>Evidence</th></tr>
              </thead>
              <tbody>
                {s.components.map((c) => (
                  <tr>
                    <td><a href={`/rules#${c.key}`}>{c.label}</a></td>
                    <td class="mono num">{c.status === 'ok' ? `${pts(c.points)} / ${c.weight}` : `— / ${c.weight}`}</td>
                    <td class="ev">{c.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p class="muted small">
          Evidence: <a href={s.evidence} rel="nofollow noopener" target="_blank">{v.name} on Finnrick ↗</a> and the vendor’s own pages. Research use only; this scores the paper trail, not any product’s fitness for use.
        </p>
      </div>
      {v.score_history.length ? (
        <details class="vnotes">
          <summary>Score history ({v.score_history.length})</summary>
          <table class="tbl tight fit">
            <thead>
              <tr><th>When</th><th>Score</th><th>Why</th></tr>
            </thead>
            <tbody>
              {v.score_history.map((h) => (
                <tr>
                  <td class="mono">{day(h.at)}</td>
                  <td class="mono">{h.old_status ? `${verifyText(h.old_score, h.old_status)} → ` : ''}{verifyText(h.new_score, h.new_status)}</td>
                  <td class="ev">{h.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  );
}

/** Every independent test, each a link to its public record with the certificate. */
function TestsSection({ v }) {
  const shown = v.independent_tests.slice(0, 100);
  const yes = (b) => (b ? <span class="ok">✓</span> : <span class="muted">–</span>);
  return (
    <section class="vsec">
      <h2>
        Independent lab tests <span class="muted small">{v.independent_tests.length}</span>
      </h2>
      <div class="scroll">
        <table class="tbl tight">
          <thead>
            <tr><th>Tested</th><th>Peptide</th><th>Result</th><th>Purity</th><th>Lab</th><th>Batch</th><th title="Certificate of analysis on file">COA</th><th>Sample</th><th>Record</th></tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr>
                <td class="mono">{t.tested_on ?? '—'}</td>
                <td>{t.peptide_slug ? <a href={`/p/${t.peptide_slug}`}>{t.peptide}</a> : t.peptide}</td>
                <td>{t.passed === true ? <span class="ok">✓ pass</span> : t.passed === false ? <span class="no" title={t.reasons.join(', ')}>✗ fail</span> : <span class="muted">not classified</span>}</td>
                <td class="mono">{t.purity ?? '—'}</td>
                <td>{t.lab_name ?? '—'}</td>
                <td class="mono">{t.batch ?? <span class="muted">none</span>}</td>
                <td>{yes(t.coa)}</td>
                <td>{t.sent_by ?? '—'}</td>
                <td><a href={t.record} rel="nofollow noopener" target="_blank">record ↗</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {v.independent_tests.length > shown.length ? (
        <p class="muted small">
          Newest {shown.length} shown; all {v.independent_tests.length} in the <a href={`/api/v1/vendors/${v.slug}`}>JSON</a>.
        </p>
      ) : null}
    </section>
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
    <Layout
      title="API, CLI and MCP"
      path="/docs"
      description="The search.peptides REST API, CLI, TUI and MCP server: the same peptide listing and vendor search as the site, with no key and no account."
    >
      <h1>API, CLI and MCP</h1>
      <p class="lede">The same search everywhere. No key, no account. {stats.listings.toLocaleString('en-US')} listings, {stats.vendors} vendors.</p>
      <h2>REST</h2>
      <pre>{`GET ${base}/api/v1/search?text=retatrutide+lab+tested+under+$1/mg
GET ${base}/api/v1/search?peptide=bpc-157&in_stock=1&max_per_mg=2&sort=per_mg
GET ${base}/api/v1/vendors?min_verification=70&contact=email&ships_from=US
GET ${base}/api/v1/rules
GET ${base}/api/v1/vendors/<slug>          lab tests, listings, contact card
GET ${base}/api/v1/peptides                 every peptide with vendors and lowest $/mg
GET ${base}/api/v1/peptides/<slug>          lab results by vendor
GET ${base}/api/v1/export                   the whole register (nichedb reads this)
GET ${base}/api/v1/stats`}</pre>
      <p>
        Filters: <code>text q peptide vendor form payment ships_from ordering contact min_price max_price min_per_mg max_per_mg min_mg max_mg min_verification min_score min_pass in_stock tested passed coupon single blend priced sort page</code>. Every search response carries <code>facets</code>: each option with the count it leads to and the query that applies it.
      </p>
      <h2>CLI and TUI</h2>
      <pre>{`bunx searchpeptides search "bpc-157 in stock under $1/mg"
bunx searchpeptides vendors --contact email --min-verification 70
bunx searchpeptides rules
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

export function AboutPage({ stats }) {
  return (
    <Layout title="About" path="/about" description="Who runs search.peptides, what it is for, how vendors get listed, and how to reach us.">
      <div class="prose">
        <h1>About {config.siteName}</h1>
        <p class="lede">
          {config.siteName} is a free, independent search over every research-peptide vendor we can find: {stats.listings.toLocaleString('en-US')} listings from {stats.vendors.toLocaleString('en-US')} vendors, ranked by price per mg, with independent lab results and each vendor’s contact details.
        </p>
        <h2>Who it is for</h2>
        <p>Researchers, labs and buyers comparing research-peptide vendors before they order: who is cheapest per milligram, who has passed independent testing, how they take payment, where they ship from and how to reach them.</p>
        <h2>Who runs it</h2>
        <p>
          It is built and run by <a href="https://profullstack.com">Profullstack, Inc.</a> as part of the Profullstack network. It sells nothing, takes no commission and uses no affiliate links; the only paid placement is a clearly labelled sponsored pin. The code is open source at <a href={REPO}>github.com/moshcoder/search.peptides</a>.
        </p>
        <h2>How vendors get listed</h2>
        <p>
          Vendors come in automatically from the public peptide price register and Finnrick’s vendor list, re-read every hour and every six hours. A shop that is missing, or listed wrongly, can <a href={`${REPO}/issues`}>open an issue</a>; a listed shop can also <a href="/sponsor">sponsor</a> its place.
        </p>
        <h2>How it works</h2>
        <p>
          <a href="/methodology">How we score and price</a> explains the vendor score, what “passed” means and how price per mg is worked out. Every search on the site is also a keyless <a href="/docs">API, CLI and MCP server</a>.
        </p>
        <h2 id="contact">Contact</h2>
        <p>
          Corrections, vendor disputes and press: <a href={`${REPO}/issues`}>GitHub issues</a>. Security reports: <a href="/.well-known/security.txt">security.txt</a>.
        </p>
      </div>
    </Layout>
  );
}

export function ChangelogPage({ entries }) {
  return (
    <Layout
      title="Changelog"
      path="/changelog"
      description="What changed on search.peptides, newest first: new pages, faster search, better prices and how the data is kept up to date."
      jsonld={{
        '@type': 'Blog',
        name: `${config.siteName} changelog`,
        url: `${config.siteUrl}/changelog`,
        blogPost: entries.map((e) => ({ '@type': 'BlogPosting', headline: e.title, datePublished: e.date, articleBody: e.text, url: `${REPO}/pull/${e.pr}`, author: { '@id': `${config.siteUrl}/#org` } })),
      }}
    >
      <div class="prose">
        <h1>Changelog</h1>
        <p class="lede">What changed on {config.siteName}, newest first. The code and every change are public on <a href={REPO}>GitHub</a>.</p>
        {entries.map((e) => (
          <section>
            <h2>{e.title}</h2>
            <p class="muted small">
              <time datetime={e.date}>{e.date}</time> · <a href={`${REPO}/pull/${e.pr}`}>#{e.pr}</a>
            </p>
            <p>{e.text}</p>
          </section>
        ))}
      </div>
    </Layout>
  );
}

export function MethodologyPage({ stats }) {
  return (
    <Layout title="How we score and price" path="/methodology" description="What the vendor score means, where the independent lab results come from, what passed means, and how price per mg is worked out on search.peptides.">
      <div class="prose">
        <h1>How we score and price</h1>
        <p class="lede">
          {config.siteName} compares research-peptide listings by price per mg and shows each vendor’s independent lab record. It is for researchers comparing vendors before they buy. It sells nothing and takes no commission.
        </p>
        <h2>Price per mg</h2>
        <p>
          Each listing’s price is the vendor’s own, converted to US dollars on the day it was read. Price per mg is that price divided by the total milligrams in the listing: the size of one vial times the number of vials in the pack. Listings sold in IU or another unit are ranked by that unit and never compared with mg. Out-of-stock listings stay in the list, marked.
        </p>
        <h2>Verification score</h2>
        <p>
          Each vendor’s 0 to 100 verification score is computed here from evidence you can check: independent lab results, whether each certificate is lot-specific, names its lab and has a public record, how many tests and how recent, Finnrick’s rating, and the vendor’s published terms. The formula, the weights, what counts as a verifiable certificate and every score change are on <a href="/rules">the rules page</a>. Scores are never sold.
        </p>
        <h2>Finnrick rating</h2>
        <p>
          The Finnrick rating is <a href="https://www.finnrick.com">Finnrick</a>’s own, shown as published. Finnrick is an independent service that lab-tests peptides sold by vendors and rates the vendors on the results. It is one component of the verification score.
        </p>
        <h2>Lab tests and “passed”</h2>
        <p>
          Lab test counts are Finnrick’s independent test results for that vendor. “Passed” on a listing means the vendor has at least one passing independent test for that peptide; it does not mean that exact batch or listing was tested. A peptide page lists every tested vendor with its passes, failures and latest test date. Findings from certificates of analysis come from documents the vendor publishes itself.
        </p>
        <h2>Contact details</h2>
        <p>Emails, phones, WhatsApp, Telegram and socials are read from each vendor’s own website (weekly) and from Finnrick’s vendor records (every three days).</p>
        <h2>How fresh it is</h2>
        <p>
          Prices and lab results are re-read every hour, and new vendors are looked for every six hours.
          {syncedDay(stats) ? ` Last read ${String(stats.synced_at).slice(0, 16).replace('T', ' ')} UTC.` : ''} Right now: {stats.listings.toLocaleString('en-US')} listings, {stats.vendors.toLocaleString('en-US')} vendors, {stats.lab_tests.toLocaleString('en-US')} lab tests.
        </p>
        <h2>Sponsored listings</h2>
        <p>
          A vendor can pay to be pinned above matching results for {config.sponsorDays} days. It is always labelled <b>Sponsored</b> and changes nothing else: scores, lab results and the order of every other listing stay as they are.
        </p>
        <h2>Corrections</h2>
        <p>
          Wrong price, dead link, or a vendor’s details out of date? <a href={`${REPO}/issues`}>Open an issue</a>.
        </p>
      </div>
    </Layout>
  );
}

/** /rules: the verification criteria, the formula, the sources and how fresh they are, and what changed. */
export function RulesPage({ report, stats, changelog }) {
  const { rules } = report;
  const years = rules.window_days / 365;
  return (
    <Layout title="Rules: how vendors are verified and scored" path="/rules" description={`The verification score on ${config.siteName}: what counts as a verifiable certificate of analysis, the formula and its weights, where the evidence comes from, how often it is re-read, and every score change.`}>
      <div class="prose">
        <h1>Rules: how vendors are verified and scored</h1>
        <p class="lede">
          A vendor comparison is only as good as its verification criteria and its update history, so both are here. The verification score (0 to 100) is built only from evidence you can check yourself, every vendor page shows each component with its weight and evidence, and a vendor without enough evidence is shown as <b>insufficient data</b> or <b>unscored</b>, never given a guessed number. For research use only; the score rates the paper trail, not any product’s fitness for use, and it is not medical advice.
        </p>
        <p class="muted small">
          Rules version {rules.version} · {report.vendors.scored} vendors scored, {report.vendors.insufficient} with insufficient data, {report.vendors.unscored} unscored{Number.isFinite(report.median_score) ? ` · median score ${report.median_score}` : ''} · tests last read {report.tests_read_at ? `${String(report.tests_read_at).slice(0, 16).replace('T', ' ')} UTC` : 'not yet'}
        </p>

        <h2 id="criteria">What counts as verified</h2>
        <p>A certificate of analysis (COA) counts toward the score only when all of this holds:</p>
        <ul>
          <li><b>Independent sample.</b> The sample was tested for Finnrick, an independent testing service, not supplied as a document by the vendor. A certificate a vendor posts on its own site cannot be traced to a sample anyone else bought, so it earns nothing here.</li>
          <li><b>Identifiable lab.</b> The certificate names the laboratory that ran the test (for example Krause Analytical, BTLabs).</li>
          <li><b>Lot-specific.</b> The record carries a lot or batch identifier as printed on the vial. A result without one says something about the vendor, less about any batch you might receive.</li>
          <li><b>Verifiable.</b> The certificate is on file with a public record page you can open: every test on a vendor page links to it.</li>
          <li><b>Recent.</b> Only tests from the last {years} years count toward results, certificates, depth and sampling; recency is scored on its own.</li>
        </ul>
        <p>Not inputs, ever: {rules.not_inputs.map((x) => x.toLowerCase()).join('; ')}.</p>

        <h2 id="formula">The formula</h2>
        <p>Score = the sum of seven components, rounded. Missing evidence earns no points for that component; nothing is estimated.</p>
        <div class="scroll">
          <table class="tbl tight">
            <thead>
              <tr><th>Component</th><th class="num">Weight</th><th>Rule</th></tr>
            </thead>
            <tbody>
              {rules.components.map((c) => (
                <tr id={c.key}>
                  <td>{c.label}</td>
                  <td class="mono num">{c.weight}</td>
                  <td class="ev">{c.rule}</td>
                </tr>
              ))}
              <tr>
                <td><b>Total</b></td>
                <td class="mono num"><b>{rules.components.reduce((n, c) => n + c.weight, 0)}</b></td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <h3 id="statuses">Scored, insufficient data, unscored</h3>
        <ul>
          {Object.entries(rules.statuses).map(([k, t]) => (
            <li>
              <b>{k === 'insufficient' ? 'Insufficient data' : k[0].toUpperCase() + k.slice(1)}.</b> {t.replace(/^[^:]*: /, '')}
            </li>
          ))}
        </ul>
        <p>“Passed” is Finnrick’s classification under its default “Purity focus” criteria. A pass is about that one sample; it does not mean every batch or listing was tested.</p>

        <h2 id="sources">Sources and how often they are read</h2>
        <div class="scroll">
          <table class="tbl tight">
            <thead>
              <tr><th>Evidence</th><th>Source</th><th>Re-read</th></tr>
            </thead>
            <tbody>
              <tr><td>Every independent test: result, purity, lab, batch, certificate, who sent the sample</td><td><a href="https://www.finnrick.com">Finnrick</a> public API, /api/v1/tests</td><td>daily</td></tr>
              <tr><td>Finnrick rating per vendor</td><td>Finnrick vendor record, /api/v1/vendors/&lt;vendor&gt;</td><td>every 3 days per vendor</td></tr>
              <tr><td>New vendors</td><td>Finnrick vendor list</td><td>every 6 hours</td></tr>
              <tr><td>Checkout, payment methods, ships-from</td><td>the vendor’s own shop and terms pages, and the compiled register</td><td>daily (shop), hourly (register)</td></tr>
              <tr><td>Contact email and website</td><td>the vendor’s own site; Finnrick’s vouched contacts</td><td>weekly; every 3 days</td></tr>
              <tr><td>The score itself</td><td>recomputed from all of the above</td><td>after every update, and every 6 hours as tests age</td></tr>
            </tbody>
          </table>
        </div>
        <p class="muted small">Not affiliated with Finnrick or any vendor. Finnrick’s data is read from its public read API, which its robots.txt opens to crawlers.</p>

        <h2 id="history">Update history</h2>
        <p>
          Each vendor page shows when its evidence was <b>last verified</b> (last read from the source), when its <b>score changed</b>, and its full score history with the reason for each change. The {report.recent_changes.length} most recent changes across all vendors:
        </p>
        {report.recent_changes.length ? (
          <div class="scroll">
            <table class="tbl tight">
              <thead>
                <tr><th>When (UTC)</th><th>Vendor</th><th>Score</th><th>Why</th></tr>
              </thead>
              <tbody>
                {report.recent_changes.map((h) => (
                  <tr>
                    <td class="mono">{String(h.at).slice(0, 16).replace('T', ' ')}</td>
                    <td><a href={`/v/${h.vendor}#score`}>{h.name ?? h.vendor}</a></td>
                    <td class="mono">{h.old_status ? `${verifyText(h.old_score, h.old_status)} → ` : ''}{verifyText(h.new_score, h.new_status)}</td>
                    <td class="ev">{h.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">No score changes yet.</p>
        )}
        <h3 id="rules-history">Changes to these rules</h3>
        <ul>
          {RULES_HISTORY.map((r) => (
            <li>
              <time datetime={r.date}>{r.date}</time>, v{r.version}: {r.text}
            </li>
          ))}
        </ul>
        <h3>Site changelog</h3>
        <ul>
          {changelog.slice(0, 5).map((e) => (
            <li>
              <time datetime={e.date}>{e.date}</time>: {e.title}
            </li>
          ))}
        </ul>
        <p>
          <a href="/changelog">Full changelog</a> · the code behind every number is public: <a href={`${REPO}/blob/main/src/score.js`}>src/score.js</a> · <a href="/api/v1/rules">these rules as JSON</a> · wrong evidence? <a href={`${REPO}/issues`}>Report a correction</a>.
        </p>
      </div>
    </Layout>
  );
}

export function PrivacyPage() {
  return (
    <Layout title="Privacy" path="/privacy" description="What search.peptides collects: no accounts and no cookies of its own, a page-view counter, and the email a sponsor gives for a receipt.">
      <div class="prose">
        <h1>Privacy</h1>
        <p class="lede">No accounts, no sign-in and no cookies set by this site. Searching the site, the API, the CLI and MCP needs nothing from you.</p>
        <h2 id="choices">Page views and ads, only if you allow them</h2>
        <p>
          The site can count visits with a crawlproof.com counter, which keeps a random visitor id in your browser’s local storage (not a cookie) and sends the page address and referrer. The home page can also show one ad unit from crawlproof.com, which may store an id the same way. Neither loads until you press Allow on the bar at the bottom of the page; No thanks, or a browser sending Global Privacy Control, keeps both off. Your answer is kept in your own browser. The “Privacy choices” link in the footer asks again.
        </p>
        <h2>Server logs</h2>
        <p>This server keeps no access logs of pages or API calls. If you reach it through the pit.world relay, that relay passes your request on to it.</p>
        <h2>Sponsors</h2>
        <p>
          Sponsoring a vendor asks for an email for the receipt. The email, the vendor and the amount are kept to run the sponsorship and are sent to CoinPay (coinpayportal.com), which takes the payment. They are not shared with anyone else or used for marketing.
        </p>
        <h2>Vendor details</h2>
        <p>
          Contact details shown for vendors are business details each vendor publishes on its own site or on Finnrick. A vendor can ask for a correction or removal by <a href={`${REPO}/issues`}>opening an issue</a>.
        </p>
        <h2>Questions</h2>
        <p>
          <a href={`${REPO}/issues`}>Open an issue</a> on the source repository.
        </p>
      </div>
    </Layout>
  );
}

export function TermsPage() {
  return (
    <Layout title="Terms of use" path="/terms" description="The terms for using search.peptides: research use only, not medical advice, data as published by vendors and Finnrick, no warranty.">
      <div class="prose">
        <h1>Terms of use</h1>
        <p class="lede">{config.siteName} is a free search over what research-peptide vendors publish. Using it, its API, CLI or MCP server means accepting these terms.</p>
        <h2>Research use, not medical advice</h2>
        <p>Nothing here is medical advice or an endorsement of any vendor or product. Listings are for research comparison only. Check the law where you are before buying anything.</p>
        <h2>The data</h2>
        <p>
          Prices, stock, contact details and certificates are each vendor’s own; lab results and ratings are Finnrick’s; the verification score is computed here under <a href="/rules">published rules</a>. They are shown as found, may be out of date or wrong, and come with no warranty. Check with the vendor before you buy. See <a href="/methodology">how we score and price</a>.
        </p>
        <h2>Vendors and links</h2>
        <p>Links to vendors carry no affiliate or referral code. We are not party to anything you buy from a vendor.</p>
        <h2>Sponsorships</h2>
        <p>
          A sponsorship is ${config.sponsorUsd} for {config.sponsorDays} days of a labelled pin above matching listings. It does not buy a better score, a lab result or any change to other listings, and it starts once the payment confirms.
        </p>
        <h2>Using the API</h2>
        <p>
          The API and MCP server are open and keyless. Keep request rates reasonable; the whole register is one call at <a href="/api/v1/export">/api/v1/export</a>. The code is MIT licensed.
        </p>
        <h2>Changes</h2>
        <p>These terms can change; the version on this page is the one that applies.</p>
      </div>
    </Layout>
  );
}

export { PAYMENT_LABELS, syncedDay };
