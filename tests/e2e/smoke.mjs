// LightPlan end-to-end smoke test (Playwright + Chromium).
//
// Usage:
//   npm run e2e                          build dist/ and run every pass (phone, desktop, desktop dark,
//                                        blocked storage)
//   node tests/e2e/smoke.mjs             run against the existing dist/lightplan.html
//   node tests/e2e/smoke.mjs --only=phone        one pass: phone | desktop | dark | storage | inputs | measure |
//                                                review | landscape | v11-phone | v11-desktop
//                                                (storage = localStorage and IndexedDB blocked;
//                                                inputs = safe share, tax, file version, damaged photo;
//                                                review = UI review findings on a phone; landscape = 844x390;
//                                                v11-* = the Phase 1.1 UI, SPEC 8.4 and 8.5: cords on the photo,
//                                                the Power step, rough measurements, the flow, tap precision.
//                                                They also write v11-<phone|desktop>-step<3|5|6>.png)
//   LP_APP=/path/to/lightplan.html node tests/e2e/smoke.mjs   run against another build
//   LP_SECTIONS='UX-0[45]' node tests/e2e/smoke.mjs --only=review   run only the matching review sections
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
const APP = process.env.LP_APP ? path.resolve(process.env.LP_APP) : path.join(ROOT, 'dist/lightplan.html');
const URL = 'file://' + APP;

const PASSES = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' },
  desktop: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, colorScheme: 'light' },
  dark: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, colorScheme: 'dark' },
};

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const selected = onlyArg ? onlyArg.slice(7).split(',') : Object.keys(PASSES).concat('storage', 'inputs', 'measure', 'review', 'landscape', 'v11-phone', 'v11-desktop');

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
    // E3 (UX-06): after Finish the hint bar shows the result and what to trace next, not "0 points" and a dead Finish.
    const afterFinish = await page.evaluate(() => {
      const vis = (id) => { const el = document.getElementById(id); return !!el && !el.hidden && el.getBoundingClientRect().height > 0; };
      const ui = window.LightPlanApp.store.ui();
      return {
        mode: ui.mode.name, sheet: ui.sheet, text: document.getElementById('hint-text').textContent,
        chips: Array.from(document.querySelectorAll('#hint-next-chips [data-next]')).map((b) => b.textContent),
        nextShown: vis('hint-next'), finishShown: vis('hint-finish'), doneShown: vis('hint-done'), moreShown: vis('hint-more'),
        traceBars: Array.from(document.querySelectorAll('.trace-bar')).filter((el) => el.getBoundingClientRect().height > 0).length,
      };
    });
    t.ok(afterFinish.mode === 'select' && afterFinish.nextShown && !afterFinish.finishShown && afterFinish.doneShown && afterFinish.moreShown,
      'after Finish the hint bar offers what to trace next (' + JSON.stringify(afterFinish.chips) + ', More, Done) and no disabled Finish');
    t.ok(/^Eave \d+: \d+′ \d+″/.test(afterFinish.text) && !/0 points/.test(afterFinish.text), 'the hint bar shows the result of the trace (' + afterFinish.text + ')');
    t.ok(afterFinish.chips.join('/') === 'Eave/Window/Bush', 'the quick picks are Eave / Window / Bush (' + afterFinish.chips.join('/') + ')');
    if (cfg.hasTouch) t.ok(afterFinish.sheet === 'min', 'phone: the sheet stays collapsed while the next item is offered (' + afterFinish.sheet + ')');
    await shot('after-trace');
    // Picking a chip starts that trace; on a phone the tracing buttons are shown once (hint bar), not twice.
    await page.click('#hint-next-chips [data-next="window"]');
    await sleep(300);
    const picked = await page.evaluate(() => ({
      mode: window.LightPlanApp.store.ui().mode, sheet: window.LightPlanApp.store.ui().sheet,
      traceBars: Array.from(document.querySelectorAll('.trace-bar')).filter((el) => el.getBoundingClientRect().height > 0).length,
      finishButtons: Array.from(document.querySelectorAll('#hint-finish, [data-act="draft-finish"]')).filter((el) => el.getBoundingClientRect().height > 0).length,
    }));
    t.ok(picked.mode.name === 'trace' && picked.mode.opts.type === 'window', 'the Window chip starts tracing a window');
    if (cfg.hasTouch) t.ok(picked.traceBars === 0 && picked.finishButtons === 1 && picked.sheet === 'min', 'phone: one set of tracing buttons, no sticky trace bar in the sheet (' + JSON.stringify({ bars: picked.traceBars, finish: picked.finishButtons, sheet: picked.sheet }) + ')');
    await page.click('#hint-cancel');
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

