/* Browser check (optional; needs Playwright + Chromium, which are NOT repo dependencies).
   Serves index.html on the production hostname via request interception and replaces
   gc.zgo.at/count.js with a stub that records hits the way the real script documents them
   (pageview: path + query). Language events are sent as image requests to a stand-in "language site"
   host that is intercepted and recorded. No real analytics traffic is sent.

   Run: NODE_PATH=<dir containing playwright> ORIGINAL=<copy of original index.html> node tests/browser.check.js
   ORIGINAL is optional; when given, rendering of every language is compared with it. */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SHIPPED_HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const MAIN_URL = SHIPPED_HTML.match(/var ENDPOINT = '([^']+)';/)[1];
/* Use the language endpoint exactly as shipped; fall back to a stand-in only while it is still blank. */
const LANG_URL = SHIPPED_HTML.match(/var LANG_ENDPOINT = '([^']*)';/)[1] || 'https://fm-lang-test.goatcounter.com/count';
assert.notEqual(LANG_URL, MAIN_URL, 'language site must differ from the visitor site');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const NEW = SHIPPED_HTML.replace(/var LANG_ENDPOINT = '[^']*';/, `var LANG_ENDPOINT = '${LANG_URL}';`);
const ORIG = process.env.ORIGINAL ? fs.readFileSync(process.env.ORIGINAL, 'utf8') : null;
const PROD = 'https://fminternational.online/';
const CODES = ['en', 'es', 'it', 'pt', 'fr', 'de', 'ru', 'zh', 'ja', 'ko', 'ar'];

const COUNT_STUB = `
(function(){
  var s = document.querySelector('script[data-goatcounter]');
  window.__gcLog = window.__gcLog || [];
  window.goatcounter = window.goatcounter || {};
  window.goatcounter.count = function(v){
    v = v || {};
    window.__gcLog.push({ kind: v.event ? 'event' : 'pageview', path: v.path, q: location.search, no_session: !!v.no_session, endpoint: s && s.getAttribute('data-goatcounter') });
  };
  window.goatcounter.count({});   /* the real script sends one automatic pageview on load */
})();`;
const QR_STUB = `window.__qrTexts=[];window.QRCode=function(el,o){window.__qrTexts.push(o.text);el.setAttribute('data-qr',o.text);};window.QRCode.CorrectLevel={H:1};`;

async function newPage(browser, html, { url = PROD, abortCount = false, abortLang = false, ctxOpts = {}, context } = {}) {
  const ctx = context || await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  const countRequests = [];
  const langRequests = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(LANG_URL)) {
      langRequests.push({ url: u, referer: route.request().headers()['referer'] });
      return abortLang ? route.abort() : route.fulfill({ status: 200, contentType: 'image/gif', body: GIF });
    }
    if (u.includes('gc.zgo.at/count.js')) {
      countRequests.push(u);
      return abortCount ? route.abort() : route.fulfill({ contentType: 'application/javascript', body: COUNT_STUB });
    }
    if (u.includes('qrcode')) return route.fulfill({ contentType: 'application/javascript', body: QR_STUB });
    if (u.startsWith('https://fonts.') ) return route.abort();
    if (u.split('?')[0].replace(/\/$/, '') === url.split('?')[0].replace(/\/$/, '') || u.split('?')[0].endsWith('/')) {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    return route.abort();
  });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(150);
  return { page, ctx, errors, countRequests, langRequests };
}
const langNames = (r) => r.langRequests.map(x => new URL(x.url).searchParams.get('p'));
const log = (page) => page.evaluate(() => window.__gcLog || []);
/* wait until the language row has stopped smooth-scrolling and transitions are done */
async function settle(page) {
  let last = null, same = 0;
  for (let i = 0; i < 40 && same < 3; i++) {
    const v = await page.evaluate(() => document.getElementById('langRow').scrollLeft + ':' + scrollY);
    same = v === last ? same + 1 : 0; last = v;
    await page.waitForTimeout(100);
  }
}

