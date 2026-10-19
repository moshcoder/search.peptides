import { countryName, PAYMENT_LABELS } from '../../core/normalize.js';
import { CONTACT_LABELS } from '../../service.js';

export const usd = (n) => (Number.isFinite(n) ? `$${n < 10 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0)}` : '—');
export const perMg = (o) => (o.unit === 'mg' && Number.isFinite(o.usd_per_mg) ? `$${o.usd_per_mg < 1 ? o.usd_per_mg.toFixed(3) : o.usd_per_mg.toFixed(2)}/mg` : o.unit && Number.isFinite(o.usd_per_mg) ? `$${o.usd_per_mg.toFixed(2)}/${o.unit}` : '—');
export const size = (o) => (Number.isFinite(o.amount) ? `${+o.amount.toFixed(2)} ${o.unit ?? ''}${o.pack_qty > 1 ? ` × ${o.pack_qty}` : ''}` : '—');
export const ORDERING = { checkout: 'Online checkout', message: 'Order by message', marketplace: 'Marketplace', login: 'Members only' };

export function Chips({ items }) {
  return <span class="chips">{items.filter(Boolean).map((t) => <span class="chip">{t}</span>)}</span>;
}

export const scoreText = (v) => (Number.isFinite(v.score) ? `${v.score}/100` : 'unscored');
export const passText = (v) => (v.tests_pass + v.tests_fail ? `${v.tests_pass}/${v.tests_pass + v.tests_fail} passed` : 'no lab tests');

/** One listing: a row on a wide screen, a card on a phone. Nothing scrolls sideways. */
export function OfferRow({ o, sponsored = false }) {
  const spec = (label, value, extra) => (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {extra ? <span class="muted"> {extra}</span> : null}
      </dd>
    </div>
  );
  return (
    <article class={`sb${sponsored ? ' sponsored' : ''}`}>
      <div class="sb-name">
        {sponsored ? <span class="tag">Sponsored</span> : null}
        <a href={`/p/${o.peptide_slug}`}>{o.name ?? o.peptide}</a>
        <span class="muted small">
          <a href={`/v/${o.vendor}`}>{o.vendor_name}</a>
          {o.passed_test ? ' · ✓ passed a lab test for this' : ''}
          {o.blend ? ` · blend of ${o.blend.length}` : ''}
          {o.in_stock === false ? ' · out of stock' : ''}
        </span>
      </div>
      <dl class="sb-specs">
        {spec('Size', size(o), o.form && o.form !== 'vial' ? o.form : null)}
        {spec('Vendor score', Number.isFinite(o.vendor_score) ? o.vendor_score : '—')}
        {spec('Lab tests', o.vendor_tests || '—')}
        {spec('Price', usd(o.price_usd), o.currency && o.currency !== 'USD' ? `${o.price} ${o.currency}` : null)}
      </dl>
      <div class="sb-price">
        <b>{perMg(o)}</b>
        {o.url ? (
          <a class="small" href={o.url} rel="nofollow noopener" target="_blank">
            vendor page ↗
          </a>
        ) : null}
      </div>
    </article>
  );
}

