import { beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { open } from '../src/db.js';
import { settle, startSponsor, verifyWebhook } from '../src/sponsor.js';
import { loadSnapshotIfEmpty } from '../src/sync.js';
import { app } from '../src/web/app.jsx';

const sign = (body, t = Math.floor(Date.now() / 1000), secret = 'whsec_test') => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
let slug;
let seq = 0;

/** A fake CoinPay that records the session request and answers like POST /api/checkout/sessions. */
function fakeCoinPay() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    const id = `cs_test_${++seq}`;
    return new Response(JSON.stringify({ success: true, id, url: `https://coinpayportal.com/checkout/${id}`, status: 'open', methods: ['USDC_POL', 'BTC', 'ETH', 'SOL', 'PAYPAL'], expires_at: '2026-10-21T14:00:00Z' }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  return { calls, impl };
}

const event = (type, sessionId, extra = {}) => ({
  id: `evt_${++seq}`,
  type,
  business_id: 'biz_test',
  data: { payment_id: `pay_${seq}`, status: 'confirmed', amount_usd: 49, checkout_session_id: sessionId, customer_email: 'buyer@example.com', account_id: 'buyer@example.com', property: 'search.peptides.test', metadata: { vendor: slug }, ...extra },
});

beforeAll(() => {
  if (!open().query('SELECT 1 FROM vendors LIMIT 1').get()) loadSnapshotIfEmpty();
  slug = open().query('SELECT slug FROM vendors ORDER BY slug LIMIT 1').get().slug;
});

describe('sponsor checkout session', () => {
  test('creates a hosted checkout session with the buyer email as customer and account, and stores its id', async () => {
    const cp = fakeCoinPay();
    const r = await startSponsor({ vendor: slug, email: ' buyer@example.com ' }, cp.impl);
    expect(cp.calls).toHaveLength(1);
    const { url, init, body } = cp.calls[0];
    expect(url).toBe('https://coinpayportal.com/api/checkout/sessions');
    expect(init.headers.authorization).toBe('Bearer cp_test_0123456789abcdef0123456789abcdef');
    expect(body).toMatchObject({ amount: 49, currency: 'USD', customer_email: 'buyer@example.com', account_id: 'buyer@example.com', property: 'search.peptides.test', expires_in_minutes: 60 });
    expect(body.metadata).toEqual({ vendor: slug, days: 30, sponsor_ref: r.ref });
    expect(body.success_url).toBe(`https://search.peptides.test/sponsor/thanks?vendor=${slug}`);
    expect(body.cancel_url).toBe(`https://search.peptides.test/sponsor?vendor=${slug}&cancelled=1`);
    expect(body).not.toHaveProperty('blockchain');
    expect(body).not.toHaveProperty('payment_method');
    expect(r.payUrl).toBe(`https://coinpayportal.com/checkout/${r.sessionId}`);
    expect(r.methods).toContain('PAYPAL');
    const row = open().query('SELECT * FROM sponsors WHERE ref = ?').get(r.ref);
    expect(row).toMatchObject({ vendor: slug, email: 'buyer@example.com', checkout_session_id: r.sessionId, status: 'pending' });
  });

  test('refuses an unknown vendor or a missing email before calling CoinPay', async () => {
    const cp = fakeCoinPay();
    await expect(startSponsor({ vendor: 'no-such-vendor', email: 'a@b.co' }, cp.impl)).rejects.toThrow('No such vendor');
    await expect(startSponsor({ vendor: slug, email: 'nope' }, cp.impl)).rejects.toThrow('email');
    expect(cp.calls).toHaveLength(0);
  });
});

describe('sponsor webhook', () => {
  const pending = async () => (await startSponsor({ vendor: slug, email: 'buyer@example.com' }, fakeCoinPay().impl)).sessionId;
  const reset = () => open().exec('DELETE FROM sponsors');

  test('verifies the signature over the raw body; now is milliseconds', () => {
    const body = '{"a":1}';
    expect(verifyWebhook(body, sign(body))).toBe(true);
    expect(verifyWebhook(body, sign('{"a":2}'))).toBe(false);
    expect(verifyWebhook(body, sign(body, 1000))).toBe(false);
    expect(verifyWebhook(body, sign(body, 1_000_000), 'whsec_test', 1_000_100_000)).toBe(true);
  });

  test('a nested confirmed event pins the vendor; forwarded after it changes nothing; a renewal extends', async () => {
    reset();
    const a = await pending();
    const b = await pending();
    const now = new Date('2026-10-21T00:00:00Z');
    expect(settle(event('payment.pending', a, { status: 'pending' }), now).ignored).toBeTruthy();
    expect(settle(event('payment.confirmed', a), now).until).toBe('2026-11-20T00:00:00.000Z');
    expect(settle(event('payment.forwarded', a, { status: 'forwarded' }), now).already).toBeTruthy();
    expect(settle(event('payment.forwarded', b, { status: 'forwarded' }), now).until).toBe('2026-12-20T00:00:00.000Z');
    expect(settle(event('payment.confirmed', 'cs_unknown'), now).ignored).toMatch(/unknown/);
    expect(open().query("SELECT count(*) n FROM sponsors WHERE status = 'paid'").get().n).toBe(2);
  });

  test('a PayPal capture (confirmed, status completed) pays', async () => {
    reset();
    const a = await pending();
    const r = settle(event('payment.confirmed', a, { status: 'completed', rail: 'paypal' }), new Date('2026-10-21T00:00:00Z'));
    expect(r.until).toBe('2026-11-20T00:00:00.000Z');
    expect(r.method).toBe('paypal');
  });

  test('expired grants nothing', async () => {
    reset();
    const a = await pending();
    expect(settle(event('payment.expired', a, { status: 'expired' })).ignored).toBe('payment.expired');
    expect(open().query('SELECT status FROM sponsors WHERE checkout_session_id = ?').get(a).status).toBe('pending');
  });

  test('POST /hooks/coinpay: signed nested event 200 and settles; bad signature 401', async () => {
    reset();
    const a = await pending();
    const raw = JSON.stringify(event('payment.confirmed', a));
    const bad = await app.request('/hooks/coinpay', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-coinpay-signature': sign(raw, undefined, 'wrong') } });
    expect(bad.status).toBe(401);
    expect(open().query('SELECT status FROM sponsors WHERE checkout_session_id = ?').get(a).status).toBe('pending');
    const good = await app.request('/hooks/coinpay', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-coinpay-signature': sign(raw) } });
    expect(good.status).toBe(200);
    expect((await good.json()).vendor).toBe(slug);
    const again = await app.request('/hooks/coinpay', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-coinpay-signature': sign(raw) } });
    expect((await again.json()).already).toBeTruthy();
  });

  test('the sponsor page offers any coin or PayPal, never card', async () => {
    const html = await (await app.request('/sponsor')).text();
    expect(html).toContain('with crypto or PayPal');
    expect(html).not.toMatch(/stripe|credit card/i);
  });
});
