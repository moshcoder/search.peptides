import { expect, test } from 'bun:test';
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
  const html = await (await app.request('/docs')).text();
  expect(html.match(/data-pit-footer/g)?.length).toBe(1);
  expect(html).toMatch(/<\/footer>[\s\S]*data-pit-footer[\s\S]*<\/nav>\s*<\/body>/);
  expect(html.slice(html.indexOf('<footer'))).not.toContain('data-cp-ad');
  const stop2 = startPitFooterRefresh('search.peptides', async () => { throw new Error('down'); });
  await new Promise((r) => setTimeout(r, 10));
  stop2();
  expect(pitFooter()).toContain('data-pit-footer');
});
