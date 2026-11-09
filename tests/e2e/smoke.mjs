// LightPlan end-to-end smoke test (Playwright + Chromium).
//
// Usage:
//   npm run e2e                          build dist/ and run every pass (phone, desktop, desktop dark)
//   node tests/e2e/smoke.mjs             run against the existing dist/lightplan.html
//   node tests/e2e/smoke.mjs --only=phone        one pass: phone | desktop | dark
//
// It opens dist/lightplan.html over file://, drives the real app the way a person would
// (step bar, tracing taps on the canvas, typed overrides, undo/redo, outlet placement,
// exports, reload, Start over, photo upload) and fails with a non-zero exit code on any
// failed check, console error or page error. Screenshots go to tests/e2e/out/ (gitignored).
// Needs Chromium for Playwright and, for the PDF text check, `pdftotext` (poppler-utils).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const APP = path.join(ROOT, 'dist/lightplan.html');
const URL = 'file://' + APP;

const PASSES = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' },
  desktop: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, colorScheme: 'light' },
  dark: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, colorScheme: 'dark' },
};

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const selected = onlyArg ? onlyArg.slice(7).split(',') : Object.keys(PASSES);

if (!fs.existsSync(APP)) {
  console.error('dist/lightplan.html is missing. Run "node build.js" first (npm run e2e does both).');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ helpers

class Check {
  constructor(name) { this.name = name; this.failures = []; this.passes = 0; }
  ok(cond, what) {
    if (cond) { this.passes += 1; console.log('  ok   ' + what); }
    else { this.failures.push(what); console.log('  FAIL ' + what); }
    return !!cond;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the app object exists and the plan has been computed once. */
async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.LightPlanApp && window.LightPlanApp.store), null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const root = document.getElementById('panel-root');
    return root && !root.querySelector('.panel-loading');
  }, null, { timeout: 15000 });
  await sleep(400);
}

const projectInfo = (page) => page.evaluate(() => {
  const s = window.LightPlanApp.store;
  const p = s.project();
  return {
    features: p.features.length,
    outlets: p.outlets.length,
    images: p.images.length,
    planes: p.planes.map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
    featureIds: p.features.map((f) => f.id),
    name: p.name,
  };
});

/** Fraction of sampled canvas pixels that are bright and the luminance spread: a blank canvas has neither. */
const canvasStats = (page) => page.evaluate(() => {
  const c = document.querySelector('#viewport canvas');
  if (!c) return null;
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let n = 0; let bright = 0; let min = 255; let max = 0; let warm = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    n += 1; if (l > 200) bright += 1;
    if (data[i] > 200 && data[i + 1] > 140 && data[i + 2] < 160) warm += 1;
    min = Math.min(min, l); max = Math.max(max, l);
  }
  return { w: c.width, h: c.height, bright: bright / n, warm, range: max - min };
});

/** Screen (page) point for an image point, or null when it is off the canvas or covered by UI. */
const imagePointToPage = (page, pt) => page.evaluate((p) => {
  const vp = window.LightPlanApp.viewport;
  const c = document.querySelector('#viewport canvas');
  const r = c.getBoundingClientRect();
  const s = vp.imageToScreen(p);
  const x = r.left + s[0]; const y = r.top + s[1];
  const hit = document.elementFromPoint(x, y);
  return { x, y, onCanvas: hit === c };
}, pt);

async function tapAt(page, cfg, x, y) {
  if (cfg.hasTouch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  await sleep(250);
}

/** Click a button, falling back to a DOM click when a phone bottom sheet scrolls it out of view. */
async function press(page, selector) {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ timeout: 5000 });
  await sleep(250);
}

async function clickAndDownload(page, selector) {
  const loc = page.locator(selector).last();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), loc.click()]);
  const file = path.join(OUT, 'smoke-' + dl.suggestedFilename());
  await dl.saveAs(file);
  return file;
}

/** Click a control that opens a file picker; confirm the in-page "Replace this plan?" dialog if it appears. */
async function chooseFile(page, clickFn, file) {
  const chooserP = page.waitForEvent('filechooser', { timeout: 10000 });
  await clickFn();
  await sleep(200);
  if (await page.locator('#dialog-backdrop').isVisible()) await page.click('#dialog-confirm');
  const chooser = await chooserP;
  await chooser.setFiles(file);
}

