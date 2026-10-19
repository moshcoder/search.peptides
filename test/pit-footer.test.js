import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { pitFooter, setPitFooter, startPitFooterRefresh } from '../src/pit-footer.ts';
import { app } from '../src/web/app.jsx';

test('pit.world footer: nothing until read, then the last thing in <body>; no ad at the footer', async () => {
  expect(setPitFooter('<p>not the footer</p>')).toBe(false);
  expect(pitFooter()).toBe('');
  const frag = '<style>.pit-foot{}</style><nav class="pit-foot" data-pit-footer>x</nav>';
  const stop = startPitFooterRefresh('search.peptides', async (url) => {
    expect(url).toBe('https://pit.world/snippets/footer.html?site=search.peptides');
    return new Response(frag);
  });
  await new Promise((r) => setTimeout(r, 10));
  stop();
  const res = await app.request('/docs');
  const html = await res.text();
  // Its <style> is allowed by hash, so the page's CSP needs no 'unsafe-inline'.
  expect(res.headers.get('content-security-policy')).toContain(`style-src 'self' 'sha256-${createHash('sha256').update('.pit-foot{}').digest('base64')}';`);
  expect(html.match(/data-pit-footer/g)?.length).toBe(1);
  expect(html).toMatch(/<\/footer>[\s\S]*data-pit-footer[\s\S]*<\/nav>\s*<\/body>/);
  expect(html.slice(html.indexOf('<footer'))).not.toContain('data-cp-ad');
  const stop2 = startPitFooterRefresh('search.peptides', async () => { throw new Error('down'); });
  await new Promise((r) => setTimeout(r, 10));
  stop2();
  expect(pitFooter()).toContain('data-pit-footer');
});

test('Profullstack webring row + built.indie badge: server-rendered, no inline style, between the site footer and the pit footer', async () => {
  const html = await (await app.request('/docs')).text();
  const ring = html.indexOf('class="pfs-footer"');
  expect(ring).toBeGreaterThan(html.indexOf('class="wrap foot"'));
  expect(html).toContain('https://rssamplifier.com/ring/profullstack/next?from=https%3A%2F%2Fsearch.peptides.pit.world%2F');
  expect(html).toContain('href="https://built.indie.pit.world/for?site=https://search.peptides.pit.world/"');
  expect(html.slice(ring, html.indexOf('</footer>', ring))).not.toContain('<style');
  const pit = html.indexOf('data-pit-footer');
  if (pit > -1) expect(pit).toBeGreaterThan(ring);
});
