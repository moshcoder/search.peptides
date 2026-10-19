import { raw } from 'hono/html';
import { readFileSync } from 'node:fs';
import { config } from '../../config.js';
import { DISCLOSURE, PRICE_NOTE } from '../../service.js';
import { pitFooter } from '../../pit-footer.ts';

// The stylesheet and script are cached for an hour; a content hash in their URLs means a deploy never pairs new markup with old assets.
const assetVersion = (file) => Bun.hash(readFileSync(new URL(`../../../public/${file}`, import.meta.url))).toString(36);
const CSS_VERSION = assetVersion('styles.css');
const JS_VERSION = assetVersion('app.js');

/** The one HTML shell: dark ground, phosphor accent, sticky search bar, the Moshpit ring bar on top. */
/** Who runs the site and how to search it, on every page; a page's own nodes join the same graph. */
const SITE_GRAPH = () => [
  { '@type': 'Organization', '@id': `${config.siteUrl}/#org`, name: config.siteName, url: `${config.siteUrl}/`, logo: `${config.siteUrl}/og.png`, sameAs: [REPO, 'https://nichedb.dev/c/peptides'] },
  {
    '@type': 'WebSite',
    '@id': `${config.siteUrl}/#site`,
    name: config.siteName,
    url: `${config.siteUrl}/`,
    publisher: { '@id': `${config.siteUrl}/#org` },
    potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${config.siteUrl}/?text={search_term_string}` }, 'query-input': 'required name=search_term_string' },
  },
];
export const REPO = 'https://github.com/moshcoder/search.peptides';

export function Layout({ title, description, path = '/', jsonld, children, q = '', noindex = false, adClaim = '', api = `${config.siteUrl}/api/v1/search` }) {
  const graph = { '@context': 'https://schema.org', '@graph': [...SITE_GRAPH(), ...[jsonld ?? []].flat().map(({ '@context': _, ...node }) => node)] };
  const full = title ? `${title} · ${config.siteName}` : `${config.siteName}: every research peptide vendor, compared`;
  const desc = description ?? 'Every research-peptide vendor and listing, compared by price per mg, independent lab results, payment and where it ships from, with each vendor’s contact details. Same search on the page, the API, the CLI and MCP.';
  const nav = [
    ['/', 'Listings'],
    ['/vendors', 'Vendors'],
    ['/peptides', 'Peptides'],
    ['/sponsor', 'Sponsor'],
    ['/docs', 'API · CLI · MCP'],
  ];
  const siteAd = Boolean(config.crawlproofAdSlot && !path.startsWith('/sponsor'));
  const active = (h) => (h === '/' ? path === '/' : path.startsWith(h));
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{full}</title>
        <meta name="description" content={desc} />
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#0b0d12" />
        {noindex ? <meta name="robots" content="noindex" /> : null}
        {config.pitVerify ? <meta name="pit-verify" content={config.pitVerify} /> : null}
        {adClaim ? <meta name="ad.network" content={adClaim} /> : null}
        <link rel="canonical" href={`${config.siteUrl}${path}`} />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="preload" href="/fonts/Geist.woff2" as="font" type="font/woff2" crossorigin="" />
        <link rel="stylesheet" href={`/styles.css?v=${CSS_VERSION}`} />
        <link rel="alternate" type="application/json" href={api} title="This page as JSON" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content={config.siteName} />
        <meta property="og:title" content={full} />
        <meta property="og:description" content={desc} />
        <meta property="og:url" content={`${config.siteUrl}${path}`} />
        <meta property="og:image" content={`${config.siteUrl}/og.png`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content={`${config.siteName}: research-peptide prices per mg and lab results`} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content={`${config.siteUrl}/og.png`} />
        <script type="application/ld+json">{raw(JSON.stringify(graph).replace(/</g, '\\u003c'))}</script>
        {/* public/app.js loads crawlproof's counter and ads only after the visitor says yes. */}
        <script src={`/app.js?v=${JS_VERSION}`} defer data-stats={config.crawlproofSite || undefined} data-ads={siteAd || adClaim ? '1' : undefined}></script>
      </head>
      <body>
        <a class="skip" href="#main">Skip to content</a>
        {raw('<!--ring-bar-->')}
        <header class="top">
          <div class="wrap top-in">
            <a class="brand" href="/" aria-label={`${config.siteName} home`}>
              <span class="logo" aria-hidden="true">⌬</span> {config.siteName}
            </a>
            <form class="topsearch" action="/" method="get" role="search">
              <input name="text" value={q} placeholder="bpc-157 lab tested under $1/mg" aria-label="Search peptide listings" autocomplete="off" />
            </form>
            <nav>
              {nav.map(([h, l]) => (
                <a href={h} class={active(h) ? 'on' : ''}>
                  {l}
                </a>
              ))}
            </nav>
          </div>
        </header>
        <main class="wrap" id="main" tabindex="-1">
          {siteAd ? <aside class="cp-ad" data-cp-ad="" data-site-ad={config.crawlproofAdSlot} aria-label="Advertisement"></aside> : null}
          {children}
        </main>
        <footer class="wrap foot">
          <p class="disclosure muted small">
            {DISCLOSURE} {PRICE_NOTE}
          </p>
          <p>
            © {config.siteName} · <a href="/methodology">How we score and price</a> · <a href="/docs">API · CLI · MCP</a> · <a href="/llms.txt">llms.txt</a> · <a href="/privacy">Privacy</a> · <a href="/privacy#choices" data-consent-reset="">Privacy choices</a> · <a href="/terms">Terms</a> · <a href={`${REPO}/issues`}>Report a correction</a> · <a href={REPO}>Source</a>
          </p>
        </footer>
        <div class="consent" id="consent" role="region" aria-label="Privacy choice" hidden>
          <p>
            Count your visit? A crawlproof.com counter and ad unit keep a random id in your browser. Nothing loads unless you allow it. <a href="/privacy">Details</a>
          </p>
          <button class="btn primary" type="button" data-consent="yes">Allow</button>
          <button class="btn" type="button" data-consent="no">No thanks</button>
        </div>
        {raw(pitFooter())}
      </body>
    </html>
  );
}
