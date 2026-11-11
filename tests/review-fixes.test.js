// Phase 1.1 review fixes (core): one test per confirmed finding, named with the finding ids.
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const suppliers = LP.require('suppliers');
const catalog = LP.require('catalog');
const design = LP.require('design');
const power = LP.require('power');
const bom = LP.require('bom');
const schema = LP.require('schema');
const planner = LP.require('plan');
const sample = LP.require('sample');
const fx = require('./power-fixtures');

const clone = (o) => JSON.parse(JSON.stringify(o));
const { F, feature, outlet } = fx;
const lineBy = (b, sku) => b.lines.find((l) => l.sku === sku);
const linesBy = (b, sku) => b.lines.filter((l) => l.sku === sku);
function libFor(supplierId, buying, extra) {
  return catalog.getLibrary({ library: Object.assign({ products: null, config: buying ? { buying } : null, supplierId }, extra || {}) });
}
/** The sample house buying from `supplierId`; `edit(project)` changes it before planning. */
function samplePlan(supplierId, buying, edit) {
  const p = sample.createSample().project;
  p.library = Object.assign({}, p.library, { supplierId, config: buying ? { buying } : null });
  if (edit) edit(p);
  return { project: p, plan: planner.computePlan(p) };
}
/** A flat-wall project with one roofline `len` ft long at 10 ft up and an outlet at u = `outletU`. */
function eaveProject(len, supplierId, o = {}) {
  const p = fx.project({
    features: [feature('ft_eave', 'roofline', [F(0, 10), F(len, 10)], Object.assign({ label: 'Eave' }, o.feature || {}))],
    outlets: [outlet('out_1', F(o.outletU === undefined ? 2 : o.outletU, 1.5))],
    library: { products: null, supplierId, config: o.config || null },
  });
  return p;
}
/** Runs, power and BOM for a fixture project, the way plan.computePlan chains them. */
function build(p) {
  const lib = catalog.getLibrary(p);
  const r = fx.plan(p, lib);
  const runs = planner.mergeRunInfo(r.runs, r.power);
  return { lib, runs, measured: r.measured, power: r.power, bom: bom.buildBom(p, runs, r.power, lib), checklist: bom.buildChecklist(p, runs, r.power, r.measured) };
}
/** A LightRun of a bulk product, shaped like design.planRuns output (38 ft bought, 34 ft hung unless overridden). */
function bulkRun(id, o = {}) {
  return Object.assign({
    id: 'run_' + id, featureId: id, featureType: 'roofline', label: id, planeId: 'pl_front', imageId: 'img_1',
    productId: 'cle:c9-bulk-12', productName: 'C9 LED on socket wire', category: 'c9', tech: 'LED', unit: 'foot',
    colorMode: 'warmWhite', colors: ['#ffc46b'], lengthFt: 34, withWasteFt: 37.4, quantity: 38, bulbs: 38, watts: 30.4, amps: 0.25,
    clips: null, lightStakes: 0, method: 'per-foot', detail: '', warnings: [],
    start: null, end: null, reversed: false, chainId: null, feedIds: [], outletId: null, circuitId: null,
  }, o);
}
function project(o = {}) {
  return Object.assign({
    schema: 'lightplan/project', version: 1, id: 'prj_t', name: 'Test',
    settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' },
    features: [], outlets: [], circuits: [], library: { products: null, config: null }, pricing: { overrides: {} },
  }, o);
}
function emptyPower(o = {}) {
  return Object.assign({ chains: [], feeds: [], outlets: [], circuits: [], runInfo: {}, cords: [],
    counts: { timers: 0, splitters: 0, cordCovers: 0, gfciAdapters: 0 }, totals: { watts: 0, amps: 0 }, warnings: [] }, o);
}

// ================================================================ D1 / C2 / U01: colour and the supplier's part number
test('D1 C2 U01: a colour the supplier\'s ready-made item is not sold in keeps the any-store product, with no part number', () => {
  for (const [sid, style, mode] of [['cle', 'strings', 'multicolor'], ['cle', 'bulk', 'multicolor'], ['1000bulbs', 'strings', 'coolWhite'], ['1000bulbs', 'bulk', 'custom'], ['cle', 'strings', 'custom']]) {
    const tag = [sid, style, mode].join('/');
    const { plan } = samplePlan(sid, { style }, (p) => { p.settings.colorMode = mode; p.settings.customColors = ['#ff3b30', '#34c759']; });
    // No line pairs another colour's name with a supplier part number or product page.
    for (const l of plan.bom.lines) {
      if (!l.supplierSku && !l.url) continue;
      assert.ok(!/ - (Multicolor|Cool white|Custom|Red|Green)/.test(l.name) || /bulbs/.test(l.name), tag + ': ' + l.name + ' has part ' + l.supplierSku);
    }
    for (const s of bom.orderSheets(plan.bom, plan.library)) {
      const text = bom.orderSheetToText(s);
      assert.ok(!/Part (77667|77653|83768|84095|CMS-25C9-8GWW|CMS-25C7-8GWW|CMS-50WA-6GWW)\b/.test(text), tag + ': a warm-white part number is on the order sheet\n' + text);
      assert.ok(!/Warm-White/.test(text), tag + ': a warm-white page is linked');
    }
    // The runs keep the any-store product (it gets a link to look for it at the supplier), and nothing warns
    // about a product the planner picked by itself.
    const minis = plan.runs.filter((r) => ['window', 'door', 'bush'].includes(r.featureType));
    assert.ok(minis.length >= 5 && minis.every((r) => r.productId === 'mini-led-100'), tag);
    assert.deepEqual(plan.warnings.filter((w) => /is not sold in/.test(w.message)), [], tag);
    const mini = plan.bom.lines.find((l) => l.sku === 'mini-led-100');
    assert.deepEqual([mini.supplierId, mini.supplierSku, mini.url, mini.priceStatus], [null, null, null, 'default'], tag);
    assert.equal(mini.findUrl, suppliers.getSupplier(sid).categoryUrls.miniLights, tag);
    const eaves = plan.runs.filter((r) => ['roofline', 'rake', 'gutter', 'ridge'].includes(r.featureType));
    // Cut-to-length wire takes any colour of bulb, so it stays; a ready-made warm-white string does not.
    assert.ok(eaves.every((r) => r.productId === (style === 'bulk' ? sid + ':c9-bulk-12' : 'c9-led')), tag + ': ' + eaves.map((r) => r.productId).join(','));
  }
  // Warm white still gets the supplier's items.
  const { plan } = samplePlan('cle', { style: 'strings' });
  assert.ok(plan.bom.lines.some((l) => l.supplierSku === '77667') && plan.bom.lines.some((l) => l.supplierSku === '83768'));
  // One run in another colour: only that run falls back.
  const one = samplePlan('cle', { style: 'strings' }, (p) => { p.features.find((f) => f.type === 'window').color = { mode: 'coolWhite' }; }).plan;
  const win = one.runs.filter((r) => r.featureType === 'window');
  assert.ok(win.length >= 2);
  assert.deepEqual(win.map((r) => r.productId), ['mini-led-100'].concat(win.slice(1).map(() => 'cle:mini-5mm-70')));
  // resolveProduct says so directly.
  const lib = libFor('cle', { style: 'strings' });
  const f = feature('ft_x', 'roofline', [F(0, 10), F(30, 10)]);
  assert.deepEqual([design.resolveProduct(f, lib).product.id, design.resolveProduct(f, lib).source], ['cle:c9-string-25', 'supplier']);
  assert.deepEqual([design.resolveProduct(f, lib, { colorMode: 'warmWhite' }).product.id], ['cle:c9-string-25']);
  assert.deepEqual([design.resolveProduct(f, lib, { colorMode: 'multicolor' }).product.id, design.resolveProduct(f, lib, { colorMode: 'multicolor' }).source], ['c9-led', 'typeDefault']);
});

