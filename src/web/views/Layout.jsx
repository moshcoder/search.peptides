import { raw } from 'hono/html';
import { readFileSync } from 'node:fs';
import { config } from '../../config.js';
import { DISCLOSURE, PRICE_NOTE } from '../../service.js';
import { pitFooter } from '../../pit-footer.ts';

// The stylesheet is cached for an hour; a content hash in its URL means a deploy never pairs new markup with old CSS.
const CSS_VERSION = Bun.hash(readFileSync(new URL('../../../public/styles.css', import.meta.url))).toString(36);

/** The one HTML shell: dark ground, phosphor accent, sticky search bar, the Moshpit ring bar on top. */
export function Layout({ title, description, path = '/', jsonld, children, q = '', noindex = false }) {
  const full = title ? `${title} · ${config.siteName}` : `${config.siteName}: every research peptide vendor, compared`;
  const desc = description ?? 'Every research-peptide vendor and listing, compared by price per mg, independent lab results, payment and where it ships from, with each vendor’s contact details. Same search on the page, the API, the CLI and MCP.';
  const nav = [
    ['/', 'Listings'],
    ['/vendors', 'Vendors'],
    ['/peptides', 'Peptides'],
    ['/sponsor', 'Sponsor'],
    ['/docs', 'API · CLI · MCP'],
  ];
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
        <link rel="canonical" href={`${config.siteUrl}${path}`} />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="preload" href="/fonts/Geist.woff2" as="font" type="font/woff2" crossorigin="" />
        <link rel="stylesheet" href={`/styles.css?v=${CSS_VERSION}`} />
        <link rel="alternate" type="application/json" href={`${config.siteUrl}/api/v1/search`} title="Search API" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content={config.siteName} />
        <meta property="og:title" content={full} />
        <meta property="og:description" content={desc} />
        <meta name="twitter:card" content="summary" />
        {jsonld ? <script type="application/ld+json">{raw(JSON.stringify(jsonld).replace(/</g, '\\u003c'))}</script> : null}
        {config.crawlproofSite ? <script data-site={config.crawlproofSite} src="https://crawlproof.com/stats.js" async></script> : null}
      </head>
      <body>
        {raw('<!--ring-bar-->')}
        <header class="top">
          <div class="wrap top-in">
            <a class="brand" href="/">
              <span class="logo">⌬</span> {config.siteName}
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
        <main class="wrap">
          {config.crawlproofAdSlot && !path.startsWith('/sponsor') ? (
            <>
              <aside class="cp-ad" data-cp-ad="" aria-label="Advertisement"></aside>
              <script>
                {raw(
                  `(function(){var e=document.currentScript.previousElementSibling;e.setAttribute('data-format',matchMedia('(min-width: 760px)').matches?'banner_728x90':'banner_300x250');e.setAttribute('data-slot',${JSON.stringify(config.crawlproofAdSlot)});var n=0;(function t(){if(window.crawlproofAds){window.crawlproofAds.scan();}else if(++n<20){setTimeout(t,250);}})();})();`,
                )}
              </script>
              <script src="https://crawlproof.com/ad.js" defer></script>
            </>
          ) : null}
          {children}
        </main>
        <footer class="wrap foot">
          <p class="disclosure muted small">
            {DISCLOSURE} {PRICE_NOTE}
          </p>
          <p>
            © {config.siteName} · <a href="/docs">API · CLI · MCP</a> · <a href="/llms.txt">llms.txt</a> · <a href="https://github.com/moshcoder/search.peptides">Source</a>
          </p>
        </footer>
        {raw(pitFooter())}
      </body>
    </html>
  );
}
