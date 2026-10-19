/** Every env var, read once. */
const env = (k, d) => process.env[k] ?? d;

export const config = {
  siteName: env('SITE_NAME', 'search.peptides'),
  siteUrl: env('SITE_URL', 'http://localhost:8802').replace(/\/$/, ''),
  // The Moshpit name; a request for it without x-moshpit-name came over Moshpit DNS.
  moshpitName: env('MOSHPIT_NAME', 'search.peptides'),
  port: Number(env('PORT', 8802)),
  dbPath: env('DB_PATH', new URL('../data/peptides.db', import.meta.url).pathname),
  // Where the register is read from, and how often. ROLES=web,worker runs the sync in-process.
  sourceUrl: env('SOURCE_URL', 'https://peptidecompare.net/data.json'),
  syncHours: Number(env('SYNC_HOURS', 24)),
  roles: env('ROLES', 'web,worker').split(','),
  // Web processes sharing the port (SO_REUSEPORT); the first also runs the daemon when ROLES says so.
  webWorkers: Math.max(1, Number(env('WEB_WORKERS', 4)) || 1),
  coinpay: {
    baseUrl: env('COINPAY_API_URL', 'https://coinpayportal.com').replace(/\/+$/, '').replace(/\/api$/, ''),
    apiKey: env('COINPAY_API_KEY', ''),
    businessId: env('COINPAY_BUSINESS_ID', ''),
    webhookSecret: env('COINPAY_WEBHOOK_SECRET', ''),
  },
  // A sponsored vendor is pinned above matching results, labelled Sponsored, for this many days.
  sponsorUsd: Number(env('SPONSOR_USD', 49)),
  sponsorDays: Number(env('SPONSOR_DAYS', 30)),
  pitVerify: env('PIT_VERIFY', ''),
  crawlproofSite: env('CRAWLPROOF_SITE', '77a9fbb4-9997-4b2d-9be3-774d2d0508eb'),
  crawlproofAdSlot: env('CRAWLPROOF_AD_SLOT', ''),
  // ad.network publisher unit on the home page: claim code (verified from the raw HTML) + crawlproof slot.
  adNetworkClaim: env('AD_NETWORK_CLAIM', 'FKUKmlmS305hF-4C'),
  adNetworkSlot: env('AD_NETWORK_SLOT', '8e1ad4ad-2129-4a4a-88c3-179120731fcf'),
};
