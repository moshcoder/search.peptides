// Every script the pages run, in one file, so the CSP needs no 'unsafe-inline'.
(function () {
  var me = document.currentScript;
  var cfg = (me && me.dataset) || {};
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /* ---------- the facet rail opens as a drawer on a phone ---------- */
  var rail = document.getElementById('facets');
  if (rail) {
    $$('[data-open-facets]').forEach(function (b) {
      b.addEventListener('click', function () { rail.classList.add('open'); document.body.style.overflow = 'hidden'; });
    });
    $$('[data-close-facets]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); rail.classList.remove('open'); document.body.style.overflow = ''; });
    });
  }

  /* ---------- sort: a pick with the mouse applies at once; with the keyboard, on Enter or on leaving ---------- */
  $$('.sort-form select[name=sort]').forEach(function (sel) {
    var start = sel.value, keyed = false;
    var go = function () { if (sel.value !== start) sel.form.submit(); };
    sel.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); go(); } else if (e.key !== 'Tab') keyed = true;
    });
    sel.addEventListener('change', function () { if (!keyed) go(); });
    sel.addEventListener('blur', function () { if (keyed) go(); });
  });

  /* ---------- vendor page: filter the listings table as you type ---------- */
  var vf = document.getElementById('vfilter');
  if (vf) {
    var rows = $$('#vlist tbody tr');
    vf.addEventListener('input', function () {
      var words = vf.value.toLowerCase().split(/\s+/).filter(Boolean);
      rows.forEach(function (r) { r.hidden = !words.every(function (w) { return r.dataset.q.indexOf(w) !== -1; }); });
    });
  }

  /* ---------- consent: crawlproof's counter and ads store an id, so they load only after a yes ---------- */
  var KEY = 'sp-consent';
  var read = function () { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  var save = function (v) { try { localStorage.setItem(KEY, v); } catch (e) {} };
  var load = function (src, attrs) {
    var s = document.createElement('script');
    s.src = src; s.async = true;
    for (var k in attrs) s.setAttribute(k, attrs[k]);
    document.head.appendChild(s);
  };
  var start = function () {
    if (cfg.stats) load('https://crawlproof.com/stats.js', { 'data-site': cfg.stats });
    if (!cfg.ads) return;
    // crawlproof's script-free frame: the ad renders in crawlproof's own document, so this page's CSP stays strict.
    $$('[data-cp-ad]').forEach(function (e) {
      var slot = e.getAttribute('data-slot') || e.getAttribute('data-site-ad');
      if (!slot) return;
      var wide = e.hasAttribute('data-site-ad') && matchMedia('(min-width: 760px)').matches;
      var f = document.createElement('iframe');
      f.src = 'https://crawlproof.com/api/ads/frame?slot=' + encodeURIComponent(slot) + '&format=' + (wide ? 'banner_728x90' : e.getAttribute('data-format') || 'banner_300x250') + '&theme=dark';
      f.width = wide ? 728 : 300;
      f.height = wide ? 90 : 250;
      f.title = 'Advertisement';
      f.loading = 'lazy';
      f.setAttribute('scrolling', 'no');
      e.appendChild(f);
    });
  };
  var bar = document.getElementById('consent');
  var answer = read();
  if (answer === 'yes') start();
  else if (!answer && navigator.globalPrivacyControl) save('no');
  else if (!answer && bar && (cfg.stats || cfg.ads)) {
    bar.hidden = false;
    bar.addEventListener('click', function (e) {
      var v = e.target.getAttribute && e.target.getAttribute('data-consent');
      if (!v) return;
      save(v);
      bar.hidden = true;
      if (v === 'yes') start();
    });
  }
  // The footer link reopens the question.
  $$('[data-consent-reset]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); try { localStorage.removeItem(KEY); } catch (x) {} location.reload(); });
  });
})();
