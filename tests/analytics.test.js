/* Unit tests for the analytics block in index.html.
   Run: node --test tests/analytics.test.js
   Uses only Node's built-in test runner; no dependencies. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\* FM-ANALYTICS-START[\s\S]*?\/\* FM-ANALYTICS-END \*\//);
assert.ok(m, 'analytics block markers not found in index.html');
const SHIPPED = m[0];
const PLACEHOLDER_RE = /var LANG_ENDPOINT = '([^']*)';/;
const SHIPPED_LANG_ENDPOINT = SHIPPED.match(PLACEHOLDER_RE)[1];
const MAIN_ENDPOINT = SHIPPED.match(/var ENDPOINT = '([^']+)';/)[1];
const TEST_LANG = 'https://fm-lang-test.goatcounter.com/count';

const LANG_CODES = (() => {
  const block = html.match(/const LANGUAGES = \[([\s\S]*?)\];/)[1];
  return [...block.matchAll(/code:\s*'([a-z]+)'/g)].map(x => x[1]);
})();

/* Build a fake browser and run the analytics block in it.
   langEndpoint: string to inject as the language-site endpoint, or null to run the code exactly as shipped. */
function boot({ url = 'https://fminternational.online/?campaign=qr-tarjeta', webdriver = false, storage = {}, storageThrows = false, langEndpoint = TEST_LANG, imageThrows = false } = {}) {
  const code = langEndpoint === null ? SHIPPED : SHIPPED.replace(PLACEHOLDER_RE, `var LANG_ENDPOINT = '${langEndpoint}';`);
  const u = new URL(url);
  const store = { ...storage };
  const appended = [];
  const images = [];
  const win = {
    location: { search: u.search, hostname: u.hostname, protocol: u.protocol },
    navigator: { webdriver },
    localStorage: storageThrows ? {
      getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }
    } : {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    URLSearchParams,
    Image: function () { if (imageThrows) throw new Error('boom'); images.push(this); }
  };
  win.document = {
    head: { appendChild: el => appended.push(el) },
    createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } })
  };
  win.window = win;
  vm.runInNewContext(code, win);
  return { win, store, appended, images };
}
const q = img => new URL(img.src);

test('visitor site: production host loads the same GoatCounter script, endpoint, async', () => {
  const b = boot();
  assert.equal(b.appended.length, 1);
  assert.equal(b.appended[0].src, '//gc.zgo.at/count.js');
  assert.equal(b.appended[0].attrs['data-goatcounter'], 'https://fminternational.goatcounter.com/count');
  assert.equal(b.appended[0].async, true);
  assert.equal(b.win.fmAnalytics.status().reason, 'production');
});

test('visitor site: never sets no_onload or any setting, so automatic pageview and campaign query are untouched', () => {
  const b = boot();
  assert.equal(b.appended[0].attrs['data-goatcounter-settings'], undefined);
  assert.equal(b.win.goatcounter, undefined);
});

test('does not load or send on localhost, previews, github.io, file:', () => {
  for (const url of ['http://localhost:8000/', 'http://127.0.0.1/', 'https://mfm2712-droid.github.io/international/', 'https://some-preview.vercel.app/', 'file:///home/x/index.html']) {
    const b = boot({ url });
    assert.equal(b.appended.length, 0, url);
    assert.equal(b.win.fmAnalytics.status().enabled, false, url);
    assert.equal(b.win.fmAnalytics.languageClicked('en', 'de', true), null, url);
    assert.equal(b.images.length, 0, url);
  }
});

test('www production host is accepted', () => {
  assert.equal(boot({ url: 'https://www.fminternational.online/' }).appended.length, 1);
});

test('automated browsers are excluded from both sites', () => {
  const b = boot({ webdriver: true });
  assert.equal(b.appended.length, 0);
  assert.equal(b.win.fmAnalytics.status().reason, 'automated-browser');
  assert.equal(b.win.fmAnalytics.languageClicked('en', 'de', true), null);
  assert.equal(b.images.length, 0);
});

test('?analytics=force enables a non-production host for that load only, with allow_local', () => {
  const b = boot({ url: 'http://localhost:8000/?analytics=force', webdriver: true });
  assert.equal(b.appended.length, 1);
  assert.equal(b.win.goatcounter.allow_local, true);
  assert.equal(Object.keys(b.store).length, 0, 'force must not persist anything');
});