// ------------------------------------------------------------------ blocked storage
// The viewer may block localStorage and IndexedDB. The app must still start and work.
async function runBlockedStorage(browser) {
  const t = new Check('blocked-storage');
  console.log('\n== blocked storage 390x844');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.addInitScript(() => {
    const deny = () => { throw new DOMException('Storage is blocked', 'SecurityError'); };
    Object.defineProperty(window, 'localStorage', { get: deny, configurable: true });
    Object.defineProperty(window, 'indexedDB', { get: deny, configurable: true });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('page error: ' + e.message));
  try {
    await page.goto(URL);
    await waitForApp(page);
    const info = await projectInfo(page);
    t.ok(info.features > 0, 'the sample opens with storage blocked');
    await page.click('button.step[data-step="6"]');
    await sleep(400);
    t.ok(await page.locator('.bom-row').count() > 0, 'the shopping list still renders');
    // mobile-ux:UX-03 / data-export:F2: a persistent note says nothing is being saved.
    const note = await page.evaluate(() => { const n = document.getElementById('notice'); return n && !n.hidden ? n.innerText : ''; });
    t.ok(/not saving your plan/.test(note), 'a note says the browser is not saving the plan (' + note.slice(0, 50) + ')');
    await page.screenshot({ path: path.join(OUT, 'smoke-storage-notice.png') });
  } catch (e) {
    t.ok(false, 'unexpected error: ' + (e && e.message ? e.message.split('\n')[0] : e));
  }
  t.ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await context.close();
  return t;
}

// ------------------------------------------------------------------ planning inputs
// Inputs whose values the planner and the file format must agree on (desktop, sample house).
async function runPlanningInputs(browser) {
  const t = new Check('inputs');
  console.log('\n== planning inputs 1280x800');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console error: ' + m.text()); });
  /** Set an input's value and fire change, the way a person typing then leaving the field does. */
  const setInput = (selector, value) => page.evaluate(([sel, v]) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, [selector, value]);
  const toast = () => page.evaluate(() => { const ui = window.LightPlanApp.store.ui(); return ui.toast ? ui.toast.message : ''; });
  try {
    await page.goto(URL);
    await waitForApp(page);

    // Safe share of the breaker: 80 means 80%, never 8,000%.
    await page.click('button.step[data-step="4"]');
    await sleep(300);
    t.ok(await setInput('[data-act="config-field"][data-path="power.continuousFactor"]', '80'), 'the safe-share field exists');
    await sleep(300);
    const cf = await page.evaluate(() => window.LightPlanApp.store.plan().library.config.power.continuousFactor);
    t.ok(cf === 0.8, 'typing 80 for the safe share stores 0.8 (' + cf + ')');
    await page.click('button.step[data-step="5"]');
    await sleep(300);
    const meter = await page.locator('.meter-text').first().innerText();
    t.ok(/\(80% of /.test(meter) && !/8000%/.test(meter), 'the circuit meter reads 80% of the breaker (' + meter.trim() + ')');

    // Tax above 100% is refused in the app, so a reload cannot silently change the quote.
    await page.click('button.step[data-step="6"]');
    await sleep(300);
    await page.evaluate(() => window.LightPlanApp.actions.updateQuote({ enabled: true }));
    await sleep(300);
    const taxBefore = await page.evaluate(() => window.LightPlanApp.store.project().quote.taxPct);
    t.ok(await setInput('[data-act="quote-num"][data-field="taxPct"]', '825'), 'the tax field exists');
    await sleep(300);
    const taxAfter = await page.evaluate(() => window.LightPlanApp.store.project().quote.taxPct);
    t.ok(taxAfter === taxBefore, 'tax 825% is refused (' + taxBefore + ' -> ' + taxAfter + ')');
    t.ok(/from 0 to 100/.test(await toast()), 'a toast says the tax must be 0 to 100%');
    const shown = await page.evaluate(() => document.querySelector('[data-act="quote-num"][data-field="taxPct"]').value);
    t.ok(shown !== '825', 'the tax field shows the kept value again (' + shown + ')');

    // An export wrapper whose version is the string "2" is refused like version 2; the plan stays.
    const featuresBefore = (await projectInfo(page)).features;
    const project = await page.evaluate(() => window.LightPlanApp.store.project());
    const future = path.join(OUT, 'inputs-future-export-str.json');
    fs.writeFileSync(future, JSON.stringify({ schema: 'lightplan/export', version: '2', exportedAt: null, project: Object.assign({}, project, { features: [] }), images: {}, derived: null }));
    await page.setInputFiles('#json-input', future);
    await page.waitForFunction(() => !window.LightPlanApp.store.ui().busy, null, { timeout: 10000 });
    await sleep(300);
    t.ok(/newer version/.test(await toast()), 'a wrapper version "2" is refused as newer (' + (await toast()) + ')');
    t.ok((await projectInfo(page)).features === featuresBefore, 'the current plan is not replaced');

    // A file whose photo data is damaged says so (not "not saved").
    const damaged = path.join(OUT, 'inputs-bad-dataurl.json');
    const photoProject = JSON.parse(JSON.stringify(project));
    photoProject.images[0].source.kind = 'upload';
    photoProject.images[0].storageKey = 'img_x';
    fs.writeFileSync(damaged, JSON.stringify({ schema: 'lightplan/export', version: 1, exportedAt: null, project: photoProject, images: { img_x: 'data:image/jpeg;base64,AAAA' }, derived: null }));
    await page.setInputFiles('#json-input', damaged);
    await page.waitForFunction(() => !window.LightPlanApp.store.ui().busy, null, { timeout: 10000 });
    await sleep(500);
    const msg = await toast();
    t.ok(/photo in this file is damaged/.test(msg) && !/not saved/.test(msg), 'a damaged photo is reported as damaged (' + msg + ')');
  } catch (e) {
    t.ok(false, 'unexpected error: ' + (e && e.message ? e.message.split('\n')[0] : e));
  }
  t.ok(errors.length === 0, 'no console or page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await context.close();
  return t;
}

// ------------------------------------------------------------------ measurement honesty in the UI
// A lens setting that disagrees with the photo's rectangles is flagged at step 1 with a one-tap fix, and two
// references on a wall of unknown size are compared (step 2 shows the disagreement and how the plane was solved).
async function runMeasureChecks(browser) {
  const t = new Check('measure');
  console.log('\n== measurement checks 390x844');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console error: ' + m.text()); });
  try {
    await page.goto(URL);
    await waitForApp(page);
    // The wide-screenshot lens preset on the sample (its rectangles measure a ~69° lens, not 90°).
    await page.evaluate(() => {
      const s = window.LightPlanApp.store;
      window.LightPlanApp.actions.updateImageCamera(s.project().images[0].id, { mode: 'preset', presetId: 'streetview' });
    });
    await page.click('button.step[data-step="1"]');
    await sleep(400);
    const mismatch = page.locator('[data-key="lens-mismatch"]');
    t.ok(await mismatch.count() === 1, 'step 1 flags the lens setting that does not match the rectangles');
    const useBtn = page.locator('[data-act="lens-use"]');
    t.ok(await useBtn.count() === 1, 'the lens warning offers the measured focal length');
    const walkLevel = await page.evaluate(() => window.LightPlanApp.store.plan().measured.features.ft_walk_left.confidence.level);
    t.ok(walkLevel === 'low', 'with the wrong lens the walkway is rated Low (' + walkLevel + ')');
    await useBtn.scrollIntoViewIfNeeded();
    await useBtn.click();
    await sleep(400);
    const cam = await page.evaluate(() => window.LightPlanApp.store.project().images[0].camera);
    t.ok(cam.mode === 'manual' && cam.focalPx > 1100 && cam.focalPx < 1230, 'tapping it sets the measured focal length (' + cam.focalPx + ' px)');
    t.ok(await page.locator('[data-key="lens-mismatch"]').count() === 0, 'the lens warning goes away');

    // A 15% wrong window reference on the Front wall (rectangle size unknown) is compared with the door height.
    await page.evaluate(() => {
      const s = window.LightPlanApp.store;
      s.commit('test: wrong window width', (d) => {
        const front = d.planes.find((pl) => pl.id === 'pl_front');
        front.refs.find((r) => r.id === 'ref_window_width').lengthFt = 4.6;
      });
      window.LightPlanApp.actions.select({ kind: 'plane', id: 'pl_front' });
    });
    await page.click('button.step[data-step="2"]');
    await sleep(400);
    await page.evaluate(() => { const b = document.querySelector('[data-act="select-plane"][data-id="pl_front"]'); if (b) b.click(); });
    await sleep(300);
    const disagree = await page.evaluate(() => { const el = document.querySelector('[data-key="disagree"]'); return el ? el.textContent : ''; });
    t.ok(/disagree by \d+(\.\d)?%/.test(disagree), 'the Front wall shows the reference disagreement (' + disagree.slice(0, 60) + ')');
    const badges = await page.evaluate(() => Array.from(document.querySelectorAll('.ref-item .err-badge')).map((b) => b.textContent.trim()));
    t.ok(badges.some((b) => /[1-9]\.\d%|[1-9]\d\.\d%/.test(b)), 'each reference shows its own error against the fit (' + badges.join(', ') + ')');
    const shot = path.join(OUT, 'measure-disagree.png');
    await page.screenshot({ path: shot, fullPage: false });
  } catch (e) {
    t.ok(false, 'unexpected error: ' + (e && e.message ? e.message.split('\n')[0] : e));
  }
  t.ok(errors.length === 0, 'no console or page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await context.close();
  return t;
}

// ------------------------------------------------------------------ UI review findings (phone 390x844)
async function newPhonePage(browser, extra) {
  const context = await browser.newContext(Object.assign({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, acceptDownloads: true, reducedMotion: 'no-preference',
  }, extra || {}));
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console error: ' + m.text()); });
  return { context, page, errors };
}
const ui = (page) => page.evaluate(() => window.LightPlanApp.store.ui());
const boxOf = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right } : null; }, sel);
const overlaps = (a, b) => !!(a && b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b);
/** Image point -> page point for several points at once. */
const toPage = (page, pts) => page.evaluate((ps) => {
  const vp = window.LightPlanApp.viewport;
  const c = document.querySelector('#viewport canvas');
  const r = c.getBoundingClientRect();
  return ps.map((p) => { const s = vp.imageToScreen(p); return [r.left + s[0], r.top + s[1]]; });
}, pts);
const toImage = (page, pts) => page.evaluate((ps) => {
  const vp = window.LightPlanApp.viewport;
  const c = document.querySelector('#viewport canvas');
  const r = c.getBoundingClientRect();
  return ps.map((p) => vp.screenToImage([p[0] - r.left, p[1] - r.top]));
}, pts);
async function quickTaps(page, pts, gapMs) {
  for (const p of pts) { await page.touchscreen.tap(p[0], p[1]); await sleep(gapMs); }
  await sleep(250);
}

async function runReview(browser) {
  const t = new Check('review');
  console.log('\n== UI review findings 390x844');
  const { context, page, errors } = await newPhonePage(browser);
  const shot = (label) => page.screenshot({ path: path.join(OUT, 'review-' + label + '.png') });
  const act = (fn, arg) => page.evaluate(fn, arg);
  let pp = null;
  let wallPts = null;
  let rect = null;
  let wallId = null;
  /** One finding's checks: a failure is recorded and the next section still runs (from a clean tool state). */
  const only = process.env.LP_SECTIONS ? new RegExp(process.env.LP_SECTIONS) : null;   // run some sections only
  const sec = async (name, fn) => {
    if (only && !only.test(name)) return;
    try {
      await page.evaluate(() => { const a = window.LightPlanApp.actions; a.cancelDraft(); a.select(null); window.LightPlanApp.store.setUI({ dialog: null }); }).catch(() => {});
      await fn();
    } catch (e) {
      t.ok(false, name + ': unexpected error: ' + (e && e.message ? e.message.split('\n')[0] : e));
      await shot('error-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 30)).catch(() => {});
    }
  };
  try {
    await page.goto(URL);
    await waitForApp(page);
    await sec('Known low: the sample note is one compact row on a phone.', async () => {
      const banner = await boxOf(page, '#sample-banner');
      t.ok(banner && banner.h <= 64, 'the sample banner is a compact row on a phone (' + (banner && Math.round(banner.h)) + ' px tall)');
      await shot('banner');
    });

    await sec('mobile-ux:UX-13: Lights off -> Night and Twinkle read as off', async () => {
      await page.click('button.step[data-step="4"]');
      await sleep(300);
      await act(() => window.LightPlanApp.actions.setView({ night: true, twinkle: true, preview: true }));
      await press(page, '[data-act="view-flip"][data-key="preview"]');
      const pressed = await page.evaluate(() => ({
        panelNight: document.querySelector('[data-act="view-flip"][data-key="night"]').getAttribute('aria-pressed'),
        panelTwinkle: document.querySelector('[data-act="view-flip"][data-key="twinkle"]').getAttribute('aria-pressed'),
        ctlNight: document.getElementById('ctl-night').getAttribute('aria-pressed'),
      }));
      t.ok(pressed.panelNight === 'false' && pressed.panelTwinkle === 'false' && pressed.ctlNight === 'false', 'with the lights off, Night and Twinkle read as off in the panel and on the canvas (' + JSON.stringify(pressed) + ')');
      await page.evaluate(() => document.getElementById('ctl-night').click());
      await sleep(200);
      const v1 = (await ui(page)).view;
      t.ok(v1.preview && v1.night, 'one tap on the canvas Night button turns the night preview on');
    });

    await sec('mobile-ux:UX-14: every product switch has an accessible name', async () => {
      const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll('input[data-act="product-enabled"]')).filter((el) => !(el.getAttribute('aria-label') || '').trim()).length);
      t.ok(unnamed === 0, 'product on/off switches have accessible names (' + unnamed + ' unnamed)');
    });

    await sec('completeness:F8: run cards offer clips, outlet and direction', async () => {
      const runCtl = await page.evaluate(() => ['run-mount', 'run-outlet', 'run-reverse'].map((a) => document.querySelectorAll('[data-act="' + a + '"]').length));
      t.ok(runCtl.every((n) => n > 0), 'run cards have Clips, Outlet and Start-from-the-other-end controls (' + runCtl.join('/') + ')');
    });

    await sec('mobile-ux:UX-01 / UX-09: with the ground active, an eave is ', async () => {
      await page.click('button.step[data-step="3"]');
      await sleep(300);
      await act(() => window.LightPlanApp.actions.setActivePlane('pl_yard'));
      await press(page, '[data-act="trace-type"][data-type="roofline"]');
      const tr = await ui(page);
      t.ok(tr.mode.name === 'trace' && tr.mode.opts.planeId === 'pl_front', 'an eave started while the ground is active is traced on the Front wall (' + tr.mode.opts.planeId + ')');
      const hp = await page.evaluate(() => { const w = document.getElementById('hint-plane-wrap'); const s = document.getElementById('hint-plane'); return w && !w.hidden && s ? s.value : null; });
      t.ok(hp === 'pl_front', 'the hint bar shows the surface being traced on, with a picker (' + hp + ')');
      await act(() => window.LightPlanApp.actions.toast('A test message while tracing.', 'warn'));
      await sleep(250);
      const tb = await boxOf(page, '.toast');
      const hb = await boxOf(page, '#hintbar');
      t.ok(tb && hb && !overlaps(tb, hb), 'a toast does not cover the hint bar while tracing');
      await shot('trace-hint');
    });

    await sec('mobile-ux:UX-12: top-bar Undo during a trace removes the las', async () => {
      await press(page, '[data-act="trace-type"][data-type="roofline"]');
      const featsBefore = (await projectInfo(page)).features;
      wallPts = await page.evaluate(() => {
        const c = window.LightPlanApp.store.project().planes.find((x) => x.id === 'pl_front').rect.corners;
        const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
        const left = lerp(c[0], c[3], 0.5), right = lerp(c[1], c[2], 0.5);
        return [lerp(left, right, 0.3), lerp(left, right, 0.36), lerp(left, right, 0.42), lerp(left, right, 0.48)];
      });
      pp = await toPage(page, wallPts.slice(0, 2));
      await quickTaps(page, pp, 400);
      await page.click('#btn-undo');
      await sleep(250);
      const afterUndo = await page.evaluate(() => ({ n: window.LightPlanApp.store.project().features.length, d: window.LightPlanApp.store.ui().draft.points.length }));
      t.ok(afterUndo.n === featsBefore && afterUndo.d === 1, 'top-bar Undo while tracing removes the last point (' + JSON.stringify(afterUndo) + ')');
      await page.click('#hint-cancel');
      await sleep(200);
    });

    await sec('mobile-ux:UX-04: four quick window taps ~30 px apart all cou', async () => {
      await press(page, '[data-act="trace-type"][data-type="window"]');
      const sq = await page.evaluate((p) => {
        const vp = window.LightPlanApp.viewport;
        const s = vp.imageToScreen(p);
        return [[s[0], s[1]], [s[0] + 30, s[1]], [s[0] + 30, s[1] + 32], [s[0], s[1] + 32]].map((q) => vp.screenToImage(q));
      }, wallPts[1]);
      pp = await toPage(page, sq);
      await quickTaps(page, pp, 150);
      const wdraft = (await ui(page)).draft.points.length;
      t.ok(wdraft === 4, 'four quick window taps ~30 px apart give four points (' + wdraft + ')');
      await page.click('#hint-cancel');
      await sleep(200);
    });

    await sec('mobile-ux:UX-07 / completeness:F8: tap the eave on the photo', async () => {
      await act(() => window.LightPlanApp.actions.setSheet('min'));
      await sleep(300);
      const eaveMid = await page.evaluate(() => { const p = window.LightPlanApp.store.project().features.find((f) => f.id === 'ft_eave').points; return [(p[0][0] * 0.75 + p[1][0] * 0.25), (p[0][1] * 0.75 + p[1][1] * 0.25)]; });
      pp = await toPage(page, [eaveMid]);
      await page.touchscreen.tap(pp[0][0], pp[0][1]);
      await sleep(600);
      const selInfo = await page.evaluate(() => {
        const s = window.LightPlanApp.store.ui();
        const del = document.querySelector('[data-act="delete-feature"][data-id="ft_eave"]');
        const root = document.getElementById('panel-root').getBoundingClientRect();
        const r = del ? del.getBoundingClientRect() : null;
        return { sel: s.selection && s.selection.id, sheet: s.sheet, delTop: r ? r.top : null, delBottom: r ? r.bottom : null, top: root.top, bottom: Math.min(root.bottom, window.innerHeight) };
      });
      t.ok(selInfo.sel === 'ft_eave' && selInfo.delTop != null && selInfo.delTop >= selInfo.top && selInfo.delBottom <= selInfo.bottom, 'tapping the eave on the photo shows its Delete button in the visible sheet (' + JSON.stringify(selInfo) + ')');
      await shot('selected');
      const nBefore = await page.evaluate(() => window.LightPlanApp.store.project().features.find((f) => f.id === 'ft_eave').points.length);
      const mid = await page.evaluate(() => { const p = window.LightPlanApp.store.project().features.find((f) => f.id === 'ft_eave').points; return [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2]; });
      pp = await toPage(page, [mid]);
      await page.touchscreen.tap(pp[0][0], pp[0][1]);
      await sleep(400);
      const nAfter = await page.evaluate(() => window.LightPlanApp.store.project().features.find((f) => f.id === 'ft_eave').points.length);
      t.ok(nAfter === nBefore + 1, 'tapping the + between two points inserts a point (' + nBefore + ' -> ' + nAfter + ')');
      const dv = page.locator('[data-act="delete-vertex"][data-id="ft_eave"]');
      t.ok(await dv.count() === 1 && !(await dv.isDisabled()), 'the new point can be deleted with Delete point');
      await dv.scrollIntoViewIfNeeded();
      await dv.click();
      await sleep(300);
      const nBack = await page.evaluate(() => window.LightPlanApp.store.project().features.find((f) => f.id === 'ft_eave').points.length);
      t.ok(nBack === nBefore, 'Delete point removes it again');
      await act(() => window.LightPlanApp.actions.select(null));
    });

    await sec('completeness:F4: an outlet placed while the ground is active', async () => {
      await page.click('button.step[data-step="5"]');
      await sleep(300);
      await act(() => window.LightPlanApp.actions.setActivePlane('pl_yard'));
      await press(page, '[data-act="place-outlet"]');
      pp = await toPage(page, [[700, 760]]);
      await page.touchscreen.tap(pp[0][0], pp[0][1]);
      await sleep(400);
      const newOutlet = await page.evaluate(() => { const o = window.LightPlanApp.store.project().outlets; return o[o.length - 1]; });
      t.ok(newOutlet && newOutlet.planeId === 'pl_front', 'a new outlet goes on the wall under the tap, not the active ground (' + (newOutlet && newOutlet.planeId) + ')');
      t.ok(await page.locator('[data-act="outlet-plane"][data-id="' + newOutlet.id + '"]').count() === 1, 'the outlet card has a Surface picker');
      await act((id) => window.LightPlanApp.actions.deleteOutlet(id), newOutlet.id);
    });

    await sec('mobile-ux:UX-06: a custom reference length typed and then Dr', async () => {
      await page.click('button.step[data-step="2"]');
      await sleep(300);
      await act(() => window.LightPlanApp.actions.select({ kind: 'plane', id: 'pl_front' }));
      await sleep(300);
      await page.selectOption('[data-act="ref-preset"]', 'custom-line');
      await sleep(300);
      const lenInput = page.locator('[data-act="ref-length"]');
      await lenInput.scrollIntoViewIfNeeded();
      await lenInput.fill('6\' 8"');
      const draw = page.locator('[data-act="draw-ref"]');
      await draw.scrollIntoViewIfNeeded();
      await draw.click();
      await sleep(300);
      const drawMode = await ui(page);
      t.ok(drawMode.mode.name === 'line' && Math.abs(drawMode.mode.opts.lengthFt - 6.6667) < 0.01, 'one tap on Draw after typing a custom length starts drawing (' + drawMode.mode.name + ')');
      await act(() => window.LightPlanApp.actions.cancelDraft());
      await sleep(200);
      t.ok(await page.locator('#ctl-snap').isVisible(), 'the Snap switch is on the canvas in step 2');
    });

    // completeness:F2 / mobile-ux:UX-04: a perspective rectangle on a new wall keeps its tapped corners (no axis
    // snap), every quick tap is a corner, and the view does not zoom.
    await sec('completeness:F2 / mobile-ux:UX-04 rectangle corners', async () => {
      wallId = await act(() => window.LightPlanApp.actions.addPlane('wall'));
      await act(() => window.LightPlanApp.actions.setCalib({ rectPresetId: 'unknown' }));
      await act((id) => window.LightPlanApp.actions.startPlaneRect(id), wallId);
      await sleep(300);
      // Taps at a calm pace (no double taps): the edges are within 4° of the image axes and must stay as tapped.
      const base = (await toPage(page, [[1250, 420]]))[0];
      const corners = [[base[0], base[1]], [base[0] + 40, base[1] + 2], [base[0] + 42, base[1] + 30], [base[0] + 1, base[1] + 31]];
      const want = await toImage(page, corners);
      await quickTaps(page, corners, 450);
      rect = await page.evaluate((id) => { const pl = window.LightPlanApp.store.project().planes.find((x) => x.id === id); return pl.rect ? pl.rect.corners : null; }, wallId);
      const maxErr = rect ? Math.max(...rect.map((c, i) => Math.hypot(c[0] - want[i][0], c[1] - want[i][1]))) : Infinity;
      t.ok(maxErr < 1, 'the stored corners are where they were tapped, not flattened to image axes (max ' + maxErr.toFixed(1) + ' image px off)');
      // Quick taps (220 ms, 28-40 px apart) each place a corner and never zoom.
      await act((id) => window.LightPlanApp.actions.startPlaneRect(id), wallId);
      await sleep(300);
      const scale0 = await page.evaluate(() => window.LightPlanApp.viewport.getView().scale);
      const quick = corners.map((c) => [c[0] + 10, c[1] + 50]);
      const wantQ = await toImage(page, quick);
      await quickTaps(page, quick, 220);
      const rq = await page.evaluate((id) => window.LightPlanApp.store.project().planes.find((x) => x.id === id).rect.corners, wallId);
      const scale1 = await page.evaluate(() => window.LightPlanApp.viewport.getView().scale);
      const qErr = Math.max(...rq.map((c, i) => Math.hypot(c[0] - wantQ[i][0], c[1] - wantQ[i][1])));
      t.ok(qErr < 1, 'four quick corner taps mark the rectangle where tapped (max ' + qErr.toFixed(1) + ' image px off)');
      t.ok(Math.abs(scale1 - scale0) < 1e-6, 'quick corner taps do not zoom the view');
      rect = rq;
    });

    await sec('mobile-ux:UX-05: zoomed in, "Mark corners again" a few px of', async () => {
      const ctr = [rect.reduce((a, c) => a + c[0], 0) / 4, rect.reduce((a, c) => a + c[1], 0) / 4];
      await page.evaluate((c) => {
        const vp = window.LightPlanApp.viewport;
        const v = vp.getView();
        vp.setView({ scale: 2, tx: v.cssW / 2 - c[0] * 2, ty: v.cssH / 2 - c[1] * 2 });
      }, ctr);
      await act((id) => window.LightPlanApp.actions.startPlaneRect(id), wallId);
      await sleep(300);
      const again = (await toPage(page, rect)).map((p) => [p[0] + 6, p[1] + 4]);
      const want2 = await toImage(page, again);
      await quickTaps(page, again, 400);
      const rect2 = await page.evaluate((id) => window.LightPlanApp.store.project().planes.find((x) => x.id === id).rect.corners, wallId);
      const err2 = Math.max(...rect2.map((c, i) => Math.hypot(c[0] - want2[i][0], c[1] - want2[i][1])));
      t.ok(err2 < 1, 'Mark corners again does not snap back onto the old corners (max ' + err2.toFixed(1) + ' image px off)');
      await page.evaluate(() => window.LightPlanApp.viewport.fit());
      await act((id) => window.LightPlanApp.actions.deletePlane(id), wallId);
      await sleep(300);
    });

    await sec('mobile-ux:UX-02: dragging the sheet handle up from half open', async () => {
      await act(() => window.LightPlanApp.actions.setSheet('half'));
      await sleep(400);
      const hb2 = await boxOf(page, '#sheet-handle');
      await page.mouse.move(hb2.x + hb2.w / 2, hb2.y + hb2.h / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(hb2.x + hb2.w / 2, hb2.y + hb2.h / 2 - i * 26); await sleep(16); }
      await page.mouse.up();
      await sleep(500);
      const sheetUp = (await ui(page)).sheet;
      t.ok(sheetUp === 'full', 'dragging the handle up opens the sheet (' + sheetUp + ')');
      await act(() => window.LightPlanApp.actions.setSheet('half'));
      await sleep(300);
    });

    await sec('data-export:F1: the sample buttons ask before replacing the ', async () => {
      const jpg = await makeFixtureJpeg(page);
      await page.setInputFiles('#file-input', jpg);
      await page.waitForFunction(() => window.LightPlanApp.store.project().images[0].source.kind === 'upload', null, { timeout: 10000 });
      await sleep(400);
      await act(() => { const a = window.LightPlanApp.actions; a.setProjectName('42 My Own House'); a.setMode('outlet', {}); a.addOutlet([600, 600]); a.cancelDraft(); });
      await page.click('button.step[data-step="1"]');
      await sleep(300);
      await press(page, '[data-act="load-sample"][data-traced="1"]');
      t.ok(await page.locator('#dialog-backdrop').isVisible(), 'loading the sample over my own plan asks first');
      await page.click('#dialog-cancel');
      await sleep(300);
      t.ok((await projectInfo(page)).name === '42 My Own House', 'cancelling keeps my plan');
      await press(page, '[data-act="load-sample"][data-traced="1"]');
      await page.click('#dialog-confirm');
      await sleep(600);
      t.ok((await projectInfo(page)).name === 'Sample house', 'confirming loads the sample');
      await page.click('#btn-undo');
      await sleep(500);
      const back = await page.evaluate(() => { const p = window.LightPlanApp.store.project(); return { name: p.name, kind: p.images[0].source.kind, outlets: p.outlets.length }; });
      t.ok(back.name === '42 My Own House' && back.kind === 'upload' && back.outlets === 1, 'Undo brings my plan and photo back (' + JSON.stringify(back) + ')');
      const photo = await canvasStats(page);
      t.ok(photo && photo.range > 60, 'my photo is drawn again after Undo');
    });

    await sec('mobile-ux:UX-15: a reload reopens at the same step in day vi', async () => {
      await page.click('button.step[data-step="2"]');
      await sleep(900);
      await page.reload();
      await waitForApp(page);
      const re = await ui(page);
      t.ok(re.step === 2 && re.view.night === false, 'a reload reopens at step 2 in day view (step ' + re.step + ', night ' + re.view.night + ')');
    });

    await sec('Known low: no toast covers the empty-state card after Start ', async () => {
      await page.click('#btn-menu');
      await sleep(200);
      await page.click('[data-menu="start-over"]');
      await sleep(250);
      await page.click('#dialog-confirm');
      await sleep(500);
      t.ok((await ui(page)).toast == null && await page.locator('#empty-state').isVisible(), 'Start over shows the empty state with no toast over it');
    });

    await sec('data-export:F3: an autosave from a newer version is backed u', async () => {
      await page.evaluate(() => {
        const p = JSON.parse(JSON.stringify(window.LightPlanApp.store.project()));
        p.version = 2;
        p.name = 'My real house (saved by v2)';
        localStorage.setItem('lightplan:v1:project', JSON.stringify(p));
      });
      await page.reload();
      await waitForApp(page);
      const n3 = await page.evaluate(() => { const n = document.getElementById('notice'); return n && !n.hidden ? n.innerText : ''; });
      t.ok(/newer version/.test(n3) && /Download it/.test(n3), 'a note explains the saved plan is kept and offers to download it');
      await shot('unreadable');
      await act(() => window.LightPlanApp.actions.updateSettings({ wastePct: 12 }));
      await sleep(900);
      const kept = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('lightplan:v1:project:unreadable')).name; } catch (e) { return null; } });
      t.ok(kept === 'My real house (saved by v2)', 'the unreadable plan survives an edit to the sample (' + kept + ')');
    });

    await sec('data-export:F5: another tab\'s save pauses this tab\'s autosav', async () => {
      await page.click('#notice-close');
      await act(() => window.LightPlanApp.actions.setProjectName('Tab A house'));
      await sleep(900);
      const page2 = await context.newPage();
      await page2.goto(URL);
      await waitForApp(page2);
      await page2.evaluate(() => window.LightPlanApp.actions.setProjectName('Tab B house'));
      await sleep(900);
      const n5 = await page.evaluate(() => { const n = document.getElementById('notice'); return n && !n.hidden ? n.innerText : ''; });
      t.ok(/another tab/.test(n5), 'tab A is told the plan changed in another tab');
      await act(() => window.LightPlanApp.actions.setProjectName('Tab A house 2'));
      await sleep(900);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lightplan:v1:project')).name);
      t.ok(stored === 'Tab B house', 'tab A no longer overwrites tab B (' + stored + ')');
      await page2.close();
    });
  } catch (e) {
    t.ok(false, 'unexpected error: ' + (e && e.message ? e.message.split('\n')[0] : e));
    await shot('error').catch(() => {});
  }
  t.ok(errors.length === 0, 'no console or page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await context.close();
  return t;
}