export function VendorRow({ v }) {
  const spec = (label, value) => (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  const reach = [v.contact.emails.length ? 'email' : null, v.contact.phones.length ? 'phone' : null, ...Object.keys(v.contact.socials)].filter(Boolean);
  return (
    <article class={`sb${v.sponsored ? ' sponsored' : ''}`}>
      <div class="sb-name">
        {v.sponsored ? <span class="tag">Sponsored</span> : null}
        <a href={`/v/${v.slug}`}>{v.name}</a>
        <span class="muted small">
          {v.ships_from.length ? `ships from ${v.ships_from.map(countryName).join(', ')}` : (v.location ?? 'location unknown')}
          {reach.length ? ` · contact: ${reach.map((k) => CONTACT_LABELS[k] ?? k).join(', ')}` : ''}
        </span>
      </div>
      <dl class="sb-specs">
        {spec('Score', scoreText(v))}
        {spec('Lab', passText(v))}
        {spec('Listings', v.offers || '—')}
        {spec('Pay', v.payments.map((p) => PAYMENT_LABELS[p] ?? p).join(', ') || '—')}
      </dl>
      <div class="sb-price">
        <b>{Number.isFinite(v.min_usd_per_mg) ? `from $${v.min_usd_per_mg.toFixed(v.min_usd_per_mg < 1 ? 3 : 2)}/mg` : '—'}</b>
        <span class="muted small">{ORDERING[v.ordering] ?? ''}</span>
      </div>
    </article>
  );
}

/** Every way to reach a vendor, each one a link. */
export function ContactCard({ c }) {
  const rows = [];
  for (const e of c.emails) rows.push(['Email', <a href={`mailto:${e}`}>{e}</a>]);
  for (const p of c.phones) rows.push(['Phone', <a href={`tel:${p}`}>{p}</a>]);
  for (const w of c.websites) rows.push(['Website', <a href={w} rel="nofollow noopener" target="_blank">{w.replace(/^https?:\/\//, '')}</a>]);
  for (const [k, list] of Object.entries(c.socials)) for (const u of list) rows.push([CONTACT_LABELS[k] ?? k, <a href={u} rel="nofollow noopener" target="_blank">{u.replace(/^https?:\/\/(www\.)?/, '')}</a>]);
  if (!rows.length) return <p class="muted">No contact details found on the vendor’s own pages.</p>;
  return (
    <dl class="facts contact">
      {rows.map(([k, v]) => (
        <div>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const href = (base, query) => (query ? `${base}?${query}` : base);

/** The drill-down rail, the r4ck.dev/servers pattern: every option is a link with the count it leads to. */
export function FacetRail({ facets, base, total }) {
  const item = (o) => (
    <li>
      <a class={`facet-item${o.active ? ' on' : ''}`} href={href(base, o.query)} rel="nofollow">
        <span class="facet-check" aria-hidden="true"></span>
        <span class="facet-label">{o.label}</span>
        <span class="facet-count">{o.count}</span>
      </a>
    </li>
  );
  return (
    <aside class="facets" id="facets">
      <div class="facets-head">
        <h2>Narrow it down</h2>
      </div>
      {facets.map((g) => {
        // Long lists show the first few; the rest fold away rather than scrolling inside the rail.
        const shown = g.options.slice(0, FOLD);
        const rest = g.options.slice(FOLD);
        return (
          <details class="facet-group" open={g.open || g.options.some((o) => o.active)}>
            <summary>{g.label}</summary>
            <ul>{shown.map(item)}</ul>
            {rest.length ? (
              <details class="facet-more">
                <summary>Show {rest.length} more</summary>
                <ul>{rest.map(item)}</ul>
              </details>
            ) : null}
          </details>
        );
      })}
      <a class="btn primary facets-close" href="#" data-close-facets>
        Show {total} {total === 1 ? 'result' : 'results'}
      </a>
    </aside>
  );
}
const FOLD = 8;

/** What is applied, each one a link to the same search without it. */
export function ActiveChips({ chips, base }) {
  if (!chips?.length) return null;
  return (
    <ul class="active-chips" aria-label="Active filters">
      {chips.map((c) => (
        <li>
          <a class="achip on" href={href(base, c.query)} title="Remove">
            {c.label} <span aria-hidden="true">×</span>
          </a>
        </li>
      ))}
      <li>
        <a class="achip clear" href={base}>
          Clear all
        </a>
      </li>
    </ul>
  );
}

/** Count, sort and (on a phone) the button that opens the rail as a drawer. */
export function ResultsHead({ title, base, params, sorts, sort, h1 = true }) {
  return (
    <header class="results-head">
      {h1 ? <h1 class="h-results">{title}</h1> : <h2 class="h-results">{title}</h2>}
      <form class="sort-form" method="get" action={base}>
        {[...params].filter(([k]) => k !== 'sort' && k !== 'page').map(([k, v]) => <input type="hidden" name={k} value={v} />)}
        {/* public/app.js applies a mouse pick at once and a keyboard pick on Enter or blur, so arrowing through never submits. */}
        <select name="sort" aria-label="Sort by">
          {sorts.map(([v, label]) => (
            <option value={v} selected={(sort ?? '') === v}>
              {label}
            </option>
          ))}
        </select>
        <noscript>
          <button class="btn" type="submit">Sort</button>
        </noscript>
        <button type="button" class="btn ghost filter-button" data-open-facets>
          Filters
        </button>
      </form>
    </header>
  );
}

/** Previous / next, keeping every filter. */
export function Pager({ base, params, page, pages }) {
  if (pages <= 1) return null;
  const at = (n) => {
    const p = new URLSearchParams(params);
    if (n > 1) p.set('page', String(n));
    else p.delete('page');
    return href(base, p.toString());
  };
  return (
    <nav class="pager" aria-label="Pages">
      {page > 1 ? <a class="btn" href={at(page - 1)} rel="prev">← Previous</a> : null}
      <span class="muted">
        Page {page} of {pages}
      </span>
      {page < pages ? <a class="btn" href={at(page + 1)} rel="next">Next →</a> : null}
    </nav>
  );
}
