import { emitKeypressEvents } from 'node:readline';

/**
 * The TUI: a search box on top, results below, live as you type.
 *
 *   type        search listings (debounced)
 *   ↑ ↓         move
 *   enter       open the vendor of the selected listing (contact card, lab tests)
 *   tab         switch between listings and vendors
 *   esc         back / clear     ctrl-c  quit
 */
export async function runTui({ api }) {
  const out = process.stdout;
  if (!process.stdin.isTTY) throw new Error('tui needs a terminal');
  const g = (s) => `\x1b[38;5;155m${s}\x1b[0m`;
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const inv = (s) => `\x1b[7m${s}\x1b[0m`;
  const pad = (s, n) => {
    s = String(s ?? '');
    return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
  };
  const usd = (n) => (Number.isFinite(n) ? `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}` : '—');
  const mg = (o) => (Number.isFinite(o.usd_per_mg) ? `$${o.usd_per_mg.toFixed(o.usd_per_mg < 1 ? 3 : 2)}/${o.unit ?? 'mg'}` : '—');

  const st = { text: '', tab: 'listings', listings: null, vendors: null, sel: 0, detail: null, busy: false, err: null };
  let timer = null;

  const run = async () => {
    st.busy = true;
    draw();
    try {
      if (st.tab === 'listings') st.listings = await api('/api/v1/search', { text: st.text || undefined, limit: 100 });
      else st.vendors = await api('/api/v1/vendors', { q: st.text || undefined, limit: 100 });
      st.err = null;
      st.sel = 0;
    } catch (err) {
      st.err = err.message;
    }
    st.busy = false;
    draw();
  };

  const rowsNow = () => (st.tab === 'listings' ? (st.listings?.offers ?? []) : (st.vendors?.vendors ?? []));

  function draw() {
    const rows = out.rows ?? 30;
    const cols = out.columns ?? 100;
    const lines = [];
    lines.push(`${g('⌬ search.peptides')} ${dim('every peptide vendor, compared')}${st.busy ? dim('  …') : ''}`);
    lines.push(`${g('›')} ${st.text}${inv(' ')}`);
    const r = st.tab === 'listings' ? st.listings : st.vendors;
    if (r?.query?.understood?.length) lines.push(dim(`  read as: ${r.query.understood.join(' · ')}`));
    lines.push(dim(`  [${st.tab === 'listings' ? 'LISTINGS' : 'listings'}${st.listings ? ` ${st.listings.total}` : ''}]  [${st.tab === 'vendors' ? 'VENDORS' : 'vendors'}${st.vendors ? ` ${st.vendors.total}` : ''}]   tab switch · ↑↓ move · enter vendor · esc back · ctrl-c quit`));
    lines.push('');
    if (st.err) lines.push(`  error: ${st.err}`);
    if (st.detail) {
      const v = st.detail;
      lines.push(`  ${g(v.name)}  ${dim(v.ships_from.join(', ') || v.location || '')}`);
      lines.push(`  score ${v.score ?? '—'} · lab ${v.tests_pass}/${v.tests_pass + v.tests_fail} passed · ${v.offers} listings`);
      lines.push('');
      for (const e of v.contact.emails) lines.push(`  email     ${e}`);
      for (const p of v.contact.phones) lines.push(`  phone     ${p}`);
      for (const w of v.contact.websites) lines.push(`  website   ${w}`);
      for (const [k, l] of Object.entries(v.contact.socials)) for (const u of l) lines.push(`  ${pad(k, 9)} ${u}`);
      lines.push('', `  pay ${v.payments_raw.join(', ') || '—'}`);
      for (const t of v.lab_tests.slice(0, 8)) lines.push(dim(`  ${pad(t.peptide, 28)} ${pad(t.result, 6)} ${t.tested_on ?? ''}`));
      lines.push('', `  ${g(v.page)}`);
    } else if (st.tab === 'listings' && st.listings) {
      lines.push(dim(`  ${pad('listing', 38)}${pad('vendor', 24)}${pad('price', 8)}${pad('per mg', 12)}score`));
      rowsNow().slice(0, rows - lines.length - 2).forEach((o, i) => {
        const line = `  ${pad(o.name ?? o.peptide, 38)}${pad(o.vendor_name, 24)}${pad(usd(o.price_usd), 8)}${pad(mg(o), 12)}${o.vendor_score ?? '—'}${o.passed_test ? ' ✓' : ''}`;
        lines.push(i === st.sel ? inv(pad(line, cols - 1)) : line);
      });
    } else if (st.tab === 'vendors' && st.vendors) {
      lines.push(dim(`  ${pad('vendor', 32)}${pad('score', 7)}${pad('lab', 12)}${pad('listings', 10)}contact`));
      rowsNow().slice(0, rows - lines.length - 2).forEach((v, i) => {
        const reach = [v.contact.emails[0], v.contact.phones[0], ...Object.keys(v.contact.socials)].filter(Boolean).join(' ');
        const line = `  ${pad(v.name, 32)}${pad(v.score ?? '—', 7)}${pad(v.tests_pass + v.tests_fail ? `${v.tests_pass}/${v.tests_pass + v.tests_fail}` : '—', 12)}${pad(v.offers || '—', 10)}${reach}`;
        lines.push(i === st.sel ? inv(pad(line, cols - 1)) : line);
      });
    }
    out.write(`\x1b[H\x1b[2J${lines.slice(0, rows - 1).map((l) => l.slice(0, cols + 40)).join('\n')}`);
  }

  out.write('\x1b[?1049h\x1b[?25l');
  const restore = () => out.write('\x1b[?25h\x1b[?1049l');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  out.on('resize', draw);
  await run();

  await new Promise((resolve) => {
    process.stdin.on('keypress', async (ch, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        restore();
        resolve();
        process.exit(0);
      }
      const n = rowsNow().length;
      if (key.name === 'escape') {
        if (st.detail) st.detail = null;
        else {
          st.text = '';
          run();
        }
        return draw();
      }
      if (key.name === 'tab') {
        st.tab = st.tab === 'listings' ? 'vendors' : 'listings';
        st.detail = null;
        if (!(st.tab === 'listings' ? st.listings : st.vendors)) run();
        return draw();
      }
      if (key.name === 'up') {
        st.sel = Math.max(0, st.sel - 1);
        return draw();
      }
      if (key.name === 'down') {
        st.sel = Math.min(n - 1, st.sel + 1);
        return draw();
      }
      if (key.name === 'return') {
        const row = rowsNow()[st.sel];
        const slug = st.tab === 'listings' ? row?.vendor : row?.slug;
        if (slug) {
          st.detail = await api(`/api/v1/vendors/${slug}`).catch(() => null);
          draw();
        }
        return;
      }
      if (key.name === 'backspace') st.text = st.text.slice(0, -1);
      else if (ch && !key.ctrl && !key.meta && ch >= ' ') st.text += ch;
      else return;
      st.detail = null;
      clearTimeout(timer);
      timer = setTimeout(run, 220);
      draw();
    });
  });
}
