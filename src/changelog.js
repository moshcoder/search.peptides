/**
 * What changed on the site, newest first, in the words a visitor needs. /changelog renders it;
 * add an entry with any change a visitor would notice. `pr` links to the pull request.
 */
export const CHANGELOG = [
  { date: '2026-10-19', pr: 22, title: 'A verification score, and the rules behind it', text: 'Every vendor now has a 0 to 100 verification score built only from evidence you can check: independent test results, whether each certificate names its lab, is lot-specific and has a public record, how many tests and how recent, blind sampling, Finnrick’s rating and the vendor’s published terms. Vendors without enough evidence say “insufficient data” instead of getting a number. The new Rules page has the criteria, the formula and its weights, the sources and how often they are read, and every score change; each vendor page shows its components, evidence, last-verified date and score history.' },
  { date: '2026-10-19', pr: 20, title: 'Faster under load, a changelog, PubMed links', text: 'Pages are served by several processes at once, so a crawl over every filter no longer slows the site down. Each peptide page links to its PubMed research, and this changelog started.' },
  { date: '2026-10-19', pr: 19, title: 'One address per page', text: 'An address ending in a slash now goes to the page without it instead of “not found”.' },
  { date: '2026-10-19', pr: 18, title: 'Dates, and the CLI on npm', text: 'Pages say when prices were last checked. `bunx searchpeptides` now installs the command-line tool from npm.' },
  { date: '2026-10-19', pr: 15, title: 'Ten times faster filters, an About page', text: 'Filter counts are worked out from an index instead of scanning every listing. Choosing another peptide from a peptide page goes to that peptide’s own page. New: About.' },
  { date: '2026-10-19', pr: 17, title: 'Better pack sizes', text: 'A pack label is read as a pack, so price per mg is not inflated by counting the pack total twice; NAD+ is no longer taken for a blend.' },
  { date: '2026-10-19', pr: 16, title: 'Supplies left out of shop prices', text: 'Bacteriostatic water, syringes and other supplies read from a vendor’s shop no longer show up as peptide listings.' },
  { date: '2026-10-19', pr: 12, title: 'Privacy choice before any counter or ad', text: 'Nothing from a third party loads until you allow it on the privacy bar, and a browser sending Global Privacy Control is never asked. The page runs under a strict content-security policy.' },
  { date: '2026-10-19', pr: 11, title: 'Prices from each vendor’s own shop', text: 'Prices are read straight from each vendor’s storefront where it has one, so they match what the shop charges today.' },
  { date: '2026-10-19', pr: 10, title: 'Methodology, privacy and terms', text: 'How we score and price, what we collect and the terms of use are written down. Each peptide page answers the common questions: the cheapest per mg, who passed a lab test, how many vendors sell it.' },
  { date: '2026-10-19', pr: 2, title: 'Always up to date', text: 'Prices and lab results are re-read every hour, new vendors are looked for every six hours, and contact details are refreshed weekly.' },
  { date: '2026-10-19', pr: 1, title: 'Launch', text: 'search.peptides opens: every research-peptide vendor and listing, ranked by price per mg, with independent lab results, payment, shipping and contact details. The same search as an API, CLI, TUI and MCP server.' },
];
