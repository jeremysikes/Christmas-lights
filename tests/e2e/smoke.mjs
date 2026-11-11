// LightPlan end-to-end smoke test (Playwright + Chromium).
//
// Usage:
//   npm run e2e                          build dist/ and run every pass (phone, desktop, desktop dark,
//                                        blocked storage)
//   node tests/e2e/smoke.mjs             run against the existing dist/lightplan.html
//   node tests/e2e/smoke.mjs --only=phone        one pass: phone | desktop | dark | storage | inputs | measure |
//                                                review | landscape | v11-phone | v11-desktop | sup-phone | sup-desktop
//                                                (storage = localStorage and IndexedDB blocked;
//                                                inputs = safe share, tax, file version, damaged photo;
//                                                review = UI review findings on a phone; landscape = 844x390;
//                                                v11-* = the Phase 1.1 UI, SPEC 8.4 and 8.5: cords on the photo,
//                                                the Power step, rough measurements, the flow, tap precision.
//                                                They also write ui-finish-<phone|desktop>-step<2|3|5|6>.png,
//                                                -step5-no-jumpers.png and dark-scheme copies of steps 5 and 6;
//                                                sup-* = suppliers, SPEC 8.3 and 8.5: "Buy from", pickers, part
//                                                numbers and links, order sheets, cost basis, exports. They write
//                                                ui-suppliers-<phone|desktop>-step<4|6>-<cle|1000bulbs>*.png)
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
const selected = onlyArg ? onlyArg.slice(7).split(',') : Object.keys(PASSES).concat('storage', 'inputs', 'measure', 'review', 'landscape', 'v11-phone', 'v11-desktop', 'sup-phone', 'sup-desktop');

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
    const bought = (kind) => power.feeds.filter((f) => f.cord && f.cord.kind === kind).map((f) => M.cordLabelText(f));
    return {
      texts: boxes.map((b) => b.text), cords: cordLabels.filter((b) => / cord$/.test(b.text)).length, jumpers: cordLabels.filter((b) => / jumper$/.test(b.text)).length,
      anchoredAll: cordLabels.every((b) => b.anchored), pairs, under, outside, far,
      homeTexts: bought('home'), jumperTexts: bought('jumper'),
    };
  });
  /** Centre a stretch of cord (two image points) on the photo so that it spans about half the canvas. */
  const zoomToPiece = async (a, b) => {
    await act(([p, q]) => {
      const vp = window.LightPlanApp.viewport;
      vp.fit();
      const v = vp.getView();
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      // The sheet covers the lower part of the canvas on a phone; pixels are read from the canvas itself, so only
      // the canvas size matters here.
      const s = Math.min(6, Math.max(v.fitScale * 0.96, 0.5 * Math.min(v.cssW, v.cssH) / len));
      vp.setView({ scale: s, tx: v.cssW / 2 - ((p[0] + q[0]) / 2) * s, ty: v.cssH / 2 - ((p[1] + q[1]) / 2) * s });
    }, [a, b]);
    await sleep(450);
  };
  /** Flip "Give this run its own cord" on the row of the cord that feeds a traced item. */
  const flipOwnCord = async (featureId) => {
    const ok = await page.evaluate((id) => {
      const sw = Array.from(document.querySelectorAll('[data-act="feed-own-cord"]')).find((el) => (el.getAttribute('data-ids') || '').split(',').includes(id));
      if (sw) sw.click();
      return !!sw;
    }, featureId);
    await sleep(400);
    return ok;
  };
  /** Wait for the autosave (debounced), reload the page and wait for the app. */
  const reload = async () => {
    await sleep(1000);
    await page.reload();
    await waitForApp(page);
  };

  try {
    await page.goto(URL);
    await waitForApp(page);
    await sleep(500);

    // ---- The screens the hand-off asks to be looked at, on the sample as it first opens (day view, so the cords
    // and labels can be read): steps 2, 3, 5 and 6, step 5 with jumper cords switched off, and steps 5 and 6 in the
    // dark colour scheme. A phone also gets the panel on its own (sheet fully open) for steps 5 and 6.
    const dev = phone ? 'phone' : 'desktop';
    const finish = (label) => page.screenshot({ path: path.join(OUT, 'ui-finish-' + dev + '-' + label + '.png') });
    const noScroll = async (what) => {
      const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      t.ok(overflowX <= 0, what + ': no horizontal page scroll');
    };
    const sheetShot = async (label) => {
      if (!phone) return;
      await act(() => window.LightPlanApp.actions.setSheet('full'));
      await sleep(400);
      await finish(label + '-sheet');
      await act(() => window.LightPlanApp.actions.setSheet('half'));
      await sleep(350);
    };
    await act(() => window.LightPlanApp.actions.setView({ night: false }));
    for (const n of [2, 3, 5, 6]) {
      await goStep(n);
      await sleep(300);
      await finish('step' + n);
      await noScroll('step ' + n);
      if (n >= 5) await sheetShot('step' + n);
    }
    await goStep(5);
    await page.locator('[data-act="power-daisy"]').evaluate((el) => el.click());
    await sleep(500);
    await act(() => { document.getElementById('panel-root').scrollTop = 0; });
    await finish('step5-no-jumpers');
    await noScroll('step 5 with jumper cords off');
    await sheetShot('step5-no-jumpers');
    await page.locator('[data-act="power-daisy"]').evaluate((el) => el.click());
    await sleep(400);
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const n of [5, 6]) {
      await goStep(n);
      await sleep(300);
      await finish('dark-step' + n);
      await sheetShot('dark-step' + n);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await sleep(200);

    // ================================================================ A. cords on the photo
    await sec('A1 cord labels', async () => {
      await goStep(5);
      await act(() => { const a = window.LightPlanApp.actions; a.dismissBanner(); a.setView({ night: false, preview: true, labels: true, overlay: true }); });
      await zoomTo([700, 720], phone ? 2.4 : 1);
      const a = await labelReport();
      t.ok(a.cords >= 1 && a.jumpers >= 1 && a.anchoredAll, 'cords are labelled "N ft cord" and jumpers "N ft jumper" (' + a.texts.filter((x) => / ft /.test(x)).join(', ') + ')');
      t.ok(a.homeTexts.length >= 1 && a.homeTexts.every((x) => /^\d+ ft cord$/.test(x)) && a.homeTexts.some((x) => a.texts.includes(x)),
        'a cord from an outlet carries the length that is bought (' + a.homeTexts.join(', ') + ')');
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
      // Which cords to look at: the cord from an outlet with the longest riser and the jumper cord with the longest
      // stretch along the ground (whatever the planner made of the sample), each in its circuit's colour.
      const pick = await page.evaluate(() => {
        const s = window.LightPlanApp.store;
        const power = s.plan().power;
        const COLORS = [[79, 157, 255], [255, 138, 61]];   // the first two circuit colours (viewport.js)
        const longest = (kind, piece) => {
          let best = null;
          for (const f of power.feeds) {
            if (!f.cord || f.cord.kind !== kind) continue;
            for (const r of f.cord.route || []) {
              if (r.kind !== piece || !r.from || !r.to) continue;
              if (!best || r.lengthFt > best.lengthFt) best = { id: f.id, from: r.from, to: r.to, lengthFt: r.lengthFt, rgb: COLORS[s.project().circuits.findIndex((c) => c.id === f.circuitId)] || null };
            }
          }
          return best;
        };
        return { home: longest('home', 'rise'), jumper: longest('jumper', 'ground') };
      });
      t.ok(pick.home && pick.home.rgb && pick.jumper && pick.jumper.rgb, 'the sample has a cord from an outlet with a riser and a jumper cord along the ground (' + (pick.home && pick.home.id) + ', ' + (pick.jumper && pick.jumper.id) + ')');
      /** Share of the points along a stretch of cord (from t0 to t1 of the way) painted in its colour. */
      const painted = (piece, t0, t1) => page.evaluate(([pc, a0, a1]) => {
        const vp = window.LightPlanApp.viewport;
        const ctx = document.querySelector('#viewport canvas').getContext('2d');
        const near = (q) => Math.abs(q[0] - pc.rgb[0]) <= 45 && Math.abs(q[1] - pc.rgb[1]) <= 45 && Math.abs(q[2] - pc.rgb[2]) <= 45;
        const A = vp.imageToScreen(pc.from), B = vp.imageToScreen(pc.to);
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        let n = 0, on = 0;
        for (let d = len * a0; d <= len * a1; d += 0.5) {
          n += 1;
          if (near(ctx.getImageData(Math.round(A[0] + (B[0] - A[0]) * d / len), Math.round(A[1] + (B[1] - A[1]) * d / len), 1, 1).data)) on += 1;
        }
        return { share: n ? on / n : 0, len: Math.round(len) };
      }, [piece, t0, t1]);
      await zoomToPiece(pick.home.from, pick.home.to);
      const home = await painted(pick.home, 0.4, 0.85);
      t.ok(home.len > 20 && home.share > 0.95, 'a cord from an outlet is drawn as a solid line in its circuit colour (' + (home.share * 100).toFixed(0) + '% of ' + home.len + ' px)');
      await zoomToPiece(pick.jumper.from, pick.jumper.to);
      const jumper = await painted(pick.jumper, 0.2, 0.8);
      t.ok(jumper.len > 40 && jumper.share > 0.3 && jumper.share < 0.9, 'a jumper cord is drawn dashed (' + (jumper.share * 100).toFixed(0) + '% of ' + jumper.len + ' px painted)');
      // 3-way taps: a white diamond where each one sits.
      await zoomTo([760, 730], phone ? 2.4 : 1.3);
      const taps = await page.evaluate(() => {
        const vp = window.LightPlanApp.viewport;
        const M = LP.require('ui.viewport');
        const c = document.querySelector('#viewport canvas');
        const ctx = c.getContext('2d');
        const power = window.LightPlanApp.store.plan().power;
        const seen = M.tapMarkers(power).map((tp) => { const s = vp.imageToScreen(tp.point); return s[0] > 4 && s[1] > 4 && s[0] < c.width - 4 && s[1] < c.height - 4 ? Array.from(ctx.getImageData(Math.round(s[0]), Math.round(s[1]), 1, 1).data).slice(0, 3) : null; }).filter(Boolean);
        return { seen, count: power.counts.taps };
      });
      t.ok(taps.count >= 1 && taps.seen.length >= Math.min(3, taps.count) && taps.seen.every((q) => q[0] > 215 && q[1] > 215 && q[2] > 215), 'each 3-way tap has a white marker where it sits (' + taps.seen.length + ' of ' + taps.count + ' in view)');
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
        const boxes = vp.labelBoxes();
        const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        const lab = boxes.find((b) => b.text === 'plugs in');
        return {
          id: feed.id, cord: feed.cord, white, labels: boxes.map((b) => b.text), kind: row ? row.getAttribute('data-kind') : null, rowText: row ? row.innerText : '',
          labelNear: lab ? Math.hypot(Math.max(lab.x - s[0], 0, s[0] - (lab.x + lab.w)), Math.max(lab.y - s[1], 0, s[1] - (lab.y + lab.h))) : null,
          labelClear: lab ? !boxes.some((b) => b !== lab && hit(b, lab)) : false,
          outletsOff: (window.LightPlanApp.store.project().outlets || []).filter((o) => { const q = vp.imageToScreen(o.point); const v = vp.getView(); return q[0] < -20 || q[0] > v.cssW + 20 || q[1] < -20 || q[1] > v.cssH + 20; }).map((o) => o.label),
        };
      });
      t.ok(!!pi && pi.cord === null, 'the test plan has a run that plugs straight in');
      t.ok(pi && pi.white >= 12 && pi.labels.includes('plugs in') && pi.labelNear != null && pi.labelNear <= 16 && pi.labelClear,
        'it gets a ring and a "plugs in" label beside it on the photo (' + (pi && pi.white) + '/24 ring points, label ' + (pi && pi.labelNear != null ? Math.round(pi.labelNear) + ' px from the ring' : 'missing') + ', labels ' + (pi && pi.labels.join(', ')) + ')');
      t.ok(pi && pi.outletsOff.every((name) => !pi.labels.includes(name)), 'an outlet that is off the edge of the view has no label left behind at the edge (' + (pi && (pi.outletsOff.join(', ') || 'none off screen')) + ')');
      t.ok(pi && pi.kind === 'plugIn' && /Plugs straight into the end of Front door \(no cord needed\)/.test(pi.rowText) && !/unknown/i.test(pi.rowText), 'the Power list says it plugs straight in, not "length unknown" (' + (pi && pi.rowText.replace(/\s+/g, ' ').slice(0, 90)) + ')');
      await shot('plug-in');
      // C: the PDF report says the same for that run.
      await goStep(6);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#action-btn')]);
      const pdfFile = path.join(OUT, name + '-plug-in-' + dl.suggestedFilename());
      await dl.saveAs(pdfFile);
      let text = '';
      try { text = execFileSync('pdftotext', ['-layout', pdfFile, '-'], { encoding: 'utf8' }); } catch (e) { text = ''; }
      const rowLine = text.split(/\r?\n/).find((ln) => /Plugs straight in/.test(ln)) || '';
      t.ok(/Walkway right edge/.test(rowLine) && /The end of Front door/.test(rowLine) && /No cord needed\./.test(text),
        'PDF cords table: the run that plugs straight in says so, with what it plugs into (' + rowLine.replace(/\s+/g, ' ').trim().slice(0, 90) + ')');
      await sleep(600);
      await act(() => window.LightPlanApp.store.setUI({ toast: null }));
      await goStep(5);
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
          plan: (() => {
            // What the panel should say, worked out from the plan itself (not from the panel's own helpers).
            const s = window.LightPlanApp.store;
            const plan = s.plan();
            const pw = plan.power;
            const feedById = new Map(pw.feeds.map((f) => [f.id, f]));
            const used = pw.outlets.filter((o) => o.feedIds.length > 0);
            const first = used[0];
            const runs = new Set();
            first.feedIds.forEach((id) => feedById.get(id).runIds.forEach((r) => runs.add(r)));
            const root0 = feedById.get(pw.groups.find((g) => g.outletId === first.id).rootFeedId);
            return {
              totalW: plan.summary.watts, limitW: Math.max(...used.map((o) => o.limitW)), counts: pw.counts,
              first: { label: s.project().outlets.find((o) => o.id === first.id).label, cords: first.directFeedIds.length, runs: runs.size, watts: first.watts },
              root: { bought: root0.cord.boughtFt, route: root0.cord.routeText, name: plan.runs.find((r) => r.id === root0.runIds[0]).label },
              warnings: pw.warnings.filter((w) => w.level === 'warn' || w.level === 'danger').length,
            };
          })(),
        };
      });
      const W = (v) => (v < 100 ? v.toFixed(1) : String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')) + ' W';
      const P = b.plan;
      const wantVerdict = 'Good to go: these lights use ' + W(P.totalW) + ', ' + Math.round(P.totalW / P.limitW * 100) + '% of one outlet\'s safe limit.';
      t.ok(P.warnings === 0 && b.verdictText === wantVerdict && / ok/.test(b.verdictClass), 'the Power step opens with a plain verdict (' + b.verdictText + ')');
      t.ok(b.firstAfterHead && b.v && b.p && b.d && b.v.bottom <= b.p.top && b.p.bottom <= b.d.top, 'order: verdict, Place outlet, then the planning-estimate note');
      t.ok(b.v && b.v.bottom <= b.rootBottom + 1, 'the verdict is in view without scrolling' + (phone ? ' on a half-open sheet' : ''));
      const wantInfo = P.first.cords + (P.first.cords === 1 ? ' cord' : ' cords') + ' at this outlet feeding ' + P.first.runs + ' runs · ' + W(P.first.watts);
      t.ok(b.outletInfo[0] === wantInfo && P.first.cords < P.first.runs, 'the outlet card counts the cords at the outlet (' + P.first.cords + ') apart from the runs they feed (' + P.first.runs + '): ' + b.outletInfo[0]);
      t.ok(b.rows === b.feeds && b.kinds[0] === 'home' && b.kinds.filter((k) => k === 'home').length === P.counts.homeRuns && b.kinds.filter((k) => k === 'jumper').length === P.counts.jumpers && P.counts.jumpers >= 1 && P.counts.homeRuns < b.feeds,
        'the supply tree lists every cord: ' + P.counts.homeRuns + ' from outlets, ' + P.counts.jumpers + ' jumper cords (' + b.rows + ' rows)');
      const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
      t.ok(b.firstRow.includes(P.root.name) && b.firstRow.includes(P.root.bought + ' ft cord from ' + P.first.label) && b.firstRow.includes(cap(P.root.route)) && / along the ground/.test(b.firstRow),
        'a cord row says where it comes from and how it runs (' + b.firstRow.slice(0, 110) + ')');
      t.ok(!/unknown/i.test(b.treeText) && /16-gauge/.test(b.treeText) && !/AWG/.test(b.treeText) && /16 AWG/.test(b.detailText), 'gauge reads "16-gauge" in the list; AWG only under Cord details');
      t.ok(b.tiles['Cords to outlets'] === String(P.counts.homeRuns) && b.tiles['Jumper cords'] === String(P.counts.jumpers) && b.tiles['3-way taps'] === String(P.counts.taps) && P.counts.taps >= 1,
        'count tiles: cords to outlets, jumper cords, 3-way taps (' + JSON.stringify(b.tiles) + ')');
      t.ok(/jumper cord \(a short cord from one run to the next\)/.test(b.treeText) && /3-way tap \(a plug with three outlets\)/.test(b.treeText), 'jumper cord and 3-way tap are explained in plain words');
      t.ok(b.daisy === true && b.ownSwitches === P.counts.jumpers, 'switches: link nearby runs (on) and one "own cord" per jumper-fed run (' + b.ownSwitches + ')');
      t.ok(b.nextButtons === 0, 'the panel no longer ends in its own Next button');
      await shot('power-top');
    });

    await sec('B2 daisy chain and own cord switches', async () => {
      await goStep(5);
      const linked = await act(() => { const c = window.LightPlanApp.store.plan().power.counts; return { homeRuns: c.homeRuns, jumpers: c.jumpers }; });
      t.ok(await flipOwnCord('ft_door'), 'the door\'s row has a "Give this run its own cord" switch');
      const o = await page.evaluate(() => {
        const s = window.LightPlanApp.store;
        const door = s.plan().power.feeds.find((f) => f.runIds.includes('run_ft_door'));
        const sw = document.querySelector('.feed-item[data-key="' + door.id + '"] [data-act="feed-own-cord"]');
        return { param: s.project().features.find((f) => f.id === 'ft_door').params.ownCord, source: door.source.kind, checked: !!(sw && sw.checked), homeRuns: s.plan().power.counts.homeRuns, undo: s.undoLabel() };
      });
      t.ok(o.param === true && o.source === 'outlet' && o.checked && o.homeRuns > linked.homeRuns && o.undo === 'Give a run its own cord', '"Give this run its own cord" gives the door a cord from the outlet (' + JSON.stringify(o) + ')');
      await page.click('#btn-undo');
      await sleep(300);
      t.ok(await act((n) => window.LightPlanApp.store.plan().power.counts.homeRuns === n, linked.homeRuns), 'one Undo takes it back');
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
      const back = await act(() => { const s = window.LightPlanApp.store; return { jumpers: s.plan().power.counts.jumpers, homeRuns: s.plan().power.counts.homeRuns, config: s.project().library.config, checked: document.querySelector('[data-act="power-daisy"]').checked }; });
      t.ok(back.jumpers === linked.jumpers && back.homeRuns === linked.homeRuns && back.checked && !back.config, 'switching it back on restores the linked plan (' + back.jumpers + ' jumper cords) and leaves no override behind');
    });

    await sec('B3 the switches survive a reload', async () => {
      // "Give this run its own cord" and "Link nearby runs" are part of the saved plan: autosave, reload, still set.
      await goStep(5);
      const before = await act(() => { const c = window.LightPlanApp.store.plan().power.counts; return { homeRuns: c.homeRuns, jumpers: c.jumpers }; });
      await flipOwnCord('ft_door');
      await reload();
      const own = await page.evaluate(() => {
        const s = window.LightPlanApp.store;
        const door = s.plan().power.feeds.find((f) => f.runIds.includes('run_ft_door'));
        const sw = document.querySelector('.feed-item[data-key="' + door.id + '"] [data-act="feed-own-cord"]');
        return { step: s.ui().step, param: s.project().features.find((f) => f.id === 'ft_door').params.ownCord, source: door.source.kind, checked: !!(sw && sw.checked), homeRuns: s.plan().power.counts.homeRuns };
      });
      t.ok(own.step === 5 && own.param === true && own.source === 'outlet' && own.checked && own.homeRuns > before.homeRuns, 'after a reload the door still has its own cord and its switch is on (' + JSON.stringify(own) + ')');
      await page.locator('[data-act="power-daisy"]').evaluate((el) => el.click());
      await sleep(300);
      await reload();
      const flat = await page.evaluate(() => {
        const s = window.LightPlanApp.store;
        const c = s.plan().power.counts;
        const cfg = s.project().library.config;
        return { daisy: cfg && cfg.power ? cfg.power.daisyChain : undefined, jumpers: c.jumpers, homeRuns: c.homeRuns, feeds: s.plan().power.feeds.length, checked: document.querySelector('[data-act="power-daisy"]').checked, ownCord: s.project().features.find((f) => f.id === 'ft_door').params.ownCord };
      });
      t.ok(flat.daisy === false && flat.jumpers === 0 && flat.homeRuns === flat.feeds && flat.checked === false && flat.ownCord === true, 'after a reload "Link nearby runs" is still off: one cord per run (' + JSON.stringify(flat) + ')');
      // Put both back the way a person would, and check the sample plan is the linked one again.
      await page.locator('[data-act="power-daisy"]').evaluate((el) => el.click());
      await sleep(400);
      await flipOwnCord('ft_door');
      const restored = await act(() => { const s = window.LightPlanApp.store; const c = s.plan().power.counts; return { homeRuns: c.homeRuns, jumpers: c.jumpers, config: s.project().library.config, ownCord: s.project().features.find((f) => f.id === 'ft_door').params.ownCord }; });
      t.ok(restored.homeRuns === before.homeRuns && restored.jumpers === before.jumpers && !restored.config && !restored.ownCord, 'switching both back gives the linked plan again (' + restored.homeRuns + ' cords to outlets, ' + restored.jumpers + ' jumper cords)');
      await reload();
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
      // Type a tape length for a roofline item on the list (the ridge on the sample): it leaves the list and the
      // plan uses it.
      const rid = await page.evaluate(() => {
        const types = ['ridge', 'rake', 'roofline', 'gutter'];
        const prj = window.LightPlanApp.store.project();
        const ids = Array.from(document.querySelectorAll('.rough-item')).map((li) => li.getAttribute('data-key').replace('rough-', ''));
        const typeOf = (id) => (prj.features.find((f) => f.id === id) || {}).type;
        return ids.find((id) => typeOf(id) === 'ridge') || ids.find((id) => types.includes(typeOf(id))) || null;
      });
      t.ok(!!rid, 'a roofline length is on the list (' + rid + ')');
      const ridge = page.locator('.rough-item[data-key="rough-' + rid + '"] [data-act="feature-len"]');
      await ridge.evaluate((el) => { const det = el.closest('details'); if (det) det.open = true; });
      await ridge.scrollIntoViewIfNeeded();
      await ridge.fill('33 6');
      await ridge.press('Enter');
      await ridge.evaluate((el) => el.blur()).catch(() => {});
      await sleep(500);
      const after = await page.evaluate((id) => {
        const s = window.LightPlanApp.store;
        const sec = document.querySelector('[data-key="rough"]');
        return { override: s.project().features.find((f) => f.id === id).overrideFt, run: s.plan().runs.find((r) => r.featureId === id).lengthFt, title: sec.querySelector('.sec-title').textContent, still: !!sec.querySelector('[data-key="rough-' + id + '"]'), badge: document.querySelector('button.step[data-step="3"] .step-badge').textContent };
      }, rid);
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
      t.ok(await act((id) => window.LightPlanApp.store.project().features.find((f) => f.id === id).overrideFt == null, rid), 'undo clears the tape length again');
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
      // What the report should say, from the plan: the first cord from an outlet, a jumper cord that leaves the
      // end of another run, the 3-way taps and the counts.
      const pw = await page.evaluate(() => {
        const plan = window.LightPlanApp.store.plan();
        const power = plan.power;
        const bought = (c) => (Array.isArray(c.pieces) && c.pieces.length ? c.pieces.map((x) => x + ' ft').join(' + ') : Math.ceil(c.lengthFt) + ' ft');
        const label = (runId) => (plan.runs.find((r) => r.id === runId) || {}).label;
        const home = power.feeds.find((f) => f.id === power.groups[0].rootFeedId);
        const jumper = power.feeds.find((f) => f.cord && f.cord.kind === 'jumper' && f.source.kind === 'feed' && f.source.port === 'end');
        const parent = jumper ? power.feeds.find((f) => f.id === jumper.source.feedId) : null;
        return {
          home: bought(home.cord) + ' cord, ' + home.cord.awg + ' AWG', route: home.cord.routeText,
          jumper: jumper ? bought(jumper.cord) + ' jumper cord, ' + jumper.cord.awg + ' AWG' : null,
          from: parent ? 'The end of ' + label(parent.runIds[parent.runIds.length - 1]) : null,
          tapAtStart: power.feeds.some((f) => f.taps > 0 && power.feeds.some((c) => c.source && c.source.kind === 'feed' && c.source.feedId === f.id && c.source.port === 'start')),
          counts: power.counts,
        };
      });
      const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
      t.ok(/PLUGS INTO/.test(text) && /CORD AND ROUTE/.test(text) && text.includes(pw.home) && !!pw.jumper && text.includes(pw.jumper) && text.includes(pw.from),
        'PDF cords table: what each cord plugs into, cord or jumper cord (' + pw.home + '; ' + pw.jumper + '; ' + pw.from + ')');
      t.ok(text.includes(cap(pw.route) + '.') && / along the ground/.test(pw.route) && pw.tapAtStart && /3-way tap at its start/.test(text), 'PDF cords table: route in words (' + cap(pw.route) + ') and where the 3-way taps go');
      t.ok(new RegExp(pw.counts.homeRuns + ' ' + pw.counts.jumpers + ' ' + pw.counts.taps + ' \\d+ Cords to outlets Jumper cords 3-way taps Timers').test(text),
        'PDF counts: ' + pw.counts.homeRuns + ' cords to outlets, ' + pw.counts.jumpers + ' jumper cords, ' + pw.counts.taps + ' 3-way taps');
      t.ok(/Measurements to double-check \(\d+\)/.test(text) && /Materials cost \(rough\)/.test(text), 'PDF lists the measurements to double-check and marks the cost rough');
      await sleep(600);
    });

    await sec('E3 nothing hides behind the pinned button', async () => {
      // The button is pinned under the panel, not over it: with the panel scrolled to its end, the last control of
      // every step is above the button and can be tapped.
      for (let n = 1; n <= 6; n += 1) {
        await goStep(n);
        for (const sheet of phone ? ['half', 'full'] : ['half']) {
          if (phone) { await act((sh) => window.LightPlanApp.actions.setSheet(sh), sheet); await sleep(350); }
          const r = await page.evaluate(() => {
            const root = document.getElementById('panel-root');
            const bar = document.getElementById('action-bar').getBoundingClientRect();
            const rr = root.getBoundingClientRect();
            // Controls that are really shown: not inside a folded <details> (its summary is), not the hidden
            // checkbox inside a switch.
            const folded = (el) => { const d = el.closest('details:not([open])'); return !!d && !(el.tagName === 'SUMMARY' && el.parentElement === d); };
            const shown = (el) => { const b = el.getBoundingClientRect(); return b.width > 1 && b.height > 1 && !folded(el) && (typeof el.checkVisibility !== 'function' || el.checkVisibility()); };
            const controls = Array.from(root.querySelectorAll('button, input, select, textarea, summary, label.switch'))
              .filter((el) => shown(el) && (el.matches('label.switch') || !el.closest('label.switch')));
            const last = controls[controls.length - 1];
            last.scrollIntoView({ block: 'end' });
            const b = last.getBoundingClientRect();
            const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            const out = {
              name: (last.innerText || last.getAttribute('aria-label') || last.tagName).trim().replace(/\s+/g, ' ').slice(0, 32),
              bottom: Math.round(b.bottom), barTop: Math.round(bar.top), rootBottom: Math.round(rr.bottom),
              reachable: !!hit && (last.contains(hit) || hit.contains(last)),
            };
            root.scrollTop = 0;
            return out;
          });
          t.ok(r.rootBottom <= r.barTop && r.bottom <= r.rootBottom && r.reachable,
            'step ' + n + (phone ? ' (sheet ' + sheet + ')' : '') + ': the last control ("' + r.name + '") scrolls clear of the pinned button and can be tapped');
        }
      }
      if (phone) {
        // A collapsed sheet shows the step's title whole above the button, not a heading cut in half.
        for (let n = 1; n <= 6; n += 1) {
          await goStep(n);
          await act(() => window.LightPlanApp.actions.setSheet('min'));
          await sleep(400);
          const m = await page.evaluate(() => {
            const root = document.getElementById('panel-root');
            root.scrollTop = 0;
            const rr = root.getBoundingClientRect();
            const kids = Array.from(root.querySelector('.panel-content').children);
            const title = root.querySelector('.panel-title').getBoundingClientRect();
            const peeking = kids.slice(1).concat(Array.from(kids[0].children)).filter((el) => { const b = el.getBoundingClientRect(); return b.height > 0 && b.top < rr.bottom - 0.5 && b.bottom > rr.bottom + 0.5; }).map((el) => el.className || el.tagName);
            return { title: root.querySelector('.panel-title').textContent, whole: title.height > 20 && title.top >= rr.top - 0.5 && title.bottom <= rr.bottom + 0.5, peeking, strip: Math.round(rr.height) };
          });
          t.ok(m.whole && m.peeking.length === 0, 'step ' + n + ', sheet collapsed: the title "' + m.title + '" is whole in the ' + m.strip + ' px above the button and nothing is cut off' + (m.peeking.length ? ' (cut: ' + m.peeking.join(', ') + ')' : ''));
          if (n === 5) await shot('sheet-min');
        }
        await act(() => window.LightPlanApp.actions.setSheet('half'));
        await sleep(300);
      }
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
        // innerText: the words that are shown (textContent would include the desktop-only words a phone hides).
        const text = Array.from(document.querySelectorAll('#lp-app p, #lp-app h2')).filter(vis).map((el) => el.innerText).join(' ');
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
      const p3 = await pinned();
      t.ok(p3.label === 'Set the scale' && p3.action === 'go-2' && p3.inView, 'on Trace with no scale yet the pinned button says "Set the scale" (' + p3.label + ')');
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
      const undone = await act(() => { const r = window.LightPlanApp.store.project().planes[0].rect; return { tapErr: r.tapErr, corner: r.corners[2] }; });
      t.ok(undone.tapErr.length === 4 && undone.tapErr.every((e) => e === want) && Math.hypot(undone.corner[0] - 950, undone.corner[1] - 660) < 0.01, 'undo restores the corner and its value (' + JSON.stringify(undone.tapErr) + ')');
      await page.click('#btn-redo');
      await sleep(300);
      const redone = await act(() => { const r = window.LightPlanApp.store.project().planes[0].rect; return { tapErr: r.tapErr, corner: r.corners[2] }; });
      t.ok(redone.tapErr.length === 4 && redone.tapErr[2] === dragged.tapErr[2] && redone.tapErr[0] === want && redone.corner[0] === dragged.corner[0] && redone.corner[1] === dragged.corner[1],
        'redo brings back the dragged corner with its own value, still index for index (' + JSON.stringify(redone.tapErr) + ')');
      await page.click('#btn-undo');
      await sleep(300);
      // Trace an eave: the first end snaps onto a rectangle corner and copies its value; the second is a fresh tap.
      await act(() => { window.LightPlanApp.viewport.fit(); window.LightPlanApp.actions.select(null); });
      await goStep(3);
      const pr = await pinned();
      t.ok(pr.label === 'Trace the roofline' && pr.action === 'trace-roofline' && pr.inView, 'on Trace with a scale and nothing traced the pinned button says "Trace the roofline" (' + pr.label + ')');
      await press(page, '[data-act="trace-type"][data-type="roofline"]');
      const pd = await pinned();
      t.ok(pd.label === 'Done tracing' && pd.primary && pd.inView, 'while tracing the pinned button says "Done tracing" (' + pd.label + ')');
      const bars = await page.evaluate(() => ({
        panel: Array.from(document.querySelectorAll('.trace-bar')).filter((el) => el.getBoundingClientRect().height > 0).length,
        hint: Array.from(document.querySelectorAll('#hint-undo, #hint-cancel, #hint-finish')).filter((el) => el.getBoundingClientRect().height > 0).length,
      }));
      t.ok(bars.hint === 3 && bars.panel === (phone ? 0 : 1), phone ? 'phone: the tracing buttons are on the photo only, with no second (sticky) bar in the sheet' : 'desktop: the tracing buttons are on the photo and in the side panel\'s bar');
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
      // E: after Finish the hint bar shows the length and offers what to trace next; the pinned button moves on.
      const chooser = await page.evaluate(() => {
        const shown = (id) => { const el = document.getElementById(id); return !!el && !el.hidden && el.getBoundingClientRect().height > 0; };
        return {
          mode: window.LightPlanApp.store.ui().mode.name, text: document.getElementById('hint-text').textContent,
          chips: Array.from(document.querySelectorAll('#hint-next-chips [data-next]')).filter((b) => b.getBoundingClientRect().height > 0).map((b) => b.textContent).join('/'),
          next: shown('hint-next'), more: shown('hint-more'), done: shown('hint-done'), finish: shown('hint-finish'),
        };
      });
      t.ok(chooser.mode === 'select' && chooser.next && chooser.more && chooser.done && !chooser.finish && chooser.chips === 'Eave/Window/Bush' && /^Eave( \d+)?: \d+′/.test(chooser.text),
        'after Finish the hint bar gives the length and offers Eave / Window / Bush, More and Done (' + chooser.text + ' ' + chooser.chips + ')');
      const pn = await pinned();
      t.ok(pn.label === 'Next: Design' && pn.inView, 'and the pinned button says "Next: Design" (' + pn.label + ')');
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
      // The values are part of the saved plan: autosave, reload, still beside their points.
      await reload();
      const kept = await act((id) => { const p = window.LightPlanApp.store.project(); const f = p.features.find((x) => x.id === id); return { rect: p.planes[0].rect.tapErr, feature: f ? f.tapErr : null, points: f ? f.points.length : 0 }; }, feat.id);
      t.ok(kept.rect && kept.rect.length === 4 && kept.rect.every((e) => e === want) && kept.feature && kept.feature.length === kept.points && kept.feature[0] === del.e[0] && kept.feature[1] === del.e[1],
        'a reload keeps each list with its points (rectangle ' + JSON.stringify(kept.rect) + ', eave ' + JSON.stringify(kept.feature) + ')');
    });

    await sec('F2 zoomed-out taps lower the confidence', async () => {
      // SPEC 8.4: a rectangle marked with the photo zoomed out is rated by how coarse those taps were, and the
      // Calibrate step says "Tapped zoomed out … zoom in and re-tap" outright. Re-tapped zoomed in, the note goes.
      await goStep(2);
      const wallId = await act(() => window.LightPlanApp.actions.addPlane('wall'));
      await act(() => window.LightPlanApp.actions.setCalib({ rectPresetId: 'garage-double' }));
      const corners = [[400, 500], [720, 500], [720, 640], [400, 640]];   // 320 x 140 px for a 16 x 7 ft door
      const state = () => page.evaluate((id) => {
        const s = window.LightPlanApp.store;
        const pl = s.project().planes.find((x) => x.id === id);
        const sol = s.plan().measured.planes[id] || {};
        const note = document.querySelector('.plane-editor [data-key="zoomed-out"]');
        let seen = false;
        if (note) {
          note.scrollIntoView({ block: 'center' });
          const b = note.getBoundingClientRect();
          const rr = document.getElementById('panel-root').getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          seen = b.height > 0 && b.top >= rr.top - 0.5 && b.bottom <= rr.bottom + 0.5 && !!hit && note.contains(hit);
        }
        const row = document.querySelector('.plane-row[data-key="' + id + '"] .pill');
        return {
          tapErr: pl.rect ? pl.rect.tapErr : null, level: sol.confidence ? sol.confidence.level : null, score: sol.confidence ? sol.confidence.score : null,
          reasons: sol.confidence ? sol.confidence.reasons : [], note: note ? note.textContent.trim() : '', seen, pill: row ? row.textContent.trim() : '',
        };
      }, wallId);
      /** Tap the four corners: at the zoom the view has now, or (zoomK) zoomed in on each corner in turn. */
      const mark = async (zoomK) => {
        await act((id) => window.LightPlanApp.actions.startPlaneRect(id), wallId);
        await sleep(350);
        for (const c of corners) {
          if (zoomK) await zoomTo(c, zoomK);
          const [pt] = await toPage(page, [c]);
          await tapAt(page, cfg, pt[0], pt[1]);
        }
        await sleep(400);
        if (phone) { await act(() => window.LightPlanApp.actions.setSheet('full')); await sleep(400); }
      };
      // Zoomed out: a phone at the zoom the photo opens with; a mouse on a photo zoomed far out.
      await act(() => window.LightPlanApp.viewport.fit());
      if (!phone) await zoomTo([560, 570], 0.35);
      await mark();
      const out = await state();
      const coarse = out.tapErr ? Math.max(...out.tapErr) : 0;
      const rank = { low: 0, medium: 1, high: 2 };
      t.ok(coarse > 5 && /^Tapped zoomed out \(about ±\d+ px on the photo\): zoom in and re-tap the corners of the rectangle\./.test(out.reasons[0] || '') && rank[out.level] < 2,
        (phone ? 'a finger at fit zoom' : 'a mouse on a zoomed-out photo') + ' (±' + coarse + ' px) rates the wall ' + out.level + ', and the first reason says why (' + (out.reasons[0] || '').slice(0, 70) + ')');
      t.ok(out.seen && out.note === out.reasons[0] && out.pill.toLowerCase() === out.level, 'the Calibrate step shows that reason in a note on screen, and the wall\'s row reads ' + out.pill);
      await shot('zoomed-out');
      // An item measured on that wall (the eave traced above, moved onto it) says the same in the Trace step.
      const fid = await act((id) => {
        const s = window.LightPlanApp.store;
        const f = s.project().features[0];
        s.commit('test: the eave is on the new wall', (d) => { d.features[0].planeId = id; });
        return f.id;
      }, wallId);
      await goStep(3);
      await act((id) => window.LightPlanApp.actions.select({ kind: 'feature', id }), fid);
      await sleep(400);
      const fnote = await page.evaluate((id) => {
        const el = document.querySelector('.feat-editor [data-key="zoomed-out-' + id + '"]');
        const conf = window.LightPlanApp.store.plan().measured.features[id].confidence;
        if (!el) return { text: '', seen: false, level: conf.level, first: conf.reasons[0] };
        el.scrollIntoView({ block: 'center' });
        const b = el.getBoundingClientRect();
        const rr = document.getElementById('panel-root').getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return { text: el.textContent.trim(), seen: b.height > 0 && b.top >= rr.top - 0.5 && b.bottom <= rr.bottom + 0.5 && !!hit && el.contains(hit), level: conf.level, first: conf.reasons[0] };
      }, fid);
      t.ok(fnote.seen && /^Tapped zoomed out \(about ±\d+ px on the photo\): zoom in and re-tap/.test(fnote.text) && fnote.text === fnote.first && rank[fnote.level] < 2,
        'the Trace step shows the note on an item measured on that wall (rated ' + fnote.level + ': ' + fnote.text.slice(0, 60) + ')');
      await shot('zoomed-out-item');
      await page.click('#btn-undo');
      await sleep(300);
      await goStep(2);
      await act((id) => window.LightPlanApp.actions.select({ kind: 'plane', id }), wallId);
      await sleep(300);
      // The same corners, each tapped with the photo zoomed in on it (on a phone the whole rectangle does not fit
      // on screen at that zoom, so the view moves between taps, as it does in a person's hands).
      if (phone) { await act(() => window.LightPlanApp.actions.setSheet('half')); await sleep(350); }
      await mark(phone ? 4.5 : 2);
      const fine = await state();
      t.ok(fine.tapErr && fine.tapErr.every((e) => e === 2.5) && rank[fine.level] > rank[out.level] && fine.score > out.score && !fine.note && !fine.reasons.some((r) => /Tapped zoomed out/.test(r)),
        're-tapped zoomed in (±2.5 px) the rating goes from ' + out.level + ' to ' + fine.level + ' and the note is gone');
      await page.click('#btn-undo');
      await sleep(300);
      const again = await state();
      t.ok(again.tapErr && Math.max(...again.tapErr) === coarse && again.level === out.level && again.note === out.note, 'undo brings the zoomed-out corners back with their precision and the note (' + JSON.stringify(again.tapErr) + ')');
      await act((id) => { window.LightPlanApp.viewport.fit(); window.LightPlanApp.actions.deletePlane(id); }, wallId);
      if (phone) { await act(() => window.LightPlanApp.actions.setSheet('half')); await sleep(300); }
      await sleep(300);
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

// ------------------------------------------------------------------ suppliers (SPEC §8.3 and §8.5)
// "Buy from" in the Design step, the product pickers, the shopping list with part numbers and links, the order
// sheets, the cost basis and the exports, on a 390 px phone and on a desktop. Expected numbers are read from the
// plan and the supplier map in the page, never pinned. Writes ui-suppliers-<phone|desktop>-step<4|6>-<supplier>*.png.
async function runSuppliers(browser, name) {
  const cfg = PASSES[name === 'sup-phone' ? 'phone' : 'desktop'];
  const phone = !!cfg.hasTouch;
  const t = new Check(name);
  console.log('\n== suppliers ' + cfg.viewport.width + 'x' + cfg.viewport.height);
  const context = await browser.newContext({
    viewport: cfg.viewport, isMobile: cfg.isMobile, hasTouch: cfg.hasTouch, colorScheme: 'light',
    deviceScaleFactor: 1, acceptDownloads: true, reducedMotion: 'no-preference',
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  // A supplier link is for a person to follow: the page itself must never fetch one or open a window.
  const fetched = [];
  await context.route(/christmaslightsetc\.com|1000bulbs\.com/, (r) => { fetched.push(r.request().url()); r.abort(); });
  await context.addInitScript(() => {
    // A clipboard the test can read ('ok') or one that refuses, as inside a locked-down frame ('blocked').
    window.__clip = { mode: 'ok', writes: [] };
    const fake = { writeText: (text) => (window.__clip.mode === 'ok' ? (window.__clip.writes.push(String(text)), Promise.resolve()) : Promise.reject(new Error('blocked'))) };
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => fake }); } catch (e) { /* keep the real one */ }
    const real = document.execCommand ? document.execCommand.bind(document) : null;
    document.execCommand = (cmd, ...rest) => (cmd === 'copy' ? false : real ? real(cmd, ...rest) : false);
    window.__opened = 0;
    window.open = () => { window.__opened += 1; return null; };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console error: ' + m.text()); });
  const shot = (label) => page.screenshot({ path: path.join(OUT, 'ui-suppliers-' + (phone ? 'phone' : 'desktop') + '-' + label + '.png') });
  const openSheet = async () => { if (phone) { await page.evaluate(() => window.LightPlanApp.store.setUI({ sheet: 'full' })); await sleep(250); } };
  const goStep = async (n) => { await page.click('button.step[data-step="' + n + '"]'); await sleep(350); await openSheet(); };
  /** Bring something in the panel to the middle of the panel (clear of the pinned button) and click it. */
  const tap = async (selector) => {
    const loc = page.locator(selector).first();
    await loc.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await sleep(150);
    await loc.click({ timeout: 5000 });
    await sleep(400);
  };
  const scrollTo = async (selector, block) => { await page.locator(selector).first().evaluate((el, b) => el.scrollIntoView({ block: b }), block || 'start'); await sleep(300); };
  const hostOf = (u) => (/^https:\/\/([^/:?#]+)/.exec(u || '') || [])[1] || '';
  const sameLines = (a, b) => JSON.stringify(a.map((l) => [l.sku, l.qty, l.unitPrice, l.lineTotal])) === JSON.stringify(b.map((l) => [l.sku, l.qty, l.unitPrice, l.lineTotal]));
  const state = () => page.evaluate(() => {
    const s = window.LightPlanApp.store; const p = s.project(); const plan = s.plan();
    return {
      supplierId: Object.prototype.hasOwnProperty.call(p.library, 'supplierId') ? p.library.supplierId : null, libSupplier: plan.library.supplierId,
      config: p.library.config, buying: plan.library.config.buying, installer: p.quote.enabled,
      subtotal: plan.bom.subtotal, cost: plan.summary.cost, watts: plan.summary.watts, quoteMaterials: plan.quote.materialsCost,
      lines: plan.bom.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, lineTotal: l.lineTotal, buyTotal: l.buyTotal, usedQty: l.usedQty,
        supplierId: l.supplierId, supplierName: l.supplierName, supplierSku: l.supplierSku, url: l.url, findUrl: l.findUrl, priceStatus: l.priceStatus, priceAsOf: l.priceAsOf, overridden: l.overridden })),
      runs: plan.runs.map((r) => ({ id: r.id, featureId: r.featureId, label: r.label, type: r.featureType, productId: r.productId, supplierId: r.supplierId || null, kind: r.productKind || null,
        auto: !(p.features.find((f) => f.id === r.featureId) || {}).productId })),
      undoLabel: s.undoLabel(), overrides: p.pricing.overrides,
    };
  });
  /** What the supplier map holds, read in the page. */
  const supplierData = (sid) => page.evaluate((id) => {
    const S = window.LP.require('suppliers');
    const s = S.getSupplier(id);
    const mine = S.SUPPLIER_PRODUCTS.filter((p) => p.supplierId === id);
    const offers = [];
    for (const p of mine) { if (p.kind === 'bulk') for (const c of S.componentOffers(p)) offers.push(c.offer); else offers.push(p); }
    for (const k of Object.keys(S.SUPPLIER_ACCESSORIES[id] || {})) offers.push(S.SUPPLIER_ACCESSORIES[id][k]);
    const bySku = new Map(offers.map((o) => [o.sku, o]));
    return {
      id, name: s.name, url: s.url, wholesale: s.wholesale, date: S.formatDate(s.priceAsOf), hosts: S.linkHosts(),
      equivs: mine.map((p) => p.equiv), observed: Array.from(bySku.values()).filter((o) => o.priceStatus === 'observed').length, items: bySku.size,
      bulk: mine.filter((p) => p.kind === 'bulk').map((p) => ({ id: p.id, parts: S.componentOffers(p).map((c) => ({ part: String(c.offer.supplierSku), status: c.offer.priceStatus })), maxRunFt: p.maxRunFt, maxBulbs: p.maxBulbsPerRun, packQty: p.components.bulb.packQty })),
      made: mine.filter((p) => p.kind !== 'bulk').map((p) => ({ id: p.id, part: String(p.supplierSku), price: '$' + p.price.toFixed(2), url: p.url })),
    };
  }, sid);
  const bomRows = () => page.evaluate(() => Array.from(document.querySelectorAll('.bom-row')).map((li) => ({
    sku: li.getAttribute('data-sku'), supplier: li.getAttribute('data-supplier'), status: li.getAttribute('data-status'),
    from: (li.querySelector('.bom-from') || {}).textContent || '', badge: (li.querySelector('.bom-from .badge') || {}).textContent || '',
    use: (li.querySelector('.bom-use') || {}).textContent || '', total: (li.querySelector('.bom-total') || {}).textContent || '',
    links: Array.from(li.querySelectorAll('a')).map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), text: a.textContent.trim(), kind: a.getAttribute('data-link') })),
    copy: li.querySelectorAll('[data-act="copy-link"]').length, price: (li.querySelector('[data-act="price"]') || {}).value,
    tall: Array.from(li.querySelectorAll('a, button')).every((el) => el.getBoundingClientRect().height >= 44),
  })));
  const runCards = () => page.evaluate(() => Array.from(document.querySelectorAll('.run-card')).map((li) => {
    const sel = li.querySelector('select[data-act="run-product"]');
    const info = li.querySelector('.prod-info');
    return {
      runId: li.getAttribute('data-key'), featureId: sel.getAttribute('data-id'), value: sel.value, auto: sel.options[0].textContent,
      groups: Array.from(sel.querySelectorAll('optgroup')).map((g) => ({ label: g.label, options: Array.from(g.querySelectorAll('option')).map((o) => ({ value: o.value, text: o.textContent })) })),
      info: info ? {
        supplier: info.getAttribute('data-supplier'), kind: info.getAttribute('data-kind'), status: info.getAttribute('data-status'), text: info.textContent,
        head: Array.from(info.children).filter((el) => !el.matches('details')).map((el) => el.textContent).join(' | '),
        badges: Array.from(info.children).filter((el) => !el.matches('details')).flatMap((el) => Array.from(el.querySelectorAll('.badge')).map((b) => ({ kind: b.getAttribute('data-status'), text: b.textContent }))),
        links: Array.from(info.children).filter((el) => el.matches('.link-row')).flatMap((el) => Array.from(el.querySelectorAll('a')).map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), text: a.textContent.trim() }))),
        parts: Array.from(info.querySelectorAll('.part-row')).map((r) => ({ status: r.getAttribute('data-status'), text: r.textContent, href: (r.querySelector('a') || { getAttribute: () => null }).getAttribute('href'), copy: r.querySelectorAll('[data-act="copy-link"]').length })),
      } : null,
    };
  }));
  const noOverflow = () => page.evaluate(() => {
    const root = document.getElementById('panel-root');
    const wide = Array.from(root.querySelectorAll('*')).filter((el) => el.getBoundingClientRect().right > root.getBoundingClientRect().right + 1 && getComputedStyle(el).position !== 'fixed').slice(0, 3).map((el) => el.className || el.tagName);
    return { page: document.documentElement.scrollWidth - window.innerWidth, panel: root.scrollWidth - root.clientWidth, wide };
  });
  const csvRows = (text) => {
    const rows = []; let row = []; let cell = ''; let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch; }
      else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  };
  const linkOk = (l) => l.target === '_blank' && /\bnoopener\b/.test(l.rel || '') && /\bnoreferrer\b/.test(l.rel || '');

  /** Steps 4 and 6 with `sid` chosen: the supplier card, the pickers, the shopping list, the order sheets. */
  async function checkSupplier(sid, base) {
    const sup = await supplierData(sid);
    await goStep(4);
    await tap('[data-act="supplier"][data-id="' + sid + '"]');
    const st = await state();
    t.ok(st.supplierId === sid && st.libSupplier === sid && st.undoLabel === 'Buy from ' + sup.name, sid + ': choosing it sets project.library.supplierId in one undoable step (' + st.undoLabel + ')');
    // Every run on Auto whose product has an equivalent at the supplier now uses the supplier's.
    const switched = st.runs.filter((r) => r.supplierId === sid);
    const wrong = st.runs.filter((r) => {
      const was = base.runs.find((b) => b.featureId === r.featureId);
      return sup.equivs.includes(was.productId) ? r.supplierId !== sid : r.productId !== was.productId;
    });
    t.ok(switched.length > 0 && switched.every((r) => r.auto) && wrong.length === 0, sid + ': ' + switched.length + ' of ' + st.runs.length + ' Auto runs switched to its products, the rest stayed' + (wrong.length ? ' (wrong: ' + wrong.map((r) => r.label).join(', ') + ')' : ''));
    t.ok(st.runs.some((r) => r.kind === 'bulk') && st.buying.style === 'bulk', sid + ': C7 and C9 runs are cut-to-length by default');

    // --- The supplier card.
    const card = await page.evaluate((id) => {
      const el = document.querySelector('.sup-card[data-supplier="' + id + '"]');
      if (!el) return null;
      const links = Array.from(el.querySelectorAll('a')).map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), text: a.textContent.trim(), kind: a.getAttribute('data-link') }));
      return {
        text: el.textContent, prices: (el.querySelector('.sup-prices') || {}).textContent || '', links, copies: el.querySelectorAll('[data-act="copy-link"]').length,
        account: (el.querySelector('.sup-account') || {}).textContent || '',
        chips: Array.from(document.querySelectorAll('[data-act="supplier"]')).map((b) => b.dataset.id + ':' + b.getAttribute('aria-pressed')).join(' '),
        styles: Array.from(document.querySelectorAll('[data-act="buy-style"]')).map((b) => ({ style: b.dataset.style, on: b.getAttribute('aria-pressed') === 'true', text: b.textContent })),
        firstSection: document.querySelector('.panel-content > section').getAttribute('data-key'),
      };
    }, sid);
    t.ok(card && card.firstSection === 'buy-from' && card.chips.includes(sid + ':true') && card.chips.split('true').length === 2, sid + ': "Buy from" is the first thing in the Design step and shows it as chosen (' + (card && card.chips) + ')');
    const site = card.links.find((l) => l.kind === 'site');
    t.ok(site && site.href === sup.url && linkOk(site) && card.copies === card.links.length, sid + ': its site link opens in a new tab (noopener noreferrer) with a Copy link button beside every link');
    const whole = card.links.find((l) => l.kind === 'wholesale');
    if (sup.wholesale.url) t.ok(whole && whole.href === sup.wholesale.url && linkOk(whole), sid + ': the wholesale page is linked (' + (whole && whole.href) + ')');
    else t.ok(!whole && card.links.length === 1, sid + ': no account page is on file, so there is no account link');
    t.ok(card.account.includes(sup.wholesale.phone) && card.account.includes(sup.wholesale.note) && (!sup.wholesale.email || card.account.includes(sup.wholesale.email)), sid + ': the phone' + (sup.wholesale.email ? ', the email' : '') + ' and what its pages say are shown');
    const sentenceOk = card.prices.includes('as of ' + sup.date) && card.prices.includes('checked on the supplier\'s page') && card.prices.includes('Your account price may be lower: edit any price.') &&
      (sup.observed > 0) === card.prices.includes(sup.observed + ' seen in a listing, not confirmed');
    t.ok(sentenceOk, sid + ': one honest sentence about its prices (' + card.prices + ')');
    t.ok(card.styles.length === 2 && card.styles[0].style === 'bulk' && card.styles[0].on && !card.styles[1].on && /Cut-to-length wire \+ bulbs/.test(card.styles[0].text) && /how installers buy/i.test(card.styles[0].text) && /Ready-made strings/.test(card.styles[1].text),
      sid + ': "C7 and C9 as" offers cut-to-length wire + bulbs (on) or ready-made strings');
    await page.evaluate(() => { document.getElementById('panel-root').scrollTop = 0; });
    await sleep(250);
    await shot('step4-' + sid);

    // --- The product pickers and the card under each.
    const cards = await runCards();
    const others = ['cle', '1000bulbs'].filter((x) => x !== sid).map((x) => (x === 'cle' ? 'Christmas Lights Etc' : '1000Bulbs'));
    const order = [sup.name, 'Any store'].concat(others).join(' > ');
    const roof = cards.find((c) => c.groups.length === 3);
    t.ok(!!roof && cards.every((c) => c.groups.map((g) => g.label).join(' > ') === order.split(' > ').filter((n) => c.groups.some((g) => g.label === n)).join(' > ')) && roof.groups.map((g) => g.label).join(' > ') === order,
      sid + ': pickers group their products by supplier, the chosen one first (' + (roof && roof.groups.map((g) => g.label).join(' > ')) + ')');
    const opts = roof.groups[0].options;
    t.ok(opts.some((o) => / · part number \S+ · \$\d+\.\d\d$/.test(o.text)) && opts.some((o) => / · sold as parts · about \$\d+\.\d\d per ft$/.test(o.text)), sid + ': options show the part number and price (' + opts.map((o) => o.text.slice(-34)).join(' | ') + ')');
    t.ok(cards.every((c) => /^Auto: /.test(c.auto)) && cards.filter((c) => c.value === '').length === cards.length, sid + ': every run is still on Auto, and Auto names the product it picks');
    const bulkCard = cards.find((c) => c.info && c.info.kind === 'bulk');
    const kit = sup.bulk.find((b) => st.runs.some((r) => r.productId === b.id));
    const listed = kit.parts.filter((x) => x.status !== 'verified').length;
    t.ok(!!bulkCard && bulkCard.info.supplier === sid && /sold as parts/.test(bulkCard.info.head) && /by the spool/.test(bulkCard.info.head) && bulkCard.info.head.includes('of ' + kit.packQty + ' by colour') &&
      /a male and a female slide-on plug for every length you cut/.test(bulkCard.info.head) && bulkCard.info.head.includes(kit.maxRunFt + ' ft') && bulkCard.info.head.includes(kit.maxBulbs + ' bulbs'),
      sid + ': a cut-to-length card says what is ordered (wire, bulbs by the ' + kit.packQty + ', a plug pair per cut) and its limit (' + kit.maxRunFt + ' ft or ' + kit.maxBulbs + ' bulbs)');
    t.ok(bulkCard.info.parts.length === kit.parts.length && kit.parts.every((x) => bulkCard.info.parts.some((r) => r.text.includes('part number ' + x.part) && r.status === (x.status === 'verified' ? 'checked' : 'check'))) &&
      bulkCard.info.parts.every((r) => sup.hosts.includes(hostOf(r.href)) && r.copy === 1),
      sid + ': its ' + kit.parts.length + ' parts are listed with part number, status and a link on the supplier\'s site');
    t.ok(bulkCard.info.badges.some((b) => b.kind === 'checked' && b.text.includes('as of ' + sup.date)) && bulkCard.info.badges.some((b) => b.kind === 'check') === (listed > 0) && !/check the price/i.test(bulkCard.info.head),
      sid + ': the kit is never marked "check price" itself; its labels count the parts (' + bulkCard.info.badges.map((b) => b.text).join(' / ') + ')');
    const plain = cards.find((c) => c.info && c.info.supplier === sid && c.info.kind !== 'bulk');
    const made = plain ? sup.made.find((m) => m.id === st.runs.find((r) => r.featureId === plain.featureId).productId) : null;
    t.ok(!!made && plain.info.head.includes('part number ' + made.part) && plain.info.head.includes(made.price) && plain.info.badges.length === 1 && plain.info.badges[0].text === 'as of ' + sup.date + ' · checked' &&
      plain.info.links.length === 1 && plain.info.links[0].text === 'Open at ' + sup.name && plain.info.links[0].href === made.url && linkOk(plain.info.links[0]) && sup.hosts.includes(hostOf(plain.info.links[0].href)),
      sid + ': a ready-made product shows its part number, price, price status and "Open at ' + sup.name + '" (part number ' + (made && made.part) + ', ' + (made && made.price) + ')');
    const stay = cards.find((c) => c.info && c.info.supplier === 'generic');
    t.ok(!!stay && /No part number on file at /.test(stay.info.head) && stay.info.links[0].text === 'Find at ' + sup.name && sup.hosts.includes(hostOf(stay.info.links[0].href)), sid + ': a run with nothing on file there says so and offers "Find at ' + sup.name + '"');
    await scrollTo('.run-card');
    await shot('step4-' + sid + '-runs');
    let over = await noOverflow();
    t.ok(over.page <= 0 && over.panel <= 0 && over.wide.length === 0, sid + ': step 4 fits the width (' + JSON.stringify(over) + ')');

    // --- Step 6: the shopping list.
    await goStep(6);
    const rows = await bomRows();
    t.ok(rows.length === st.lines.length && rows.every((r, i) => r.sku === st.lines[i].sku), sid + ': the shopping list has a row for each of the ' + st.lines.length + ' lines');
    const bad = [];
    st.lines.forEach((l, i) => {
      const r = rows[i];
      const open = r.links.find((x) => x.kind === 'product');
      const find = r.links.find((x) => x.kind === 'find');
      if (!r.from.includes(l.supplierName)) bad.push(l.name + ': supplier');
      if (l.supplierSku && !r.from.includes('part number ' + l.supplierSku)) bad.push(l.name + ': part number');
      if (l.url && !(open && open.href === l.url && open.text === 'Open' && linkOk(open) && sup.hosts.includes(hostOf(open.href)) && r.copy === 1)) bad.push(l.name + ': Open link');
      if (!l.url && l.findUrl && !(find && find.href === l.findUrl && find.text === 'Find at ' + sup.name && linkOk(find) && r.copy === 1)) bad.push(l.name + ': Find link');
      if (!l.url && !l.findUrl && r.links.length) bad.push(l.name + ': a link from nowhere');
      const want = l.priceStatus === 'verified' ? 'as of ' + sup.date + ' · checked' : l.priceStatus === 'observed' ? 'as of ' + sup.date + ' · check price' : l.priceStatus === 'yours' ? 'your price' : 'typical price';
      if (r.badge !== want) bad.push(l.name + ': status "' + r.badge + '"');
      if ((l.usedQty < l.qty) !== !!r.use) bad.push(l.name + ': used and left over');
      if (!r.tall) bad.push(l.name + ': a tap target under 44 px');
    });
    t.ok(bad.length === 0, sid + ': every row shows supplier, part number, price status and its link on the supplier\'s site' + (bad.length ? ' (' + bad.slice(0, 4).join('; ') + ')' : ''));
    t.ok(st.lines.some((l) => l.supplierSku) && st.lines.some((l) => l.url) && st.lines.some((l) => !l.url && l.findUrl), sid + ': the list has part numbers, product links and "Find at" links to check');
    const wire = rows.filter((r) => /ft used/.test(r.use)).map((r) => /^([\d,]+) (spools?|lengths?) \(([\d,]+) ft\): ([\d,]+) ft used, ([\d,]+) ft left$/.exec(r.use));
    const boxes = rows.filter((r) => /spare$/.test(r.use)).map((r) => /^([\d,]+) (boxes|box|packs?) \(([\d,]+) (bulbs|plugs)\): ([\d,]+) used, ([\d,]+) spare$/.exec(r.use));
    const num = (x) => Number(String(x).replace(/,/g, ''));
    t.ok(wire.length > 0 && wire.every((m) => m && num(m[4]) + num(m[5]) === num(m[3])) && boxes.length >= 3 && boxes.every((m) => m && num(m[5]) + num(m[6]) === num(m[3])),
      sid + ': rows bought by the spool, box or pack say what is used and left (' + rows.filter((r) => r.use).map((r) => r.use).slice(0, 2).join(' | ') + ')');
    await scrollTo('[data-key="bom"]');
    await shot('step6-' + sid);

    // --- Order sheets.
    const sheets = await page.evaluate(() => Array.from(document.querySelectorAll('.order-card')).map((c) => ({
      id: c.getAttribute('data-supplier'), head: c.querySelector('.order-head').textContent,
      lines: Array.from(c.querySelectorAll('.order-line')).map((li) => ({ qty: li.querySelector('.os-qty').textContent, name: li.querySelector('.os-name').textContent, part: li.getAttribute('data-part') })),
      total: c.querySelector('.order-total').textContent, phone: (c.querySelector('[data-fact="phone"]') || {}).textContent || '', shipping: (c.querySelector('[data-fact="shipping"]') || {}).textContent || '',
      buttons: Array.from(c.querySelectorAll('button')).map((b) => b.textContent.trim()),
    })));
    const mine = st.lines.filter((l) => l.supplierId === sid);
    const rest = st.lines.filter((l) => !l.supplierId);
    const own = sheets.find((x) => x.id === sid);
    const money = (v) => '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    t.ok(sheets.map((x) => x.id).join(',') === sid + ',generic' && !!own && own.lines.length === mine.length && own.lines.every((ln, i) => ln.part === mine[i].supplierSku && ln.name === mine[i].name && ln.qty.startsWith(String(mine[i].qty))),
      sid + ': an order sheet for it (' + mine.length + ' lines: part number, item, qty) and one for any store (' + rest.length + ')');
    t.ok(own.total.includes(money(mine.reduce((a, l) => a + l.buyTotal, 0))) && own.phone.includes(sup.wholesale.phone) && own.buttons.join('|') === 'Copy order list|Save order CSV',
      sid + ': its sheet shows the subtotal to order and the phone (' + own.phone + ')');
    const ships = /ships free/.test(sup.wholesale.note);
    t.ok(ships ? sup.wholesale.note.includes(own.shipping) && /ships free with orders of \$\d+/.test(own.shipping) : own.shipping === '', sid + ': the free-shipping line is shown only when its pages give one (' + (own.shipping || 'none') + ')');
    await scrollTo('.order-card[data-supplier="' + sid + '"]');
    await shot('step6-' + sid + '-orders');
    over = await noOverflow();
    t.ok(over.page <= 0 && over.panel <= 0 && over.wide.length === 0, sid + ': step 6 fits the width (' + JSON.stringify(over) + ')');

    // Save order CSV: the right columns, and quantities equal to the shopping list.
    const csvFile = await clickAndDownload(page, '.order-card[data-supplier="' + sid + '"] [data-act="order-csv"]');
    const csv = csvRows(fs.readFileSync(csvFile, 'utf8').replace(/^﻿/, ''));
    t.ok(/-order-[a-z0-9-]+\.csv$/.test(csvFile) && csv[0].join(',') === 'Part number,Item,Qty,Unit,Unit Price,Total,Price status,Link,Notes', sid + ': the order CSV downloads with its columns (' + path.basename(csvFile) + ')');
    t.ok(mine.every((l, i) => csv[i + 1][0] === l.supplierSku && csv[i + 1][1] === l.name && csv[i + 1][2] === String(l.qty) && csv[i + 1][7] === l.url && sup.hosts.includes(hostOf(csv[i + 1][7]))) && csv[mine.length + 1].join('') === '',
      sid + ': its ' + mine.length + ' rows carry the part numbers, the shopping list\'s quantities and the product links');
    await sleep(400);
    // Copy order list: plain text on the clipboard.
    await page.evaluate(() => { window.__clip.writes.length = 0; });
    await tap('.order-card[data-supplier="' + sid + '"] [data-act="copy-order"]');
    const copied = await page.evaluate(() => ({ text: window.__clip.writes[0] || '', toast: (window.LightPlanApp.store.ui().toast || {}).message || '' }));
    t.ok(copied.text.startsWith('Order from ' + sup.name) && mine.every((l) => copied.text.includes('Part ' + l.supplierSku + ': ')) && copied.text.includes('Phone: ' + sup.wholesale.phone) && /copied\.$/.test(copied.toast),
      sid + ': Copy order list puts the list on the clipboard as text (' + copied.toast + ')');
    return { st, sup, rows };
  }

  try {
    await page.goto(URL);
    await waitForApp(page);
    const base = await state();
    t.ok(base.libSupplier === 'generic' && base.supplierId == null && base.lines.every((l) => !l.supplierId && !l.url && !l.findUrl), 'the sample starts at Any store: no supplier, no links');

    // --- Any store: the control is there, with nothing to link to.
    await goStep(4);
    const any = await page.evaluate(() => ({
      chips: Array.from(document.querySelectorAll('[data-act="supplier"]')).map((b) => b.textContent.trim() + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')).join(' | '),
      first: document.querySelector('.panel-content > section').getAttribute('data-key'),
      links: document.querySelectorAll('#panel-root a').length, style: document.querySelectorAll('[data-act="buy-style"]').length, info: document.querySelectorAll('.prod-info').length,
      note: (document.querySelector('[data-key="buy-note"]') || {}).textContent || '',
    }));
    t.ok(any.chips === 'Any store* | Christmas Lights Etc | 1000Bulbs' && any.first === 'buy-from', 'step 4 opens with "Buy from": ' + any.chips);
    t.ok(any.links === 0 && any.style === 0 && any.info === 0 && /no part numbers and no links/.test(any.note), 'at Any store there are no links, no part numbers and no C7/C9 choice');
    const anyCards = await runCards();
    t.ok(anyCards.find((c) => c.groups.length === 3).groups.map((g) => g.label).join(' > ') === 'Any store > Christmas Lights Etc > 1000Bulbs', 'at Any store the pickers list any-store products first, then each supplier');
    await shot('step4-any');
    await goStep(6);
    const anyRows = await bomRows();
    t.ok(anyRows.every((r) => r.badge === 'typical price' && /^Any store/.test(r.from) && r.links.length === 0 && !r.use), 'at Any store every row says "Any store" and "typical price", with no link');
    const anyTitles = await page.evaluate(() => Array.from(document.querySelectorAll('#panel-root .sec-title')).map((h) => h.textContent));
    t.ok(anyTitles.includes('Shopping list') && anyTitles.includes('Order sheets') && !anyTitles.some((x) => /bill of materials|sku/i.test(x)) && !/\bSKU\b/.test(await page.locator('#panel-root').innerText()),
      'the Review step says "Shopping list" and "Order sheets", never "Bill of materials" or "SKU" (' + anyTitles.join(', ') + ')');

    // --- Christmas Lights Etc.
    const cle = await checkSupplier('cle', base);

    // Copy link: to the clipboard when the browser allows it...
    await page.evaluate(() => { window.__clip.writes.length = 0; });
    const firstLink = cle.st.lines.find((l) => l.url);
    const rowSel = '.bom-row[data-sku="' + firstLink.sku + '"]';
    await tap(rowSel + ' [data-act="copy-link"]');
    let cp = await page.evaluate((sel) => ({ writes: window.__clip.writes.slice(), toast: (window.LightPlanApp.store.ui().toast || {}).message || '', label: document.querySelector(sel + ' [data-act="copy-link"]').textContent.trim(), field: !!document.querySelector('[data-copy-field]') }), rowSel);
    t.ok(cp.writes.length === 1 && cp.writes[0] === firstLink.url && cp.toast === 'Link copied.' && cp.label === 'Copied' && !cp.field, 'Copy link writes the address to the clipboard and says so (' + cp.toast + ')');
    // ...and, where the clipboard is blocked, the address is shown selected in a read-only field.
    await page.evaluate(() => { window.__clip.mode = 'blocked'; window.__clip.writes.length = 0; });
    await tap(rowSel + ' [data-act="copy-link"]');
    cp = await page.evaluate((sel) => {
      const f = document.querySelector(sel + ' [data-copy-field]');
      return f ? { value: f.value, readOnly: f.readOnly, focused: document.activeElement === f, start: f.selectionStart, end: f.selectionEnd, fields: document.querySelectorAll('[data-copy-field]').length, writes: window.__clip.writes.length,
        hint: f.closest('.copy-fallback').textContent, inView: f.getBoundingClientRect().right <= window.innerWidth, toast: (window.LightPlanApp.store.ui().toast || {}).message || '' } : null;
    }, rowSel);
    t.ok(cp && cp.value === firstLink.url && cp.readOnly && cp.focused && cp.start === 0 && cp.end === firstLink.url.length && cp.fields === 1 && cp.writes === 0 && /Copying is blocked/.test(cp.hint) && cp.inView,
      'with the clipboard blocked, the address is shown selected in a read-only field to copy by hand');
    t.ok(cp && /^Copying is blocked/.test(cp.toast) && !/copied/i.test(cp.toast), 'and the message says copying is blocked, not "copied" (' + (cp && cp.toast) + ')');
    await shot('copy-blocked');
    // The order list falls back the same way, as several lines.
    await tap('.order-card[data-supplier="cle"] [data-act="copy-order"]');
    cp = await page.evaluate(() => { const f = document.querySelector('.order-card[data-supplier="cle"] [data-copy-field]'); return f ? { tag: f.tagName, text: f.value, readOnly: f.readOnly, sel: f.selectionEnd - f.selectionStart, fields: document.querySelectorAll('[data-copy-field]').length } : null; });
    t.ok(cp && cp.tag === 'TEXTAREA' && cp.readOnly && cp.text.startsWith('Order from Christmas Lights Etc') && cp.sel === cp.text.length && cp.fields === 1, 'a blocked order list is shown selected in a read-only box (and the link field is gone)');
    await tap('[data-act="copy-close"]');
    t.ok(await page.locator('[data-copy-field]').count() === 0, 'Done puts the read-only box away');
    await page.evaluate(() => { window.__clip.mode = 'ok'; });

    // A person's tap on a link does open it, in a new tab. (The request is stopped by the route above, so the test
    // never reaches a supplier; this one request is the only one allowed, and it is cleared afterwards.)
    t.ok(fetched.length === 0, 'nothing was fetched from a supplier before a link was tapped');
    const openLink = page.locator(rowSel + ' a[data-link="product"]');
    await openLink.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await sleep(150);
    const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 8000 }), openLink.click()]);
    for (let i = 0; i < 40 && !fetched.length; i += 1) await sleep(100);
    const stayed = await page.evaluate(() => ({ here: location.protocol === 'file:', step: window.LightPlanApp.store.ui().step, opened: window.__opened }));
    t.ok(fetched.length === 1 && fetched[0] === firstLink.url && stayed.here && stayed.step === 6 && stayed.opened === 0, 'tapping Open follows the link in a new tab and leaves the plan where it was (' + (fetched[0] || 'no request') + ')');
    await popup.close().catch(() => {});
    fetched.length = 0;

    // --- Exports with a supplier chosen: the shopping-list CSV and the PDF report.
    const bomCsvFile = await clickAndDownload(page, '[data-act="export"][data-kind="csv"]');
    const bomCsv = csvRows(fs.readFileSync(bomCsvFile, 'utf8').replace(/^﻿/, ''));
    const col = (n) => bomCsv[0].indexOf(n);
    t.ok(bomCsv[0].join(',') === 'SKU,Item,Category,Qty,Unit,Unit Price,Line Total,Notes,Supplier,Part number,Price status,Link' &&
      cle.st.lines.every((l, i) => bomCsv[i + 1][col('Supplier')] === l.supplierName && bomCsv[i + 1][col('Part number')] === (l.supplierSku || '') && bomCsv[i + 1][col('Link')] === (l.url || l.findUrl || '') && bomCsv[i + 1][col('Qty')] === String(l.qty)),
      'the shopping-list CSV gains Supplier, Part number, Price status and Link columns, filled for every line');
    await sleep(400);
    const pdfFile = await clickAndDownload(page, '[data-act="export"][data-kind="pdf"]');
    const pdfBytes = fs.readFileSync(pdfFile);
    let pdfText = '';
    try { pdfText = execFileSync('pdftotext', [pdfFile, '-'], { encoding: 'utf8' }); } catch (e) { pdfText = ''; }
    const flat = pdfText.replace(/\s+/g, ' ');
    const cleLines = cle.st.lines.filter((l) => l.supplierId === 'cle');
    t.ok(flat.includes('Shopping list') && flat.includes('Where to buy') && flat.includes('Christmas Lights Etc') && cleLines.every((l) => flat.includes('Part number ' + l.supplierSku)) && !/\bSKU\b/.test(flat),
      'the PDF report\'s materials table shows the supplier and part number of every line');
    t.ok(flat.includes('Prices were last checked on ' + cle.sup.date + '; confirm at checkout.') && flat.includes('Site: ' + cle.sup.url) && flat.includes('Phone ' + cle.sup.wholesale.phone),
      'the report says when prices were last checked and has a "Where to buy" block with the site and phone');
    const pdfLinks = Array.from(pdfBytes.toString('latin1').matchAll(/\/S \/URI \/URI \(([^)]*)\)/g)).map((m) => m[1]);
    t.ok(cleLines.every((l) => pdfLinks.includes(l.url)) && pdfLinks.every((u) => cle.sup.hosts.includes(hostOf(u))), 'every product link is in the PDF as a link (' + pdfLinks.length + ' links, all on the supplier\'s site)');
    await sleep(400);

    // --- Installer mode: the cost-basis switch, and a customer quote with no supplier in it.
    t.ok(await page.locator('[data-act="cost-basis"]').count() === 0, 'the cost-basis switch is not shown to a homeowner');
    await page.locator('[data-act="quote-toggle"]').evaluate((el) => el.click());
    await sleep(400);
    const basis0 = await page.evaluate(() => Array.from(document.querySelectorAll('[data-act="cost-basis"]')).map((b) => b.dataset.basis + ':' + b.getAttribute('aria-pressed') + ':' + b.textContent).join(' | '));
    t.ok(/^bought:true:Everything ordered/.test(basis0) && / \| used:false:Only what is used/.test(basis0) && /Charge this job for/.test(await page.locator('.cost-basis').innerText()), 'installer mode shows "Charge this job for: everything ordered / only what is used"');
    await scrollTo('.cost-basis', 'center');
    await shot('step6-cle-installer');
    await tap('[data-act="cost-basis"][data-basis="used"]');
    const usedSt = await state();
    const toOrder = await page.evaluate(() => (document.querySelector('[data-key="to-order"]') || {}).textContent || '');
    const buyAll = usedSt.lines.reduce((a, l) => a + l.buyTotal, 0);
    t.ok(usedSt.buying.costBasis === 'used' && usedSt.undoLabel === 'Change what the job is charged for' && usedSt.subtotal < cle.st.subtotal && usedSt.quoteMaterials === usedSt.subtotal &&
      toOrder.includes('$' + buyAll.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')),
      '"Only what is used" lowers the job\'s materials ($' + cle.st.subtotal + ' -> $' + usedSt.subtotal + ') and still shows what to order (' + toOrder.replace(/\s+/g, ' ') + ')');
    const usedRows = await bomRows();
    t.ok(usedRows.filter((r) => /the whole order costs \$/.test(r.use)).length === usedSt.lines.filter((l) => l.usedQty < l.qty).length, 'each row charged by its share also says what the whole order costs');
    const quoteFile = await clickAndDownload(page, '[data-act="export"][data-kind="quote"]');
    const quoteBytes = fs.readFileSync(quoteFile).toString('latin1');
    let quoteText = '';
    try { quoteText = execFileSync('pdftotext', [quoteFile, '-'], { encoding: 'utf8' }); } catch (e) { quoteText = ''; }
    const leaks = [];
    for (const hay of [quoteBytes, quoteText]) {
      for (const word of ['Christmas Lights Etc', '1000Bulbs', 'christmaslightsetc', '1000bulbs.com', 'Part number', 'part number', 'Any store', cle.sup.wholesale.phone, 'https://', '/Subtype /Link']) if (hay.includes(word)) leaks.push(word);
      for (const l of usedSt.lines.filter((x) => x.supplierSku)) if (hay.includes(l.supplierSku)) leaks.push(l.supplierSku);
    }
    const quoteMoney = quoteText.match(/\$[\d,]+\.\d\d/g) || [];
    const quoteLines = await page.evaluate(() => window.LightPlanApp.store.plan().quote.lines.map((l) => '$' + l.amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')));
    t.ok(/QUOTE/.test(quoteText) && leaks.length === 0 && quoteMoney.length >= quoteLines.length && quoteMoney.every((m) => quoteLines.includes(m)),
      'the customer quote PDF has no supplier name, part number, link or supplier unit price' + (leaks.length ? ' (found: ' + leaks.join(', ') + ')' : ''));
    await sleep(400);
    // Back to "everything ordered" and out of installer mode, by undo (one step each).
    await page.click('#btn-undo');
    await sleep(300);
    await page.click('#btn-undo');
    await sleep(300);
    const afterInstaller = await state();
    t.ok(!afterInstaller.installer && afterInstaller.buying.costBasis === 'bought' && afterInstaller.subtotal === cle.st.subtotal && afterInstaller.supplierId === 'cle', 'two undos take the cost basis and installer mode back');

    // --- A run can use another supplier's product: it then goes on that supplier's order sheet.
    await goStep(4);
    const roofRun = cle.st.runs.find((r) => r.kind === 'bulk');
    const otherId = await page.evaluate((fid) => {
      const sel = document.querySelector('select[data-act="run-product"][data-id="' + fid + '"]');
      const g = Array.from(sel.querySelectorAll('optgroup')).find((x) => x.label === '1000Bulbs');
      return Array.from(g.querySelectorAll('option')).find((o) => /part number/.test(o.textContent)).value;
    }, roofRun.featureId);
    await page.locator('select[data-act="run-product"][data-id="' + roofRun.featureId + '"]').selectOption(otherId);
    await sleep(500);
    const mixed = await state();
    const mixedRun = mixed.runs.find((r) => r.featureId === roofRun.featureId);
    t.ok(mixedRun.productId === otherId && !mixedRun.auto && mixed.supplierId === 'cle' && mixed.lines.some((l) => l.supplierId === '1000bulbs'), 'picking a 1000Bulbs product for one run keeps it while the rest stay with Christmas Lights Etc');
    await goStep(6);
    const mixedSheets = await page.evaluate(() => Array.from(document.querySelectorAll('.order-card')).map((c) => c.getAttribute('data-supplier')).join(','));
    t.ok(mixedSheets === 'cle,1000bulbs,generic', 'the order sheets then list both suppliers and any store (' + mixedSheets + ')');
    await page.click('#btn-undo');
    await sleep(300);
    t.ok(sameLines((await state()).lines, cle.st.lines), 'undo puts the run back on Auto');

    // --- 1000Bulbs.
    const tb = await checkSupplier('1000bulbs', base);
    t.ok(tb.st.subtotal !== cle.st.subtotal && tb.st.lines.every((l) => l.supplierId !== 'cle'), 'switching supplier re-prices the plan with the new supplier\'s products only');

    // --- Ready-made strings instead of cut-to-length.
    await goStep(4);
    await tap('[data-act="buy-style"][data-style="strings"]');
    const strings = await state();
    const stringCards = await runCards();
    const stringCard = stringCards.find((c) => c.featureId === roofRun.featureId);
    t.ok(strings.buying.style === 'strings' && strings.undoLabel === 'Change how C7 and C9 are bought' && !strings.runs.some((r) => r.kind === 'bulk') && strings.runs.find((r) => r.featureId === roofRun.featureId).supplierId === '1000bulbs' &&
      strings.lines.every((l) => l.usedQty === l.qty), '"Ready-made strings" swaps every cut-to-length run for a ready-made string from the same supplier, with nothing bought by the spool');
    const stringMade = tb.sup.made.find((m) => m.id === strings.runs.find((r) => r.featureId === roofRun.featureId).productId);
    t.ok(stringCard.info && stringCard.info.kind !== 'bulk' && !!stringMade && stringCard.info.head.includes('part number ' + stringMade.part) && stringCard.info.links[0].text === 'Open at 1000Bulbs' && stringCard.info.links[0].href === stringMade.url && hostOf(stringCard.info.links[0].href) === 'www.1000bulbs.com' &&
      await page.locator('[data-act="buy-style"][data-style="strings"]').getAttribute('aria-pressed') === 'true', 'the run\'s card now shows the string\'s part number and "Open at 1000Bulbs"');
    await scrollTo('.run-card');
    await shot('step4-1000bulbs-strings');

    // --- Override a price: the line becomes "your price"; undo brings the supplier's price and date back.
    await goStep(6);
    const target = strings.lines.find((l) => l.supplierId === '1000bulbs' && l.priceStatus === 'verified');
    const input = page.locator('.bom-row[data-sku="' + target.sku + '"] [data-act="price"]');
    await input.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const myPrice = Math.round((target.unitPrice * 0.8) * 100) / 100;
    await input.fill(String(myPrice));
    await input.press('Enter');
    await input.evaluate((el) => el.blur());
    await sleep(450);
    const priced = await state();
    const pl = priced.lines.find((l) => l.sku === target.sku);
    const pr = (await bomRows()).find((r) => r.sku === target.sku);
    t.ok(priced.overrides[target.sku] === myPrice && pl.unitPrice === myPrice && pl.priceStatus === 'yours' && pl.priceAsOf === null && pr.badge === 'your price' && pr.status === 'yours' &&
      Math.abs(priced.subtotal - (strings.subtotal - target.lineTotal + pl.lineTotal)) < 0.006, 'a typed price is kept by the line\'s key and flips its status to "your price" ($' + target.unitPrice + ' -> $' + myPrice + ')');
    await scrollTo('.bom-row[data-sku="' + target.sku + '"]', 'center');
    await shot('step6-1000bulbs-your-price');
    await page.click('#btn-undo');
    await sleep(350);
    const unpriced = await state();
    const ur = (await bomRows()).find((r) => r.sku === target.sku);
    t.ok(Object.keys(unpriced.overrides).length === 0 && sameLines(unpriced.lines, strings.lines) && ur.badge === 'as of ' + tb.sup.date + ' · checked', 'undo takes the price back to the supplier\'s, with its date');
    await page.click('#btn-undo');
    await sleep(350);
    const unstyled = await state();
    t.ok(unstyled.buying.style === 'bulk' && sameLines(unstyled.lines, tb.st.lines) && unstyled.config === null, 'a second undo goes back to cut-to-length wire and bulbs');

    // --- Back to Any store: the original plan, exactly.
    await goStep(4);
    await tap('[data-act="supplier"][data-id="generic"]');
    const back = await state();
    t.ok(back.supplierId === null && back.libSupplier === 'generic' && back.undoLabel === 'Buy from any store', 'Any store clears the supplier (' + back.undoLabel + ')');
    t.ok(back.subtotal === base.subtotal && back.cost === base.cost && back.watts === base.watts && JSON.stringify(back.lines) === JSON.stringify(base.lines) && JSON.stringify(back.runs) === JSON.stringify(base.runs),
      'back at Any store the totals, every line and every run are exactly the original ($' + base.subtotal + ', ' + base.watts + ' W)');
    t.ok(await page.locator('#panel-root a').count() === 0 && await page.locator('[data-act="buy-style"]').count() === 0, 'and the links and the C7/C9 choice are gone again');

    // --- Reload keeps the choice.
    await tap('[data-act="supplier"][data-id="cle"]');
    await tap('[data-act="buy-style"][data-style="strings"]');
    const chosen = await state();
    await sleep(1000); // autosave is debounced (400 ms)
    await page.reload();
    await waitForApp(page);
    const reloaded = await state();
    t.ok(reloaded.supplierId === 'cle' && reloaded.buying.style === 'strings' && reloaded.subtotal === chosen.subtotal && sameLines(reloaded.lines, chosen.lines), 'a reload keeps the supplier and how C7 and C9 are bought ($' + reloaded.subtotal + ')');
    await goStep(4);
    const reChips = await page.evaluate(() => ({
      sup: (document.querySelector('[data-act="supplier"][aria-pressed="true"]') || {}).textContent, style: (document.querySelector('[data-act="buy-style"][aria-pressed="true"]') || { dataset: {} }).dataset.style,
      card: !!document.querySelector('.sup-card[data-supplier="cle"]'),
    }));
    t.ok(reChips.sup === 'Christmas Lights Etc' && reChips.style === 'strings' && reChips.card, 'after the reload the Design step shows Christmas Lights Etc and ready-made strings as chosen');
    const opened = await page.evaluate(() => window.__opened);
    t.ok(opened === 0 && fetched.length === 0, 'no window was opened by code and nothing was fetched from a supplier' + (fetched.length ? ' (' + fetched.slice(0, 2).join(', ') + ')' : ''));
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
  if (name === 'sup-phone' || name === 'sup-desktop') { results.push(await runSuppliers(browser, name)); continue; }
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