test('D1 C2: a supplier item picked by hand in a colour it is not sold in loses its part number and says so', () => {
  const lib = libFor('cle', { style: 'strings' });
  const run = bulkRun('Eave', { productId: 'cle:c9-string-25', unit: 'string', quantity: 6, method: 'linear', colorMode: 'multicolor', colors: ['#ff3b30', '#34c759'] });
  const b = bom.buildBom(project(), [run], emptyPower(), lib);
  const l = b.lines[0];
  assert.equal(l.name, 'C9 OptiCore LED string, 25 bulbs on 25 ft, ready to hang - Multicolor (the part on file is warm white only: choose the colour at the supplier)');
  assert.deepEqual([l.supplierId, l.supplierSku, l.url, l.priceStatus], ['cle', null, null, 'observed']);
  assert.equal(l.findUrl, suppliers.getSupplier('cle').categoryUrls.stringers);
  assert.equal(bom.priceStatusText(l), 'as of Nov 11, 2026 (check the price)');
  assert.match(l.notes, /The part number on file \(77667\) is the warm white one, so it is left off: choose multicolor at the supplier and check its price\./);
  const text = bom.orderSheetToText(bom.orderSheets(b, lib)[0]);
  assert.ok(!/Part 77667/.test(text) && !/Warm-White/.test(text), text);
  // The run itself still carries the warning, because the user picked that product.
  const p = fx.project({ features: [feature('ft_eave', 'roofline', [F(0, 10), F(30, 10)], { productId: 'cle:c9-string-25', color: { mode: 'multicolor' } })], library: { products: null, config: null, supplierId: 'cle' } });
  assert.match(design.planRuns(p, fx.measure(p), catalog.getLibrary(p))[0].warnings.join(' '), /is not sold in multicolor\. Pick another color or product\./);
  // Custom colours are named, not shown as codes.
  const c = bom.buildBom(project(), [Object.assign({}, run, { colorMode: 'custom', colors: ['#ff3b30', '#34c759'] })], emptyPower(), lib).lines[0];
  assert.match(c.name, / - Red and green \(the part on file is warm white only/);
  assert.ok(!/#/.test(c.name));
});

test('D7: a line for a supplier string says when a lower-priced set for the same job is on file', () => {
  const { plan } = samplePlan('cle', { style: 'strings' });
  const l = plan.bom.lines.find((x) => x.supplierSku === '77667');
  assert.match(l.notes, /A lower-priced set for the same job is also on file at this supplier \(C9 LED string, 25 bulbs on 17 ft, sealed set, green wire, part 84095\): pick it on the run in the Design step if you prefer it\./);
  // 1000Bulbs has one kind only, so nothing to say.
  const tb = samplePlan('1000bulbs', { style: 'strings' }).plan.bom.lines.find((x) => x.supplierSku === 'CMS-25C9-8GWW');
  assert.ok(!/lower-priced/.test(tb.notes));
});

// ================================================================ C1: the supplier's timer rating
test('C1: an outlet that carries more than the supplier\'s timer is rated for gets a plan warning and a heavy-duty timer, not that timer', () => {
  const edit = (p) => {
    for (const f of p.features) if (['roofline', 'rake', 'gutter', 'ridge'].includes(f.type)) f.productId = 'c9-incan';
    p.outlets = p.outlets.filter((o) => o.id === 'out_porch');
  };
  const { plan } = samplePlan('1000bulbs', null, edit);
  const o = plan.power.outlets[0];
  assert.ok(o.watts > 1000 && o.watts <= o.limitW && !o.overloaded, 'the outlet is over the timer but within its own limit: ' + o.watts);
  assert.equal(o.timerMaxW, 1000);
  const w = plan.warnings.filter((x) => x.code === 'timer-rating');
  assert.equal(w.length, 1);
  assert.deepEqual([w[0].level, w[0].outletId], ['warn', 'out_porch']);
  assert.match(w[0].message, /^Porch outlet would run 1,182 W through its timer, more than the 1,000 W the 1000Bulbs timer is rated for\. The shopping list has a heavy-duty timer for this outlet instead: check that its label says 15 A \(1,800 W\)\.$/);
  // The 1,000 W timer is not ordered for that outlet.
  assert.equal(lineBy(plan.bom, '1000bulbs:PLTS-12336'), undefined);
  const heavy = lineBy(plan.bom, 'timer-outdoor');
  assert.deepEqual([heavy.qty, heavy.name, heavy.supplierId, heavy.supplierSku, heavy.priceStatus], [1, 'Heavy-duty outdoor plug-in timer, rated 15 A (1,800 W)', null, null, 'default']);
  assert.equal(heavy.findUrl, suppliers.getSupplier('1000bulbs').categoryUrls.timers);
  assert.match(heavy.notes, /^For Porch outlet \(1,182 W\): more than the 1,000 W the 1000Bulbs timer is rated for, so this outlet needs a heavier timer\./);
  for (const s of bom.orderSheets(plan.bom, plan.library)) assert.ok(!/PLTS-12336/.test(bom.orderSheetToText(s)));
  // Two outlets, one light and one heavy: one timer of each kind.
  const two = samplePlan('1000bulbs', null, (p) => {
    for (const f of p.features) if (['roofline', 'rake', 'gutter', 'ridge'].includes(f.type)) f.productId = 'c9-incan';
  }).plan;
  const over = two.power.outlets.filter((x) => x.timer && x.watts > 1000).length, under = two.power.outlets.filter((x) => x.timer && x.watts <= 1000).length;
  assert.equal((lineBy(two.bom, '1000bulbs:PLTS-12336') || { qty: 0 }).qty, under);
  assert.equal((lineBy(two.bom, 'timer-outdoor') || { qty: 0 }).qty, over);
  assert.equal(two.warnings.filter((x) => x.code === 'timer-rating').length, over);
  // An LED plan is far inside the rating: the supplier's timer, no warning. A 15 A timer (CLE) never warns.
  const led = samplePlan('1000bulbs').plan;
  assert.ok(lineBy(led.bom, '1000bulbs:PLTS-12336').qty >= 1 && !lineBy(led.bom, 'timer-outdoor'));
  assert.deepEqual(led.warnings.filter((x) => x.code === 'timer-rating'), []);
  assert.deepEqual(samplePlan('cle', null, edit).plan.warnings.filter((x) => x.code === 'timer-rating'), []);
  assert.equal(samplePlan('cle', null, edit).plan.power.outlets[0].timerMaxW, null);
});

// ================================================================ C3 / C10: cut-to-length wire in the power plan
test('C3: cut-to-length wire is hung and lit over the true length; the waste allowance is bought, not hung', () => {
  for (const [len, sid] of [[227, 'cle'], [228, 'cle'], [240, 'cle'], [250, 'cle'], [240, '1000bulbs']]) {
    const r = build(eaveProject(len, sid));
    const tag = len + ' ft at ' + sid;
    const perFt = sid === 'cle' ? 0.8 : 0.74;
    assert.equal(r.runs[0].quantity, Math.ceil(len * 1.1 - 1e-9), tag + ': the feet bought include the waste');
    assert.equal(r.runs[0].hung, len, tag);
    assert.equal(r.power.feeds.length, 1, tag + ': a run of up to 250 ft is one feed');
    assert.deepEqual([r.power.feeds[0].strings, r.power.feeds[0].watts], [len, Math.round(len * perFt * 100) / 100], tag);
    assert.equal(r.power.totals.watts, Math.round(len * perFt * 100) / 100, tag + ': live load is the hung feet');
    assert.deepEqual(r.power.feeds[0].cord.pieces, [25], tag);
    assert.equal(r.power.counts.splitters, 0, tag);
    assert.equal(r.power.chains[0].spares, r.runs[0].quantity - len, tag);
    assert.deepEqual(fx.checkPlan(eaveProject(len, sid), r.measured, r.power, r.lib, { runs: r.runs }), [], tag);
  }
  // 300 ft: a second feed starts 250 ft along the eave (true feet), and carries the other 50 ft.
  const long = build(eaveProject(300, 'cle'));
  assert.deepEqual(long.power.feeds.map((f) => [f.strings, f.watts]), [[250, 200], [50, 40]]);
  assert.match(long.power.feeds[1].start.label, /^point 250 ft from the left end of Eave$/);
  // The checklist cuts the hung length, and says what the spare wire is for.
  const r = build(eaveProject(34, 'cle'));
  const steps = r.checklist.flatMap((g) => g.steps);
  assert.ok(steps.some((s) => /^On the ground, cut one length of socket wire for Eave: 34 ft \(34 sockets\)\./.test(s)), steps.join('\n'));
  assert.ok(steps.some((s) => /^Hang the wire along Eave \(34 ft\), starting at the left end of Eave\./.test(s)), steps.join('\n'));
  assert.ok(steps.some((s) => s === 'The order has 4 ft of wire and bulbs to spare. If a run turns out longer than the plan says, cut it longer; keep what is left for repairs.'), steps.join('\n'));
  // The shopping list still buys the feet with waste (SPEC 8.3): 38 ft of wire, 38 bulbs.
  assert.match(r.bom.lines[0].notes, /^38 ft needed for Eave \(38 ft\)\./);
  assert.match(lineBy(r.bom, 'cle:72636').notes, /^38 bulbs needed/);
  assert.match(r.runs[0].detail, /34 ft of it is cut, hung and lit; the other 4 ft is the allowance for waste and stays on the spool\.$/);
  // The sample: the eave measures 34 ft, so 34 ft is hung along it.
  const sp = samplePlan('cle').plan;
  const eave = sp.runs.find((x) => x.label === 'Front eave');
  assert.deepEqual([eave.quantity, eave.hung, eave.watts], [38, 34, 27.2]);
  assert.ok(sp.checklist.flatMap((g) => g.steps).some((s) => /Front eave \(34 ft\)/.test(s)));
  // Strings and the per-foot track are untouched: every foot of track is installed.
  const track = fx.project({ features: [feature('ft_eave', 'roofline', [F(0, 10), F(40, 10)], { productId: 'track-permanent' })], outlets: [outlet('out_1', F(2, 1.5))] });
  const tl = catalog.getLibrary(track);
  tl.products.find((x) => x.id === 'track-permanent').enabled = true;
  const tr = fx.plan(track, tl);
  assert.deepEqual([tr.runs[0].quantity, tr.power.feeds[0].strings], [44, 44]);
});

test('C10: a long cut-to-length run with an outlet under its middle is fed outward from there', () => {
  const p = eaveProject(400, '1000bulbs', { outletU: 200 });
  const r = build(p);
  assert.equal(r.power.feeds.length, 2);
  assert.deepEqual(r.power.feeds.map((f) => f.strings), [200, 200]);
  const home = r.power.feeds.find((f) => f.source.kind === 'outlet'), other = r.power.feeds.find((f) => f !== home);
  assert.deepEqual(home.cord.pieces, [25]);
  assert.deepEqual([other.source.kind, other.source.port, other.plugIn, other.cord], ['feed', 'start', true, null]);
  assert.match(home.start.label, /^point 200 ft from the (left|right) end of Eave$/);
  assert.deepEqual(r.power.warnings.filter((w) => w.code === 'long-cord'), []);
  assert.equal(r.power.warnings.filter((w) => w.code === 'fed-from-middle').length, 1);
  assert.deepEqual(fx.checkPlan(p, r.measured, r.power, r.lib, { runs: r.runs }), []);
  // The outlet at one end: fed from that end, the second feed 250 ft along.
  const end = build(eaveProject(400, '1000bulbs', { outletU: 2 }));
  assert.deepEqual(end.power.feeds.map((f) => f.strings), [250, 150]);
});

test('U06: a run with "its own cord" is still fed from its middle: one cord from the outlet, both halves on the tap', () => {
  const mk = (ownCord) => fx.project({
    // 40 ft of eave is two 25 ft strings whether it is fed from an end or from the middle.
    features: [feature('ft_eave', 'roofline', [F(0, 10), F(40, 10)], { label: 'Eave 1', params: { ownCord } }),
      feature('ft_rail', 'railing', [F(26, 3), F(34, 3)], { label: 'Rail' })],
    outlets: [outlet('out_1', F(20, 1.5))],
  });
  const own = fx.plan(mk(true));
  const fs = own.power.feeds.filter((f) => f.runIds.includes('run_ft_eave'));
  assert.equal(fs.length, 2);
  const home = fs.find((f) => f.source.kind === 'outlet'), half = fs.find((f) => f !== home);
  assert.ok(home && half, 'one cord from the outlet');
  assert.deepEqual([half.source.kind, half.source.feedId, half.source.port, half.plugIn, half.cord], ['feed', home.id, 'start', true, null]);
  // 17 ft of cord to the middle; from an end it would be 36 ft, a 50 ft cord.
  assert.deepEqual([home.cord.pieces, home.taps], [[25], 1]);
  assert.match(home.start.label, /^point 20 ft from the (left|right) end of Eave 1$/);
  assert.match(half.start.label, /^point 20 ft from the (left|right) end of Eave 1$/);
  assert.notEqual(home.start.label, half.start.label);
  // With its own cord nothing else hangs off the eave, and the eave hangs off nothing.
  const rail = fx.feedOf(own.power, 'run_ft_rail');
  assert.equal(rail.source.kind, 'outlet');
  assert.deepEqual(rail.childFeedIds, []);
  assert.deepEqual(fx.checkPlan(mk(true), own.measured, own.power, fx.lib, { runs: own.runs }), []);
  // Jumpers switched off altogether: no tap either, each half gets a cord (as before).
  const off = fx.plan(mk(true), fx.libWith({ daisyChain: false }));
  assert.ok(off.power.feeds.every((f) => f.source.kind === 'outlet'));
});

// ================================================================ C8 / C9: cords beside openings
test('C8: a cord to the middle of a row of windows that nearly touch runs up between them or over them, never through one', () => {
  const win = (id, u0, u1, v0, v1) => feature(id, 'window', [F(u0, v1), F(u1, v1), F(u1, v0), F(u0, v0)], { params: { ownCord: true } });
  const cases = {
    'gaps of 4 in, middle window lower': [win('ft_w1', 5, 8, 3, 7), win('ft_w2', 8.33, 11.33, 3, 6), win('ft_w3', 11.67, 14.67, 3, 7)],
    'windows that touch, middle window lower': [win('ft_w1', 5, 8, 3, 7), win('ft_w2', 8, 11, 3, 6), win('ft_w3', 11, 14, 3, 7)],
    'tops level to within tap noise': [win('ft_w1', 5, 8, 3, 7), win('ft_w2', 8.33, 11.33, 3, 6.88), win('ft_w3', 11.67, 14.67, 3, 7)],
    'four in a row, uneven': [win('ft_w1', 5, 8, 3, 7.5), win('ft_w2', 8.2, 11, 2.5, 6), win('ft_w3', 11.2, 14, 3, 6.5), win('ft_w4', 14.1, 17, 3, 8)],
  };
  for (const [name, feats] of Object.entries(cases)) {
    const p = fx.project({ features: feats, outlets: [outlet('out_1', F(2, 1.5))] });
    const r = fx.plan(p);
    assert.deepEqual(fx.checkPlan(p, r.measured, r.power, fx.lib, { runs: r.runs }), [], name);
    for (const f of r.power.feeds) {
      assert.equal(f.source.kind, 'outlet', name);
      const path = f.cordPath.map(fx.toFt);
      for (let k = 1; k < path.length; k++) {
        for (const o of fx.openingsByWall(p, r.measured).get('pl_front')) assert.ok(!fx.segInsideBox(path[k - 1], path[k], o, 0.05), `${name}: ${f.id} is drawn through ${o.id}: ${JSON.stringify(path)}`);
      }
    }
  }
  // 4 in gaps: the riser stands in the gap beside the middle window.
  const p = fx.project({ features: cases['gaps of 4 in, middle window lower'], outlets: [outlet('out_1', F(2, 1.5))] });
  const mid = fx.feedOf(fx.plan(p).power, 'run_ft_w2');
  assert.deepEqual(mid.cordPath.map((q) => fx.toFt(q).map((x) => Math.round(x * 100) / 100)), [[2, 1.5], [2, 0], [8.16, 0], [8.16, 6], [8.33, 6]]);
  // Windows that touch: up beside the row, over the taller neighbour, down to the corner.
  const q = fx.project({ features: cases['windows that touch, middle window lower'], outlets: [outlet('out_1', F(2, 1.5))] });
  const over = fx.feedOf(fx.plan(q).power, 'run_ft_w2');
  assert.deepEqual(fx.kinds(over), ['drop', 'ground', 'rise', 'hop', 'drop']);
  assert.equal(over.cord.routeText, 'down 1.5 ft, 2.5 ft along the ground, up 7.5 ft beside ft_w1, 3.5 ft across, down 1.5 ft');
});

test('C9: the cord from an outlet beside a door frame goes straight down first', () => {
  const p = fx.project({
    features: [feature('ft_door', 'door', [F(10, 0), F(10, 6.7), F(13, 6.7), F(13, 0)]), feature('ft_eave', 'roofline', [F(0, 9), F(30, 9)])],
    outlets: [outlet('out_1', F(13.25, 1.5))],
  });
  const r = fx.plan(p);
  const homes = r.power.feeds.filter((f) => f.source.kind === 'outlet');
  assert.ok(homes.length >= 1);
  for (const f of homes) {
    assert.equal(f.cord.route[0].kind, 'drop', f.cord.routeText);
    assert.deepEqual(fx.toFt(f.cordPath[1]).map((x) => Math.round(x * 100) / 100), [13.25, 0], 'straight down at the outlet');
  }
  assert.deepEqual(fx.checkPlan(p, r.measured, r.power, fx.lib, { runs: r.runs }), []);
  // An outlet traced inside an opening's own box is still moved beside it.
  const inside = fx.project({ features: [feature('ft_win', 'window', [F(10, 6), F(14, 6), F(14, 1), F(10, 1)]), feature('ft_eave', 'roofline', [F(0, 9), F(30, 9)])], outlets: [outlet('out_1', F(12, 4))] });
  const ri = fx.plan(inside);
  assert.ok(ri.power.feeds.every((f) => f.outletId === 'out_1'));
});

// ================================================================ D2 / C5 / C6 / K2: slide-on plugs
test('D2 K2: plugNeeds counts slide-on plugs from the wire that is bought', () => {
  const need = (cuts, pieces) => { const n = bom.plugNeeds(cuts, pieces.map(([lengthFt, plugs]) => ({ lengthFt, plugs }))); return [n.male, n.female, n.joints]; };
  // Bare wire off a spool: one male and one female for every cut length (SPEC 8.3).
  assert.deepEqual(need([40, 30, 20], [[1000, false]]), [3, 3, 0]);
  // A ready-made length used whole needs nothing; cut short, only its far end needs a plug.
  assert.deepEqual(need([25], [[25, 'both']]), [0, 0, 0]);
  assert.deepEqual(need([20], [[25, 'both']]), [0, 1, 0]);
  assert.deepEqual(need([20], [[100, 'male']]), [0, 1, 0]);
  // Two ready-made lengths joined end to end plug into each other; male-only lengths need a female at the joint.
  assert.deepEqual(need([150], [[100, 'both'], [50, 'both']]), [0, 0, 1]);
  assert.deepEqual(need([200], [[100, 'male'], [100, 'male']]), [0, 2, 1]);
  assert.deepEqual(need([200, 200, 200, 200], Array.from({ length: 9 }, () => [100, 'male'])), [0, 8, 4]);
  // Three lengths cut from a 100 ft and a 50 ft piece: the off-cut with the factory far end is used that way round.
  assert.deepEqual(need([73, 31, 23], [[100, 'both'], [50, 'both']]), [1, 2, 0]);
  // Not enough wire on file for the cuts: a full pair is counted rather than nothing. Odd input: no throw.
  assert.deepEqual(need([30], []), [1, 1, 0]);
  assert.deepEqual(need([], [[25, 'both']]), [0, 0, 0]);
  assert.deepEqual(bom.plugNeeds([NaN, -3, 'x'], [null, { lengthFt: 0, plugs: 'both' }, 7]), { male: 0, female: 0, joints: 0 });
  assert.deepEqual(bom.plugNeeds(null, null), { male: 0, female: 0, joints: 0 });
});

test('D2 C5: C7 and C9 wire on one job share one line per plug part', () => {
  const lib = libFor('cle');
  const runs = [bulkRun('A', { quantity: 60, lengthFt: 54 }), bulkRun('B', { quantity: 30, lengthFt: 27 }), bulkRun('C', { productId: 'cle:c7-bulk-12', quantity: 12, lengthFt: 10 })];
  // Spools only (your own prices make the spools the buy), so every cut needs both plugs: 2 + 1 = 3 of each.
  const spools = project({ pricing: { overrides: { 'cle:15085': 20, 'cle:15054': 10 } } });
  const b = bom.buildBom(spools, runs, emptyPower(), lib);
  for (const sku of ['cle:88283', 'cle:88287']) {
    assert.equal(linesBy(b, sku).length, 1, sku + ' is on the list once');
    assert.match(lineBy(b, sku).notes, /^One for each cut end of wire that has no plug of its own: 3 needed, 10 bought\./);
    assert.deepEqual([lineBy(b, sku).qty, lineBy(b, sku).usedQty, lineBy(b, sku).lineTotal], [1, 0.3, 12.4]);
  }
  assert.equal(new Set(b.lines.map((l) => l.sku)).size, b.lines.length, 'no sku is on the list twice');
  // The reviewer's house: red and green C9 plus a warm white C7 gutter at CLE, planned end to end.
  const { plan } = samplePlan('cle', null, (p) => {
    p.settings.colorMode = 'custom'; p.settings.customColors = ['#ff3b30', '#34c759'];
    const g = p.features.find((f) => f.type === 'gutter'); g.productId = 'cle:c7-bulk-12'; g.color = { mode: 'warmWhite' };
  });
  assert.equal(new Set(plan.bom.lines.map((l) => l.sku)).size, plan.bom.lines.length);
  assert.ok(linesBy(plan.bom, 'cle:88283').length <= 1 && linesBy(plan.bom, 'cle:88287').length <= 1);
  // 1000Bulbs the same.
  const tb = bom.buildBom(project({ pricing: { overrides: { '1000bulbs:CMS-10105': 20, '1000bulbs:CMS-10095': 10 } } }),
    [bulkRun('A', { productId: '1000bulbs:c9-bulk-12' }), bulkRun('C', { productId: '1000bulbs:c7-bulk-12' })], emptyPower(), libFor('1000bulbs'));
  assert.equal(linesBy(tb, '1000bulbs:PLUG-10001').length, 1);
  assert.match(lineBy(tb, '1000bulbs:PLUG-10002').notes, /: 2 needed, 10 bought\./);
});

test('D2 K2: no plugs are ordered for wire that comes with them', () => {
  // A 20 ft roofline at CLE: one 25 ft ready-made length with a plug on each end. Only its cut far end needs a plug.
  const r = build(eaveProject(20, 'cle'));
  assert.deepEqual(r.bom.lines.filter((l) => /socket wire/.test(l.name)).map((l) => [l.supplierSku, l.qty]), [['15100', 1]]);
  assert.equal(lineBy(r.bom, 'cle:88283'), undefined, 'no male plugs: the length has one');
  const female = lineBy(r.bom, 'cle:88287');
  assert.equal(female.qty, 1);
  assert.equal(female.notes, 'One for each cut end of wire that has no plug of its own: 1 needed, 10 bought. It goes on the far end, so the next run or a jumper cord can plug in. ' +
    'The lengths bought come with a plug on each end, so only the ends you cut need one.');
  // A run that is exactly a whole ready-made length needs no slide-on plug at all.
  const whole = bom.buildBom(project(), [bulkRun('Eave', { quantity: 25, lengthFt: 25, withWasteFt: 25 })], emptyPower(), libFor('cle'));
  assert.deepEqual(whole.lines.filter((l) => /plug/.test(l.name) && !/socket wire/.test(l.name)), []);
});

test('D2 C6: plugs to join ready-made lengths inside one run are counted', () => {
  // A 200 ft and a 100 ft roofline at 1000Bulbs: 330 ft of wire with waste is three 100 ft lengths (male plug
  // only) and a 50 ft length. The 200 ft run is two lengths joined, so it needs a female plug at the joint as
  // well as one on its far end; the 100 ft run needs one on its far end. No male plug is needed at all.
  const p = fx.project({
    features: [feature('ft_a', 'roofline', [F(0, 10), F(200, 10)], { label: 'Eave A' }), feature('ft_b', 'roofline', [F(210, 10), F(310, 10)], { label: 'Eave B' })],
    outlets: [outlet('out_1', F(205, 1.5))],
    library: { products: null, supplierId: '1000bulbs', config: null },
  });
  const r = build(p);
  assert.deepEqual(r.bom.lines.filter((l) => /socket wire/.test(l.name)).map((l) => [l.supplierSku, l.qty]), [['CMS-10124', 3], ['CMS-10319', 1]]);
  assert.deepEqual(r.power.feeds.map((f) => f.strings).sort((x, y) => y - x), [200, 100]);
  assert.equal(lineBy(r.bom, '1000bulbs:PLUG-10001'), undefined, 'every length starts with its own male plug');
  const female = lineBy(r.bom, '1000bulbs:PLUG-10002');
  assert.equal(female.notes, 'One for each cut end of wire that has no plug of its own: 3 needed, 10 bought. ' +
    'It goes on the far end, so the next run or a jumper cord can plug in, and on the first piece wherever two pieces of wire are joined.');
  assert.deepEqual([female.qty, female.usedQty], [1, 0.3]);
});

// ================================================================ D3 / C7 / K1: price honesty for a colour that is not on file
test('D3 C7 K1: a bulb colour that is not on file says "check the price", never "checked"', () => {
  for (const [sid, pid] of [['cle', 'cle:c9-bulk-12'], ['1000bulbs', '1000bulbs:c9-bulk-12']]) {
    const b = bom.buildBom(project(), [bulkRun('Eave', { productId: pid, quantity: 143, colorMode: 'custom', colors: ['#ff7a00', '#b44dff'] })], emptyPower(), libFor(sid));
    const odd = b.lines.filter((l) => /choose the colour at the supplier/.test(l.name));
    assert.equal(odd.length, 2, sid);
    for (const l of odd) {
      assert.deepEqual([l.supplierId, l.supplierSku, l.url, l.priceStatus, l.priceAsOf], [sid, null, null, 'observed', '2026-11-11'], l.name);
      assert.equal(bom.priceStatusText(l), 'as of Nov 11, 2026 (check the price)');
      assert.match(l.notes, /so it is priced like warm white: choose the colour at the supplier and check its price\.$/);
      assert.ok(l.findUrl);
    }
    const text = bom.orderSheetToText(bom.orderSheets(b, libFor(sid))[0]);
    assert.match(text, /Orange \(choose the colour at the supplier\) - \$\d+\.\d\d each = \$\d+\.\d\d \(as of Nov 11, 2026, check the price\)/);
    assert.ok(!/\(as of Nov 11, 2026 \(/.test(text), 'one pair of brackets');
  }
  // Your own price for that line is still "your price".
  const mine = bom.buildBom(project({ pricing: { overrides: { 'cle:72636:orange': 31 } } }), [bulkRun('Eave', { colorMode: 'custom', colors: ['#ff7a00'] })], emptyPower(), libFor('cle'));
  assert.deepEqual([lineBy(mine, 'cle:72636:orange').priceStatus, lineBy(mine, 'cle:72636:orange').unitPrice], ['yours', 31]);
});

// ================================================================ D4 / D6 / K3 / K4: wire sizes and the mix that is bought
test('D4: the 50 ft lengths the suppliers list are on file, so a short job does not buy 100 ft', () => {
  const sizes = (id) => suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === id).components.wire.sizes.map((s) => [s.lengthFt, s.supplierSku, s.price, s.priceStatus, s.plugsIncluded, s.maxAmps]);
  assert.deepEqual(sizes('cle:c9-bulk-12').find((s) => s[0] === 50), [50, '15106', 27.99, 'verified', 'both', 7]);
  assert.deepEqual(sizes('cle:c7-bulk-12').find((s) => s[0] === 50), [50, '15077', 22.99, 'verified', 'both', 5]);
  assert.deepEqual(sizes('1000bulbs:c9-bulk-12').filter((s) => s[0] === 50), [[50, 'CMS-10319', 26.98, 'observed', 'both', undefined]]);
  assert.deepEqual(sizes('1000bulbs:c7-bulk-12').filter((s) => s[0] === 50), [[50, 'CMS-10122', 18.85, 'observed', 'male', undefined], [50, 'CMS-10318', 30.44, 'observed', 'both', undefined]]);
  // The thinner 25 ft lengths at 1000Bulbs stay out.
  assert.ok(!JSON.stringify(suppliers.SUPPLIER_PRODUCTS).includes('CMS-10126') && !JSON.stringify(suppliers.SUPPLIER_PRODUCTS).includes('CMS-10119'));
  const wire = (pid, sid, feet) => bom.buildBom(project(), [bulkRun('Eave', { productId: pid, quantity: feet, lengthFt: feet / 1.1 })], emptyPower(), libFor(sid))
    .lines.filter((l) => /socket wire/.test(l.name)).map((l) => [l.supplierSku, l.qty, l.unitPrice, l.priceStatus]);
  assert.deepEqual(wire('1000bulbs:c9-bulk-12', '1000bulbs', 22), [['CMS-10319', 1, 26.98, 'observed']]);
  assert.deepEqual(wire('1000bulbs:c7-bulk-12', '1000bulbs', 22), [['CMS-10122', 1, 18.85, 'observed']]);
  assert.deepEqual(wire('1000bulbs:c7-bulk-12', '1000bulbs', 60), [['CMS-10122', 2, 18.85, 'observed']]);
  assert.deepEqual(wire('cle:c9-bulk-12', 'cle', 40), [['15106', 1, 27.99, 'verified']]);
  assert.deepEqual(wire('cle:c7-bulk-12', 'cle', 40), [['15077', 1, 22.99, 'verified']]);
  // A line bought at a listed-only price says so.
  const l = bom.buildBom(project(), [bulkRun('Eave', { productId: '1000bulbs:c9-bulk-12', quantity: 22 })], emptyPower(), libFor('1000bulbs')).lines[0];
  assert.match(l.notes, /Seen on the supplier's category list only, not on its own page: check the price and details there\.$/);
  assert.equal(bom.priceStatusText(l), 'as of Nov 11, 2026 (check the price)');
});

test('D6 K4: the wire mix prefers fewer pieces and confirmed prices unless the saving is clear', () => {
  const mix = (pid, sid, feet, overrides) => bom.buildBom(project({ pricing: { overrides: overrides || {} } }), [bulkRun('Eave', { productId: pid, quantity: feet })], emptyPower(), libFor(sid))
    .lines.filter((l) => /socket wire/.test(l.name)).map((l) => [l.supplierSku, l.qty]);
  // CLE C9: one 100 ft length, not three 25 ft lengths; never more than four ready-made lengths.
  assert.deepEqual(mix('cle:c9-bulk-12', 'cle', 60), [['15106', 1], ['15100', 1]]);
  assert.deepEqual(mix('cle:c9-bulk-12', 'cle', 80), [['15098', 1]]);
  assert.deepEqual(mix('cle:c9-bulk-12', 'cle', 190), [['15098', 2]]);
  assert.deepEqual(mix('cle:c9-bulk-12', 'cle', 360), [['15098', 4]]);
  assert.deepEqual(mix('cle:c9-bulk-12', 'cle', 410), [['81832', 1]]);
  assert.deepEqual(mix('cle:c9-bulk-12', 'cle', 900), [['15085', 1]]);
  // 1000Bulbs C9: a 1,000 ft spool, not nine joined 100 ft lengths; the 500 ft spool is bought for 401 to 500 ft.
  assert.deepEqual(mix('1000bulbs:c9-bulk-12', '1000bulbs', 850), [['CMS-10105', 1]]);
  assert.deepEqual(mix('1000bulbs:c9-bulk-12', '1000bulbs', 450), [['CMS-10110', 1]]);
  assert.deepEqual(mix('1000bulbs:c9-bulk-12', '1000bulbs', 380), [['CMS-10124', 4]]);
  // 1000Bulbs C7: the 1,000 ft spool read on its own page ($481.47), not two listed-only 500 ft spools ($459.54).
  assert.deepEqual(mix('1000bulbs:c7-bulk-12', '1000bulbs', 900), [['CMS-10095', 1]]);
  // A clear saving still wins, and the line says the price is unconfirmed.
  assert.deepEqual(mix('1000bulbs:c7-bulk-12', '1000bulbs', 450), [['CMS-10093', 1]]);
  // Your own price is a confirmed price: with an account price on the 500 ft spool, two of them are the buy.
  assert.deepEqual(mix('1000bulbs:c7-bulk-12', '1000bulbs', 900, { '1000bulbs:CMS-10093': 200 }), [['CMS-10093', 2]]);
  // The rule itself.
  assert.deepEqual(bom.MIX_RULE, { pieceCost: 5, unsurePct: 10, maxReadyMade: 4 });
  const sizes = [{ lengthFt: 1000, price: 400 }, { lengthFt: 100, price: 39, readyMade: true }, { lengthFt: 50, price: 19, readyMade: true, unsure: true }];
  const pick = (feet, rule) => bom.cheapestMix(feet, sizes, rule).map((m) => [m.size.lengthFt, m.count]);
  assert.deepEqual(pick(900), [[50, 18]], 'with no rule: the cheapest, as before');
  assert.deepEqual(pick(900, bom.MIX_RULE), [[1000, 1]]);
  assert.deepEqual(pick(300, bom.MIX_RULE), [[100, 3]]);
  assert.deepEqual(pick(40, bom.MIX_RULE), [[50, 1]]);
  // Only ready-made sizes on file: the cap cannot hold, so it is dropped rather than buying nothing.
  assert.deepEqual(bom.cheapestMix(700, sizes.slice(1), bom.MIX_RULE).map((m) => [m.size.lengthFt, m.count]), [[100, 7]]);
});

test('K3: a spool reads as a spool, a ready-made length as a piece', () => {
  const units = (feet) => bom.buildBom(project(), [bulkRun('Eave', { quantity: feet })], emptyPower(), libFor('cle')).lines.filter((l) => /socket wire/.test(l.name)).map((l) => [l.supplierSku, l.unit]);
  assert.deepEqual(units(410), [['81832', 'spool']]);
  assert.deepEqual(units(900), [['15085', 'spool']]);
  assert.deepEqual(units(560), [['81832', 'spool'], ['15106', 'each'], ['15100', 'each']]);
});

// ================================================================ D5 / K5: watts by bulb colour
test('D5 K5: blue C7 bulbs at 1000Bulbs count at their own 0.54 W, and a full run of them still fits one feed', () => {
  const tb7 = suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === '1000bulbs:c7-bulk-12');
  assert.deepEqual([tb7.wattsPerUnit, tb7.maxConnectedW, tb7.components.bulb.variants.blue.wattsEach], [0.48, 135, 0.54]);
  const plan = (color) => {
    const p = eaveProject(250, '1000bulbs', { feature: { productId: '1000bulbs:c7-bulk-12', color } });
    p.settings.wastePct = 0;
    const lib = catalog.getLibrary(p);
    const m = fx.measure(p);
    m.features.ft_eave.withWasteFt = 250;
    const runs = design.planRuns(p, m, lib);
    const pw = power.planPower(p, m, runs, lib);
    return { run: planner.mergeRunInfo(runs, pw)[0], pw };
  };
  const blue = plan({ mode: 'custom', colors: ['#2f7bff'] });
  assert.deepEqual([blue.run.quantity, blue.run.watts, blue.pw.totals.watts], [250, 135, 135]);
  assert.equal(blue.pw.feeds.length, 1);
  assert.deepEqual(blue.pw.warnings.filter((w) => w.code === 'pass-through'), []);
  // Warm white is unchanged; blue and white alternating is half and half.
  assert.equal(plan(null).run.watts, 120);
  assert.equal(plan({ mode: 'custom', colors: ['#2f7bff', '#ffffff'] }).run.watts, 127.5);
  // C9 blue is listed at 0.5 W, under the 0.74 W of the family: the plan keeps the higher figure.
  assert.equal(suppliers.bulkWatts(suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === '1000bulbs:c9-bulk-12'), { colorMode: 'custom', colors: ['#2f7bff'] }, 100), 74);
  assert.equal(suppliers.bulkWatts({}, {}, 10), null);
  assert.match(tb7.components.bulb.variants.blue.notes, /0\.54 W per bulb as listed, a little more than the 0\.48 W of the other colours, so the plan counts 0\.54 W for each blue bulb\./);
});

// ================================================================ D8: gutter clips
test('D8: gutter runs use the supplier\'s all-in-one clip when it has no gutter clip of its own', () => {
  for (const sid of ['cle', '1000bulbs']) {
    const { plan } = samplePlan(sid);
    assert.equal(lineBy(plan.bom, 'clip-gutter'), undefined, sid);
    const all = plan.bom.lines.find((l) => l.category === 'clips' && /gutter/i.test(l.name) && l.supplierId === sid);
    assert.match(all.notes, /^58 clips \+ 10% spare = 64, in packs of \d+\. 23 of them are for the gutter runs: this clip hangs on a gutter too\.$/, sid);
  }
  // Any store keeps its own gutter clips.
  const g = planner.computePlan(sample.createSample().project);
  assert.equal(lineBy(g.bom, 'clip-gutter').qty, 1);
  assert.ok(!/gutter runs/.test(lineBy(g.bom, 'clip-allinone').notes));
});

// ================================================================ D9: the price sentence
test('D9: the price sentence does not call any-store prices "checked"', () => {
  const { plan } = samplePlan('cle');
  assert.equal(bom.priceNote(plan.bom), 'Supplier prices were last checked on Nov 11, 2026; the other prices are typical store prices. Confirm at checkout. Account (wholesale) prices differ: edit any price.');
  const sheets = bom.orderSheets(plan.bom, plan.library);
  assert.equal(bom.priceNote(sheets[0]), 'Prices were last checked on Nov 11, 2026; confirm at checkout. Account (wholesale) prices differ: edit any price.');
  assert.equal(bom.priceNote(sheets[1]), '');
  assert.equal(bom.priceNote(planner.computePlan(sample.createSample().project).bom), '');
  assert.match(bom.bomToCsv(plan.bom), /\r\nNote,"Supplier prices were last checked on Nov 11, 2026; the other prices are typical store prices\. Confirm at checkout\./);
});

// ================================================================ D10 / D11 / D12: catalog notes and links
test('D10 D11 D12: catalog notes say only what is on file, and the clips link fits mini-light clips', () => {
  for (const [id, item] of [['cle:c9-string-25', '77667'], ['cle:c7-string-25', '77653']]) {
    const p = suppliers.SUPPLIER_PRODUCTS.find((x) => x.id === id);
    assert.ok(!/gives no limit/.test(p.notes), id);
    assert.match(p.notes, /LightPlan plans at most 10 sets \(250 ft, 250 bulbs, 200 W\) on one run, the trade rule for this wire, whatever larger figure the supplier's page prints for sets joined end to end\.$/);
    assert.equal(p.orderNote, `The page offers more than one size: pick the 25-light, 25 ft set (item ${item}).`);
    assert.equal(p.maxEndToEnd, 10);
  }
  const cle = suppliers.getSupplier('cle');
  assert.equal(cle.categoryUrls.clips, 'https://www.christmaslightsetc.com/christmas-light-clips-and-hangers--102.htm');
  const { plan } = samplePlan('cle');
  assert.equal(lineBy(plan.bom, 'clip-adhesive').findUrl, cle.categoryUrls.clips);
  assert.ok(suppliers.allLinks().some((l) => l.url === cle.categoryUrls.clips && l.kind === 'category'));
});

// ================================================================ C4 / D13 / U08 / U04 / U05: cost basis
test('C4 D13 U08: "only what is used" changes what the job is charged, never what is ordered', () => {
  const quote = { enabled: true };
  const order = (b) => b.lines.map((l) => [l.sku, l.qty, l.unit, l.buyTotal]);
  for (const sid of ['cle', '1000bulbs']) {
    const bought = samplePlan(sid, { costBasis: 'bought' }, (p) => { p.quote = Object.assign({}, p.quote, quote); }).plan;
    const used = samplePlan(sid, { costBasis: 'used' }, (p) => { p.quote = Object.assign({}, p.quote, quote); }).plan;
    assert.deepEqual(order(used.bom), order(bought.bom), sid + ': the same order');
    assert.deepEqual([bought.bom.costBasis, used.bom.costBasis], ['bought', 'used']);
    assert.equal(used.bom.orderTotal, bought.bom.subtotal, sid);
    assert.equal(bought.bom.orderTotal, bought.bom.subtotal, sid);
    assert.ok(used.bom.subtotal < bought.bom.subtotal, sid);
    assert.deepEqual(bom.orderSheets(used.bom, used.library).map((s) => s.subtotal), bom.orderSheets(bought.bom, bought.library).map((s) => s.subtotal), sid);
    assert.ok(!used.bom.lines.some((l) => /1,000 ft spool/.test(l.name)), sid + ': no 1,000 ft spool for a 139 ft job');
    const wire = used.bom.lines.filter((l) => /socket wire/.test(l.name));
    for (const l of wire) {
      assert.ok(l.total < l.buyTotal && Math.abs(l.total - l.usedQty * l.unitPrice) < 0.011, l.name);
      assert.match(l.notes, /If you already have this wire on a spool, take the 139 ft from it instead of ordering\.$/);
    }
    assert.ok(!bought.bom.lines.some((l) => /already have this wire/.test(l.notes)));
  }
  // A 20 ft job: a 25 ft length either way, not a 1,000 ft spool.
  const p = eaveProject(20, 'cle', { config: { buying: { costBasis: 'used' } } });
  p.quote = quote;
  assert.deepEqual(build(p).bom.lines.filter((l) => /socket wire/.test(l.name)).map((l) => [l.supplierSku, l.qty]), [['15100', 1]]);
});

test('U04: the cost basis applies in installer mode only; with it off the list is priced as everything ordered', () => {
  const off = samplePlan('cle', { costBasis: 'used' }).plan;                       // quote.enabled is false in the sample
  const base = samplePlan('cle').plan;
  assert.equal(off.bom.costBasis, 'bought');
  assert.deepEqual(off.bom, base.bom);
  assert.equal(off.summary.cost, base.summary.cost);
  assert.ok(off.bom.lines.every((l) => l.total === l.buyTotal));
  const on = samplePlan('cle', { costBasis: 'used' }, (p) => { p.quote = Object.assign({}, p.quote, { enabled: true }); }).plan;
  assert.equal(on.bom.costBasis, 'used');
  assert.ok(on.bom.subtotal < base.bom.subtotal);
  // No project at all (a bare call): bought.
  assert.equal(bom.buildBom(null, [bulkRun('A')], emptyPower(), libFor('cle', { costBasis: 'used' })).costBasis, 'bought');
});

test('U05 C4: with "only what is used" the CSV shows what is used, what the order costs, and says why', () => {
  const used = samplePlan('cle', { costBasis: 'used' }, (p) => { p.quote = Object.assign({}, p.quote, { enabled: true }); }).plan;
  const rows = bom.bomToCsv(used.bom).trim().split('\r\n');
  assert.equal(rows[0], 'SKU,Item,Category,Qty,Unit,Unit Price,Line Total,Notes,Supplier,Part number,Price status,Link,Used Qty,Order Total');
  const bulbs = rows.find((r) => r.startsWith('cle:72636,'));
  assert.match(bulbs, /,lights,6,pack,29\.99,166\.74,/);
  assert.match(bulbs, /,5\.56,179\.94$/);
  const timer = rows.find((r) => r.startsWith('cle:80056,'));
  assert.match(timer, /,2,69\.98$/, 'a line that is used whole: used qty = qty, order total = line total');
  assert.ok(rows.includes('Subtotal,' + used.bom.subtotal.toFixed(2) + ',,,,,,,,,,,,'));
  assert.ok(rows.includes('To order,' + used.bom.orderTotal.toFixed(2) + ',,,,,,,,,,,,'));
  assert.ok(rows.some((r) => r.startsWith('Note,"Line totals count only the share of the wire, bulbs and plugs that this job uses.')));
  assert.equal(bom.USED_NOTE, 'Line totals count only the share of the wire, bulbs and plugs that this job uses. "Order Total" and "To order" are what the whole spools, boxes and packs cost.');
  // Basis "bought": the columns and rows are as before.
  const plain = bom.bomToCsv(samplePlan('cle').plan.bom).trim().split('\r\n');
  assert.equal(plain[0], 'SKU,Item,Category,Qty,Unit,Unit Price,Line Total,Notes,Supplier,Part number,Price status,Link');
  assert.ok(!plain.some((r) => r.startsWith('To order')));
});

// ================================================================ K6: price overrides that match no line
test('K6: a price override whose key matches no line changes nothing and breaks nothing', () => {
  const base = samplePlan('cle').plan;
  const odd = { 'cle:c9-spool-1000-spt1': 300, 'cle:no-such-item': 5, 'nonsense': 0, '1000bulbs:CMS-10124': 1, 'cle:72636:orange': 2 };
  const { project: prj, plan } = samplePlan('cle', null, (p) => { p.pricing = { overrides: odd }; });
  assert.deepEqual(plan.warnings.filter((w) => w.code === 'internal-error'), []);
  assert.deepEqual(plan.bom, base.bom);
  assert.deepEqual(schema.validateProject(prj).errors, []);
  assert.deepEqual(schema.normalizeProject(prj).pricing.overrides['cle:c9-spool-1000-spt1'], 300, 'the entry is kept, so nothing is lost on save');
});

// ================================================================ C11: plain words in validateProject
test('C11: a bad price status on a product is reported in plain words', () => {
  const p = sample.createSample().project;
  p.library.products = [Object.assign(clone(suppliers.SUPPLIER_PRODUCTS.find((x) => x.id === 'cle:c9-bulk-12')), { priceStatus: 'certified' })];
  const errors = schema.validateProject(p).errors;
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'Product "C9 LED on socket wire, a bulb every 12 in (cut to length)": the price check must be "verified" or "observed".');
  assert.ok(!/priceStatus/.test(errors.join(' ')));
});

// ================================================================ U12: custom colours by name
test('U12: custom colours are named on the shopping list and the checklist, not printed as codes', () => {
  const { plan } = samplePlan('generic', null, (p) => { p.settings.colorMode = 'custom'; p.settings.customColors = ['#ff3b30', '#34c759']; });
  const names = plan.bom.lines.filter((l) => l.category === 'lights').map((l) => l.name);
  assert.ok(names.includes('C9 LED string, 25 bulbs - Red and green'), names.join(' | '));
  assert.ok(!plan.bom.lines.some((l) => /#[0-9a-f]{3,6}/i.test(l.name + ' ' + l.notes)));
  const steps = plan.checklist.flatMap((g) => g.steps).join('\n');
  assert.match(steps, /C9 LED string, 25 bulbs in red and green/);
  assert.ok(!/#[0-9a-f]{6}/i.test(steps));
  assert.equal(suppliers.colourNames(['#ff3b30', '#34c759', '#ff0000']), 'red and green');
  assert.equal(suppliers.colourNames(['#2f7bff']), 'blue');
  assert.equal(suppliers.colourNames([]), '');
  assert.equal(suppliers.colourNames(['zzz', 7, null]), '');
  assert.equal(bom.colourFamily('#b44dff'), 'purple');
});

// ================================================================ U16: walkway and doorway wording
test('U16: a cord that stops at the door jamb just inside a walkway edge does not "cross a walkway"; the doorway warning matches the route', () => {
  // The sample with jumper cords off: the cord to the door runs 2.5 ft along the wall to the jamb, a foot inside
  // the traced walkway edge. It needs no cord cover.
  const { plan } = samplePlan('generic', null, (p) => { p.library = Object.assign({}, p.library, { config: { power: { daisyChain: false } } }); });
  const door = plan.power.feeds.find((f) => /Front door/.test(f.start.label));
  assert.deepEqual([door.source.kind, door.crossesWalkway, door.crossesDoorway], ['outlet', false, false]);
  assert.deepEqual(plan.warnings.filter((w) => w.code === 'cord-walkway'), []);
  assert.equal(plan.power.counts.cordCovers, 0);
  // A cord that lies right across the walkway front is still flagged: both edges meet the wall and the cord passes both.
  const wall = (o) => fx.project({
    features: [feature('ft_wl', 'walkway', [F(10, 0), F(10, -2)], { label: 'Walk left' }), feature('ft_wr', 'walkway', [F(14, 0), F(14, -2)], { label: 'Walk right' }),
      feature('ft_rail', 'railing', [F(o.to, 0.5), F(o.to + 6, 0.5)], { label: 'Rail' })],
    outlets: [outlet('out_1', F(o.from, 1.5))],
  });
  const lib = fx.libWith({ daisyChain: false });
  const across = fx.plan(wall({ from: 8, to: 16 }), lib);
  assert.equal(fx.feedOf(across.power, 'run_ft_rail').crossesWalkway, true, 'outlet left of the walkway, lights right of it');
  const justIn = fx.plan(wall({ from: 8, to: 11 }), lib);
  assert.equal(fx.feedOf(justIn.power, 'run_ft_rail').crossesWalkway, false, 'the cord ends a foot inside the edge');
  const well = fx.plan(wall({ from: 8, to: 12.5 }), lib);
  assert.equal(fx.feedOf(well.power, 'run_ft_rail').crossesWalkway, true, 'the cord lies across 2.5 ft of the walkway');
  // One edge only (nothing to pair it with): passing where it meets the wall counts, as before.
  const single = fx.project({
    features: [feature('ft_wl', 'walkway', [F(10, 0), F(10, -2)], { label: 'Walk left' }), feature('ft_rail', 'railing', [F(16, 0.5), F(22, 0.5)], { label: 'Rail' })],
    outlets: [outlet('out_1', F(8, 1.5))],
  });
  assert.equal(fx.feedOf(fx.plan(single, lib).power, 'run_ft_rail').crossesWalkway, true);
  // The doorway warning says what the route drawn on the photo does.
  const p = fx.project({
    features: [feature('ft_door', 'door', [F(10, 0), F(10, 6.7), F(13, 6.7), F(13, 0)], { label: 'Front door', params: { ownCord: true } }),
      feature('ft_rail', 'railing', [F(17, 0.5), F(23, 0.5)], { label: 'Rail', params: { ownCord: true } })],
    outlets: [outlet('out_1', F(8, 1.5))],
  });
  const r = fx.plan(p);
  const w = fx.byCode(r.power, 'cord-doorway');
  assert.equal(w.length, 1);
  assert.equal(w[0].message, 'The cord to the left end of Rail runs along the ground in front of Front door. Keep it tight against the doorstep under a cord cover so nobody trips, or use an outlet on the other side of the door.');
  const steps = bom.buildChecklist(p, planner.mergeRunInfo(r.runs, r.power), r.power, r.measured).flatMap((g) => g.steps).join('\n');
  assert.match(steps, /Keep the cord tight against the doorstep where it runs in front of Front door and lay a cord cover over it there\./);
});

// ================================================================ U14: advice that fits how the points were tapped
test('U14: points already tapped zoomed in are not told to "zoom in"; an item tapped zoomed out always says so', () => {
  const measure = LP.require('measure');
  const sc = (f) => measure.scoreConfidence(Object.assign({ mode: 'rect-known', checks: 1 }, f));
  // Nothing recorded (older plans, the sample): the advice is the old one.
  assert.equal(sc({ uncertaintyPct: 9 }).reasons[0], 'Expected error about ±9.0% from how exactly the points could be tapped; zoom in or use a larger rectangle.');
  // Every tap known to be at the 2.5 px floor: only a larger rectangle helps.
  const fine = sc({ uncertaintyPct: 9, tapsFine: true });
  assert.equal(fine.level, sc({ uncertaintyPct: 9 }).level);
  assert.equal(fine.reasons[0], 'Expected error about ±9.0% from how exactly the points could be tapped; use a larger rectangle (the points were already tapped zoomed in, so zooming in further will not help).');
  // The item's own points were tapped zoomed out, but the surface's error is the larger part: the level still
  // follows the expected error, and a second reason says to re-tap the item.
  const own = sc({ uncertaintyPct: 18, uncertaintyBasePct: 16, tapPx: 16.4, tapWhat: 'item', ownTapPx: 16.4 });
  assert.equal(own.level, 'low');
  assert.match(own.reasons[0], /^Expected error about ±18% from how exactly the points could be tapped/);
  assert.ok(own.reasons.includes('Tapped zoomed out (about ±16 px on the photo): zoom in and re-tap the points of this item too.'), own.reasons.join(' | '));
  // When the coarse item is already the reason given, it is said once.
  const main = sc({ uncertaintyPct: 18, uncertaintyBasePct: 4, tapPx: 16.4, tapWhat: 'item', ownTapPx: 16.4 });
  assert.equal(main.reasons.filter((r) => /^Tapped zoomed out/.test(r)).length, 1);
  assert.match(main.reasons[0], /^Tapped zoomed out \(about ±16 px on the photo\): zoom in and re-tap the points of this item\./);
  // A long item that is rated High despite coarse taps gets no nagging.
  assert.ok(!sc({ uncertaintyPct: 1.5, ownTapPx: 16 }).reasons.some((r) => /Tapped zoomed out/.test(r)));
  // End to end on the sample: record every tap as placed zoomed in (2.5 px), then one eave as placed zoomed out.
  const p = sample.createSample().project;
  const lists = [];
  for (const pl of p.planes) {
    if (pl.rect) lists.push([pl.rect, pl.rect.corners]);
    for (const r of pl.refs || []) lists.push([r, r.points]);
    if (pl.derived && pl.derived.line) lists.push([pl.derived, pl.derived.line]);
  }
  for (const f of p.features) lists.push([f, f.points]);
  for (const [holder, pts] of lists) holder.tapErr = pts.map(() => 2.5);
  const all = measure.measureProject(p);
  const texts = JSON.stringify(all);
  assert.ok(!/zoom in or use a larger rectangle/.test(texts), 'no "zoom in" advice when every tap was zoomed in');
  assert.ok(Object.keys(all.planes).every((id) => all.planes[id].tapsRecorded === true));
  const eave = p.features.find((f) => f.id === 'ft_eave');
  eave.tapErr = eave.points.map(() => 16.41);
  const coarse = measure.measureProject(p).features.ft_eave.confidence;
  assert.ok(coarse.reasons.some((r) => /^Tapped zoomed out \(about ±16 px on the photo\): zoom in and re-tap the points of this item/.test(r)), coarse.reasons.join(' | '));
  // The sample as shipped records nothing, so its wording is unchanged.
  assert.ok(Object.values(measure.measureProject(sample.createSample().project).planes).every((s) => s.tapsRecorded === false));
});
