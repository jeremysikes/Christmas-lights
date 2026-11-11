// LightPlan end-to-end smoke test (Playwright + Chromium).
//
// Usage:
//   npm run e2e                          build dist/ and run every pass (phone, desktop, desktop dark,
//                                        blocked storage)
//   node tests/e2e/smoke.mjs             run against the existing dist/lightplan.html
//   node tests/e2e/smoke.mjs --only=phone        one pass: phone | desktop | dark | storage | inputs | measure |
//                                                review | landscape
//                                                (storage = localStorage and IndexedDB blocked;
//                                                inputs = safe share, tax, file version, damaged photo;
//                                                review = UI review findings on a phone; landscape = 844x390)
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
const selected = onlyArg ? onlyArg.slice(7).split(',') : Object.keys(PASSES).concat('storage', 'inputs', 'measure', 'review', 'landscape');

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

// ------------------------------------------------------------------ main

const browser = await chromium.launch();
const results = [];
for (const name of selected) {
  if (name === 'review') { results.push(await runReview(browser)); continue; }
  if (name === 'landscape') { results.push(await runLandscape(browser)); continue; }
  if (name === 'storage') { results.push(await runBlockedStorage(browser)); continue; }
  if (name === 'inputs') { results.push(await runPlanningInputs(browser)); continue; }
  if (name === 'measure') { results.push(await runMeasureChecks(browser)); continue; }
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
