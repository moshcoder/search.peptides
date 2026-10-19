import { beforeAll, describe, expect, test } from 'bun:test';
import { open } from '../src/db.js';
import { batchOf, ratingFromRecord, readTests, saveRating, saveTests, testRow } from '../src/finnrick.js';
import { handle } from '../src/mcp.js';
import { computeScore, recomputeScores, RULES } from '../src/score.js';
import { invalidate, searchVendors } from '../src/service.js';
import { loadSnapshotIfEmpty } from '../src/sync.js';
import { app } from '../src/web/app.jsx';

const NOW = '2026-10-19T12:00:00.000Z';
const t = (o = {}) => ({ record_id: `r${Math.random().toString(36).slice(2, 9)}`, vendor: 'acme', tested_on: '2026-10-01', classifiable: 1, passed: 1, coa: 1, lab_name: 'Krause Analytical', batch: 'LOT-1', sent_by: 'Public', ...o });
const byKey = (r) => Object.fromEntries(r.components.map((c) => [c.key, c]));

describe('computeScore', () => {
  test('weights add up to 100', () => {
    expect(RULES.components.reduce((n, c) => n + c.weight, 0)).toBe(100);
  });

  test('perfect evidence scores 100 and every component says why', () => {
    const tests = Array.from({ length: 30 }, () => t());
    const r = computeScore({ tests, rating: { rating: 100, scored_on: '2026-10-19' }, vendor: { ordering: 'checkout', payments: ['crypto'], ships_from: ['US'], contact: { emails: ['a@b.co'], websites: ['https://b.co'] } }, now: NOW });
    expect(r.status).toBe('scored');
    expect(r.score).toBe(100);
    for (const c of r.components) {
      expect(c.points).toBe(c.weight);
      expect(c.evidence.length).toBeGreaterThan(10);
    }
  });

  test('fewer than three classifiable tests is insufficient data, not a number', () => {
    const r = computeScore({ tests: [t(), t(), t({ classifiable: 0, passed: null })], now: NOW });
    expect(r.status).toBe('insufficient');
    expect(r.score).toBeNull();
    expect(r.note).toContain('2 classifiable tests');
  });

  test('no tests at all is unscored, and missing evidence earns nothing', () => {
    const r = computeScore({ tests: [], now: NOW });
    expect(r.status).toBe('unscored');
    expect(r.score).toBeNull();
    const c = byKey(r);
    expect(c.lab.status).toBe('no data');
    expect(c.lab.points).toBe(0);
    expect(c.rating.status).toBe('no data');
  });

  test('a certificate counts only for what it shows: on file, lab named, lot-specific', () => {
    const tests = [t(), t({ batch: null }), t({ lab_name: null, batch: null }), t({ coa: 0, lab_name: null, batch: null })];
    const c = byKey(computeScore({ tests, now: NOW })).certificates;
    // 3 + 2 + 1 + 0 checks of 12
    expect(c.points).toBe(Math.round(20 * (6 / 12) * 10) / 10);
    expect(c.data).toMatchObject({ coa_on_file: 3, lab_named: 2, lot_specific: 1, tests: 4 });
  });

  test('lab results are the pass share; recency steps with the newest test', () => {
    const tests = [t({ passed: 0 }), t(), t(), t({ tested_on: '2026-03-01' })];
    const c = byKey(computeScore({ tests, now: NOW }));
    expect(c.lab.points).toBe(Math.round(35 * 0.75 * 10) / 10);
    expect(c.recency.points).toBe(10);
    const old = byKey(computeScore({ tests: [t({ tested_on: '2026-03-01' })], now: NOW }));
    expect(old.recency.points).toBe(Math.round((10 * 1) / 3 * 10) / 10);
  });

  test('tests older than the window do not count toward results', () => {
    const r = computeScore({ tests: [t({ tested_on: '2023-01-01' }), t({ tested_on: '2023-01-02' }), t({ tested_on: '2023-01-03' })], now: NOW });
    expect(r.status).toBe('insufficient');
    expect(byKey(r).recency.points).toBe(0);
  });

  test('only public or Finnrick purchases are blind samples', () => {
    const tests = [t(), t({ sent_by: 'Finnrick' }), t({ sent_by: 'Vendor' }), t({ sent_by: 'Pulse' })];
    expect(byKey(computeScore({ tests, now: NOW })).independence.points).toBe(2.5);
  });
});

