import { open, setMeta } from './db.js';
import { FINNRICK } from './enrich.js';
import { slugify } from './core/normalize.js';

/**
 * Finnrick's per-test records and per-vendor ratings: the evidence the verification
 * score (src/score.js) is computed from. Both come from Finnrick's public v1 read API
 * (robots.txt allows /api/v1/ for every crawler):
 *
 *   /api/v1/tests?page=N    every independent test, newest first, 100 a page: lab, certificate
 *                           on file, batch identifier, who sent the sample, pass/fail under
 *                           Finnrick's default "Purity focus" criteria
 *   /api/v1/vendors/<slug>  each vendor's record: its current Finnrick rating, read with its
 *                           contacts by the finnrick-vendors queue
 *
 * A test's public record is FINNRICK/tests/<record_id>, which redirects to its certificate page.
 */
export const testUrl = (id) => `${FINNRICK}/tests/${encodeURIComponent(id)}`;
const PAGE_SIZE = 100;

// "N/A", "-", "unknown", "none" are a label that says there is no batch, not a batch.
const NO_BATCH = /^(?:n\/?a|none|unknown|not (?:listed|stated|provided|available)|no batch|-+|\?+|0+)$/i;
export const batchOf = (s) => {
  const b = String(s ?? '').trim();
  return b && !NO_BATCH.test(b) ? b : null;
};

const bool = (v) => (v === true ? 1 : v === false ? 0 : null);

/** One /api/v1/tests item → a finnrick_tests row. Pure. */
export function testRow(t, seenAt) {
  if (!t?.record_id || !t.vendor_slug) return null;
  const peptide = [t.product_name, t.product_variant].filter(Boolean).join(' ') || null;
  return {
    record_id: String(t.record_id),
    vendor: String(t.vendor_slug),
    peptide,
    peptide_slug: t.product_slug ? String(t.product_slug) : peptide ? slugify(peptide) : null,
    tested_on: /^\d{4}-\d{2}-\d{2}/.test(t.test_date ?? '') ? t.test_date.slice(0, 10) : null,
    classifiable: bool(t.safety_classifiable) ?? 0,
    passed: bool(t.safety_passed),
    reasons: JSON.stringify(Array.isArray(t.safety_reasons) ? t.safety_reasons : []),
    purity: t.purity_label ?? null,
    deviation: t.dosage_deviation_label ?? null,
    identity: t.identity_result ?? null,
    test_type: t.test_type ?? null,
    batch: batchOf(t.batch_identifier),
    lab_name: t.lab_name ? String(t.lab_name).trim() || null : null,
    lab_code: t.lab_code ?? null,
    coa: t.coa_available === true ? 1 : 0,
    sent_by: t.sent_by ?? null,
    label: t.label_details ?? null,
    seen_at: seenAt,
  };
}

/** Every page of the tests feed. Stops at the reported total or a short page. */
export async function readTests(fetcher, { signal, pageSize = PAGE_SIZE, maxPages = 1000 } = {}) {
  const seenAt = new Date().toISOString();
  const rows = [];
  let total = null;
  for (let page = 1; page <= maxPages; page++) {
    const doc = await fetcher.json(`${FINNRICK}/api/v1/tests?page=${page}&page_size=${pageSize}`, { signal });
    const items = Array.isArray(doc?.items) ? doc.items : [];
    total ??= Number.isFinite(doc?.total) ? doc.total : null;
    for (const t of items) {
      const r = testRow(t, seenAt);
      if (r) rows.push(r);
    }
    const size = Number.isFinite(doc?.page_size) ? doc.page_size : pageSize;
    if (items.length < size || (total !== null && page * size >= total)) break;
  }
  // Newest first and paged: a record added mid-read shifts the pages, so one can be read twice.
  const unique = [...new Map(rows.map((r) => [r.record_id, r])).values()];
  return { rows: unique, total, seenAt };
}

const TEST_COLS = ['record_id', 'vendor', 'peptide', 'peptide_slug', 'tested_on', 'classifiable', 'passed', 'reasons', 'purity', 'deviation', 'identity', 'test_type', 'batch', 'lab_name', 'lab_code', 'coa', 'sent_by', 'label', 'seen_at'];

/**
 * Replace the held tests with a fresh read, in one transaction. A read with less than
 * 90% of the records we hold is refused: Finnrick does not delete tests, so a short
 * read is a broken read and the old evidence stays.
 */
export function saveTests({ rows, seenAt }, { force = false } = {}) {
  const db = open();
  const have = db.query('SELECT count(*) n FROM finnrick_tests').get().n;
  if (!force && have && rows.length < have * 0.9) throw new Error(`refusing a read of ${rows.length} Finnrick tests over the ${have} we hold`);
  const put = db.query(`INSERT INTO finnrick_tests (${TEST_COLS.join(', ')}) VALUES (${TEST_COLS.map(() => '?').join(', ')})`);
  db.transaction(() => {
    db.exec('DELETE FROM finnrick_tests');
    for (const r of rows) put.run(...TEST_COLS.map((k) => r[k] ?? null));
  })();
  setMeta('finnrick_tests_at', seenAt);
  return { tests: rows.length, vendors: new Set(rows.map((r) => r.vendor)).size };
}

/**
 * A vendor's own record (/api/v1/vendors/<slug>, read by the finnrick-vendors queue for its
 * contacts too) → its rating row under Finnrick's default classifier, or null when unrated.
 * The vendor list carries ratings for its top 20 only, so the record is the one source for all.
 */
export function ratingFromRecord(doc, seenAt = new Date().toISOString()) {
  const ts = doc?.total_score;
  const e = ts?.entry;
  const slug = e?.vendor_slug ?? doc?.vendor?.slug;
  if (!slug || !Number.isFinite(e?.stat_percent)) return null;
  const num = (n) => (Number.isFinite(n) ? n : null);
  const dated = (e.rating_history ?? []).map((h) => h?.test_date).filter(Boolean).sort();
  return {
    vendor: String(slug),
    rating: e.stat_percent,
    observed: num(e.stat_observed_percent),
    classifiable: num(e.stat_classifiable_count),
    pass: num(e.stat_pass_count),
    fail: num(e.stat_fail_count),
    rank: num(e.rank) || null,
    classifier: ts.classifier_label ?? ts.classifier_key ?? null,
    scored_on: dated.at(-1)?.slice(0, 10) ?? null,
    seen_at: seenAt,
  };
}

const RATING_COLS = ['vendor', 'rating', 'observed', 'classifiable', 'pass', 'fail', 'rank', 'classifier', 'scored_on', 'seen_at'];

/** Store one vendor's rating, or drop it when Finnrick no longer rates the vendor. */
export function saveRating(slug, row) {
  const db = open();
  if (!row) return db.query('DELETE FROM finnrick_ratings WHERE vendor = ?').run(slug).changes > 0;
  const was = db.query('SELECT rating FROM finnrick_ratings WHERE vendor = ?').get(slug);
  db.query(`INSERT OR REPLACE INTO finnrick_ratings (${RATING_COLS.join(', ')}) VALUES (${RATING_COLS.map(() => '?').join(', ')})`).run(...RATING_COLS.map((k) => row[k] ?? null));
  return was?.rating !== row.rating;
}
