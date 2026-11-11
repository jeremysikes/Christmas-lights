// Screenshots of the sample house for a last look before shipping (not a test: it checks nothing).
//
//   node build.js && node tests/e2e/final-shots.mjs
//
// Writes tests/e2e/out/final-<step>-<width>.png for step 4 (Design), 5 (Power) and 6 (Review) at 1280x800 and
// 390x844, with Christmas Lights Etc chosen as the supplier, plus final-<step>-<width>-p<n>.png: the same step
// with the panel scrolled one screen further each time, so the whole panel can be read.
//   LP_SUPPLIER=1000bulbs node tests/e2e/final-shots.mjs     another supplier ('generic' for Any store)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const APP = process.env.LP_APP ? path.resolve(process.env.LP_APP) : path.resolve(HERE, '../../dist/lightplan.html');
const SUPPLIER = process.env.LP_SUPPLIER || 'cle';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(APP)) { console.error('dist/lightplan.html is missing. Run "node build.js" first.'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
for (const [width, height, touch] of [[1280, 800, false], [390, 844, true]]) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + APP);
  await page.waitForFunction(() => !!(window.LightPlanApp && window.LightPlanApp.store) && !document.querySelector('.panel-loading'), null, { timeout: 15000 });
  await sleep(500);
  await page.evaluate((id) => { const a = window.LightPlanApp.actions; a.setSupplier(id); a.dismissBanner(); }, SUPPLIER);
  for (const step of [4, 5, 6]) {
    await page.click('button.step[data-step="' + step + '"]');
    await sleep(500);
    await page.evaluate(() => { document.getElementById('panel-root').scrollTop = 0; window.LightPlanApp.store.setUI({ toast: null }); });
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, 'final-' + step + '-' + width + '.png') });
    // The rest of the panel, a screen at a time (the phone's sheet raised so more of it shows).
    if (touch) { await page.evaluate(() => window.LightPlanApp.actions.setSheet('full')); await sleep(400); }
    const pages = await page.evaluate(() => { const r = document.getElementById('panel-root'); return { h: r.clientHeight, total: r.scrollHeight }; });
    const n = Math.min(14, Math.ceil(pages.total / Math.max(1, pages.h - 40)));
    for (let i = 1; i < n; i++) {
      await page.evaluate(([k, h]) => { document.getElementById('panel-root').scrollTop = k * (h - 40); }, [i, pages.h]);
      await sleep(200);
      await page.screenshot({ path: path.join(OUT, 'final-' + step + '-' + width + '-p' + (i + 1) + '.png') });
    }
    if (touch) { await page.evaluate(() => window.LightPlanApp.actions.setSheet('half')); await sleep(300); }
    console.log('step ' + step + ' at ' + width + ' px: ' + n + ' screen' + (n === 1 ? '' : 's'));
  }
  if (errors.length) console.log('page errors at ' + width + ': ' + errors.slice(0, 3).join(' | '));
  await context.close();
}
await browser.close();
console.log('Screenshots in tests/e2e/out/final-*.png');