test('?analytics=force never overrides production rules on the production host', () => {
  const auto = boot({ url: 'https://fminternational.online/?analytics=force', webdriver: true });
  assert.equal(auto.appended.length, 0);
  assert.equal(auto.win.fmAnalytics.status().reason, 'automated-browser');
  assert.equal(auto.win.fmAnalytics.languageClicked('en', 'de', true), null);
  const norm = boot({ url: 'https://fminternational.online/?analytics=force' });
  assert.equal(norm.appended.length, 1);
  assert.equal(norm.win.fmAnalytics.status().reason, 'production');
  assert.equal(norm.win.goatcounter, undefined);
  const www = boot({ url: 'https://www.fminternational.online/?analytics=force', webdriver: true });
  assert.equal(www.appended.length, 0);
});

test('admin opt-out: ?analytics=off stores one flag and blocks both sites; ?analytics=on removes it', () => {
  const off = boot({ url: 'https://fminternational.online/?analytics=off' });
  assert.equal(off.appended.length, 0);
  assert.deepEqual(off.store, { 'fm-analytics-optout': '1' });
  assert.equal(off.win.fmAnalytics.status().reason, 'admin-opt-out');
  assert.equal(off.win.fmAnalytics.languageClicked('en', 'de', true), null);
  assert.equal(off.images.length, 0);

  const next = boot({ storage: off.store });
  assert.equal(next.appended.length, 0);
  assert.equal(next.win.fmAnalytics.languageClicked('en', 'de', true), null);

  const on = boot({ url: 'https://fminternational.online/?analytics=on', storage: off.store });
  assert.equal(on.appended.length, 1);
  assert.deepEqual(on.store, {});
});

test('opt-out wins over force', () => {
  const b = boot({ url: 'http://localhost/?analytics=force', storage: { 'fm-analytics-optout': '1' } });
  assert.equal(b.appended.length, 0);
  assert.equal(b.win.fmAnalytics.languageClicked('en', 'de', true), null);
});

test('normal customers have no flag and nothing is written to storage', () => {
  const b = boot();
  b.win.fmAnalytics.languageClicked('en', 'de', true);
  assert.deepEqual(b.store, {});
});

test('blocked localStorage does not break tracking or throw', () => {
  const b = boot({ storageThrows: true });
  assert.equal(b.appended.length, 1);
  assert.equal(b.win.fmAnalytics.languageClicked('en', 'de', true), 'language-selected-de');
});

test('opening the menu sends nothing to the language site; the visitor site gets only its automatic pageview', () => {
  const b = boot();
  assert.equal(b.win.fmAnalytics.menuOpened, undefined, 'no menu-opened API');
  assert.equal(b.images.length, 0);
  assert.equal(b.appended.length, 1);
});

test('a language event is one GET to the LANGUAGE site with only p, t, e, ns, rnd', () => {
  const b = boot({ url: 'https://fminternational.online/?campaign=qr-tarjeta&email=a@b.c' });
  b.win.fmAnalytics.languageClicked('en', 'fr', true);
  assert.equal(b.images.length, 1);
  const u = q(b.images[0]);
  assert.equal(u.origin + u.pathname, TEST_LANG);
  assert.deepEqual([...u.searchParams.keys()].sort(), ['e', 'ns', 'p', 'rnd', 't']);
  assert.equal(u.searchParams.get('p'), 'language-selected-fr');
  assert.equal(u.searchParams.get('t'), 'language-selected-fr');
  assert.equal(u.searchParams.get('e'), '1');
  assert.equal(u.searchParams.get('ns'), '1');
  assert.equal(b.images[0].referrerPolicy, 'no-referrer');
  assert.ok(!/campaign|email|qr-tarjeta|fminternational|https?%3A|online/i.test(u.search), 'no page URL, query or personal data in the request');
});

test('language events never touch the visitor site or its script', () => {
  const b = boot();
  let counted = 0;
  b.win.goatcounter = { count() { counted++; } };
  b.win.fmAnalytics.languageClicked('en', 'es', true);
  b.win.fmAnalytics.languageClicked('es', 'it', true);
  assert.equal(counted, 0, 'goatcounter.count (visitor site) must not be called for language events');
  for (const img of b.images) assert.ok(!img.src.startsWith(MAIN_ENDPOINT), 'must not go to the visitor site');
  assert.equal(b.images.length, 2);
});

test('language events do not wait for, or depend on, the visitor-site script', () => {
  const b = boot();                        /* count.js never loads or even fails: no onload/onerror needed */
  assert.equal(b.win.fmAnalytics.languageClicked('en', 'de', true), 'language-selected-de');
  assert.equal(b.images.length, 1);
});

