import { randomBytes } from 'node:crypto';
import { CoinPay, readWebhook, verifyWebhook as verifyCoinPay } from '@profullstack/coinpay-onboard';
import { config } from './config.js';
import { open } from './db.js';
import { invalidate } from './service.js';

/**
 * The one thing for sale: a sponsored slot. A vendor pays once through a CoinPay hosted
 * checkout session (the buyer picks any coin or PayPal on CoinPay's page) and is pinned,
 * labelled Sponsored, for SPONSOR_DAYS. A second payment for a vendor still sponsored
 * extends from its current end, not from today.
 *
 * There are no accounts: the buyer's email is both customer_email and account_id. The
 * webhook payload is NESTED (`data.checkout_session_id`; the top-level id is the event),
 * and what was paid for is looked up by the checkout session id stored on our row, never
 * from echoed metadata.
 */
export const payConfigured = () => /^cp_(live|test)_[0-9a-f]{32}$/.test(config.coinpay.apiKey) && Boolean(config.coinpay.businessId && config.coinpay.webhookSecret);

const property = () => new URL(config.siteUrl).hostname;

export async function startSponsor({ vendor, email }, fetchImpl = fetch) {
  if (!payConfigured()) throw new Error('Sponsorships are not open yet.');
  const v = open().query('SELECT slug, name FROM vendors WHERE slug = ?').get(String(vendor ?? ''));
  if (!v) throw new Error('No such vendor.');
  const mail = String(email ?? '').trim().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('Give an email for the receipt.');
  const ref = `sp_${randomBytes(12).toString('hex')}`;
  const coinpay = new CoinPay({ base: config.coinpay.baseUrl, token: config.coinpay.apiKey, fetch: fetchImpl });
  let session;
  try {
    session = await coinpay.createCheckoutSession({
      amount: config.sponsorUsd,
      currency: 'USD',
      description: `${config.siteName}: sponsor ${v.name} for ${config.sponsorDays} days`,
      customerEmail: mail,
      accountId: mail,
      property: property(),
      metadata: { vendor: v.slug, days: config.sponsorDays, sponsor_ref: ref },
      successUrl: `${config.siteUrl}/sponsor/thanks?vendor=${v.slug}`,
      cancelUrl: `${config.siteUrl}/sponsor?vendor=${v.slug}&cancelled=1`,
      expiresInMinutes: 60,
    });
  } catch (err) {
    throw new Error(`CoinPay said ${err?.status ?? 'no'}: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  if (!session?.id || !session?.url) throw new Error('CoinPay returned no checkout session.');
  open()
    .query('INSERT INTO sponsors (ref, vendor, email, usd, created_at, checkout_session_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ref, v.slug, mail, config.sponsorUsd, new Date().toISOString(), String(session.id));
  return { ref, sessionId: session.id, payUrl: session.url, methods: session.methods ?? [] };
}

/** `t=<unix>,v1=<hex hmac-sha256 of "t.rawBody">`, 300 s window, over the RAW bytes. `now` is milliseconds. */
export function verifyWebhook(rawBody, header, secret = config.coinpay.webhookSecret, now = Date.now()) {
  return verifyCoinPay(rawBody, header ? String(header) : header, secret, now);
}

/**
 * Marks a sponsorship paid. Paid is payment.confirmed or payment.forwarded (a PayPal capture is
 * confirmed with status 'completed'); one session can send both, so a repeat changes nothing.
 * Returns what happened, for the log; unknown sessions change nothing.
 */
export function settle(payload, now = new Date()) {
  const e = readWebhook(payload);
  if (!e.paid) return { ok: true, ignored: e.type || e.status || 'no status' };
  const db = open();
  let row = e.checkoutSessionId ? db.query('SELECT * FROM sponsors WHERE checkout_session_id = ?').get(e.checkoutSessionId) : null;
  // Rows made before checkout sessions (2026-10-21) were keyed by the CoinPay payment id.
  if (!row && e.paymentId) row = db.query('SELECT * FROM sponsors WHERE ref = ? AND checkout_session_id IS NULL').get(e.paymentId);
  if (!row) return { ok: true, ignored: `unknown session ${e.checkoutSessionId ?? e.paymentId ?? '?'}` };
  if (row.status === 'paid') return { ok: true, already: row.ref };
  const current = db.query("SELECT max(until) until FROM sponsors WHERE vendor = ? AND status = 'paid'").get(row.vendor)?.until;
  const from = current && current > now.toISOString() ? new Date(current) : now;
  const until = new Date(from.getTime() + config.sponsorDays * 86400_000).toISOString();
  db.query("UPDATE sponsors SET status = 'paid', paid_at = ?, until = ?, payment_id = coalesce(?, payment_id) WHERE ref = ?").run(now.toISOString(), until, e.paymentId || null, row.ref);
  invalidate();
  return { ok: true, vendor: row.vendor, until, method: e.method || null };
}