// ------------------------------------------------------------------ phone held sideways (mobile-ux:UX-10)
async function runLandscape(browser) {
  const t = new Check('landscape');
  console.log('\n== landscape phone 844x390');
  const { context, page, errors } = await newPhonePage(browser, { viewport: { width: 844, height: 390 } });
  try {
    await page.goto(URL);
    await waitForApp(page);
    await page.click('button.step[data-step="3"]');
    await sleep(300);
    await press(page, '[data-act="trace-type"][data-type="roofline"]');
    await sleep(400);
    const c = await boxOf(page, '#viewport canvas');
    const hint = await boxOf(page, '#hintbar');
    t.ok(c && c.h >= 250, 'the tracing canvas keeps most of the height (' + (c && Math.round(c.h)) + ' px)');
    t.ok(hint && c && hint.h <= c.h * 0.35, 'the hint bar covers little of it (' + (hint && Math.round(hint.h)) + ' px)');
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    t.ok(overflowX <= 0, 'no horizontal page scroll');
    await page.screenshot({ path: path.join(OUT, 'landscape-trace.png') });
  } catch (e) {
    t.ok(false, 'unexpected error: ' + (e && e.message ? e.message.split('\n')[0] : e));
  }
  t.ok(errors.length === 0, 'no console or page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await context.close();
  return t;
}

// ------------------------------------------------------------------ Phase 1.1 UI (SPEC §8.4 and §8.5)
// Cords on the photo (A), the Power step (B), the PDF report (C), rough measurements on Review (D), the flow (E),
// tap precision (F) and the small fixes (G), on a 390 px phone and on a desktop.

/** A 640x480 JPEG (a photo that is too small to measure well). */
async function makeSmallJpeg(page) {
  const file = path.join(OUT, 'fixture-small.jpg');
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    g.fillStyle = '#9cc3e6'; g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#e9e1cf'; g.fillRect(140, 200, 360, 160);
    g.fillStyle = '#5a4030'; g.fillRect(300, 270, 44, 90);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

async function runPhase11(browser, name) {
  const cfg = PASSES[name === 'v11-phone' ? 'phone' : 'desktop'];
  const phone = !!cfg.hasTouch;
  const t = new Check(name);
  console.log('\n== Phase 1.1 UI ' + cfg.viewport.width + 'x' + cfg.viewport.height);
  const context = await browser.newContext({
    viewport: cfg.viewport, isMobile: cfg.isMobile, hasTouch: cfg.hasTouch, colorScheme: 'light',
    deviceScaleFactor: 1, acceptDownloads: true, reducedMotion: 'no-preference',
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console error: ' + m.text()); });
  const shot = (label) => page.screenshot({ path: path.join(OUT, name + '-' + label + '.png') });
  const act = (fn, arg) => page.evaluate(fn, arg);
  const goStep = async (n) => { await page.click('button.step[data-step="' + n + '"]'); await sleep(350); };
  const only = process.env.LP_SECTIONS ? new RegExp(process.env.LP_SECTIONS) : null;
  const sec = async (title, fn) => {
    if (only && !only.test(title)) return;
    try {
      await page.evaluate(() => { const a = window.LightPlanApp.actions; a.cancelDraft(); a.select(null); window.LightPlanApp.store.setUI({ dialog: null, toast: null }); }).catch(() => {});
      await fn();
    } catch (e) {
      t.ok(false, title + ': unexpected error: ' + (e && e.message ? e.message.split('\n')[0] : e));
      await shot('error-' + title.replace(/[^a-z0-9]+/gi, '-').slice(0, 30)).catch(() => {});
    }
  };
  /** The pinned button: its label, the action it holds, and whether all of it is inside the window. */
  const pinned = () => page.evaluate(() => {
    const b = document.getElementById('action-btn');
    const bar = document.getElementById('action-bar');
    if (!b || !bar || bar.hidden) return { label: null, inView: false };
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      label: b.textContent.trim(), action: b.getAttribute('data-action'), primary: b.classList.contains('primary'),
      inView: r.height >= 40 && r.top >= 0 && r.bottom <= window.innerHeight + 0.5 && r.left >= 0 && r.right <= window.innerWidth + 0.5 && !!top && b.contains(top),
      note: (document.getElementById('action-note') || {}).textContent || '',
    };
  });
  /** Zoom the photo so image point c sits mid-canvas at k times the fit scale. */
  const zoomTo = async (c, k) => {
    await act(([pt, kk]) => {
      const vp = window.LightPlanApp.viewport;
      vp.fit();
      const v = vp.getView();
      const s = v.fitScale * 0.96 * kk;
      vp.setView({ scale: s, tx: v.cssW / 2 - pt[0] * s, ty: v.cssH / 2 - pt[1] * s });
    }, [c, k]);
    await sleep(450);
  };
  /** What the cord labels on the canvas look like right now (see drawLabels / labelBoxes in viewport.js). */
  const labelReport = () => page.evaluate(() => {
    const vp = window.LightPlanApp.viewport;
    const M = LP.require('ui.viewport');
    const cr = document.querySelector('#viewport canvas').getBoundingClientRect();
    const boxes = vp.labelBoxes();
    const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const floats = Array.from(document.querySelectorAll('.canvas-controls, .hintbar, .sample-banner')).map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height }));
    const pairs = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i], boxes[j])) pairs.push(boxes[i].text + ' x ' + boxes[j].text);
    const under = boxes.filter((b) => floats.some((f) => hit(b, f))).map((b) => b.text);
    const outside = boxes.filter((b) => b.x < 0 || b.y < 0 || b.x + b.w > cr.width + 0.5 || b.y + b.h > cr.height + 0.5).map((b) => b.text);
    // Every cord label lies right beside a cord that carries that label.
    const power = window.LightPlanApp.store.plan().power;
    const distToBox = (q, b) => Math.hypot(Math.max(b.x - q[0], 0, q[0] - (b.x + b.w)), Math.max(b.y - q[1], 0, q[1] - (b.y + b.h)));
    const far = [];
    const cordLabels = boxes.filter((b) => /ft (cord|jumper)$/.test(b.text));
    for (const b of cordLabels) {
      let best = Infinity;
      for (const f of power.feeds) {
        if (M.cordLabelText(f) !== b.text) continue;
        const S = (f.cordPath || []).map((q) => vp.imageToScreen(q));
        for (let i = 0; i + 1 < S.length; i++) {
          const len = Math.hypot(S[i + 1][0] - S[i][0], S[i + 1][1] - S[i][1]);
          const n = Math.max(1, Math.ceil(len / 2));
          for (let k = 0; k <= n; k++) best = Math.min(best, distToBox([S[i][0] + (S[i + 1][0] - S[i][0]) * k / n, S[i][1] + (S[i + 1][1] - S[i][1]) * k / n], b));
        }
      }
      if (best > 22) far.push(b.text + ' (' + Math.round(best) + ' px from its cord)');
    }
    return {
      texts: boxes.map((b) => b.text), cords: cordLabels.filter((b) => / cord$/.test(b.text)).length, jumpers: cordLabels.filter((b) => / jumper$/.test(b.text)).length,
      anchoredAll: cordLabels.every((b) => b.anchored), pairs, under, outside, far,
    };
  });

  try {
    await page.goto(URL);
    await waitForApp(page);
    await sleep(500);

    // ---- The three screens the hand-off asks to be looked at, on the sample as it first opens.
    for (const n of [3, 5, 6]) {
      await goStep(n);
      if (n === 5) await act(() => window.LightPlanApp.actions.setView({ night: false }));
      await sleep(300);
      await shot('step' + n);
      const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      t.ok(overflowX <= 0, 'step ' + n + ': no horizontal page scroll');
    }

    // ================================================================ A. cords on the photo
    await sec('A1 cord labels', async () => {
      await goStep(5);
      await act(() => { const a = window.LightPlanApp.actions; a.dismissBanner(); a.setView({ night: false, preview: true, labels: true, overlay: true }); });
      await zoomTo([700, 720], phone ? 2.4 : 1);
      const a = await labelReport();
      t.ok(a.cords >= 1 && a.jumpers >= 1 && a.anchoredAll, 'cords are labelled "N ft cord" and jumpers "N ft jumper" (' + a.texts.filter((x) => / ft /.test(x)).join(', ') + ')');
      t.ok(a.texts.includes('25 ft cord') || a.texts.includes('15 ft cord'), 'a cord from an outlet carries the length that is bought');
      t.ok(a.texts.some((x) => /outlet$/i.test(x)), 'outlet labels are still shown (' + a.texts.filter((x) => /outlet/i.test(x)).join(', ') + ')');
      t.ok(a.pairs.length === 0, 'no label covers another label or an outlet label' + (a.pairs.length ? ': ' + a.pairs.join('; ') : ''));
      t.ok(a.under.length === 0, 'no label sits under the buttons floating over the photo' + (a.under.length ? ': ' + a.under.join(', ') : ''));
      t.ok(a.outside.length === 0 && a.far.length === 0, 'every cord label is on the canvas beside its own cord' + (a.far.length ? ': ' + a.far.join('; ') : ''));
      await shot('cords');
      // Zoomed in with half the cords off screen to the left (this is where four labels used to pile up at the edge).
      await zoomTo([930, 700], phone ? 3.4 : 2.7);
      const z = await labelReport();
      t.ok(z.pairs.length === 0 && z.outside.length === 0 && z.far.length === 0 && z.under.length === 0,
        'zoomed in with cords running off screen: labels stay beside their cords, none at the edge (' + z.texts.filter((x) => / ft /.test(x)).join(', ') + ')' +
        (z.pairs.concat(z.far, z.under).length ? ' problems: ' + z.pairs.concat(z.far, z.under).join('; ') : ''));
      await shot('cords-zoomed');
    });

    await sec('A2 cord styles and markers', async () => {
      await goStep(5);
      await act(() => { const a = window.LightPlanApp.actions; a.dismissBanner(); a.setView({ night: false, preview: false, labels: false, overlay: true }); });
      await zoomTo([760, 730], phone ? 2.4 : 1.3);
      const px = await page.evaluate(() => {
        const vp = window.LightPlanApp.viewport;
        const M = LP.require('ui.viewport');
        const c = document.querySelector('#viewport canvas');
        const ctx = c.getContext('2d');
        const power = window.LightPlanApp.store.plan().power;
        const near = (q, rgb, tol) => Math.abs(q[0] - rgb[0]) <= tol && Math.abs(q[1] - rgb[1]) <= tol && Math.abs(q[2] - rgb[2]) <= tol;
        const at = (s) => ctx.getImageData(Math.round(s[0]), Math.round(s[1]), 1, 1).data;
        /** Share of the points along a→b (from t0 to t1 of the way) painted in the cord colour. */
        const share = (a, b, rgb, t0, t1) => {
          const A = vp.imageToScreen(a), B = vp.imageToScreen(b);
          const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
          let n = 0, on = 0;
          for (let d = len * t0; d <= len * t1; d += 0.5) { n += 1; if (near(at([A[0] + (B[0] - A[0]) * d / len, A[1] + (B[1] - A[1]) * d / len]), rgb, 45)) on += 1; }
          return { share: n ? on / n : 0, len: Math.round(len) };
        };
        const BLUE = [79, 157, 255], ORANGE = [255, 138, 61];
        const home = power.feeds.find((f) => f.id === 'feed_ft_garage_gutter_1');
        const riser = home.cord.route.find((r) => r.kind === 'rise');
        const jumper = power.feeds.find((f) => f.id === 'feed_ft_tree_1');
        const ground = jumper.cord.route.find((r) => r.kind === 'ground');
        const taps = M.tapMarkers(power).map((tp) => { const s = vp.imageToScreen(tp.point); return s[0] > 4 && s[1] > 4 && s[0] < c.width - 4 && s[1] < c.height - 4 ? Array.from(at(s)).slice(0, 3) : null; }).filter(Boolean);
        return {
          homeKind: home.cord.kind, jumperKind: jumper.cord.kind,
          home: share(riser.from, riser.to, ORANGE, 0.4, 0.85), jumper: share(ground.from, ground.to, BLUE, 0.2, 0.8),
          taps, tapCount: power.counts.taps,
        };
      });
      t.ok(px.homeKind === 'home' && px.home.len > 20 && px.home.share > 0.95, 'a cord from an outlet is drawn as a solid line in its circuit colour (' + (px.home.share * 100).toFixed(0) + '% of ' + px.home.len + ' px)');
      t.ok(px.jumperKind === 'jumper' && px.jumper.len > 40 && px.jumper.share > 0.3 && px.jumper.share < 0.9, 'a jumper cord is drawn dashed (' + (px.jumper.share * 100).toFixed(0) + '% of ' + px.jumper.len + ' px painted)');
      t.ok(px.taps.length >= 3 && px.taps.every((q) => q[0] > 215 && q[1] > 215 && q[2] > 215), 'each 3-way tap has a white marker where it sits (' + px.taps.length + ' of ' + px.tapCount + ' in view)');
      await shot('cord-styles');
      // A run that plugs straight into the one before it: a ring and "plugs in", and no cord of its own.
      await act(() => window.LightPlanApp.store.commit('test: walkway starts at the door plug', (d) => { d.features.find((f) => f.id === 'ft_walk_right').points[0] = [732.4, 809.3]; }));
      await act(() => window.LightPlanApp.actions.setView({ labels: true }));
      await zoomTo([735, 800], phone ? 6 : 3.2);
      const pi = await page.evaluate(() => {
        const vp = window.LightPlanApp.viewport;
        const ctx = document.querySelector('#viewport canvas').getContext('2d');
        const feed = window.LightPlanApp.store.plan().power.feeds.find((f) => f.plugIn === true);
        if (!feed) return null;
        const s = vp.imageToScreen(feed.start.point);
        let white = 0;
        for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; const q = ctx.getImageData(Math.round(s[0] + Math.cos(a) * 9), Math.round(s[1] + Math.sin(a) * 9), 1, 1).data; if (q[0] > 200 && q[1] > 200 && q[2] > 200) white += 1; }
        const row = document.querySelector('.feed-item[data-key="' + feed.id + '"]');
        return { id: feed.id, cord: feed.cord, white, labels: vp.labelBoxes().map((b) => b.text), kind: row ? row.getAttribute('data-kind') : null, rowText: row ? row.innerText : '' };
      });
      t.ok(!!pi && pi.cord === null, 'the test plan has a run that plugs straight in');
      t.ok(pi && pi.white >= 12 && pi.labels.includes('plugs in'), 'it gets a ring and a "plugs in" label on the photo (' + (pi && pi.white) + '/24 ring points, labels ' + (pi && pi.labels.join(', ')) + ')');
      t.ok(pi && pi.kind === 'plugIn' && /Plugs straight into the end of Front door \(no cord needed\)/.test(pi.rowText) && !/unknown/i.test(pi.rowText), 'the Power list says it plugs straight in, not "length unknown" (' + (pi && pi.rowText.replace(/\s+/g, ' ').slice(0, 90)) + ')');
      await shot('plug-in');
      await page.click('#btn-undo');
      await sleep(300);
      t.ok(await act(() => !window.LightPlanApp.store.plan().power.feeds.some((f) => f.plugIn)), 'undo puts the walkway back');
      await act(() => { window.LightPlanApp.viewport.fit(); window.LightPlanApp.actions.setView({ preview: true, labels: true }); });
    });

    // ================================================================ B. the Power step
    await sec('B1 verdict, outlets, tiles', async () => {
      await goStep(5);
      if (phone) { await act(() => window.LightPlanApp.actions.setSheet('half')); await sleep(350); }
      await act(() => { document.getElementById('panel-root').scrollTop = 0; });
      const b = await page.evaluate(() => {
        const root = document.getElementById('panel-root');
        const rr = root.getBoundingClientRect();
        const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        const verdict = root.querySelector('[data-key="verdict"]');
        const place = root.querySelector('[data-act="place-outlet"]');
        const disc = root.querySelector('[data-key="disclaimer"]');
        const tiles = {};
        root.querySelectorAll('[data-key="counts"] .tile').forEach((el) => { tiles[el.querySelector('.tile-label').textContent] = el.querySelector('.tile-value').textContent; });
        const feeds = root.querySelector('[data-key="feeds"]');
        const clone = feeds.cloneNode(true);
        clone.querySelectorAll('[data-key="cord-detail"]').forEach((el) => el.remove());
        const rows = Array.from(feeds.querySelectorAll('.feed-item'));
        return {
          verdictText: verdict ? verdict.textContent.trim() : '', verdictClass: verdict ? verdict.className : '',
          firstAfterHead: root.querySelector('.panel-content').children[1] === verdict,
          v: box(verdict), p: box(place), d: box(disc), rootBottom: rr.bottom,
          outletInfo: Array.from(root.querySelectorAll('.outlet-info')).map((el) => el.textContent.trim()),
          tiles, rows: rows.length, kinds: rows.map((r) => r.getAttribute('data-kind')),
          firstRow: rows[0] ? rows[0].innerText.replace(/\s+/g, ' ') : '',
          treeText: clone.textContent, detailText: (feeds.querySelector('[data-key="cord-detail"]') || {}).textContent || '',
          feeds: window.LightPlanApp.store.plan().power.feeds.length,
          ownSwitches: feeds.querySelectorAll('[data-act="feed-own-cord"]').length,
          daisy: !!(root.querySelector('[data-act="power-daisy"]') || {}).checked,
          nextButtons: root.querySelectorAll('.panel-next').length,
        };
      });
      t.ok(/^Good to go: these lights use 233 W, 16% of one outlet's safe limit\.$/.test(b.verdictText) && / ok/.test(b.verdictClass), 'the Power step opens with a plain verdict (' + b.verdictText + ')');
      t.ok(b.firstAfterHead && b.v && b.p && b.d && b.v.bottom <= b.p.top && b.p.bottom <= b.d.top, 'order: verdict, Place outlet, then the planning-estimate note');
      t.ok(b.v && b.v.bottom <= b.rootBottom + 1, 'the verdict is in view without scrolling' + (phone ? ' on a half-open sheet' : ''));
      t.ok(b.outletInfo[0] === '1 cord at this outlet feeding 11 runs · 185 W', 'the outlet card counts the cords at the outlet and the runs they feed (' + b.outletInfo[0] + ')');
      t.ok(b.rows === b.feeds && b.kinds[0] === 'home' && b.kinds.filter((k) => k === 'home').length === 2 && b.kinds.filter((k) => k === 'jumper').length === 10,
        'the supply tree lists every cord: 2 from outlets, 10 jumper cords (' + b.rows + ' rows)');
      t.ok(/Walkway left edge .*15 ft cord from Porch outlet .*Down 1\.5 ft, 2\.5 ft along the ground/.test(b.firstRow), 'a cord row says where it comes from and how it runs (' + b.firstRow.slice(0, 110) + ')');
      t.ok(!/unknown/i.test(b.treeText) && /16-gauge/.test(b.treeText) && !/AWG/.test(b.treeText) && /16 AWG/.test(b.detailText), 'gauge reads "16-gauge" in the list; AWG only under Cord details');
      t.ok(b.tiles['Cords to outlets'] === '2' && b.tiles['Jumper cords'] === '10' && b.tiles['3-way taps'] === '4', 'count tiles: cords to outlets, jumper cords, 3-way taps (' + JSON.stringify(b.tiles) + ')');
      t.ok(/jumper cord \(a short cord from one run to the next\)/.test(b.treeText) && /3-way tap \(a plug with three outlets\)/.test(b.treeText), 'jumper cord and 3-way tap are explained in plain words');
      t.ok(b.daisy === true && b.ownSwitches === 10, 'switches: link nearby runs (on) and one "own cord" per jumper-fed run (' + b.ownSwitches + ')');
      t.ok(b.nextButtons === 0, 'the panel no longer ends in its own Next button');
      await shot('power-top');
    });

    await sec('B2 daisy chain and own cord switches', async () => {
      await goStep(5);
      const own = page.locator('.feed-item[data-key="feed_ft_door_1"] [data-act="feed-own-cord"]');
      await own.evaluate((el) => el.click());
      await sleep(400);
      const o = await page.evaluate(() => {
        const s = window.LightPlanApp.store;
        const door = s.plan().power.feeds.find((f) => f.runIds.includes('run_ft_door'));
        const sw = document.querySelector('.feed-item[data-key="' + door.id + '"] [data-act="feed-own-cord"]');
        return { param: s.project().features.find((f) => f.id === 'ft_door').params.ownCord, source: door.source.kind, checked: !!(sw && sw.checked), homeRuns: s.plan().power.counts.homeRuns, undo: s.undoLabel() };
      });
      t.ok(o.param === true && o.source === 'outlet' && o.checked && o.homeRuns > 2 && o.undo === 'Give a run its own cord', '"Give this run its own cord" gives the door a cord from the outlet (' + JSON.stringify(o) + ')');
      await page.click('#btn-undo');
      await sleep(300);
      t.ok(await act(() => window.LightPlanApp.store.plan().power.counts.homeRuns === 2), 'one Undo takes it back');
      await page.locator('[data-act="power-daisy"]').evaluate((el) => el.click());
      await sleep(500);
      const d = await page.evaluate(() => {
        const s = window.LightPlanApp.store;
        const c = s.plan().power.counts;
        const tiles = {};
        document.querySelectorAll('[data-key="counts"] .tile').forEach((el) => { tiles[el.querySelector('.tile-label').textContent] = el.querySelector('.tile-value').textContent; });
        return {
          cfg: s.project().library.config, jumpers: c.jumpers, homeRuns: c.homeRuns, feeds: s.plan().power.feeds.length, tiles,
          verdict: document.querySelector('[data-key="verdict"]').textContent.trim(), verdictClass: document.querySelector('[data-key="verdict"]').className,
          ownSwitches: document.querySelectorAll('[data-act="feed-own-cord"]').length,
          info: document.querySelector('.outlet-info').textContent.trim(),
        };
      });
      t.ok(d.cfg && d.cfg.power && d.cfg.power.daisyChain === false && d.jumpers === 0 && d.homeRuns === d.feeds, 'switching "Link nearby runs" off gives every run its own cord (' + d.homeRuns + ' cords, ' + d.jumpers + ' jumpers)');
      t.ok(d.tiles['Jumper cords'] === '0' && d.tiles['Cords to outlets'] === String(d.homeRuns) && d.ownSwitches === 0, 'the tiles follow, and the own-cord switches go away');
      t.ok(/^One thing to fix first: .*walkway/i.test(d.verdict) && / warn/.test(d.verdictClass), 'the verdict now names what to fix (' + d.verdict.slice(0, 80) + ')');
      t.ok(/^\d+ cords at this outlet feeding \d+ runs · /.test(d.info), 'the outlet card follows (' + d.info + ')');
      await shot('power-flat');
      await page.locator('[data-act="power-daisy"]').evaluate((el) => el.click());
      await sleep(400);
      t.ok(await act(() => window.LightPlanApp.store.plan().power.counts.jumpers === 10 && !window.LightPlanApp.store.project().library.config), 'switching it back on restores the linked plan and leaves no override behind');
    });

    // ================================================================ D. rough measurements on Review
    await sec('D rough measurements', async () => {
      await goStep(6);
      if (phone) { await act(() => window.LightPlanApp.actions.setSheet('full')); await sleep(350); }
      const d = await page.evaluate(() => {
        const root = document.getElementById('panel-root');
        const sec = root.querySelector('[data-key="rough"]');
        const plan = window.LightPlanApp.store.plan();
        const low = Object.values(plan.measured.features).filter((m) => m.ok && !m.overridden && m.confidence.level === 'low').length;
        const badge = document.querySelector('button.step[data-step="3"] .step-badge');
        const cost = root.querySelector('[data-key="cost-tile"]');
        return {
          first: root.querySelector('.panel-content').children[1] === sec, title: sec ? sec.querySelector('.sec-title').textContent : '', low,
          items: sec ? Array.from(sec.querySelectorAll('.rough-item')).map((li) => ({ id: li.getAttribute('data-key').replace('rough-', ''), text: li.querySelector('.rough-text').textContent, fields: li.querySelectorAll('[data-act="feature-len"]').length, link: !!li.querySelector('[data-act="show-feature"]') })) : [],
          badge: badge && !badge.hidden ? { text: badge.textContent, cls: badge.className } : null,
          cost: cost ? { rough: cost.getAttribute('data-rough'), text: cost.textContent } : null,
        };
      });
      t.ok(d.first && d.title === 'Measurements to double-check (' + d.low + ')' && d.items.length === d.low && d.low >= 3, 'Review opens with "Measurements to double-check (' + d.low + ')"');
      t.ok(d.items.every((it) => it.fields >= 1 && it.link) && d.items.some((it) => /could be \d+(\.5)? to \d+(\.5)? ft/.test(it.text)), 'each item has a range, a tape-measure field and a link (' + (d.items[d.items.length - 1] || {}).text + ')');
      t.ok(d.badge && d.badge.text === String(d.low) && /neutral/.test(d.badge.cls), 'the Trace step counts them in a neutral badge (' + JSON.stringify(d.badge) + ')');
      t.ok(d.cost && d.cost.rough === 'true' && /rough/.test(d.cost.text), 'the cost tile is marked rough');
      await shot('review-rough');
      // Type a tape length for the ridge: it leaves the list and the plan uses it.
      const ridge = page.locator('.rough-item[data-key="rough-ft_ridge"] [data-act="feature-len"]');
      await ridge.evaluate((el) => { const det = el.closest('details'); if (det) det.open = true; });
      await ridge.scrollIntoViewIfNeeded();
      await ridge.fill('33 6');
      await ridge.press('Enter');
      await ridge.evaluate((el) => el.blur()).catch(() => {});
      await sleep(500);
      const after = await page.evaluate(() => {
        const s = window.LightPlanApp.store;
        const sec = document.querySelector('[data-key="rough"]');
        return { override: s.project().features.find((f) => f.id === 'ft_ridge').overrideFt, run: s.plan().runs.find((r) => r.featureId === 'ft_ridge').lengthFt, title: sec.querySelector('.sec-title').textContent, still: !!sec.querySelector('[data-key="rough-ft_ridge"]'), badge: document.querySelector('button.step[data-step="3"] .step-badge').textContent };
      });
      t.ok(after.override === 33.5 && after.run === 33.5 && !after.still && after.title === 'Measurements to double-check (' + (d.low - 1) + ')' && after.badge === String(d.low - 1),
        'a tape-measured length sets the override and takes the item off the list (' + JSON.stringify(after) + ')');
      // "Show it" opens the item in the Trace step.
      const show = page.locator('.rough-item [data-act="show-feature"]').first();
      const showId = await show.getAttribute('data-id');
      await show.scrollIntoViewIfNeeded();
      await show.click();
      await sleep(500);
      const shown = await ui(page);
      t.ok(shown.step === 3 && shown.selection && shown.selection.id === showId, '"Show it" opens the item in the Trace step (' + showId + ')');
      await act(() => window.LightPlanApp.actions.select(null));
      await page.click('#btn-undo');
      await sleep(300);
      t.ok(await act(() => window.LightPlanApp.store.project().features.find((f) => f.id === 'ft_ridge').overrideFt == null), 'undo clears the tape length again');
    });

    // ================================================================ E. flow: the pinned button and the step bar
    await sec('E1 pinned button on the sample', async () => {
      const want = { 1: 'Next: Calibrate', 2: 'Next: Trace', 3: 'Next: Design', 4: 'Next: Power', 5: 'See the shopping list', 6: 'Save PDF' };
      for (let n = 1; n <= 6; n += 1) {
        await goStep(n);
        for (const sheet of phone ? ['min', 'half', 'full'] : ['half']) {
          if (phone) { await act((sh) => window.LightPlanApp.actions.setSheet(sh), sheet); await sleep(350); }
          const p = await pinned();
          t.ok(p.label === want[n] && p.inView && p.primary, 'step ' + n + (phone ? ' (sheet ' + sheet + ')' : '') + ': "' + p.label + '" is pinned in view');
        }
      }
      const done = await page.evaluate(() => Array.from(document.querySelectorAll('#stepbar-list [data-step]')).map((b) => b.getAttribute('data-done')).join(','));
      t.ok(done === 'true,true,true,true,true,false', 'the step bar marks steps done from the plan (' + done + ' while step 6 is open)');
      await goStep(1);
      const done1 = await page.evaluate(() => Array.from(document.querySelectorAll('#stepbar-list .step.done')).length);
      t.ok(done1 === 5, 'the same five steps are done while step 1 is open (' + done1 + ')');
      // The button moves on, and on step 6 it saves the PDF (C: the report carries the cord kinds, routes and taps).
      if (phone) { await act(() => window.LightPlanApp.actions.setSheet('half')); await sleep(300); }
      await page.click('#action-btn');
      await sleep(350);
      t.ok((await ui(page)).step === 2, 'the pinned button opens the next step');
      await goStep(6);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#action-btn')]);
      const pdfFile = path.join(OUT, name + '-' + dl.suggestedFilename());
      await dl.saveAs(pdfFile);
      let text = '';
      try { text = execFileSync('pdftotext', [pdfFile, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' '); } catch (e) { text = ''; }
      t.ok(/\.pdf$/.test(pdfFile) && fs.readFileSync(pdfFile).subarray(0, 4).toString('latin1') === '%PDF', '"Save PDF" on Review saves the report');
      t.ok(/PLUGS INTO/.test(text) && /CORD AND ROUTE/.test(text) && /15 ft cord, 16 AWG/.test(text) && /6 ft jumper cord, 16 AWG/.test(text) && /The end of Front door/.test(text),
        'PDF cords table: what each cord plugs into, cord or jumper cord');
      t.ok(/Down 1\.5 ft, 2\.5 ft along the ground\./.test(text) && /3-way tap at its start/.test(text), 'PDF cords table: route in words and where the 3-way taps go');
      t.ok(/2 10 4 \d+ Cords to outlets Jumper cords 3-way taps Timers/.test(text), 'PDF counts: cords to outlets, jumper cords, 3-way taps');
      t.ok(/Measurements to double-check \(\d+\)/.test(text) && /Materials cost \(rough\)/.test(text), 'PDF lists the measurements to double-check and marks the cost rough');
      await sleep(600);
    });

    await sec('G lens wording', async () => {
      await goStep(1);
      await act(() => { const s = window.LightPlanApp.store; window.LightPlanApp.actions.updateImageCamera(s.project().images[0].id, { mode: 'preset', presetId: 'streetview' }); });
      await sleep(400);
      const g = await page.evaluate(() => {
        const sel = document.querySelector('[data-act="lens-mode"]');
        return { option: sel ? sel.options[sel.selectedIndex].textContent : '', options: sel ? Array.from(sel.options).map((o) => o.textContent).join(' | ') : '', text: document.getElementById('lp-app').innerText };
      });
      t.ok(g.option === 'Screenshot (wide view)', 'the wide lens preset is called "Screenshot (wide view)" (' + g.option + ')');
      t.ok(!/street\s*view/i.test(g.text) && !/street\s*view/i.test(g.options), 'no "Street View" wording on screen');
      await page.click('#btn-undo');
      await sleep(300);
    });

    // ================================================================ E2, F, G on a fresh photo
    await sec('E2 empty state and photo load', async () => {
      await page.click('#btn-menu');
      await sleep(200);
      await page.click('[data-menu="start-over"]');
      await sleep(250);
      await page.click('#dialog-confirm');
      await sleep(500);
      const e = await page.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const buttons = Array.from(document.querySelectorAll('#lp-app button')).filter(vis).map((b) => b.textContent.trim());
        const text = Array.from(document.querySelectorAll('#lp-app p, #lp-app h2, #lp-app span')).filter(vis).map((el) => el.textContent).join(' ');
        return { take: buttons.filter((x) => x === 'Take photo').length, choose: buttons.filter((x) => x === 'Choose photo').length, drop: /drop (a|one|the) (photo)?/i.test(text) || /drop one/i.test(text), chooseOrTake: /Choose or take a photo/.test(text),
          done: Array.from(document.querySelectorAll('#stepbar-list .step.done')).length };
      });
      const p0 = await pinned();
      t.ok(p0.label === 'Choose photo' && p0.inView, 'with no photo the pinned button says "Choose photo"');
      t.ok(e.take === 1, 'the Take photo button is shown once (' + e.take + ')');
      t.ok(e.chooseOrTake && (phone ? !e.drop : e.drop), phone ? 'a phone reads "Choose or take a photo", with nothing about dropping a file' : 'a desktop also offers to drop a photo');
      t.ok(e.done === 0, 'no step is marked done on an empty plan');
      await shot('empty');
      // A photo under 1,000 px wide: it loads, step 2 opens, and a warning says it is small.
      const small = await makeSmallJpeg(page);
      await page.setInputFiles('#file-input', small);
      await page.waitForFunction(() => window.LightPlanApp.store.project().images.length === 1, null, { timeout: 10000 });
      await sleep(600);
      const sm = await page.evaluate(() => { const u = window.LightPlanApp.store.ui(); return { step: u.step, toast: u.toast, callout: !!document.querySelector('[data-key="small-photo"]') }; });
      t.ok(sm.step === 2 && sm.toast && sm.toast.kind === 'warn' && /small \(640 px wide\)/.test(sm.toast.message) && sm.callout, 'a 640 px photo is accepted with a warning that it is small (' + (sm.toast && sm.toast.message.slice(0, 60)) + ')');
      // The real fixture (1200 px): step 2 opens by itself and the app says so.
      await page.evaluate(() => { window.LightPlanApp.store.setUI({ toast: null }); });
      const jpg = await makeFixtureJpeg(page);
      await page.setInputFiles('#file-input', jpg);
      await sleep(300);
      if (await page.locator('#dialog-backdrop').isVisible()) await page.click('#dialog-confirm');
      await page.waitForFunction(() => { const im = window.LightPlanApp.store.project().images[0]; return im && im.width === 1200; }, null, { timeout: 10000 });
      await sleep(600);
      const up = await page.evaluate(() => {
        const u = window.LightPlanApp.store.ui();
        return { step: u.step, toast: u.toast, small: !!document.querySelector('[data-key="small-photo"]'), done: Array.from(document.querySelectorAll('#stepbar-list [data-step]')).map((b) => b.getAttribute('data-done')).join(',') };
      });
      t.ok(up.step === 2 && up.toast && up.toast.kind === 'ok' && /step 2/.test(up.toast.message) && !up.small, 'after the photo loads step 2 opens and a message says so (' + (up.toast && up.toast.message) + ')');
      t.ok(up.done === 'true,false,false,false,false,false', 'only the Photo step is done, though step 2 is open (' + up.done + ')');
      const p2 = await pinned();
      t.ok(p2.label === 'Mark the 4 corners' && p2.inView && /Left to do: set the scale, trace the lights, place an outlet\./.test(p2.note), 'the pinned button says "Mark the 4 corners" and what is left (' + p2.note + ')');
      await shot('photo-added');
      // A toast does not follow to another step.
      await goStep(3);
      t.ok((await ui(page)).toast == null, 'the toast is gone after a step change');
      await goStep(2);
    });

    await sec('F tap precision', async () => {
      // Mark the 4 corners from the pinned button, at the zoom the photo opens with.
      await act(() => window.LightPlanApp.actions.setCalib({ rectPresetId: 'garage-double' }));
      await page.click('#action-btn');
      await sleep(400);
      const m = await ui(page);
      t.ok(m.mode.name === 'rect' && m.mode.opts.purpose === 'planeRect', 'the pinned button starts marking the rectangle');
      const pc = await pinned();
      t.ok(pc.label === 'Cancel' && !pc.primary && pc.inView, 'while a tool is in use the pinned button is the way out (' + pc.label + ')');
      // A phone marks them at the zoom the photo opens with; the desktop zooms out first, so that a mouse is
      // coarser than the 2.5 px floor too and the stored value can be told from a later, finer tap.
      if (!phone) await zoomTo([600, 450], 0.35);
      const scale = await act(() => window.LightPlanApp.viewport.getView().scale);
      const corners = [[250, 360], [950, 360], [950, 660], [250, 660]];
      for (const c of await toPage(page, corners)) await tapAt(page, cfg, c[0], c[1]);
      await sleep(300);
      const rect = await act(() => window.LightPlanApp.store.project().planes[0].rect);
      const k = phone ? 3 : 1.5;
      const want = Math.round(Math.min(80, Math.max(2.5, k / scale)) * 100) / 100;
      t.ok(rect && Array.isArray(rect.tapErr) && rect.tapErr.length === 4 && rect.tapErr.every((e) => Math.abs(e - want) < 0.011),
        'each corner stores its tap precision: clamp(' + k + ' / ' + scale.toFixed(3) + ') = ' + want + ' px (' + JSON.stringify(rect && rect.tapErr) + ')');
      t.ok(want > 5, (phone ? 'a finger at fit zoom on a phone' : 'a mouse on a zoomed-out photo') + ' is much coarser than the old 2.5 px (' + want + ' px)');
      const pt = await pinned();
      t.ok(pt.label === 'Trace the lights', 'with the scale set the pinned button says "Trace the lights" (' + pt.label + ')');
      // Drag one corner while zoomed in: only that corner's value changes, and it gets better.
      await act(() => window.LightPlanApp.actions.select({ kind: 'plane', id: window.LightPlanApp.store.project().planes[0].id }));
      if (phone) { await act(() => window.LightPlanApp.actions.setSheet('min')); await sleep(350); }
      await zoomTo([950, 660], 4);
      const [from] = await toPage(page, [[950, 660]]);
      if (phone) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
        for (let i = 1; i <= 6; i += 1) { await sleep(70); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from[0] + i * 3, y: from[1] + i * 2 }] }); }
        await sleep(80);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.move(from[0], from[1]);
        await page.mouse.down();
        for (let i = 1; i <= 6; i += 1) { await page.mouse.move(from[0] + i * 3, from[1] + i * 2); await sleep(30); }
        await page.mouse.up();
      }
      await sleep(400);
      const dragged = await act(() => { const r = window.LightPlanApp.store.project().planes[0].rect; return { tapErr: r.tapErr, corner: r.corners[2], scale: window.LightPlanApp.viewport.getView().scale }; });
      const wantDrag = Math.round(Math.min(80, Math.max(2.5, k / (dragged.scale * (phone ? 2.5 : 1)))) * 100) / 100;
      t.ok(Math.hypot(dragged.corner[0] - 950, dragged.corner[1] - 660) > 1 && Math.abs(dragged.tapErr[2] - wantDrag) < 0.011 && dragged.tapErr[0] === want && dragged.tapErr[1] === want && dragged.tapErr[3] === want,
        'dragging one corner zoomed in' + (phone ? ' (aimed with the loupe)' : '') + ' updates that corner only: ' + JSON.stringify(dragged.tapErr) + ' (expected ' + wantDrag + ' at index 2)');
      await page.click('#btn-undo');
      await sleep(300);
      const undone = await act(() => window.LightPlanApp.store.project().planes[0].rect.tapErr);
      t.ok(undone.length === 4 && undone.every((e) => e === want), 'undo restores the corner and its value (' + JSON.stringify(undone) + ')');
      // Trace an eave: the first end snaps onto a rectangle corner and copies its value; the second is a fresh tap.
      await act(() => { window.LightPlanApp.viewport.fit(); window.LightPlanApp.actions.select(null); });
      await goStep(3);
      await press(page, '[data-act="trace-type"][data-type="roofline"]');
      await zoomTo([420, 340], phone ? 2.5 : 1);
      const view = await act(() => window.LightPlanApp.viewport.getView().scale);
      const corner0 = await act(() => window.LightPlanApp.store.project().planes[0].rect.corners[0]);
      const [a, b] = await toPage(page, [corner0, [600, 300]]);
      await tapAt(page, cfg, a[0] + 2, a[1] + 1);
      await tapAt(page, cfg, b[0], b[1]);
      const draft = (await ui(page)).draft;
      const fresh = Math.round(Math.min(80, Math.max(2.5, k / view)) * 100) / 100;
      t.ok(draft.points.length === 2 && draft.points[0][0] === corner0[0] && draft.points[0][1] === corner0[1] && draft.tapErr[0] === want && Math.abs(draft.tapErr[1] - fresh) < 0.011 && fresh < want,
        'a point snapped onto a corner copies that corner\'s value (' + want + '); a fresh tap gets its own (' + fresh + '): ' + JSON.stringify(draft.tapErr));
      await page.click('#hint-finish');
      await sleep(400);
      const feat = await act(() => { const f = window.LightPlanApp.store.project().features; return f[f.length - 1]; });
      t.ok(feat && feat.tapErr && feat.tapErr.length === feat.points.length && feat.tapErr[0] === want, 'the traced item stores one value per point (' + JSON.stringify(feat && feat.tapErr) + ')');
      // Insert a point with the + handle, then delete it: the list stays in step.
      const mid = [(feat.points[0][0] + feat.points[1][0]) / 2, (feat.points[0][1] + feat.points[1][1]) / 2];
      const [mp] = await toPage(page, [mid]);
      await tapAt(page, cfg, mp[0], mp[1]);
      await sleep(300);
      const ins = await act((id) => { const f = window.LightPlanApp.store.project().features.find((x) => x.id === id); return { n: f.points.length, e: f.tapErr }; }, feat.id);
      t.ok(ins.n === 3 && ins.e.length === 3 && ins.e[1] === 2.5, 'inserting a point keeps the list aligned (' + JSON.stringify(ins.e) + ')');
      await act((id) => window.LightPlanApp.actions.deleteVertex(id, 1), feat.id);
      const del = await act((id) => { const f = window.LightPlanApp.store.project().features.find((x) => x.id === id); return { n: f.points.length, e: f.tapErr }; }, feat.id);
      t.ok(del.n === 2 && del.e.length === 2 && del.e[0] === want, 'deleting it too (' + JSON.stringify(del.e) + ')');
      await act(() => window.LightPlanApp.actions.finishTracing());
    });

    await sec('G hint wording', async () => {
      await goStep(2);
      await act(() => { const a = window.LightPlanApp.actions; a.setCalib({ refPresetId: 'door-height' }); a.startReference(window.LightPlanApp.store.project().planes[0].id); });
      await sleep(350);
      const hint = await page.evaluate(() => document.getElementById('hint-text').textContent);
      t.ok(/^Tap both ends of the entry door height on /.test(hint) && !/the the/.test(hint), 'the reference hint reads "the entry door height" once (' + hint + ')');
      await shot('hint');
      await act(() => window.LightPlanApp.actions.cancelDraft());
      // A walkway before any ground plane: the hint bar explains, and no toast repeats it.
      await goStep(3);
      await press(page, '[data-act="trace-type"][data-type="walkway"]');
      await sleep(350);
      const w = await page.evaluate(() => ({ hint: document.getElementById('hint-text').textContent, toast: window.LightPlanApp.store.ui().toast, mode: window.LightPlanApp.store.ui().mode }));
      t.ok(w.mode.name === 'line' && w.mode.opts.purpose === 'groundBase' && /lie on the ground, so mark the ground first/.test(w.hint) && w.toast == null, 'starting a walkway explains the ground step in the hint bar only (' + w.hint.slice(0, 60) + ')');
      await act(() => window.LightPlanApp.actions.cancelDraft());
      // An outlet has not been placed: the Power step says so in one sentence and the pinned button offers it.
      await goStep(5);
      const v = await page.evaluate(() => document.querySelector('[data-key="verdict"]').textContent.trim());
      const pp = await pinned();
      t.ok(/^Place an outlet: these lights use/.test(v) && !/feed/i.test(v) && pp.label === 'Place an outlet' && pp.inView, 'with no outlet the verdict and the pinned button both say to place one (' + v.slice(0, 50) + ')');
      await page.click('#action-btn');
      await sleep(300);
      t.ok((await ui(page)).mode.name === 'outlet', 'the pinned button starts placing an outlet');
      await act(() => window.LightPlanApp.actions.cancelDraft());
    });
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
  if (name === 'review') { results.push(await runReview(browser)); continue; }
  if (name === 'landscape') { results.push(await runLandscape(browser)); continue; }
  if (name === 'storage') { results.push(await runBlockedStorage(browser)); continue; }
  if (name === 'inputs') { results.push(await runPlanningInputs(browser)); continue; }
  if (name === 'measure') { results.push(await runMeasureChecks(browser)); continue; }
  if (name === 'v11-phone' || name === 'v11-desktop') { results.push(await runPhase11(browser, name)); continue; }
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
