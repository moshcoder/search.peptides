import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { cleanUrl, countries, paymentClasses } from '../src/core/normalize.js';
import { readText, toParams } from '../src/core/parse.js';
import { robotsAllows } from '@profullstack/scraper-daemon';
import { finnrickRows, saveDiscovered } from '../src/discover.js';
import { contactsIn, emailsIn, finnrickToContacts, normalizeContact, saveContacts, socialKind, whatsappNumber } from '../src/enrich.js';
import { open } from '../src/db.js';
import { getVendor, invalidate, parse, searchOffers, searchVendors } from '../src/service.js';
import { settle, verifyWebhook } from '../src/sponsor.js';
import { loadSnapshotIfEmpty, transform, unpackProducts, write } from '../src/sync.js';

const DOC = {
  vendors: [
    { slug: 'acme', name: 'Acme Peptides', score: 82, website: 'https://acme.example/?aff=PEPTIDECOMPARE&x=1', location: 'US', latest_test: '23 Apr 2026' },
    { slug: 'zen', name: 'Zen Bio', score: 60, website: 'https://wa.me/8613800000000?text=I+found+you+on+Finnrick', location: 'china' },
  ],
  affiliates: { acme: { params: { aff: 'PEPTIDECOMPARE' } } },
  coupons: { acme: [{ code: 'PEPTIDECOMPARE', discount: '10% off' }, { code: 'CRYPTO20', discount: '20% off' }] },
  terms: { acme: { payment: ['USDT', 'Zelle'], ships_from: ['US (Flower Mound, TX)'] }, zen: { payment: ['bank transfer (T/T)', 'Alibaba'], ships_from: ['CN/HK'] } },
  ordering: { acme: { method: 'checkout' }, zen: { method: 'message' } },
  test_totals: [{ vendor_slug: 'acme', tests: 2, pass: 2, fail: 0 }],
  tests: [{ vendor_slug: 'acme', peptide: 'BPC-157', test_date: '23 Apr 2026', result: 'Pass' }],
  ratings: [],
  contacts: [{ vendor_slug: 'zen', kind: 'whatsapp', url: 'https://wa.me/8613800000000?text=hi' }],
  products: {
    packed: 1,
    n: 3,
    tables: { vendor_slug: ['acme', 'zen'], peptide: ['BPC-157', 'Tirzepatide'], unit: ['mg'], currency: ['USD'], form: ['vial'] },
    origin: { acme: 'https://acme.example' },
    scraped: {},
    cols: {
      vendor_slug: [0, 0, 1],
      peptide: [0, 1, 1],
      unit: [0, 0, 0],
      currency: [0, 0, 0],
      form: [0, 0, 0],
      id: [1, 2, 3],
      amount: [10, 30, 10],
      pack_qty: [1, 1, 1],
      price: [40, 150, 20],
      price_usd: [40, 150, 20],
      total_mg: [10, 30, 10],
      usd_per_mg: [4, 5, 2],
      usd_per_unit: [40, 150, 20],
      in_stock: [1, 0, null],
      name: ['BPC-157 10mg', 'Tirz 30mg', 'Tirz 10mg'],
      url: ['/p/bpc?ref=PeptideCompare', '/p/tirz', 'https://zen.example/t'],
      components: [null, null, null],
    },
  },
};

describe('sync', () => {
  test('unpacks column-packed products through their lookup tables', () => {
    const rows = unpackProducts(DOC.products);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ vendor_slug: 'zen', peptide: 'Tirzepatide', unit: 'mg', price_usd: 20 });
  });

  test('strips the source’s referral params and its own coupon codes', () => {
    const { vendors, offers } = transform(DOC);
    const acme = vendors.find((v) => v.slug === 'acme');
    expect(acme.website).toBe('https://acme.example/?x=1');
    expect(acme.coupons.map((c) => c.code)).toEqual(['CRYPTO20']);
    expect(offers[0].url).toBe('https://acme.example/p/bpc');
    expect(acme.payments.sort()).toEqual(['crypto', 'zelle']);
    expect(acme.ships_from).toEqual(['US']);
    expect(acme.latest_test).toBe('2026-04-23');
    expect(vendors.find((v) => v.slug === 'zen').website).toBe('https://wa.me/8613800000000');
  });

  test('refuses a document with less than half the vendors already held', () => {
    write(transform(DOC), { force: true });
    expect(() => write(transform({ ...DOC, vendors: [] }))).toThrow(/refusing/);
  });
});

