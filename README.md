# search.peptides

Every research-peptide vendor and listing, compared: ~20,000 listings from ~240 vendors across ~770 peptides, ranked by USD per mg, with independent lab results for ~460 vendors and each vendor's contact details (email, phone, WhatsApp, Telegram, socials, websites).

- Web: https://search.peptides.pit.world (on Moshpit DNS: https://search.peptides)
- Faceted search, the r4ck.dev/servers rail: peptide, price per mg, price, vial size, lab testing, verification score, Finnrick rating, payment, ships from, form, single or blend, how you order, vendor. Every count is exact and every option is a link.
- API, no key: `/api/v1/search`, `/api/v1/vendors`, `/api/v1/vendors/:slug`, `/api/v1/peptides`, `/api/v1/peptides/:slug`, `/api/v1/rules`, `/api/v1/export`
- MCP: `POST /mcp` or `bunx searchpeptides mcp` (tools `search_listings`, `search_vendors`, `get_vendor`, `get_peptide`, `list_peptides`, `get_rules`)
- CLI and TUI: `bunx searchpeptides search "retatrutide lab tested under $1/mg"`, `… vendors --contact email`, `… vendor <slug>`, `… rules`, `… tui`
- Mirrored to https://nichedb.dev/c/peptides

## Verification score

Every vendor gets a 0-100 verification score computed in `src/score.js` from evidence that can be checked: Finnrick's per-test records (pass/fail, lab named, certificate on file with a public record page, lot/batch identifier, who sent the sample), Finnrick's own rating, and the vendor's published terms. Price, reviews and certificates a vendor posts itself are not inputs. Fewer than 3 classifiable tests in two years shows "insufficient data", none shows "unscored"; nothing is guessed. Weights, rules and every score change: `/rules` (`/api/v1/rules`, `peptides rules`, MCP `get_rules`). The score is recomputed after every daemon update and every 6 h; each change goes to `score_log` with its reason. Change a rule: bump `RULES_VERSION` and add a `RULES_HISTORY` entry.

Scores and test counts come from Finnrick's independent lab testing; COA findings are from documents the vendor publishes. Not affiliated with Finnrick or any vendor. For research use; not medical advice.

## Data

Kept fresh by the updater daemon, [`@profullstack/scraper-daemon`](https://github.com/profullstack/scraper-daemon) (the same package ch4nnels.com, r4ck.dev, rssamplifier.com and p0dcasters.com run), in `src/daemon.js`, as the `worker` role of the one process. State lives in the same SQLite file; `/api/v1/daemon` shows it.

| task | kind | every | what |
| --- | --- | --- | --- |
| `register` | job | 1 h | the public price/lab register: column-packed listings decoded, referral parameters and the source's own coupon codes stripped, register rows replaced in one transaction (a document under half the size held is refused) |
| `discover` | job | 6 h | Finnrick's public vendor list: vendors the register lacks are added (origin `finnrick`); register syncs never remove them |
| `finnrick-vendors` | queue | 3 d per vendor | each vendor's Finnrick record: the emails and websites it vouches for, and its Finnrick rating (was `finnrick-contacts`) |
| `finnrick-tests` | job | 1 d | every independent test record from Finnrick's public `/api/v1/tests` (~125 pages): lab, certificate, batch, sample source, pass/fail; a read under 90% of what is held is refused |
| `scores` | job | 6 h | recompute every verification score (tests age, so recency moves) and log changes |
| `shop-prices` | queue | 1 d per vendor | each vendor's own WooCommerce or Shopify catalogue |
| `site-contacts` | queue | 7 d per vendor | each vendor's own site (homepage, contact and about pages) for emails, phones and socials |

Fetching goes through the package: robots.txt, one request at a time per host, public addresses only, every redirect re-checked, 429 holds the host. `peptides daemon run <task> [vendor]` runs one task by hand; `data/snapshot.json.gz` seeds a fresh install offline.

## Run

```sh
bun install
bun src/main.js            # :8802, loads the snapshot on first boot, then syncs and enriches
bun test
```

## Deploy (dev2)

`/opt/search.peptides`, unit `search-peptides`, port 8802, `bin/install.sh` (OpenInstall). app.env at `/root/.local/share/search-peptides/app.env` from vault `profullstack/search-peptides--prod`. Every merge to main deploys through the forced command `deploy/search-peptides-deploy`; `deploy/after-checkout.sh` takes an online copy of the database first (`~anthony/Backups/root-db/search-peptides/search-peptides-predeploy-*.sqlite.gz`, newest 5). Moshpit origin vhost: `deploy/nginx-search.peptides.conf`, installed as `/etc/moshpit/templates/search.peptides.conf`.

Sponsored placement ($49 / 30 days, CoinPay) is the one thing for sale; sponsored vendors are always labelled.

MIT.
