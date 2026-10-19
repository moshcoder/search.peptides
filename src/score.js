import { config } from './config.js';
import { getMeta, open } from './db.js';
import { testUrl } from './finnrick.js';
import { FINNRICK } from './enrich.js';

/**
 * The verification score: 0 to 100 per vendor, from evidence we can point to. Every
 * component carries its weight, the points it earned and the evidence behind them, and
 * missing evidence earns nothing rather than a guess. /rules renders RULES; the API,
 * CLI and MCP carry the same components. Price, reviews and a vendor's own COA uploads
 * are not inputs: none of them can be checked against a sample someone else bought.
 *
 * Change a weight or a rule → bump RULES_VERSION and add a RULES_HISTORY entry; the next
 * recompute logs every vendor whose score moved, with the reason.
 */
export const RULES_VERSION = 1;
export const WINDOW_DAYS = 730;
export const MIN_TESTS = 3;
const DEPTH_FULL = 30;
// Who sent the sample, as Finnrick records it: only these two mean the vendor could not choose it.
const BLIND = /^(?:public|finnrick)$/i;
const RECENCY_STEPS = [
  [90, 1],
  [180, 2 / 3],
  [365, 1 / 3],
];

export const RULES = {
  version: RULES_VERSION,
  window_days: WINDOW_DAYS,
  min_tests: MIN_TESTS,
  components: [
    { key: 'lab', label: 'Lab results', weight: 35, rule: `Share of the vendor’s classifiable independent tests in the last ${WINDOW_DAYS / 365} years that passed Finnrick’s default criteria (identity confirmed, purity at least 99.5%, dose within 35% of the label). Points = weight × share passed.` },
    { key: 'certificates', label: 'Verifiable certificates', weight: 20, rule: 'For each test in the window, one third each for: a certificate of analysis on file with a public record page; the lab named; a lot or batch identifier on the sample. Points = weight × the average.' },
    { key: 'depth', label: 'Testing depth', weight: 10, rule: `Number of independent tests in the window, full points at ${DEPTH_FULL}. Points = weight × min(tests, ${DEPTH_FULL}) / ${DEPTH_FULL}.` },
    { key: 'recency', label: 'Recency', weight: 10, rule: 'Age of the newest test: up to 90 days full points, up to 180 days two thirds, up to a year one third, older none.' },
    { key: 'rating', label: 'Finnrick rating', weight: 15, rule: 'Finnrick’s own confidence-adjusted rating (0 to 100) under its default “Purity focus” classifier, as published. Points = weight × rating / 100.' },
    { key: 'independence', label: 'Blind sampling', weight: 5, rule: 'Share of tests in the window whose sample is recorded as bought by the public or by Finnrick, so the vendor could not pick it. Samples sent in by the vendor, or through a program the record does not explain, do not count. Points = weight × share.' },
    { key: 'terms', label: 'Ordering and terms', weight: 5, rule: 'One point each, from the vendor’s own pages: an online checkout; payment methods published; where it ships from published; a contact email; a website we could read.' },
  ],
  statuses: {
    scored: `At least ${MIN_TESTS} classifiable independent tests in the window: scored.`,
    insufficient: `Some independent tests, but fewer than ${MIN_TESTS} classifiable ones in the window: shown as “insufficient data”, no score.`,
    unscored: 'No independent tests on record: shown as “unscored”.',
  },
  not_inputs: ['Price', 'Customer reviews or forum reputation', 'Certificates the vendor posts itself (they cannot be traced to a sample someone else bought)', 'Sponsorship (it buys a labelled pin, never points)'],
};

// What changed in the rules, newest first. Every entry is also on /rules.
export const RULES_HISTORY = [{ version: 1, date: '2026-10-19', text: 'First version: seven components, 100 points, scored from Finnrick’s per-test records and ratings and the vendor’s own pages.' }];

const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 864e5);
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (n) => `${Math.round(n * 100)}%`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One vendor's score. Pure: tests are finnrick_tests rows, rating a finnrick_ratings row
 * (or null), vendor the vendors row with `contact` = { emails, websites }.
 */