describe('normalize', () => {
  test('folds payment spellings into classes', () => {
    expect(paymentClasses(['Bitcoin', 'credit/debit card', 'Cash App', 'Western Union']).sort()).toEqual(['card', 'cashapp', 'crypto', 'western-union']);
  });
  test('reads country codes out of free text', () => {
    expect(countries(['UK', 'CN/HK', 'multiple warehouses (unspecified)', 'US-CA'])).toEqual(['GB', 'CN', 'HK', 'US']);
  });
  test('cleans tracking off a link', () => {
    expect(cleanUrl('https://x.example/?utm_source=a&ref=b&id=7')).toBe('https://x.example/?id=7');
  });
});

describe('free text', () => {
  const known = { peptides: [{ slug: 'bpc-157-plus-tb-500', name: 'BPC-157 + TB-500' }, { slug: 'bpc-157', name: 'BPC-157' }] };
  test('reads price, stock, testing and the peptide', () => {
    const { filters } = readText('BPC-157 + TB-500 lab tested in stock under $1/mg pay with crypto', known);
    expect(filters).toEqual({ peptide: 'bpc-157-plus-tb-500', tested: true, in_stock: true, max_per_mg: 1, payment: 'crypto' });
  });
  test('leaves what it does not understand as words', () => {
    expect(readText('lobster kit', known).filters).toEqual({ q: 'lobster kit' });
  });
  test('params round-trip in a stable order', () => {
    expect(toParams({ in_stock: true, peptide: 'bpc-157', page: 1 }).toString()).toBe('peptide=bpc-157&in_stock=1');
  });
});

describe('search over the snapshot', () => {
  // An active option's link removes it (its count is the current total), so only inactive ones are followed.
  test('every facet count equals the total its link leads to', () => {
    open().exec('DELETE FROM vendors');
    loadSnapshotIfEmpty();
    invalidate();
    const r = searchOffers(parse({ text: 'retatrutide in stock' }), { facets: true });
    expect(r.total).toBeGreaterThan(50);
    for (const group of r.facets.slice(0, 6)) {
      for (const o of group.options.filter((x) => !x.active).slice(0, 3)) {
        expect(searchOffers(parse(new URLSearchParams(o.query))).total).toBe(o.count);
      }
    }
  });
  test('listings rank cheapest per mg first', () => {
    const r = searchOffers(parse({ peptide: 'bpc-157' }), { limit: 20 });
    const per = r.offers.filter((o) => o.unit === 'mg').map((o) => o.usd_per_mg);
    expect(per).toEqual(per.toSorted((a, b) => a - b));
  });
  test('vendor search facets include contact channels once contacts exist', () => {
    const slug = searchVendors(parse({})).vendors[0].slug;
    open().query("INSERT OR IGNORE INTO vendor_contacts (vendor, kind, value, found_at) VALUES (?, 'email', 'sales@vendor.example', '2026-10-19')").run(slug);
    invalidate();
    const r = searchVendors(parse({ contact: 'email' }), { facets: true });
    expect(r.vendors.map((v) => v.slug)).toContain(slug);
    expect(getVendor(slug).contact.emails).toContain('sales@vendor.example');
  });
});

