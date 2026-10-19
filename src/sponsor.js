import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { open } from './db.js';
import { invalidate } from './service.js';

/**
 * The one thing for sale: a sponsored slot. A vendor pays once (CoinPay, crypto) and
 * is pinned, labelled Sponsored, for SPONSOR_DAYS. A second payment for a vendor still
 * sponsored extends from its current end, not from today.
 *
 * The webhook payload is NESTED (`data.payment_id`; the top-level id is the event),
 * and what was paid for is looked up by payment id, never from echoed metadata.
 */
export const payConfigured = () => /^cp_(live|test)_[0-9a-f]{32}$/.test(config.coinpay.apiKey) && Boolean(config.coinpay.businessId && config.coinpay.webhookSecret);

export async function startSponsor({ vendor, email }, fetchImpl = fetch) {
  if (!payConfigured()) throw new Error('Sponsorships are not open yet.');
  const v = open().query('SELECT slug, name FROM vendors WHERE slug = ?').get(String(vendor ?? ''));
  if (!v) throw new Error('No such vendor.');
  const mail = String(email ?? '').trim().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('Give an email for the receipt.');
  const res = await fetchImpl(`${config.coinpay.baseUrl}/api/payments/create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.coinpay.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      business_id: config.coinpay.businessId,
      amount: config.sponsorUsd,
      currency: 'USD',
      blockchain: 'USDC_POL',
      payment_method: 'crypto',
      description: `${config.siteName}: sponsor ${v.name} for ${config.sponsorDays} days`,
      metadata: { vendor: v.slug },
      success_url: `${config.siteUrl}/sponsor/thanks?vendor=${v.slug}`,
      cancel_url: `${config.siteUrl}/sponsor?vendor=${v.slug}&cancelled=1`,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CoinPay said ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  const payment = body?.payment ?? body;
  const ref = payment?.id ?? payment?.payment_id;
  if (!ref) throw new Error('CoinPay returned no payment reference.');
  open().query('INSERT INTO sponsors (ref, vendor, email, usd, created_at) VALUES (?, ?, ?, ?, ?)').run(String(ref), v.slug, mail, config.sponsorUsd, new Date().toISOString());
  return { ref, payUrl: payment?.stripe_checkout_url ?? `${config.coinpay.baseUrl}/pay/${ref}` };
}

/** `t=<unix>,v1=<hex hmac-sha256 of "t.rawBody">`, 300 s window, over the RAW bytes. */
export function verifyWebhook(rawBody, header, secret = config.coinpay.webhookSecret, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=').map((s) => s.trim())));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !/^[0-9a-f]+$/i.test(parts.v1 ?? '')) return false;
  if (Math.abs(now / 1000 - t) > 300) return false;
  const a = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest();
  const b = Buffer.from(parts.v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const SETTLED = new Set(['confirmed', 'paid', 'completed', 'succeeded', 'settled', 'forwarded']);

/** Marks a sponsorship paid. Returns what happened, for the log; unknown or repeated payments change nothing. */
export function settle(payload, now = new Date()) {
  const d = payload?.data ?? payload;
  const status = String(d?.status ?? '').toLowerCase();
  const settled = SETTLED.has(status) || /\.(confirmed|forwarded)$/.test(String(payload?.type ?? ''));
  const ref = String(d?.payment_id ?? d?.id ?? '');
  if (!settled || !ref) return { ok: true, ignored: status || payload?.type || 'no status' };
  const db = open();
  const row = db.query('SELECT * FROM sponsors WHERE ref = ?').get(ref);
  if (!row) return { ok: true, ignored: `unknown payment ${ref}` };
  if (row.status === 'paid') return { ok: true, already: ref };
  const current = db.query("SELECT max(until) until FROM sponsors WHERE vendor = ? AND status = 'paid'").get(row.vendor)?.until;
  const from = current && current > now.toISOString() ? new Date(current) : now;
  const until = new Date(from.getTime() + config.sponsorDays * 86400_000).toISOString();
  db.query("UPDATE sponsors SET status = 'paid', paid_at = ?, until = ? WHERE ref = ?").run(now.toISOString(), until, ref);
  invalidate();
  return { ok: true, vendor: row.vendor, until };
}
