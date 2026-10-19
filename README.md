# search.peptides

Every research-peptide vendor and listing, compared: ~20,000 listings from ~240 vendors across ~770 peptides, ranked by USD per mg, with independent lab results for ~460 vendors and each vendor's contact details (email, phone, WhatsApp, Telegram, socials, websites).

- Web: https://search.peptides.pit.world (on Moshpit DNS: https://search.peptides)
- Faceted search, the r4ck.dev/servers rail: peptide, price per mg, price, vial size, lab testing, vendor score, payment, ships from, form, single or blend, how you order, vendor. Every count is exact and every option is a link.
- API, no key: `/api/v1/search`, `/api/v1/vendors`, `/api/v1/vendors/:slug`, `/api/v1/peptides`, `/api/v1/peptides/:slug`, `/api/v1/export`
- MCP: `POST /mcp` or `bunx searchpeptides mcp` (tools `search_listings`, `search_vendors`, `get_vendor`, `get_peptide`, `list_peptides`)
- CLI and TUI: `bunx searchpeptides search "retatrutide lab tested under $1/mg"`, `… vendors --contact email`, `… vendor <slug>`, `… tui`
- Mirrored to https://nichedb.dev/c/peptides

Scores and test counts come from Finnrick's independent lab testing; COA findings are from documents the vendor publishes. Not affiliated with Finnrick or any vendor. For research use; not medical advice.

## Data

- `src/sync.js` reads the public register (`SOURCE_URL`, daily), decodes its column-packed listings, strips referral parameters and the source's own coupon codes, and replaces the tables in one transaction. A document with under half the vendors already held is refused. `data/snapshot.json.gz` seeds a fresh install offline.
- `src/enrich.js` reads each vendor's own site (homepage, contact and about pages; robots.txt honoured; public addresses only, every redirect re-checked) for emails, phones and social accounts. Weekly; `bun src/enrich.js [--vendor slug]` by hand.

## Run

```sh
bun install
bun src/main.js            # :8802, loads the snapshot on first boot, then syncs and enriches
bun test
```

## Deploy (dev2)

`/opt/search.peptides`, unit `search-peptides`, port 8802, `bin/install.sh` (OpenInstall). app.env at `/root/.local/share/search-peptides/app.env` from vault `profullstack/search-peptides--prod`. Every merge to main deploys through the forced command `deploy/search-peptides-deploy`. Moshpit origin vhost: `deploy/nginx-search.peptides.conf`, installed as `/etc/moshpit/templates/search.peptides.conf`.

Sponsored placement ($49 / 30 days, CoinPay) is the one thing for sale; sponsored vendors are always labelled.

MIT.