(async () => {
  const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  const results = [];
  const ok = (name) => { results.push(name); console.log('PASS', name); };

  /* 1. Production load: one pageview carrying the campaign query, no custom event, same endpoint */
  {
    const { page, errors, countRequests, langRequests } = await newPage(browser, NEW, { url: PROD + '?campaign=qr-tarjeta' });
    const l = await log(page);
    const pv = l.filter(x => x.kind === 'pageview'), ev = l.filter(x => x.kind === 'event');
    assert.equal(countRequests.length, 1, 'count.js requested once');
    assert.equal(pv.length, 1, 'exactly one pageview');
    assert.equal(pv[0].q, '?campaign=qr-tarjeta', 'campaign query present on the pageview');
    assert.equal(pv[0].endpoint, 'https://fminternational.goatcounter.com/count');
    assert.deepEqual(ev, [], 'opening the menu sends only the automatic pageview');
    assert.deepEqual(langRequests, [], 'opening the menu sends nothing to the language site');
    assert.deepEqual(errors, []);
    ok('production load: 1 pageview with ?campaign=qr-tarjeta to the visitor site, nothing to the language site, no JS errors');
    await page.context().close();
  }

  /* 2. All 11 languages, clicked in order from the real chips; events go ONLY to the language site */
  {
    const r = await newPage(browser, NEW, { url: PROD + '?campaign=qr-tarjeta' });
    const { page, errors } = r;
    const chips = await page.$$eval('.lang-chip', els => els.map(e => e.getAttribute('data-lang')));
    assert.deepEqual(chips, CODES, 'chips match the 11 defined languages');
    for (const c of CODES) {
      await page.click(`.lang-chip[data-lang="${c}"]`);
      assert.equal(await page.evaluate(() => document.documentElement.lang), c);
    }
    await page.waitForTimeout(150);
    /* English is already shown, so the first click on it records nothing */
    assert.deepEqual(langNames(r), ['language-selected-es', ...CODES.slice(2).map(c => 'language-changed-' + c)]);
    /* repeat selection after switching away is recorded; same-language re-click is not */
    await page.click('.lang-chip[data-lang="de"]');
    await page.click('.lang-chip[data-lang="de"]');
    await page.click('.lang-chip[data-lang="ar"]');
    await page.waitForTimeout(150);
    assert.deepEqual(langNames(r).slice(-2), ['language-changed-de', 'language-changed-ar']);
    const l = await log(page);
    assert.equal(l.filter(x => x.kind === 'pageview').length, 1, 'language clicks create no extra visitor-site pageviews');
    assert.equal(l.filter(x => x.kind === 'event').length, 0, 'no language event goes through the visitor-site script');
    assert.equal(r.countRequests.length, 1, 'visitor-site script loaded once');
    assert.equal(l.find(x => x.kind === 'pageview').endpoint, MAIN_URL, 'pageview goes to the visitor site');
    assert.ok(r.langRequests.length > 0 && r.langRequests.every(x => x.url.startsWith(LANG_URL + '?')), 'every language event goes to the language site');
    assert.ok(r.langRequests.every(x => !x.url.startsWith(MAIN_URL)), 'no language event reaches the visitor site');
    for (const x of r.langRequests) {
      const u = new URL(x.url);
      assert.deepEqual([...u.searchParams.keys()].sort(), ['e', 'ns', 'p', 'rnd', 't']);
      assert.equal(u.searchParams.get('e'), '1');
      assert.ok(!/campaign|qr-tarjeta|fminternational|https?%3A|online/i.test(u.search), 'no page URL or campaign in the language request query');
      assert.equal(x.referer, undefined, 'no Referer header sent to the language site');
    }
    assert.deepEqual(errors, []);
    ok('11 languages: events only to the language site (p,t,e,ns,rnd; no URL, campaign or Referer); visitor site still has exactly 1 pageview');
    await page.context().close();
  }

  /* 3. Rendering identical to the original for every language (DOM text + screenshot) */
  if (ORIG) {
    for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      const a = await newPage(browser, ORIG, { ctxOpts: { viewport: vp } });
      const b = await newPage(browser, NEW, { ctxOpts: { viewport: vp } });
      for (const c of CODES) {
        for (const p of [a.page, b.page]) { await p.click(`.lang-chip[data-lang="${c}"]`); await settle(p); }
        const [ta, tb] = await Promise.all([a.page, b.page].map(p => p.evaluate(() => document.querySelector('.menu-wrap').outerHTML)));
        assert.equal(ta, tb, `DOM differs for ${c} @${vp.width}`);
        /* Pixel-compare with retries: a real regression differs on every attempt; mid-transition frames do not. */
        let same = false;
        for (let attempt = 0; attempt < 5 && !same; attempt++) {
          await a.page.waitForTimeout(500); await settle(a.page); await settle(b.page);
          const sa = await a.page.screenshot({ fullPage: true, animations: 'disabled' });
          const sb = await b.page.screenshot({ fullPage: true, animations: 'disabled' });
          same = sa.equals(sb);
        }
        assert.ok(same, `screenshot differs persistently for ${c} @${vp.width}`);
      }
      const dir = await Promise.all([a.page, b.page].map(p => p.evaluate(() => [document.documentElement.lang, document.documentElement.dir])));
      assert.deepEqual(dir[0], dir[1]);
      await a.ctx.close(); await b.ctx.close();
    }
    ok('rendering: DOM and full-page screenshots byte-identical to original for all 11 languages at 390px and 1280px');
  }

  /* 4. QR destination unchanged */
  {
    const a = ORIG ? await newPage(browser, ORIG) : null;
    const b = await newPage(browser, NEW);
    const qb = await b.page.evaluate(() => ({ texts: window.__qrTexts, shown: document.getElementById('qrUrlText').textContent }));
    assert.ok(qb.texts.includes('https://fminternational.online/?campaign=qr-tarjeta'));
    assert.equal(qb.shown, 'https://fminternational.online/?campaign=qr-tarjeta');
    if (a) {
      const qa = await a.page.evaluate(() => ({ texts: window.__qrTexts, shown: document.getElementById('qrUrlText').textContent }));
      assert.deepEqual(qa, qb);
      await a.ctx.close();
    }
    ok('QR destination and shown URL identical to original: https://fminternational.online/?campaign=qr-tarjeta');
    await b.ctx.close();
  }

  /* 5. Either site blocked: menu works, no errors, no retries */
  {
    const r = await newPage(browser, NEW, { abortCount: true });
    for (const c of CODES) await r.page.click(`.lang-chip[data-lang="${c}"]`);
    await r.page.waitForTimeout(150);
    assert.equal(await r.page.evaluate(() => document.documentElement.dir), 'rtl');
    assert.deepEqual(r.errors, []);
    assert.equal(r.countRequests.length, 1, 'no retries');
    assert.equal(langNames(r).length, 10, 'language site is independent of the visitor script');
    ok('visitor script blocked: all 11 languages still switch, no JS errors, no retries, language events unaffected');
    await r.page.context().close();

    const r2 = await newPage(browser, NEW, { abortLang: true });
    for (const c of CODES) await r2.page.click(`.lang-chip[data-lang="${c}"]`);
    await r2.page.waitForTimeout(150);
    assert.equal(await r2.page.evaluate(() => document.documentElement.dir), 'rtl');
    assert.deepEqual(r2.errors, []);
    assert.equal((await log(r2.page)).filter(x => x.kind === 'pageview').length, 1, 'visitor pageview unaffected');
    assert.equal(r2.langRequests.length, 10, 'one attempt per event, no retries');
    ok('language site blocked: menu works, no JS errors, no retries, visitor pageview unaffected');
    await r2.page.context().close();
  }

  /* 6. Exclusions make no analytics request at all */
  for (const [label, url, launchWebdriver] of [
    ['localhost', 'http://localhost:8123/', false],
    ['github pages preview', 'https://mfm2712-droid.github.io/international/', false],
    ['vercel-style preview', 'https://international-git-x.vercel.app/', false],
  ]) {
    const r = await newPage(browser, NEW, { url });
    assert.equal(r.countRequests.length, 0, label);
    assert.deepEqual(await log(r.page), []);
    await r.page.click('.lang-chip[data-lang="de"]');
    await r.page.waitForTimeout(100);
    assert.deepEqual(r.errors, []);
    assert.equal(r.langRequests.length, 0, label);
    ok(`excluded host (${label}): nothing sent to either site, language switching still works`);
    await r.page.context().close();
  }
  {
    const b2 = await chromium.launch(); /* default Playwright Chromium: navigator.webdriver === true */
    const ctx = await b2.newContext(); const page = await ctx.newPage();
    let reqs = 0, lang = 0;
    await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith(LANG_URL)) { lang++; return r.abort(); } if (u.includes('gc.zgo.at')) { reqs++; return r.abort(); } if (u.startsWith(PROD)) return r.fulfill({ contentType: 'text/html', body: NEW }); return r.abort(); });
    await page.goto(PROD); await page.waitForTimeout(150);
    await page.click('.lang-chip[data-lang="de"]'); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => navigator.webdriver), true);
    assert.equal(reqs, 0);
    assert.equal(lang, 0);
    ok('automated browser (navigator.webdriver=true) on production host: nothing sent to either site');
    await b2.close();
  }

  /* 6b. ?analytics=force must not override production rules (automated browser stays excluded on production) */
  {
    const b2 = await chromium.launch(); /* webdriver === true */
    const ctx = await b2.newContext(); const page = await ctx.newPage();
    let reqs = 0, lang = 0;
    await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith(LANG_URL)) { lang++; return r.abort(); } if (u.includes('gc.zgo.at')) { reqs++; return r.abort(); } if (u.startsWith(PROD)) return r.fulfill({ contentType: 'text/html', body: NEW }); return r.abort(); });
    await page.goto(PROD + '?analytics=force'); await page.waitForTimeout(150);
    await page.click('.lang-chip[data-lang="de"]'); await page.waitForTimeout(100);
    assert.equal(reqs, 0);
    assert.equal(lang, 0);
    assert.equal(await page.evaluate(() => window.fmAnalytics.status().reason), 'automated-browser');
    ok('?analytics=force on the production host does not override the automated-browser exclusion');
    await b2.close();
    const f = await newPage(browser, NEW, { url: 'http://localhost:8123/?analytics=force' });
    assert.equal(f.countRequests.length, 1);
    assert.equal((await log(f.page)).filter(x => x.kind === 'pageview').length, 1);
    await f.page.click('.lang-chip[data-lang="de"]'); await f.page.waitForTimeout(100);
    assert.deepEqual(langNames(f), ['language-selected-de']);
    ok('?analytics=force on a non-production host enables tracking for that load (1 pageview, language events to the language site)');
    await f.ctx.close();
  }

  /* 7. Admin opt-out toggle persists across visits in the same browser profile */
  {
    const ctx = await browser.newContext();
    let r = await newPage(browser, NEW, { url: PROD + '?analytics=off', context: ctx });
    assert.equal(r.countRequests.length, 0);
    await r.page.click('.lang-chip[data-lang="de"]'); await r.page.waitForTimeout(100);
    assert.equal(r.langRequests.length, 0, 'opted out: no language events either');
    assert.equal(await r.page.evaluate(() => localStorage.getItem('fm-analytics-optout')), '1');
    r = await newPage(browser, NEW, { url: PROD + '?campaign=qr-tarjeta', context: ctx });
    assert.equal(r.countRequests.length, 0, 'still opted out on a later visit');
    r = await newPage(browser, NEW, { url: PROD + '?analytics=on', context: ctx });
    assert.equal(r.countRequests.length, 1);
    assert.equal(await r.page.evaluate(() => localStorage.getItem('fm-analytics-optout')), null);
    r = await newPage(browser, NEW, { url: PROD, context: ctx });
    assert.equal(r.countRequests.length, 1, 'tracking resumed');
    ok('admin opt-out: ?analytics=off persists and blocks both sites; ?analytics=on removes the flag and resumes');
    await ctx.close();
  }

  /* 8. Fresh customer profile has nothing stored by the menu */
  {
    const { page } = await newPage(browser, NEW);
    await page.click('.lang-chip[data-lang="fr"]');
    const stored = await page.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, ck: document.cookie }));
    assert.deepEqual(stored, { ls: 0, ss: 0, ck: '' });
    ok('customer browser: no localStorage, sessionStorage or cookies written by the menu');
    await page.context().close();
  }

  await browser.close();
  console.log(`\n${results.length} browser checks passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