describe('contacts', () => {
  test('finds emails, phones and socials, and skips share buttons and asset names', () => {
    const html = `<a href="mailto:Sales@Shop.example?subject=hi">mail</a> info [at] shop.example
      <img src="logo@2x.png"> <a href="tel:+1 (555) 010-9999">call</a>
      <a href="https://www.instagram.com/shop_peps/?igsh=xyz">ig</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
      <a href="https://api.whatsapp.com/send?phone=8613800000000">wa</a>`;
    const found = contactsIn(html, 'https://shop.example/');
    const by = (k) => found.filter((c) => c.kind === k).map((c) => normalizeContact(k, c.value));
    expect(by('email').sort()).toEqual(['info@shop.example', 'sales@shop.example']);
    expect(by('phone').sort()).toEqual(['+15550109999', '+8613800000000']);
    expect(by('instagram')).toEqual(['https://www.instagram.com/shop_peps']);
    expect(by('whatsapp')).toEqual(['https://wa.me/8613800000000']);
    expect(by('facebook')).toEqual([]);
  });
  test('rejects placeholder emails', () => {
    expect(emailsIn('your@email.com you@example.com name@domain.com')).toEqual([]);
  });
  test('reads WhatsApp numbers', () => {
    expect(whatsappNumber('https://wa.me/85244686937?text=x')).toBe('+85244686937');
    expect(socialKind('https://twitter.com/shop')).toBe('x');
    expect(normalizeContact('x', 'https://mobile.twitter.com/shop/')).toBe('https://x.com/shop');
  });
  test('robots: wildcards do not disallow the whole site, longest rule wins', () => {
    const robots = 'User-agent: *\nDisallow: /*?add-to-cart=\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n';
    expect(robotsAllows(robots, '/')).toBe(true);
    expect(robotsAllows(robots, '/contact')).toBe(true);
    expect(robotsAllows(robots, '/shop?add-to-cart=1')).toBe(false);
    expect(robotsAllows(robots, '/wp-admin/admin-ajax.php')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /\n', '/contact')).toBe(false);
  });
});

describe('sponsor', () => {
  const sign = (body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}`;
  test('verifies the CoinPay signature over the raw body', () => {
    const body = '{"a":1}';
    expect(verifyWebhook(body, sign(body))).toBe(true);
    expect(verifyWebhook(body, sign('{"a":2}'))).toBe(false);
    expect(verifyWebhook(body, sign(body, 1000))).toBe(false);
  });
  test('a settled payment pins the vendor; a repeat changes nothing; a renewal extends', () => {
    const db = open();
    const slug = db.query('SELECT slug FROM vendors LIMIT 1').get().slug;
    db.query("INSERT INTO sponsors (ref, vendor, usd, created_at) VALUES ('pay_1', ?, 49, '2026-10-19'), ('pay_2', ?, 49, '2026-10-19')").run(slug, slug);
    const now = new Date('2026-10-19T00:00:00Z');
    expect(settle({ type: 'payment.detected', data: { payment_id: 'pay_1', status: 'detected' } }, now).ignored).toBeTruthy();
    const first = settle({ type: 'payment.confirmed', data: { payment_id: 'pay_1', status: 'confirmed' } }, now);
    expect(first.until).toBe('2026-11-18T00:00:00.000Z');
    expect(settle({ data: { payment_id: 'pay_1', status: 'confirmed' } }, now).already).toBe('pay_1');
    expect(settle({ data: { payment_id: 'pay_2', status: 'confirmed' } }, now).until).toBe('2026-12-18T00:00:00.000Z');
    expect(settle({ data: { payment_id: 'nope', status: 'confirmed' } }, now).ignored).toMatch(/unknown/);
  });
});

describe('discovery and the daemon’s writers', () => {
  test('Finnrick’s list adds the vendors the register lacks, and a register sync keeps them', () => {
    open().exec('DELETE FROM vendors');
    loadSnapshotIfEmpty();
    const known = open().query("SELECT slug FROM vendors WHERE origin = 'register' LIMIT 1").get().slug;
    const rows = finnrickRows({
      items: [
        { slug: known, name: 'Renamed Upstream', status: 'Trading', test_count: 99 },
        { slug: 'brand-new-labs', name: 'Brand New Labs', contact_url: 'https://brandnew.example/', contact_kind: 'website', location: 'China', test_count: 3, status: 'Trading' },
        { slug: 'mail-only', name: 'Mail Only', contact_url: 'mailto:x@y.example', contact_kind: 'email' },
      ],
    });
    expect(rows.find((r) => r.slug === 'mail-only').website).toBeNull();
    expect(saveDiscovered(rows)).toBe(2);
    const fresh = open().query('SELECT name, origin, status, website, country FROM vendors WHERE slug = ?');
    expect(fresh.get('brand-new-labs')).toEqual({ name: 'Brand New Labs', origin: 'finnrick', status: 'Trading', website: 'https://brandnew.example/', country: 'CN' });
    // A register vendor keeps its own name; only its trading status is taken.
    expect(fresh.get(known).origin).toBe('register');
    expect(fresh.get(known).name).not.toBe('Renamed Upstream');
    expect(fresh.get(known).status).toBe('Trading');
    // A register sync replaces only what the register owns.
    write(transform(DOC), { force: true });
    expect(fresh.get('brand-new-labs').origin).toBe('finnrick');
  });

  test('Finnrick contacts: vouched or confident only, emails and socials sorted out', () => {
    const found = finnrickToContacts({
      contact_url: 'https://shop.example/',
      contacts: [
        { kind: 'email', value: 'sales@shop.example', vouched: true },
        { kind: 'email', value: 'guess@shop.example', confidence: 0.3 },
        { kind: 'website', url: 'https://t.me/shopchannel', confidence: 0.9 },
        { kind: 'website', url: 'https://wa.me/15550109999', vouched: true },
      ],
    });
    expect(found).toEqual([
      { kind: 'email', value: 'sales@shop.example' },
      { kind: 'telegram', value: 'https://t.me/shopchannel' },
      { kind: 'whatsapp', value: 'https://wa.me/15550109999' },
      { kind: 'phone', value: '+15550109999' },
      { kind: 'website', value: 'https://shop.example/' },
    ]);
  });

  test('each origin’s contacts are replaced on their own', () => {
    const slug = open().query('SELECT slug FROM vendors LIMIT 1').get().slug;
    saveContacts(slug, 'finnrick', [{ kind: 'email', value: 'a@vendor.example' }]);
    saveContacts(slug, 'site', [{ kind: 'email', value: 'b@vendor.example', source: 'https://vendor.example/contact' }]);
    saveContacts(slug, 'site', [{ kind: 'phone', value: '+15550100000', source: 'https://vendor.example/' }]);
    const rows = open().query('SELECT kind, value FROM vendor_contacts WHERE vendor = ? ORDER BY value').all(slug);
    expect(rows).toEqual([
      { kind: 'phone', value: '+15550100000' },
      { kind: 'email', value: 'a@vendor.example' },
    ]);
  });
});

describe('a source that stops serving its register', () => {
  test('a decoy document is refused by name and nothing is written', () => {
    const decoy = { synthetic_cache_test: true, notice: 'Synthetic random data for HTTP cache testing.', records: [{ id: 'cache-test-001' }] };
    expect(() => transform(decoy)).toThrow(/served no register: "Synthetic random data/);
  });
});

describe('the export', () => {
  test('carries every vendor, not one page of them', () => {
    const all = open().query('SELECT count(*) n FROM vendors').get().n;
    expect(searchVendors({ filters: {}, understood: [], text: '' }, { all: true }).vendors.length).toBe(all);
  });
});

describe('prices from vendor shops', () => {
  test('reads sizes: single, blend, micrograms, packs', async () => {
    const { readAmount } = await import('../src/shops.js');
    expect(readAmount('Dosage: 10 MG')).toEqual({ amount: 10, unit: 'mg', pack: 1, parts: 1 });
    expect(readAmount('Dosage: 5 MG / 5 MG')).toEqual({ amount: 10, unit: 'mg', pack: 1, parts: 2 });
    expect(readAmount('Thymosin 500mcg')).toEqual({ amount: 0.5, unit: 'mg', pack: 1, parts: 1 });
    expect(readAmount('BPC-157 10mg x 10 vials')).toMatchObject({ amount: 10, pack: 10 });
    expect(readAmount('HGH 10IU')).toMatchObject({ amount: 10, unit: 'iu' });
    expect(readAmount('Lab coat, size L')).toBeNull();
  });

  test('matches the longest known peptide, prices per mg in USD, skips what is not a peptide', async () => {
    const { peptideMatcher, toOffer, shopOfferId } = await import('../src/shops.js');
    const match = peptideMatcher(['BPC-157', 'TB-500', 'BPC-157 + TB-500', 'NAD+', 'Tirzepatide']);
    expect(match('BPC-157 + TB-500 Blend').name).toBe('BPC-157 + TB-500');
    expect(match('NAD+ 500mg').name).toBe('NAD+');
    expect(match('Gift card')).toBeNull();
    const o = toOffer({ vendor: 'acme', id: 9, name: 'TIRZEPATIDE', label: 'Dosage: 30 MG', price: 150, currency: 'EUR', inStock: true, url: 'https://acme.example/p/t', match });
    expect(o).toMatchObject({ peptide: 'Tirzepatide', peptide_slug: 'tirzepatide', amount: 30, unit: 'mg', price: 150, currency: 'EUR', price_usd: 162, usd_per_mg: 5.4, in_stock: 1, name: 'TIRZEPATIDE 30 MG' });
    expect(toOffer({ vendor: 'acme', id: 10, name: 'Merch hoodie', price: 40, currency: 'USD', match })).toBeNull();
    expect(toOffer({ vendor: 'acme', id: 11, name: 'Tirzepatide', price: 40, currency: 'USD', match })).toBeNull();
    expect(shopOfferId('acme', 9)).toBe(shopOfferId('acme', 9));
    expect(shopOfferId('acme', 9)).toBeGreaterThan(2_999_999_999);
    expect(shopOfferId('acme', 9)).not.toBe(shopOfferId('zen', 9));
  });

  test('a vendor with shop listings shows those, its stats follow, and a register sync leaves them alone', async () => {
    const { saveShopOffers, peptideMatcher, toOffer, shopOfferId } = await import('../src/shops.js');
    open().exec('DELETE FROM vendors');
    loadSnapshotIfEmpty();
    const slug = open().query("SELECT vendor FROM offers WHERE origin = 'register' GROUP BY vendor HAVING count(*) > 3 LIMIT 1").get().vendor;
    const match = peptideMatcher(['Retatrutide']);
    const offers = [toOffer({ vendor: slug, id: shopOfferId(slug, 'r10'), name: 'Retatrutide', label: 'Size: 10 MG', price: 70, currency: 'USD', inStock: true, url: 'https://shop.example/r', match })];
    expect(saveShopOffers(slug, offers)).toBe(1);
    invalidate();
    const v = getVendor(slug);
    expect(v.listings.map((l) => l.source)).toEqual(['shop']);
    expect(v.offers).toBe(1);
    expect(v.min_usd_per_mg).toBe(7);
    write(transform(DOC), { force: true });
    expect(open().query("SELECT count(*) n FROM offers WHERE vendor = ? AND origin = 'shop'").get(slug).n).toBe(1);
  });
});

describe('shop sizes: totals, thousands, packs', () => {
  test('a pack total is not more peptide; thousands separators are thousands; a blend still adds up', async () => {
    const { readAmount } = await import('../src/shops.js');
    expect(readAmount('Glutathione 1200mg x 10vials, 12000mg')).toEqual({ amount: 1200, unit: 'mg', pack: 10, parts: 1 });
    expect(readAmount('NAD+ 1,000mg')).toMatchObject({ amount: 1000, pack: 1 });
    expect(readAmount('Semax 2,5mg')).toMatchObject({ amount: 2.5 });
    expect(readAmount('Glutathione ™ 1500mg*10vials')).toMatchObject({ amount: 1500, pack: 10 });
    expect(readAmount('Dosage: 5 MG / 5 MG')).toMatchObject({ amount: 10, parts: 2 });
    expect(readAmount('BPC-157 5mg TB-500 5mg', { blend: true })).toMatchObject({ amount: 10, parts: 2 });
    expect(readAmount('BPC-157 5mg TB-500 5mg')).toMatchObject({ amount: 5, parts: 1 });
  });
});

describe('shop supplies', () => {
  test('a syringe that names a peptide is not a listing', async () => {
    const { peptideMatcher, toOffer } = await import('../src/shops.js');
    const match = peptideMatcher(['Insulin', 'Tirzepatide']);
    expect(toOffer({ vendor: 'x', id: 1, name: 'Easy Touch U-100 Insulin Syringe with Needle, 30G', price: 4.99, currency: 'USD', match })).toBeNull();
    expect(toOffer({ vendor: 'x', id: 2, name: 'Tirzepatide 10mg', price: 60, currency: 'USD', match })).not.toBeNull();
  });
});

describe('shop sizes: name and variation together', () => {
  test('NAD+ is not a blend; a label that is the vial times a pack is a pack', async () => {
    const { peptideMatcher, toOffer, sizeOf } = await import('../src/shops.js');
    expect(sizeOf('Glutathione 1500mg', '7500mg (5vials) $182.16')).toMatchObject({ amount: 1500, pack: 5 });
    expect(sizeOf('BPC-157', 'Size: 10 MG')).toMatchObject({ amount: 10, pack: 1 });
    expect(sizeOf('CJC-1295 / Ipamorelin Blend', 'Dosage: 5 MG / 5 MG', true)).toMatchObject({ amount: 10 });
    const match = peptideMatcher(['NAD+', 'BPC-157 + TB-500']);
    const nad = toOffer({ vendor: 'x', id: 1, name: 'NAD+ 1000mg x 10vials, 10000mg', price: 265, currency: 'USD', match });
    expect(nad).toMatchObject({ amount: 1000, pack_qty: 10, usd_per_mg: 0.0265 });
    const wolverine = toOffer({ vendor: 'x', id: 2, name: 'BPC-157 + TB-500', label: 'Dosage: 5mg / 5mg', price: 80, currency: 'USD', match });
    expect(wolverine).toMatchObject({ amount: 10, usd_per_mg: 8 });
  });
});
