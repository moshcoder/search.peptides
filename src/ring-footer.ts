/**
 * The << Profullstack >> webring row and the built.indie badge, from @profullstack/footer.
 * Rendered into the HTML on the server: the ring verifier and built.indie's backlink check
 * read the page and never run script.
 *
 * Pages render synchronously, so the footer is kept as a string: the bundled template at
 * boot, then the @latest template from the CDN, refreshed every 15 minutes (a footer
 * release reaches us with no redeploy). A failed refresh keeps the last good copy. Our CSP
 * allows no inline styles, so css is off and the .pfs-footer rules live in styles.css.
 */
import { footerHtml, footerHtmlSync } from '@profullstack/footer'

const OPTIONS = {
  site: 'https://search.peptides.pit.world/',
  name: 'Search Peptides',
  owner: { name: 'Search Peptides', url: 'https://search.peptides.pit.world/' },
  since: 2026,
  css: false,
  links: [
    { label: 'About', href: '/about' },
    { label: 'Contact', href: '/about#contact' },
    { label: 'Scoring rules', href: '/rules' },
    { label: 'How we price', href: '/methodology' },
    { label: 'Sponsor pricing', href: '/sponsor' },
    { label: 'Changelog', href: '/changelog' },
    { label: 'API · CLI · MCP', href: '/docs' },
    { label: 'llms.txt', href: '/llms.txt' },
    { label: 'Privacy', href: '/privacy' },
    { label: 'Terms', href: '/terms' },
    { label: 'Report a correction', href: 'https://github.com/moshcoder/search.peptides/issues' },
    { label: 'Source', href: 'https://github.com/moshcoder/search.peptides' },
  ],
  tagline: 'Independent lab testing and certificate of analysis findings; research information only.',
}

let html = footerHtmlSync(OPTIONS)

/** The footer markup, never empty. */
export function ringFooter(): string {
  return html
}

/** Accept a rendered footer only when it still links the ring. */
export function setRingFooter(next: unknown): boolean {
  if (typeof next !== 'string' || !next.includes('/ring/profullstack') || next.length > 64_000) return false
  html = next
  return true
}

export function startRingFooterRefresh(everyMs = 15 * 60_000): () => void {
  const run = () => void footerHtml(OPTIONS).then(setRingFooter, () => {})
  run()
  const timer = setInterval(run, everyMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