describe('Finnrick feed', () => {
  test('a test item becomes a row; placeholder batches are not batches', () => {
    const row = testRow({ record_id: 'w2ydbdb', product_name: 'CJC-1295', product_slug: 'cjc-1295', product_variant: 'DAC', vendor_slug: 'liberty-peptides', test_date: '2026-10-15', safety_classifiable: true, safety_passed: false, safety_reasons: ['purity_below_threshold'], batch_identifier: 'LPUS029001', coa_available: true, lab_name: 'Krause Analytical', sent_by: 'Public', purity_label: '90.8%' }, NOW);
    expect(row).toMatchObject({ vendor: 'liberty-peptides', peptide: 'CJC-1295 DAC', passed: 0, classifiable: 1, coa: 1, batch: 'LPUS029001', tested_on: '2026-10-15' });
    expect(batchOf('N/A')).toBeNull();
    expect(batchOf(' - ')).toBeNull();
    expect(batchOf('RT50')).toBe('RT50');
  });

  test('readTests pages until the total and drops duplicates', async () => {
    const pages = { 1: ['a', 'b'], 2: ['b', 'c'] };
    const fetcher = { json: async (url) => ({ total: 4, page_size: 2, items: pages[new URL(url).searchParams.get('page')].map((id) => ({ record_id: id, vendor_slug: 'v' })) }) };
    const r = await readTests(fetcher, { pageSize: 2 });
    expect(r.rows.map((x) => x.record_id)).toEqual(['a', 'b', 'c']);
  });

  test('a vendor record gives its rating', () => {
    const r = ratingFromRecord({ vendor: { slug: 'a-orange' }, total_score: { classifier_label: 'Purity focus', entry: { vendor_slug: 'a-orange', stat_percent: 78.68, stat_pass_count: 5, stat_fail_count: 1, rank: 0, rating_history: [{ test_date: '2026-06-16' }, { test_date: '2026-08-06' }] } } });
    expect(r).toMatchObject({ vendor: 'a-orange', rating: 78.68, classifier: 'Purity focus', scored_on: '2026-08-06', rank: null });
    expect(ratingFromRecord({ vendor: { slug: 'x' }, total_score: { entry: { stat_percent: null } } })).toBeNull();
  });
});

describe('scores in the site', () => {
  let slug;
  beforeAll(() => {
    loadSnapshotIfEmpty();
    slug = open().query("SELECT slug FROM vendors WHERE origin = 'register' ORDER BY slug LIMIT 1").get().slug;
    const rows = Array.from({ length: 5 }, (_, i) => ({ ...t({ vendor: slug, record_id: `fx${i}`, passed: i === 0 ? 0 : 1 }), peptide: 'BPC-157', peptide_slug: 'bpc-157', reasons: '[]', seen_at: NOW }));
    saveTests({ rows, seenAt: NOW }, { force: true });
    saveRating(slug, { vendor: slug, rating: 80, classifier: 'Purity focus', scored_on: '2026-10-01', seen_at: NOW });
    recomputeScores({ now: NOW });
    invalidate();
  });

  test('a short Finnrick read is refused', () => {
    expect(() => saveTests({ rows: [], seenAt: NOW })).toThrow(/refusing/);
  });

  test('the vendor API carries the score, its components, evidence links and history', async () => {
    const v = await (await app.request(`/api/v1/vendors/${slug}`)).json();
    expect(v.verification.status).toBe('scored');
    expect(v.verification_score).toBe(v.verification.score);
    expect(v.verification.components.map((c) => c.key)).toEqual(RULES.components.map((c) => c.key));
    expect(v.verification.verified_at).toBe(NOW);
    expect(v.independent_tests[0].record).toMatch(/^https:\/\/www\.finnrick\.com\/tests\//);
    expect(v.score_history[0].why).toContain('first score');
  });

  test('vendors sort and filter by the verification score; unscored never pass a minimum', () => {
    const all = searchVendors({ filters: {}, understood: [], text: '' }, { all: true }).vendors;
    expect(all[0].slug).toBe(slug);
    const min = searchVendors({ filters: { min_verification: 1 }, understood: [], text: '' }, { all: true });
    expect(min.vendors.every((v) => Number.isFinite(v.verification_score))).toBe(true);
    expect(min.total).toBe(1);
  });

  test('a change in evidence is logged with its reason', async () => {
    open().query("UPDATE finnrick_tests SET passed = 0 WHERE record_id = 'fx1'").run();
    expect(recomputeScores({ now: NOW }).changed).toBe(1);
    const log = open().query('SELECT old_score, new_score, why FROM score_log WHERE vendor = ? ORDER BY id DESC').all(slug);
    expect(log[0].new_score).toBe(log[0].old_score - 7);
    expect(log[0].why).toBe('lab results 28→21');
    // Nothing moved: nothing logged.
    expect(recomputeScores({ now: NOW }).changed).toBe(0);
  });

  test('/rules has the criteria, the formula, the sources and the history; pages link to it', async () => {
    invalidate();
    const rules = await (await app.request('/rules')).text();
    for (const s of ['What counts as verified', 'Lot-specific', 'Identifiable lab', 'The formula', 'Sources and how often', 'Update history', 'Insufficient data', 'research use']) expect(rules).toContain(s);
    for (const c of RULES.components) expect(rules).toContain(`id="${c.key}"`);
    const home = await (await app.request('/vendors')).text();
    expect(home).toContain('href="/rules"');
    expect(home).toContain(`href="/v/${slug}#score"`);
    const page = await (await app.request(`/v/${slug}`)).text();
    expect(page).toContain('id="score"');
    expect(page).toContain('last verified 2026-10-19');
    expect(page).toContain('/rules#lab');
  });

  test('/api/v1/rules and MCP get_rules answer', async () => {
    const r = await (await app.request('/api/v1/rules')).json();
    expect(r.rules.components.length).toBe(7);
    expect(r.vendors.scored).toBeGreaterThanOrEqual(1);
    const m = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_rules', arguments: {} } });
    expect(m.result.structuredContent.rules.version).toBe(RULES.version);
  });
});
