/**
 * Faceted drill-down, the r4ck.dev/servers pattern, for registers small
 * enough to filter in memory.
 *
 * A facet is a group of options; each option is a patch of filter params
 * ({ resolution: '4K' }, { min_price: 5, max_price: 10 }). The count next to
 * an option is how many results the search would return with that patch
 * applied on top of every other active filter, so a click never lands on an
 * empty page and a zero is never offered. Within an exclusive group the
 * group's own params are lifted first, so sibling options read as "switch to
 * this" rather than all showing zero. Options in an `independent` group (a
 * row of yes/no switches) each stand alone.
 *
 * `count(filters)` is supplied by the caller and runs its real matcher, so a
 * count can never disagree with the results the link leads to.
 */
export function buildFacets(defs, filters, count, toParams) {
  const out = [];
  for (const def of defs) {
    const groupKeys = def.params ?? [...new Set(def.options.flatMap((o) => Object.keys(o.set)))];
    const options = [];
    for (const o of def.options) {
      const keys = def.independent ? Object.keys(o.set) : groupKeys;
      const active = isActive(filters, o.set, def.independent ? Object.keys(o.set) : groupKeys);
      const base = omit(filters, [...keys, 'page', 'offset']);
      const next = active ? base : { ...base, ...o.set };
      const n = count({ ...base, ...o.set });
      if (!n && !active) continue;
      options.push({ key: o.key, label: o.label, count: n, active, query: toParams(next).toString() });
    }
    if (!options.length) continue;
    if (def.sort === 'count') options.sort((a, b) => b.active - a.active || b.count - a.count || a.label.localeCompare(b.label));
    if (def.limit && options.length > def.limit) options.length = def.limit;
    // A single option that is not chosen narrows nothing: every result already has it.
    if (options.length === 1 && !options[0].active && !def.keepSingle && options[0].count === count(omit(filters, groupKeys))) continue;
    out.push({ name: def.name, label: def.label, open: def.open ?? false, options });
  }
  return out;
}

/** Active filters as removable chips: each one links to the same search without it. */
export function activeChips(facets, filters, toParams, extra = []) {
  const chips = [];
  for (const f of facets) for (const o of f.options) if (o.active) chips.push({ label: o.label, query: o.query });
  for (const e of extra) if (filters[e.param] !== undefined && filters[e.param] !== '') chips.push({ label: e.label(filters[e.param]), query: toParams(omit(filters, [e.param, 'page'])).toString() });
  return chips;
}

/**
 * A price the buckets cannot show ("under €12", "under $10": buckets are fixed
 * EUR ranges) still gets a chip, so every filter in force is visible and removable.
 */
export function priceChip(f, facets, toParams) {
  if (f.max_price === undefined && f.min_price === undefined) return null;
  if (facets.some((g) => g.name === 'price' && g.options.some((o) => o.active))) return null;
  const cur = f.currency ? ` ${f.currency}` : '';
  const sym = f.currency ? '' : '€';
  const label = f.min_price !== undefined && f.max_price !== undefined ? `${sym}${f.min_price} to ${sym}${f.max_price}${cur}/mo` : f.max_price !== undefined ? `under ${sym}${f.max_price}${cur}/mo` : `${sym}${f.min_price}${cur}/mo or more`;
  return { label, query: toParams(omit(f, ['min_price', 'max_price', 'currency', 'page'])).toString() };
}

function isActive(filters, set, keys) {
  for (const k of keys) {
    const want = set[k];
    const have = filters[k];
    if (want === undefined) {
      if (have !== undefined && have !== '' && have !== false) return false;
    } else if (String(have) !== String(want)) return false;
  }
  return true;
}

export function omit(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

/** Price buckets per month, as min/max patches. The last is open-ended. */
export function priceOptions(edges, sym = '€') {
  const opts = [{ key: 'free', label: 'Free', set: { max_price: 0 } }];
  let lo = 0;
  for (const hi of edges) {
    opts.push({ key: `${lo}-${hi}`, label: lo ? `${sym}${lo} to ${sym}${hi}` : `under ${sym}${hi}`, set: lo ? { min_price: lo, max_price: hi } : { max_price: hi } });
    lo = hi;
  }
  opts.push({ key: `${lo}+`, label: `${sym}${lo} or more`, set: { min_price: lo } });
  return opts;
}