export function computeScore({ tests = [], rating = null, vendor = {}, now = new Date().toISOString() }) {
  const since = new Date(Date.parse(now) - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const inWindow = tests.filter((t) => t.tested_on && t.tested_on >= since);
  const classifiable = inWindow.filter((t) => t.classifiable && (t.passed === 1 || t.passed === 0));
  const passed = classifiable.filter((t) => t.passed === 1).length;
  const newest = tests.reduce((m, t) => (t.tested_on && (!m || t.tested_on > m) ? t.tested_on : m), null);
  const W = Object.fromEntries(RULES.components.map((c) => [c.key, c]));
  const out = [];
  const add = (key, share, evidence, data = {}, ok = true) => {
    const c = W[key];
    out.push({ key, label: c.label, weight: c.weight, points: ok ? round1(c.weight * share) : 0, status: ok ? 'ok' : 'no data', evidence, data });
  };

  if (classifiable.length) add('lab', passed / classifiable.length, `${passed} of ${plural(classifiable.length, 'classifiable test')} in the window passed (${pct(passed / classifiable.length)}).`, { passed, classifiable: classifiable.length });
  else add('lab', 0, 'No classifiable independent test in the window.', { passed: 0, classifiable: 0 }, false);

  if (inWindow.length) {
    const coa = inWindow.filter((t) => t.coa).length;
    const lab = inWindow.filter((t) => t.lab_name).length;
    const lot = inWindow.filter((t) => t.batch).length;
    const share = (coa + lab + lot) / (3 * inWindow.length);
    const labs = [...new Set(inWindow.map((t) => t.lab_name).filter(Boolean))].sort();
    add('certificates', share, `Of ${plural(inWindow.length, 'test')}: ${coa} with a certificate on file, ${lab} naming the lab, ${lot} lot-specific (batch identifier).${labs.length ? ` Labs: ${labs.join(', ')}.` : ''}`, { tests: inWindow.length, coa_on_file: coa, lab_named: lab, lot_specific: lot, labs });
  } else add('certificates', 0, 'No independent test in the window, so no certificate to check.', { tests: 0 }, false);

  if (inWindow.length) add('depth', Math.min(inWindow.length, DEPTH_FULL) / DEPTH_FULL, `${plural(inWindow.length, 'independent test')} in the last ${WINDOW_DAYS / 365} years.`, { tests: inWindow.length });
  else add('depth', 0, 'No independent test in the window.', { tests: 0 }, false);

  if (newest) {
    const age = daysBetween(newest, now);
    const step = RECENCY_STEPS.find(([d]) => age <= d);
    add('recency', step ? step[1] : 0, `Newest test ${newest} (${plural(age, 'day')} ago).`, { newest, age_days: age });
  } else add('recency', 0, 'No test on record.', {}, false);

  if (rating && Number.isFinite(rating.rating)) add('rating', Math.max(0, Math.min(100, rating.rating)) / 100, `Finnrick rating ${round1(rating.rating)} (${rating.classifier ?? 'default classifier'}, ${rating.scored_on ?? 'date unknown'}).`, { rating: rating.rating, scored_on: rating.scored_on, rank: rating.rank });
  // Not "Finnrick has no rating": a vendor record not read yet looks the same as one without a rating.
  else add('rating', 0, 'No Finnrick rating on record (each vendor’s Finnrick record is re-read every 3 days).', {}, false);

  if (inWindow.length) {
    const known = inWindow.filter((t) => t.sent_by);
    const blind = known.filter((t) => BLIND.test(t.sent_by)).length;
    if (known.length) add('independence', blind / known.length, `${blind} of ${plural(known.length, 'sample')} bought by the public or Finnrick; ${known.length - blind} sent in by the vendor or another program.`, { blind, other: known.length - blind });
    else add('independence', 0, 'Who sent the samples is not recorded.', {}, false);
  } else add('independence', 0, 'No independent test in the window.', {}, false);

  const has = {
    checkout: vendor.ordering === 'checkout',
    payments: (vendor.payments?.length ?? 0) > 0,
    ships_from: (vendor.ships_from?.length ?? 0) > 0,
    email: (vendor.contact?.emails?.length ?? 0) > 0,
    website: (vendor.contact?.websites?.length ?? 0) > 0 || Boolean(vendor.shop_url),
  };
  const got = Object.values(has).filter(Boolean).length;
  const labels = { checkout: 'online checkout', payments: 'payment methods', ships_from: 'ships-from country', email: 'contact email', website: 'readable website' };
  add('terms', got / 5, got ? `Published: ${Object.keys(has).filter((k) => has[k]).map((k) => labels[k]).join(', ')}.${got < 5 ? ` Missing: ${Object.keys(has).filter((k) => !has[k]).map((k) => labels[k]).join(', ')}.` : ''}` : 'None of checkout, payment methods, ships-from, email or website found.', has, got > 0);

  const status = classifiable.length >= MIN_TESTS ? 'scored' : tests.length ? 'insufficient' : 'unscored';
  const total = Math.round(out.reduce((n, c) => n + c.points, 0));
  return {
    score: status === 'scored' ? total : null,
    status,
    note: status === 'scored' ? null : status === 'insufficient' ? `Insufficient data: ${plural(classifiable.length, 'classifiable test')} in the window, ${MIN_TESTS} needed.` : 'Unscored: no independent test on record.',
    components: out,
  };
}

/** What moved between two component lists, in words: "recency 15→10, depth 9→9.5". */
function diff(before, after) {
  const prev = new Map((before ?? []).map((c) => [c.key, c.points]));
  return after
    .filter((c) => prev.has(c.key) && prev.get(c.key) !== c.points)
    .map((c) => `${c.label.toLowerCase()} ${prev.get(c.key)}→${c.points}`)
    .join(', ');
}

const J = (s, d) => {
  try {
    return JSON.parse(s ?? 'null') ?? d;
  } catch {
    return d;
  }
};

/**
 * Score every vendor from what the database holds now, store the result and log every
 * change of score or status. Cheap (one pass over ~12k tests), so the daemon runs it after
 * any task that changed data and on its own every few hours, as test ages move recency.
 */
export function recomputeScores({ now = new Date().toISOString() } = {}) {
  const db = open();
  const tests = new Map();
  for (const t of db.query('SELECT * FROM finnrick_tests').all()) (tests.get(t.vendor) ?? tests.set(t.vendor, []).get(t.vendor)).push(t);
  const ratings = new Map(db.query('SELECT * FROM finnrick_ratings').all().map((r) => [r.vendor, r]));
  const contacts = new Map();
  for (const c of db.query("SELECT vendor, kind, value FROM vendor_contacts WHERE kind IN ('email', 'website')").all()) {
    const card = contacts.get(c.vendor) ?? contacts.set(c.vendor, { emails: [], websites: [] }).get(c.vendor);
    (c.kind === 'email' ? card.emails : card.websites).push(c.value);
  }
  const held = new Map(db.query('SELECT * FROM vendor_scores').all().map((r) => [r.vendor, r]));
  const testsAt = getMeta('finnrick_tests_at');
  const put = db.query('INSERT OR REPLACE INTO vendor_scores (vendor, score, status, rules_version, components, computed_at, verified_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const log = db.query('INSERT INTO score_log (vendor, at, old_score, new_score, old_status, new_status, rules_version, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let changed = 0;
  const counts = { scored: 0, insufficient: 0, unscored: 0 };
  db.transaction(() => {
    for (const v of db.query('SELECT slug, ordering, payments, ships_from, shop_url FROM vendors').all()) {
      const vt = tests.get(v.slug) ?? [];
      const rating = ratings.get(v.slug) ?? null;
      const r = computeScore({ tests: vt, rating, vendor: { ...v, payments: J(v.payments, []), ships_from: J(v.ships_from, []), contact: contacts.get(v.slug) }, now });
      counts[r.status]++;
      // Last verified: when the evidence this score rests on was last read from its source.
      const verified = [vt.length ? testsAt : null, rating?.seen_at].filter(Boolean).sort().at(-1) ?? null;
      const prev = held.get(v.slug);
      const moved = !prev || prev.score !== r.score || prev.status !== r.status;
      const moves = prev ? diff(J(prev.components, {}).components, r.components) : '';
      const why = !prev ? `first ${r.status === 'scored' ? 'score' : 'assessment'} under rules v${RULES_VERSION}` : prev.rules_version !== RULES_VERSION ? `rules v${prev.rules_version}→v${RULES_VERSION}${moves ? `: ${moves}` : ''}` : moves || 'evidence changed';
      put.run(v.slug, r.score, r.status, RULES_VERSION, JSON.stringify({ note: r.note, components: r.components }), now, verified, moved ? now : prev.changed_at);
      if (moved) {
        changed++;
        // A first assessment of a vendor with no evidence is not news; the log keeps scores.
        if (prev || r.status !== 'unscored') log.run(v.slug, now, prev?.score ?? null, r.score, prev?.status ?? null, r.status, RULES_VERSION, why);
      }
    }
  })();
  return { ...counts, changed };
}

/** A vendor_scores row → the `verification` object every surface carries. */
export function verificationOf(row, slug) {
  if (!row) return { score: null, status: 'unscored', note: 'Not assessed yet.', rules_version: RULES_VERSION, rules: `${config.siteUrl}/rules`, components: [], computed_at: null, verified_at: null, changed_at: null, evidence: `${FINNRICK}/vendors/${slug}` };
  const body = J(row.components, {});
  return {
    score: row.score,
    status: row.status,
    note: body.note ?? null,
    rules_version: row.rules_version,
    rules: `${config.siteUrl}/rules`,
    computed_at: row.computed_at,
    verified_at: row.verified_at,
    changed_at: row.changed_at,
    evidence: `${FINNRICK}/vendors/${slug}`,
    components: body.components ?? [],
  };
}

/** The score's history for one vendor, newest first, plus its tests with their record links. */
export function scoreHistory(slug, limit = 30) {
  return open().query('SELECT at, old_score, new_score, old_status, new_status, rules_version, why FROM score_log WHERE vendor = ? ORDER BY at DESC, id DESC LIMIT ?').all(slug, limit);
}

export function vendorTests(slug) {
  return open()
    .query('SELECT record_id, peptide, peptide_slug, tested_on, classifiable, passed, reasons, purity, deviation, identity, batch, lab_name, coa, sent_by FROM finnrick_tests WHERE vendor = ? ORDER BY tested_on DESC, record_id')
    .all(slug)
    .map((t) => ({ ...t, classifiable: !!t.classifiable, passed: t.passed === null ? null : !!t.passed, coa: !!t.coa, reasons: J(t.reasons, []), record: testUrl(t.record_id) }));
}

/** Score changes across every vendor, newest first: the update history on /rules. */
export function recentScoreChanges(limit = 50) {
  return open().query('SELECT l.vendor, v.name, l.at, l.old_score, l.new_score, l.old_status, l.new_status, l.why FROM score_log l LEFT JOIN vendors v ON v.slug = l.vendor ORDER BY l.at DESC, l.id DESC LIMIT ?').all(limit);
}