/** A 1200x900 JPEG of a simple house, drawn in the page with a canvas. */
async function makeFixtureJpeg(page) {
  const file = path.join(OUT, 'fixture-house.jpg');
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 900;
    const g = c.getContext('2d');
    g.fillStyle = '#9cc3e6'; g.fillRect(0, 0, 1200, 900);
    g.fillStyle = '#6b8f4e'; g.fillRect(0, 640, 1200, 260);
    g.fillStyle = '#e9e1cf'; g.fillRect(250, 360, 700, 300);
    g.fillStyle = '#7a3b2e'; g.beginPath(); g.moveTo(220, 370); g.lineTo(600, 160); g.lineTo(980, 370); g.closePath(); g.fill();
    g.fillStyle = '#5a4030'; g.fillRect(560, 500, 80, 160);
    g.fillStyle = '#cfe3f3'; g.fillRect(320, 440, 120, 90); g.fillRect(760, 440, 120, 90);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

// ------------------------------------------------------------------ one pass

async function runPass(browser, name) {
  const cfg = PASSES[name];
  const t = new Check(name);
  console.log('\n== ' + name + ' ' + cfg.viewport.width + 'x' + cfg.viewport.height + (cfg.colorScheme === 'dark' ? ' dark' : ''));
  const context = await browser.newContext({
    viewport: cfg.viewport, isMobile: cfg.isMobile, hasTouch: cfg.hasTouch, colorScheme: cfg.colorScheme,
    deviceScaleFactor: 1, acceptDownloads: true, reducedMotion: 'no-preference',
  });
  // The sandbox may have no route to Google Fonts; serve an empty stylesheet so a failed font
  // request is not reported as a console error. The app falls back to system fonts.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console error: ' + m.text()); });
  const shot = (label) => page.screenshot({ path: path.join(OUT, 'smoke-' + name + '-' + label + '.png') });

  try {
    await page.goto(URL);
    await waitForApp(page);

    // --- First run: the traced sample with the night preview.
    let info = await projectInfo(page);
    t.ok(info.features > 0 && info.images === 1, 'first run opens the traced sample (' + info.features + ' features)');
    t.ok(await page.locator('#sample-banner').isVisible(), 'sample banner is shown');
    await sleep(600);
    const stats = await canvasStats(page);
    t.ok(stats && stats.range > 60 && stats.bright > 0.0005, 'canvas is not blank (luminance range ' + (stats && stats.range.toFixed(0)) + ', bright ' + (stats && (stats.bright * 100).toFixed(2)) + '%)');
    t.ok(stats && stats.warm > 150, 'night preview shows warm lights (' + (stats && stats.warm) + ' warm pixels)');
    await shot('night');

    // --- Every step renders through the step bar.
    for (let n = 1; n <= 6; n += 1) {
      await page.click('button.step[data-step="' + n + '"]');
      await sleep(350);
      const st = await page.evaluate(() => ({
        step: window.LightPlanApp.store.ui().step,
        dataStep: document.getElementById('lp-app').getAttribute('data-step'),
        text: document.getElementById('panel-root').innerText.length,
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
      }));
      t.ok(st.step === n && st.dataStep === String(n) && st.text > 40, 'step ' + n + ' renders (' + st.text + ' chars of panel text)');
      t.ok(st.overflowX <= 0, 'step ' + n + ': no horizontal page scroll');
      await shot('step' + n);
    }

    // --- Step 3: trace a new roofline with two taps on the Front wall, then Finish.
    await page.click('button.step[data-step="3"]');
    await sleep(300);
    await press(page, '[data-act="trace-type"][data-type="roofline"]');
    const tracePts = await page.evaluate(() => {
      const p = window.LightPlanApp.store.project();
      const ui = window.LightPlanApp.store.ui();
      const plane = p.planes.find((x) => x.id === (ui.mode.opts && ui.mode.opts.planeId)) || p.planes.find((x) => x.kind === 'wall' && x.rect);
      const c = plane.rect.corners; // TL TR BR BL
      const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      // A line across the middle of the calibrated rectangle, away from traced features.
      const left = lerp(c[0], c[3], 0.45); const right = lerp(c[1], c[2], 0.45);
      return { a: lerp(left, right, 0.2), b: lerp(left, right, 0.65), planeId: plane.id };
    });
    let pa = await imagePointToPage(page, tracePts.a);
    let pb = await imagePointToPage(page, tracePts.b);
    t.ok(pa.onCanvas && pb.onCanvas, 'trace points are on the visible canvas');
    await tapAt(page, cfg, pa.x, pa.y);
    await tapAt(page, cfg, pb.x, pb.y);
    const draftN = await page.evaluate(() => window.LightPlanApp.store.ui().draft.points.length);
    t.ok(draftN === 2, 'two taps add two draft points (' + draftN + ')');
    await page.click('#hint-finish');
    await sleep(400);
    const after = await projectInfo(page);
    const newId = after.featureIds.find((id) => !info.featureIds.includes(id));
    t.ok(after.features === info.features + 1 && !!newId, 'finishing the trace adds a feature');
    const m0 = await page.evaluate((id) => window.LightPlanApp.store.plan().measured.features[id], newId);
    t.ok(m0 && m0.ok && m0.lengthFt > 1, 'the new roofline has a measured length (' + (m0 && m0.lengthFt && m0.lengthFt.toFixed(2)) + ' ft)');
    await page.click('#hint-cancel').catch(() => {});
    await sleep(300);
    await shot('trace');

    // --- Type an override; the plan updates. Then undo and redo.
    const rowBtn = '[data-act="select-feature"][data-id="' + newId + '"]';
    if (await page.locator(rowBtn).getAttribute('aria-expanded') !== 'true') await press(page, rowBtn);
    const lenText = await page.locator('li[data-key="' + newId + '"] .feat-len').innerText();
    t.ok(/\d/.test(lenText), 'the feature list shows its length (' + lenText.trim() + ')');
    const runBefore = await page.evaluate((id) => (window.LightPlanApp.store.plan().runs.find((r) => r.featureId === id) || {}).lengthFt, newId);
    const ov = page.locator('[data-act="feature-len"][data-id="' + newId + '"]');
    await ov.scrollIntoViewIfNeeded();
    await ov.fill('25');
    await ov.press('Enter');
    await ov.evaluate((el) => el.blur());
    await sleep(400);
    const ovState = await page.evaluate((id) => {
      const s = window.LightPlanApp.store;
      return { override: s.project().features.find((f) => f.id === id).overrideFt, run: (s.plan().runs.find((r) => r.featureId === id) || {}).lengthFt };
    }, newId);
    t.ok(ovState.override === 25 && ovState.run === 25 && runBefore !== 25, 'typed override updates the plan (run ' + (runBefore && runBefore.toFixed(2)) + ' -> ' + ovState.run + ' ft)');
    await page.click('#btn-undo');
    await sleep(300);
    const undone = await page.evaluate((id) => window.LightPlanApp.store.project().features.find((f) => f.id === id).overrideFt, newId);
    t.ok(undone == null, 'undo removes the override');
    await page.click('#btn-redo');
    await sleep(300);
    const redone = await page.evaluate((id) => window.LightPlanApp.store.project().features.find((f) => f.id === id).overrideFt, newId);
    t.ok(redone === 25, 'redo puts the override back');
    await shot('override');

    // --- Step 5: place an outlet.
    await page.click('button.step[data-step="5"]');
    await sleep(300);
    const outletsBefore = (await projectInfo(page)).outlets;
    await press(page, '[data-act="place-outlet"]');
    const outPt = await page.evaluate(() => {
      const p = window.LightPlanApp.store.project();
      const plane = p.planes.find((x) => x.kind === 'wall' && x.rect);
      const c = plane.rect.corners;
      return [c[3][0] + (c[2][0] - c[3][0]) * 0.55, c[3][1] + (c[2][1] - c[3][1]) * 0.55 - 25];
    });
    const po = await imagePointToPage(page, outPt);
    t.ok(po.onCanvas, 'outlet point is on the visible canvas');
    await tapAt(page, cfg, po.x, po.y);
    await sleep(300);
    const outletsAfter = (await projectInfo(page)).outlets;
    t.ok(outletsAfter === outletsBefore + 1, 'placing an outlet adds it (' + outletsBefore + ' -> ' + outletsAfter + ')');
    await shot('outlet');

    // --- Step 6: BOM rows.
    await page.click('button.step[data-step="6"]');
    await sleep(400);
    const bomRows = await page.locator('.bom-row').count();
    t.ok(bomRows > 0, 'the shopping list has rows (' + bomRows + ')');
    await shot('review');

    // --- Exports through the blob-download fallback (no window.claude in a plain file).
    const csvFile = await clickAndDownload(page, '[data-act="export"][data-kind="csv"]');
    const csv = fs.readFileSync(csvFile, 'utf8').replace(/^﻿/, '');
    t.ok(csv.split(/\r?\n/)[0] === 'SKU,Item,Category,Qty,Unit,Unit Price,Line Total,Notes', 'CSV header is correct');
    const jsonFile = await clickAndDownload(page, '[data-act="export"][data-kind="json"]');
    const exported = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    t.ok(exported && exported.project && exported.project.features.length === after.features, 'JSON export holds the project (' + (exported.project && exported.project.features.length) + ' features)');
    const pdfFile = await clickAndDownload(page, '[data-act="export"][data-kind="pdf"]');
    const pdf = fs.readFileSync(pdfFile);
    t.ok(pdf.subarray(0, 4).toString('latin1') === '%PDF', 'PDF report starts with %PDF (' + pdf.length + ' bytes)');
    let pdfText = '';
    try { pdfText = execFileSync('pdftotext', [pdfFile, '-'], { encoding: 'utf8' }); } catch (e) { pdfText = ''; }
    t.ok(/LightPlan/.test(pdfText), 'pdftotext finds "LightPlan" in the PDF');

    // Re-import the JSON through the menu's Open project.
    // Delete the new roofline first so the import visibly brings it back.
    await page.evaluate((id) => window.LightPlanApp.actions.deleteFeature(id), newId);
    await sleep(200);
    t.ok((await projectInfo(page)).features === after.features - 1, 'deleting the roofline before the import');
    await page.click('#btn-menu');
    await sleep(200);
    await chooseFile(page, () => page.click('[data-menu="open"]'), jsonFile);
    await page.waitForFunction(() => !window.LightPlanApp.store.ui().busy, null, { timeout: 10000 });
    await sleep(500);
    const reimported = await projectInfo(page);
    t.ok(reimported.features === after.features && reimported.outlets === outletsAfter && reimported.images === 1, 'Open project re-imports the JSON (' + reimported.features + ' features, ' + reimported.outlets + ' outlets)');

    // --- Reload: autosave restores the project.
    await sleep(900); // autosave is debounced (400 ms)
    await page.reload();
    await waitForApp(page);
    const reloaded = await projectInfo(page);
    t.ok(reloaded.features === after.features && reloaded.outlets === outletsAfter, 'reload restores the autosaved project (' + reloaded.features + ' features)');
    const reloadStats = await canvasStats(page);
    t.ok(reloadStats && reloadStats.range > 60, 'the photo is restored after reload');

    // --- Start over: in-page dialog, confirm, blank state.
    await page.click('#btn-menu');
    await sleep(200);
    await page.click('[data-menu="start-over"]');
    await sleep(250);
    t.ok(await page.locator('#dialog-backdrop').isVisible(), 'Start over asks in an in-page dialog');
    await shot('dialog');
    await page.click('#dialog-confirm');
    await sleep(500);
    const blank = await projectInfo(page);
    t.ok(blank.features === 0 && blank.images === 0 && blank.outlets === 0, 'confirming Start over leaves a blank project');
    t.ok(await page.locator('#empty-state').isVisible(), 'the empty state asks for a photo');
    await shot('blank');

    // --- Upload a JPEG through #file-input.
    const jpg = await makeFixtureJpeg(page);
    await page.setInputFiles('#file-input', jpg);
    await page.waitForFunction(() => window.LightPlanApp.store.project().images.length === 1, null, { timeout: 10000 });
    await sleep(500);
    const up = await projectInfo(page);
    t.ok(up.images === 1 && up.planes.some((p) => p.kind === 'wall' && p.name === 'Front wall'), 'the uploaded photo loads with a Front wall plane');
    const upStats = await canvasStats(page);
    t.ok(upStats && upStats.range > 60, 'the uploaded photo is drawn on the canvas');
    await page.click('button.step[data-step="2"]');
    await sleep(400);
    await shot('upload-step2');
  } catch (e) {
    t.ok(false, 'unexpected error: ' + (e && e.message ? e.message.split('\n')[0] : e));
    await shot('error').catch(() => {});
  }

  t.ok(errors.length === 0, 'no console or page errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
  await context.close();
  return t;
}

// ------------------------------------------------------------------ main

const browser = await chromium.launch();
const results = [];
for (const name of selected) {
  if (!PASSES[name]) { console.error('unknown pass ' + name); process.exitCode = 2; continue; }
  results.push(await runPass(browser, name));
}
await browser.close();

console.log('\nSummary');
let failed = 0;
for (const r of results) {
  console.log('  ' + r.name + ': ' + r.passes + ' passed, ' + r.failures.length + ' failed');
  failed += r.failures.length;
}
if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('All smoke checks passed. Screenshots in tests/e2e/out/');
