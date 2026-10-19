// config.js reads env once per process, so the test database is chosen before anything imports it.
process.env.DB_PATH = ':memory:';
process.env.SITE_URL = 'https://search.peptides.test';
process.env.COINPAY_API_KEY = 'cp_test_0123456789abcdef0123456789abcdef';
process.env.COINPAY_BUSINESS_ID = 'biz_test';
process.env.COINPAY_WEBHOOK_SECRET = 'whsec_test';
