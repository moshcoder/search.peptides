import { beforeAll, describe, expect, test } from 'bun:test';
import { invalidate } from '../src/service.js';
import { loadSnapshotIfEmpty } from '../src/sync.js';
import { app } from '../src/web/app.jsx';

beforeAll(() => {
  loadSnapshotIfEmpty();
  invalidate();
});

const get = async (path, headers = {}) => {
  const res = await app.request(path, { headers });
  return { res, body: await res.text() };
};
const graph = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1])['@graph'];

describe('answer-engine surfaces', () => {
  test('every page carries the site graph; a peptide page adds breadcrumbs, listings and answers', async () => {
    const { body } = await get('/p/glutathione');
    const types = graph(body).map((n) => n['@type']);
    expect(types).toEqual(['Organization', 'WebSite', 'BreadcrumbList', 'ItemList', 'FAQPage']);
    expect(body).toContain('quick answers');
    expect(body).toContain('summary_large_image');
    expect(body).toContain('/api/v1/peptides/glutathione');
    expect(body).not.toContain('1970-01-01');
  });

  test('a filtered peptide page keeps only the breadcrumbs', async () => {
    const { body } = await get('/p/glutathione?in_stock=1');
    expect(graph(body).map((n) => n['@type'])).toEqual(['Organization', 'WebSite', 'BreadcrumbList']);
  });

  test('robots names the AI crawlers and repeats the disallows for them', async () => {
    const { body } = await get('/robots.txt');
    expect(body).toContain('User-agent: GPTBot');
    expect(body).toContain('User-agent: ClaudeBot');
    expect(body.match(/Disallow: \/hooks\//g).length).toBe(2);
  });

  test('security.txt, llms-full.txt and the new pages answer', async () => {
    for (const path of ['/.well-known/security.txt', '/llms-full.txt', '/methodology', '/privacy', '/terms', '/og.png']) expect((await get(path)).res.status).toBe(200);
    expect((await get('/.well-known/security.txt')).body).toMatch(/^Contact: https:\/\/github\.com\/.*\nExpires: \d{4}-/);
  });

  test('no page needs unsafe-inline, and crawlproof waits for consent', async () => {
    for (const path of ['/', '/?text=bpc-157', '/p/glutathione', '/vendors', '/peptides', '/docs', '/sponsor', '/methodology', '/nope']) {
      const { res, body } = await get(path);
      expect(res.headers.get('content-security-policy')).not.toContain('unsafe-inline');
      const scripts = [...body.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
      expect(scripts.every((a) => /type="application\/ld\+json"|src="\/app\.js/.test(a))).toBe(true);
      expect(body).not.toMatch(/\son[a-z]+="|\sstyle="/);
      expect(body).not.toContain('crawlproof.com/stats.js');
      expect(body).toContain('id="consent"');
    }
    const vendor = (await get('/vendors')).body.match(/href="\/v\/([^"]+)"/)[1];
    const { body } = await get(`/v/${vendor}`);
    expect([...body.matchAll(/<script([^>]*)>/g)].every((m) => /ld\+json|\/app\.js/.test(m[1]))).toBe(true);
  });

  test('HSTS only through the pit.world relay', async () => {
    expect((await get('/', { host: 'search.peptides' })).res.headers.get('strict-transport-security')).toBeNull();
    expect((await get('/', { host: 'search.peptides', 'x-moshpit-name': 'search.peptides' })).res.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});