test('a failing request never propagates to the menu', () => {
  const b = boot({ imageThrows: true });
  assert.doesNotThrow(() => b.win.fmAnalytics.languageClicked('en', 'es', true));
  assert.equal(b.win.fmAnalytics.languageClicked('es', 'it', true), null);
});

test('language site not configured (empty endpoint): nothing is sent', () => {
  const b = boot({ langEndpoint: '' });
  assert.equal(b.win.fmAnalytics.status().languageSite, false);
  assert.equal(b.win.fmAnalytics.languageClicked('en', 'de', true), null);
  assert.equal(b.images.length, 0);
  assert.equal(b.appended.length, 1, 'the visitor-site script still loads');
});

test('language endpoint as shipped is empty or a valid GoatCounter /count URL that differs from the visitor site', () => {
  assert.ok(SHIPPED_LANG_ENDPOINT === '' || /^https:\/\/[a-z0-9-]+\.goatcounter\.com\/count$/.test(SHIPPED_LANG_ENDPOINT), SHIPPED_LANG_ENDPOINT);
  assert.notEqual(SHIPPED_LANG_ENDPOINT, MAIN_ENDPOINT, 'language events must never go to the visitor site');
  const b = boot({ langEndpoint: null });      /* exactly as shipped */
  assert.equal(b.win.fmAnalytics.status().languageSite, SHIPPED_LANG_ENDPOINT !== '');
});

test('language events: first genuine switch is language-selected-<code>, later ones language-changed-<code>', () => {
  const b = boot();
  const a = b.win.fmAnalytics;
  assert.equal(a.languageClicked('en', 'de', true), 'language-selected-de');
  assert.equal(a.languageClicked('de', 'es', true), 'language-changed-es');
  assert.equal(a.languageClicked('es', 'de', true), 'language-changed-de', 'switching back is a legitimate repeat');
  assert.equal(a.languageClicked('de', 'es', true), 'language-changed-es');
  assert.deepEqual(b.images.map(i => q(i).searchParams.get('p')), ['language-selected-de', 'language-changed-es', 'language-changed-de', 'language-changed-es']);
});

test('re-clicking the already active language records nothing', () => {
  const b = boot();
  const a = b.win.fmAnalytics;
  a.languageClicked('en', 'fr', true);
  assert.equal(a.languageClicked('fr', 'fr', true), null);
  assert.equal(b.images.length, 1);
});

test('clicking English while English is shown records nothing and is not a selection or change', () => {
  const b = boot();
  const a = b.win.fmAnalytics;
  assert.equal(a.languageClicked('en', 'en', true), null);
  assert.equal(a.languageClicked('en', 'en', true), null);
  assert.equal(b.images.length, 0);
  assert.equal(a.languageClicked('en', 'de', true), 'language-selected-de');
  assert.equal(a.languageClicked('de', 'en', true), 'language-changed-en');
  assert.equal(a.languageClicked('en', 'en', true), null);
});

test('unknown language codes are ignored and do not consume the first-selection slot', () => {
  const b = boot();
  const a = b.win.fmAnalytics;
  assert.equal(a.languageClicked('en', 'xx', false), null);
  assert.equal(a.languageClicked('en', 'pt', true), 'language-selected-pt');
});

test('all 11 languages defined in index.html produce distinct, correctly named events', () => {
  assert.equal(LANG_CODES.length, 11);
  assert.deepEqual(LANG_CODES, ['en', 'es', 'it', 'pt', 'fr', 'de', 'ru', 'zh', 'ja', 'ko', 'ar']);
  const b = boot();
  const a = b.win.fmAnalytics;
  let prev = 'en';
  const names = [];
  LANG_CODES.forEach(c => {
    const n = a.languageClicked(prev, c, true);   /* 'en' first: already shown, so no event */
    if (n) names.push(n);
    prev = c;
  });
  assert.equal(names[0], 'language-selected-es');
  assert.deepEqual(names.slice(1), LANG_CODES.slice(2).map(c => 'language-changed-' + c));
  assert.equal(names.length, 10);
  assert.equal(a.languageClicked('ar', 'en', true), 'language-changed-en');
  assert.equal(new Set(names.concat('language-changed-en')).size, 11);
  assert.equal(b.images.length, 11);
});

test('QR destination and campaign identifier are unchanged in index.html', () => {
  assert.ok(html.includes("window.location.origin + window.location.pathname + '?campaign=qr-tarjeta'"));
});
