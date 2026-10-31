import { expect, test } from 'bun:test';
import { app } from '../src/web/app.jsx';

test('the universal footer is the only footer; no ad at the footer', async () => {
  const res = await app.request('/docs');
  const html = await res.text();
  expect(res.headers.get('content-security-policy')).toContain("style-src 'self'");
  expect(html.match(/<footer/g)?.length).toBe(1);
  expect(html).toContain('class="pfs-footer"');
  expect(html).not.toContain('data-pit-footer');
  expect(html.slice(html.indexOf('<footer'))).not.toContain('data-cp-ad');
});

test('the shared footer carries the ring and publisher badges without inline CSS', async () => {
  const html = await (await app.request('/docs')).text();
  const ring = html.indexOf('class="pfs-footer"');
  expect(ring).toBeGreaterThan(html.indexOf('class="wrap foot"'));
  expect(html).toContain('https://rssamplifier.com/ring/profullstack/next?from=https%3A%2F%2Fsearch.peptides.pit.world%2F');
  expect(html).toContain('href="https://built.indie.pit.world/for?site=https://search.peptides.pit.world/"');
  expect(html).toContain('src="https://pwamart.com/for.svg?site=https://search.peptides.pit.world/"');
  expect(html.slice(ring, html.indexOf('</footer>', ring))).not.toContain('<style');
  expect(html).not.toContain('data-pit-footer');
});
