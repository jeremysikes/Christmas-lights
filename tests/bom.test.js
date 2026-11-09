const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = LP.require('catalog');
const bom = LP.require('bom');

// ------------------------------------------------------------------ fixtures (hand-made; shapes per SPEC §5.6 and §5.7)
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const lib = catalog.getLibrary(null);
const DEFAULT_QUOTE = { enabled: false, company: '', laborMethod: 'perFt', ratePerFt: 3.5, ratePerHour: 65, markupPct: 30,
  takedownFee: 150, storageFee: 75, taxPct: 0, validDays: 30, notes: '' };

/** LightRun per SPEC §5.6 (a 2-string C9 roofline unless overridden). */
function run(id, o = {}) {
  return Object.assign({
    id: 'run_' + id, featureId: id, featureType: 'roofline', label: id, planeId: 'pl_front', imageId: 'img_1',
    productId: 'c9-led', productName: 'C9 LED string, 25 bulbs', category: 'c9', tech: 'LED', unit: 'string',
    colorMode: 'warmWhite', colors: ['#ffc46b'], lengthFt: 40, withWasteFt: 44, quantity: 2, bulbs: 50, watts: 19.2, amps: 0.16,
    clips: null, lightStakes: 0, method: 'linear', detail: '', warnings: [],
    start: null, end: null, reversed: false, chainId: null, feedIds: [], outletId: null, circuitId: null,
  }, o);
}
function project(o = {}) {
  return Object.assign({
    schema: 'lightplan/project', version: 1, id: 'prj_t', name: 'Test',
    settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' },
    features: [], outlets: [], circuits: [], library: { products: null, config: null },
    pricing: { overrides: {} }, quote: Object.assign({}, DEFAULT_QUOTE),
  }, o);
}
/** PowerPlan per SPEC §5.7 with nothing in it unless overridden. */
function power(o = {}) {
  return Object.assign({
    chains: [], feeds: [], outlets: [], circuits: [], runInfo: {}, cords: [],
    counts: { timers: 0, splitters: 0, cordCovers: 0, gfciAdapters: 0 }, totals: { watts: 0, amps: 0 }, warnings: [],
  }, o);
}
const lineBy = (b, sku, nameRe) => b.lines.find((l) => l.sku === sku && (!nameRe || nameRe.test(l.name)));

// ================================================================ buildBom
test('light lines are grouped by product and color mode, in run order', () => {
  const runs = [
    run('Front eave', { quantity: 2 }),
    run('Window', { productId: 'mini-led-100', productName: '5 mm mini LED string, 100 bulbs', unit: 'string', quantity: 4 }),
    run('Garage eave', { quantity: 1 }),
    run('Railing', { colorMode: 'multicolor', colors: ['#ff3b30', '#34c759'], quantity: 3 }),
    run('Red', { colorMode: 'custom', colors: ['#ff0000'], quantity: 1 }),
    run('Green', { colorMode: 'custom', colors: ['#00ff00'], quantity: 1 }),
    run('Unmeasured', { quantity: 0 }),
  ];
  const b = bom.buildBom(project(), runs, power(), lib);
  assert.equal(b.ok, true);
  const lights = b.lines.filter((l) => l.category === 'lights');
  assert.deepEqual(lights.map((l) => [l.sku, l.name, l.qty]), [
    ['c9-led', 'C9 LED string, 25 bulbs - Warm white', 3],
    ['mini-led-100', '5 mm mini LED string, 100 bulbs - Warm white', 4],
    ['c9-led', 'C9 LED string, 25 bulbs - Multicolor', 3],
    ['c9-led', 'C9 LED string, 25 bulbs - Custom (#ff0000)', 1],
    ['c9-led', 'C9 LED string, 25 bulbs - Custom (#00ff00)', 1],
  ]);
  const warm = lights[0];
  assert.deepEqual(warm, {
    sku: 'c9-led', category: 'lights', name: 'C9 LED string, 25 bulbs - Warm white', qty: 3, unit: 'string',
    unitPrice: 32.99, defaultPrice: 32.99, overridden: false, lineTotal: 98.97, notes: 'For Front eave (2), Garage eave (1).',
  });
});

test('price overrides are keyed by SKU and only valid prices apply', () => {
  const products = catalog.DEFAULT_PRODUCTS.map((p) => (p.id === 'c9-led' ? Object.assign({}, p, { sku: 'C9-WARM-25' }) : p));
  const l = catalog.getLibrary({ library: { products } });
  const p = project({ pricing: { overrides: { 'C9-WARM-25': 30, 'c9-led': 1, 'mini-led-100': -2, 'clip-allinone': '10.5', 'timer-outdoor': 'cheap' } } });
  const runs = [run('eave', { clips: { type: 'allInOne', count: 50 } }), run('win', { productId: 'mini-led-100', quantity: 1 })];
  const b = bom.buildBom(p, runs, power({ counts: { timers: 1, splitters: 0, cordCovers: 0, gfciAdapters: 0 } }), l);
  const c9 = lineBy(b, 'C9-WARM-25');
  assert.deepEqual([c9.unitPrice, c9.defaultPrice, c9.overridden, c9.lineTotal], [30, 32.99, true, 60]);
  assert.equal(lineBy(b, 'c9-led'), undefined, 'the line uses the product SKU, not its id');
  const mini = lineBy(b, 'mini-led-100');
  assert.deepEqual([mini.unitPrice, mini.overridden], [12.99, false], 'negative prices are ignored');
  assert.deepEqual([lineBy(b, 'clip-allinone').unitPrice, lineBy(b, 'clip-allinone').overridden], [10.5, true]);
  assert.deepEqual([lineBy(b, 'timer-outdoor').unitPrice, lineBy(b, 'timer-outdoor').overridden], [19.99, false]);
});

test('clips are bought in packs of each accessory pack size with the waste % added', () => {
  const runs = [
    run('eave', { clips: { type: 'allInOne', count: 150 } }),
    run('gutter', { clips: { type: 'allInOne', count: 20 } }),
    run('window', { productId: 'mini-led-100', quantity: 1, clips: { type: 'adhesive', count: 46 } }),
    run('railing', { productId: 'mini-led-100', quantity: 1, clips: { type: 'zipTie', count: 30 } }),
    run('bad', { clips: { type: 'staples', count: 99 } }),
  ];
  const b = bom.buildBom(project(), runs, power(), lib);
  const allInOne = lineBy(b, 'clip-allinone');
  assert.deepEqual([allInOne.qty, allInOne.unit, allInOne.unitPrice, allInOne.lineTotal], [2, 'pack', 12.99, 25.98]);
  assert.equal(allInOne.notes, '170 clips + 10% spare = 187, in packs of 100.');
  const adhesive = lineBy(b, 'clip-adhesive');
  assert.equal(adhesive.qty, 2, '46 + 10% = 51 adhesive clips needs two packs of 50');
  assert.equal(adhesive.notes, '46 clips + 10% spare = 51, in packs of 50.');
  assert.equal(lineBy(b, 'zip-ties').notes, '30 zip ties + 10% spare = 33, in packs of 100.');
  assert.deepEqual(b.lines.filter((l) => l.category === 'clips').map((l) => l.sku), ['clip-allinone', 'clip-adhesive', 'zip-ties']);
  const noWaste = bom.buildBom(project({ settings: { wastePct: 0 } }), runs, power(), lib);
  assert.equal(lineBy(noWaste, 'clip-adhesive').qty, 1);
});

test('cords, timers, power stakes, GFCI adapters, light stakes and cord covers come from the power plan', () => {
  const runs = [run('stakes', { featureType: 'stakes', lightStakes: 13 }), run('stakes2', { featureType: 'stakes', lightStakes: 13 })];
  const pw = power({
    feeds: [
      { id: 'f1', outletId: 'out_1', start: { label: 'left end of Front eave' }, cord: { lengthFt: 20, awg: 16, pieces: [25] } },
      { id: 'f2', outletId: 'out_1', start: { label: 'base of Oak tree' }, cord: { lengthFt: 22, awg: 16, pieces: [25] } },
      { id: 'f3', outletId: 'out_2', start: { label: 'top end of Walk' }, cord: { lengthFt: 140, awg: 14, pieces: [100, 50] } },
    ],
    cords: [{ awg: 16, lengthFt: 25, count: 2 }, { awg: 14, lengthFt: 50, count: 1 }, { awg: 14, lengthFt: 100, count: 1 }],
    outlets: [
      { id: 'out_1', label: 'Porch outlet', feedIds: ['f1', 'f2'], timer: true, splitters: 1, needsSplitter: true },
      { id: 'out_2', label: 'Garage outlet', feedIds: ['f3'], timer: true, splitters: 0, needsSplitter: false },
    ],
    counts: { timers: 2, splitters: 1, cordCovers: 1, gfciAdapters: 1 },
  });
  const p = project({ outlets: [{ id: 'out_1', label: 'Porch outlet', type: 'exteriorGfci', gfci: true }, { id: 'out_2', label: 'Garage outlet', type: 'garage', gfci: false }] });
  const b = bom.buildBom(p, runs, pw, lib);
  assert.deepEqual(b.lines.map((l) => [l.category, l.sku, l.qty, l.lineTotal]), [
    ['lights', 'c9-led', 4, 131.96],
    ['cords', 'cord-16-25', 2, 29.98],
    ['cords', 'cord-14-50', 1, 36.99],
    ['cords', 'cord-14-100', 1, 59.99],
    ['power', 'timer-outdoor', 2, 39.98],
    ['power', 'splitter-3', 1, 12.99],
    ['power', 'gfci-adapter', 1, 24.99],
    ['hardware', 'light-stakes', 2, 29.98],
    ['hardware', 'cord-cover', 1, 14.99],
  ]);
  assert.equal(lineBy(b, 'cord-16-25').notes, 'For the cords to the left end of Front eave and the base of Oak tree.');
  assert.equal(lineBy(b, 'cord-14-100').notes, 'For the cord to the top end of Walk.');
  assert.equal(lineBy(b, 'cord-16-25').name, 'Outdoor extension cord, 16 AWG, 25 ft');
  assert.equal(lineBy(b, 'timer-outdoor').notes, 'One for each outlet used: Porch outlet and Garage outlet.');
  assert.equal(lineBy(b, 'gfci-adapter').notes, 'For outlets without GFCI protection: Garage outlet.');
  assert.equal(lineBy(b, 'light-stakes').notes, '26 stakes for stakes and stakes2, in packs of 25.');
  assert.deepEqual(b.byCategory, { lights: 131.96, clips: 0, cords: 126.96, power: 77.96, hardware: 44.97 });
  assert.equal(b.subtotal, 381.85);
});

test('money is rounded to cents on every line and total', () => {
  assert.equal(bom.round2(1.005), 1.01);
  assert.equal(bom.round2(2.675), 2.68);
  assert.equal(bom.round2(0.1 + 0.2), 0.3);
  assert.equal(bom.round2(-1.005), -1.01);
  const p = project({ pricing: { overrides: { 'c9-led': 0.1, 'mini-led-100': 0.333 } } });
  const runs = [run('a', { quantity: 3 }), run('b', { productId: 'mini-led-100', quantity: 3 })];
  const b = bom.buildBom(p, runs, power(), lib);
  assert.equal(lineBy(b, 'c9-led').lineTotal, 0.3);
  assert.equal(lineBy(b, 'mini-led-100').unitPrice, 0.33);
  assert.equal(lineBy(b, 'mini-led-100').lineTotal, 0.99);
  assert.equal(b.subtotal, 1.29);
  assert.equal(b.subtotal, bom.round2(b.lines.reduce((s, l) => s + l.lineTotal, 0)));
});

test('a run whose product left the library still gets a line, priced at 0 with a note', () => {
  const b = bom.buildBom(project(), [run('old', { productId: 'gone', productName: 'Old lights', unit: 'net' })], power(), lib);
  assert.deepEqual(b.lines.map((l) => [l.sku, l.name, l.unit, l.unitPrice, l.lineTotal]), [['gone', 'Old lights - Warm white', 'net', 0, 0]]);
  assert.match(b.lines[0].notes, /No price in the product library\.$/);
});

test('buildBom never throws, never mutates and copes with missing pieces', () => {
  assert.deepEqual(bom.buildBom(null, null, null, null), { ok: true, lines: [], subtotal: 0, byCategory: { lights: 0, clips: 0, cords: 0, power: 0, hardware: 0 } });
  const odd = bom.buildBom(42, [null, 1, 'x', { quantity: 'many' }, run('ok', { clips: { type: 'gutter', count: 'lots' } })], 'power', { products: 'nope' });
  assert.equal(odd.ok, true);
  assert.deepEqual(odd.lines.map((l) => l.sku), ['c9-led']);
  const p = deepFreeze(project({ pricing: { overrides: { 'c9-led': 30 } } }));
  const runs = deepFreeze([run('a', { clips: { type: 'allInOne', count: 40 }, lightStakes: 3 })]);
  const pw = deepFreeze(power({ cords: [{ awg: 16, lengthFt: 25, count: 1 }], counts: { timers: 1, splitters: 0, cordCovers: 1, gfciAdapters: 0 } }));
  const b = bom.buildBom(p, runs, pw, lib);
  assert.equal(b.ok, true);
  assert.equal(b.lines.length, 6);
  const hostile = {};
  Object.defineProperty(hostile, 'quantity', { enumerable: true, get() { throw new Error('boom'); } });
  const failed = bom.buildBom(project(), [hostile], power(), lib);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'The bill of materials could not be worked out from this project data.');
  assert.deepEqual(failed.lines, []);
});

// ================================================================ bomToCsv
/** Tiny RFC 4180 parser for checking the output. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i += 1; continue; }
      field += c; i += 1; continue;
    }
    if (c === '"') { quoted = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    field += c; i += 1;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

test('bomToCsv writes RFC 4180 CSV with a header, the lines, a blank row and a Subtotal row', () => {
  const b = {
    lines: [
      { sku: 'c9-led', category: 'lights', name: 'C9 LED string, 25 bulbs - Warm white', qty: 3, unit: 'string', unitPrice: 32.99, lineTotal: 98.97, notes: 'For "Front" eave\nand garage' },
      { sku: 'x', category: 'power', name: '=HYPERLINK("http://evil")', qty: 1, unit: 'each', unitPrice: 5, lineTotal: 5, notes: '-2 spare' },
    ],
    subtotal: 103.97,
  };
  const csv = bom.bomToCsv(b);
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(csv.split('\r\n')[0], 'SKU,Item,Category,Qty,Unit,Unit Price,Line Total,Notes');
  assert.ok(csv.includes('"C9 LED string, 25 bulbs - Warm white"'));
  assert.ok(csv.includes('"For ""Front"" eave\nand garage"'));
  assert.deepEqual(parseCsv(csv), [
    ['SKU', 'Item', 'Category', 'Qty', 'Unit', 'Unit Price', 'Line Total', 'Notes'],
    ['c9-led', 'C9 LED string, 25 bulbs - Warm white', 'lights', '3', 'string', '32.99', '98.97', 'For "Front" eave\nand garage'],
    ['x', "'=HYPERLINK(\"http://evil\")", 'power', '1', 'each', '5.00', '5.00', "'-2 spare"],
    ['', '', '', '', '', '', '', ''],
    ['Subtotal', '103.97', '', '', '', '', '', ''],
  ]);
  assert.equal(bom.bomToCsv(null), 'SKU,Item,Category,Qty,Unit,Unit Price,Line Total,Notes\r\n,,,,,,,\r\nSubtotal,0.00,,,,,,\r\n');
});

test('bomToCsv: summing the Line Total column gives the subtotal (the subtotal is not in that column)', () => {
  const b = bom.buildBom(project(), [run('eave', { clips: { type: 'allInOne', count: 41 } }), run('garage', { quantity: 3 })], power(), lib);
  const rows = parseCsv(bom.bomToCsv(b));
  const col = rows[0].indexOf('Line Total');
  const sum = rows.slice(1).reduce((s, r) => s + (Number.isFinite(Number(r[col])) && r[col] !== '' ? Number(r[col]) : 0), 0);
  assert.equal(Math.round(sum * 100) / 100, b.subtotal);
  const sub = rows.find((r) => r.includes('Subtotal'));
  assert.ok(sub, 'a Subtotal row is still written');
  assert.ok(sub.includes(b.subtotal.toFixed(2)));
});

test('bomToCsv matches buildBom output', () => {
  const b = bom.buildBom(project(), [run('eave', { clips: { type: 'allInOne', count: 41 } })], power(), lib);
  const rows = parseCsv(bom.bomToCsv(b));
  assert.equal(rows.length, b.lines.length + 3);
  assert.deepEqual(rows[1].slice(0, 7), ['c9-led', 'C9 LED string, 25 bulbs - Warm white', 'lights', '2', 'string', '32.99', '65.98']);
  assert.deepEqual(rows[rows.length - 2], ['', '', '', '', '', '', '', '']);
  assert.deepEqual(rows[rows.length - 1], ['Subtotal', b.subtotal.toFixed(2), '', '', '', '', '', '']);
});

// ================================================================ buildQuote
const quoteRuns = () => [
  run('eave', { lengthFt: 60.4, quantity: 3 }),
  run('window', { featureType: 'window', lengthFt: 20.2, quantity: 1 }),
  run('oak', { featureType: 'tree', lengthFt: 50, quantity: 2, method: 'spiral' }),
  run('bush', { featureType: 'bush', lengthFt: 0, quantity: 3, method: 'bush-rule' }),
  run('gutter', { featureType: 'gutter', lengthFt: 0, quantity: 0 }),
];

test('per-foot quote: marked-up materials, labor, fees and tax on materials', () => {
  const p = project({ quote: Object.assign({}, DEFAULT_QUOTE, { enabled: true, taxPct: 8.25, notes: 'Thanks!', validDays: 14 }) });
  const q = bom.buildQuote(p, { subtotal: 200 }, null, quoteRuns(), lib);
  // 81 ft (60.4 + 20.2 rounded); 1 tree × 0.75 h + 1 bush × 0.25 h = 1 h; hours = 81/40 + 1 setup + 1 = 4.025 → 4.
  assert.deepEqual(q, {
    ok: true, enabled: true, materialsCost: 200, markupPct: 30, materialsPrice: 260, laborMethod: 'perFt', linearFt: 81,
    laborHours: 4, laborCost: 348.5, takedownFee: 150, storageFee: 75, taxPct: 8.25, tax: 21.45, total: 854.95,
    lines: [
      { description: 'Materials', amount: 260 },
      { description: 'Installation labor (81 ft, 4 h)', amount: 348.5 },
      { description: 'Takedown', amount: 150 },
      { description: 'Storage', amount: 75 },
      { description: 'Tax (8.25%)', amount: 21.45 },
      { description: 'Total', amount: 854.95 },
    ],
    validDays: 14, notes: 'Thanks!',
  });
});

test('per-hour quote charges the estimated hours; zero fees and tax are left off the lines', () => {
  const p = project({ quote: Object.assign({}, DEFAULT_QUOTE, { laborMethod: 'perHour', takedownFee: 0, storageFee: 0 }) });
  const q = bom.buildQuote(p, { subtotal: 100.005 }, null, quoteRuns(), lib);
  assert.equal(q.materialsCost, 100.01);
  assert.equal(q.materialsPrice, 130.01);
  assert.equal(q.laborCost, 260);
  assert.equal(q.total, 390.01);
  assert.deepEqual(q.lines.map((l) => l.description), ['Materials', 'Installation labor (81 ft, 4 h)', 'Total']);
  assert.equal(q.enabled, false);
});

test('labor uses the library config, rounds to quarter hours and is zero with nothing to install', () => {
  const l = catalog.getLibrary({ library: { config: { labor: { ftPerHour: 20, setupHours: 0.5 } } } });
  const q = bom.buildQuote(project({ quote: Object.assign({}, DEFAULT_QUOTE, { laborMethod: 'perHour' }) }), { subtotal: 0 }, null, [run('eave', { lengthFt: 33 })], l);
  assert.equal(q.laborHours, 2.25, '33/20 + 0.5 = 2.15 h → 2.25 h');
  const none = bom.buildQuote(project(), { subtotal: 0 }, null, [run('x', { quantity: 0, lengthFt: 10 })], lib);
  assert.deepEqual([none.linearFt, none.laborHours, none.laborCost], [0, 0, 0]);
  assert.equal(none.lines[1].description, 'Installation labor (0 ft, 0 h)');
});

test('quote falls back to measured totals without runs, and to defaults without quote settings', () => {
  const measured = { totals: { totalFt: 100.4, byType: { tree: { count: 1, lengthFt: 30 }, bush: { count: 2, lengthFt: 0 } } } };
  const q = bom.buildQuote({}, { subtotal: 10 }, measured, null, lib);
  assert.equal(q.linearFt, 70);
  assert.equal(q.laborCost, 70 * 3.5 + 1.25 * 65);
  assert.equal(q.enabled, false);
  assert.equal(q.markupPct, 30);
  const empty = bom.buildQuote(null, null, null, null, null);
  assert.equal(empty.ok, true);
  assert.equal(empty.total, 225, 'default takedown and storage fees only');
});

// ================================================================ buildChecklist
function checklistFixture() {
  const runs = [
    run('eave', { label: 'Front eave', quantity: 5, clips: { type: 'allInOne', count: 101 }, start: [0, 100], end: [1000, 100] }),
    run('gutter', { label: 'Side gutter', featureType: 'gutter', quantity: 1, clips: { type: 'gutter', count: 26 }, start: [1500, 100], end: [1020, 100] }),
    run('win', { label: 'Bay window', featureType: 'window', productId: 'mini-led-100', productName: '5 mm mini LED string, 100 bulbs', quantity: 1, clips: { type: 'adhesive', count: 13 }, start: [400, 400], end: [400, 400] }),
    run('oak', { label: 'Oak tree', featureType: 'tree', productId: 'treewrap-led', productName: 'LED tree-wrap string, 150 bulbs (green wire)', quantity: 2, method: 'spiral', start: [600, 900], end: [600, 500] }),
    run('loose', { label: 'Garage eave', quantity: 1, start: [1200, 90], end: [1900, 90] }),
    run('x', { label: 'Back gutter', quantity: 0 }),
    run('y', { label: 'Mystery', productId: null, productName: null, quantity: 0 }),
  ];
  const pw = power({
    chains: [
      { id: 'chain_eave', productId: 'c9-led', runIds: ['run_eave', 'run_gutter'], feedIds: ['feed_eave_1', 'feed_eave_2'] },
      { id: 'chain_win', productId: 'mini-led-100', runIds: ['run_win'], feedIds: ['feed_win_1'] },
      { id: 'chain_oak', productId: 'treewrap-led', runIds: ['run_oak'], feedIds: ['feed_oak_1'] },
    ],
    feeds: [
      { id: 'feed_eave_1', chainId: 'chain_eave', runIds: ['run_eave'], strings: 3, outletId: 'out_1', circuitId: 'cir_1',
        start: { label: 'left end of Front eave' }, cord: { lengthFt: 22.3, awg: 16, pieces: [25], voltageDropPct: 0.1 }, crossesWalkway: false },
      { id: 'feed_eave_2', chainId: 'chain_eave', runIds: ['run_eave', 'run_gutter'], strings: 3, outletId: 'out_1', circuitId: 'cir_1',
        start: { label: 'point 60 ft from the left end of Front eave' }, cord: { lengthFt: 112, awg: 14, pieces: [100, 15], voltageDropPct: 0.5 }, crossesWalkway: true },
      { id: 'feed_win_1', chainId: 'chain_win', runIds: ['run_win'], strings: 1, outletId: 'out_2', circuitId: 'cir_2',
        start: { label: 'top-left corner of Bay window' }, cord: null, cordUnknown: true, crossesWalkway: false },
      { id: 'feed_oak_1', chainId: 'chain_oak', runIds: ['run_oak'], strings: 2, outletId: null, circuitId: null,
        start: { label: 'base of Oak tree' }, cord: null, crossesWalkway: false },
    ],
    outlets: [
      { id: 'out_1', label: 'Porch outlet', circuitId: 'cir_1', feedIds: ['feed_eave_1', 'feed_eave_2'], watts: 60, needsSplitter: true, splitters: 1, timer: true },
      { id: 'out_2', label: 'Garage outlet', circuitId: 'cir_2', feedIds: ['feed_win_1'], watts: 5, needsSplitter: false, splitters: 0, timer: true },
    ],
    circuits: [
      { id: 'cir_1', name: 'Porch circuit', breakerAmps: 15, voltage: 120, limitW: 1440, loadW: 1100, existingLoadW: 100, utilizationPct: 76.4, outletIds: ['out_1'], overloaded: false },
      { id: 'cir_2', name: 'Garage circuit', breakerAmps: 20, voltage: 120, limitW: 1920, loadW: 2000, existingLoadW: 0, utilizationPct: 104, outletIds: ['out_2'], overloaded: true },
      { id: 'cir_3', name: 'Spare circuit', breakerAmps: 15, voltage: 120, limitW: 1440, loadW: 0, existingLoadW: 0, utilizationPct: 0, outletIds: [], overloaded: false },
    ],
  });
  const p = project({
    features: [{ id: 'win', type: 'window', closed: true, points: [[400, 400], [700, 400], [700, 700], [400, 700]] }],
    outlets: [
      { id: 'out_2', label: 'Garage outlet', type: 'exteriorGfci', gfci: true, circuitId: 'cir_2' },
      { id: 'out_1', label: 'Porch outlet', type: 'garage', gfci: false, circuitId: 'cir_1' },
    ],
    circuits: [{ id: 'cir_1', name: 'Porch circuit' }, { id: 'cir_2', name: 'Garage circuit' }],
  });
  return { p, runs, pw };
}

test('checklist groups by outlet in project order, then no-outlet runs, unplanned runs and safety', () => {
  const { p, runs, pw } = checklistFixture();
  const groups = bom.buildChecklist(p, runs, pw, null);
  assert.deepEqual(groups.map((g) => [g.outletId, g.title]), [
    ['out_2', 'Garage outlet (Garage circuit)'],
    ['out_1', 'Porch outlet (Porch circuit)'],
    [null, 'No outlet chosen yet'],
    [null, 'Not in the plan yet'],
    [null, 'Safety and final test'],
  ]);
  for (const g of groups) for (const s of g.steps) {
    assert.equal(typeof s, 'string');
    assert.doesNotMatch(s, /undefined|NaN|null|\[object/, s);
  }
  assert.deepEqual(groups[0].steps, [
    'Plug an outdoor timer or smart plug into Garage outlet and leave it switched off while you work.',
    'Run an outdoor extension cord from Garage outlet to the top-left corner of Bay window. Measure that distance on site, because the photo cannot size this cord.',
    'Stick 13 adhesive clips around Bay window, one every 12 in. Wipe the surface clean and dry first.',
    'Hang 1 × warm white 5 mm mini LED string, 100 bulbs around Bay window, starting at the top-left corner of Bay window. Plug the first string into the cord.',
    'Test: switch the timer on and check that the string on this cord lights. Fix dead bulbs or blown fuses, then switch it off.',
    'Set the timer on Garage outlet to switch the lights on at dusk and off at bedtime.',
  ]);
});

test('checklist steps follow timer → cord → clips → hang from the start end → continue → test', () => {
  const { p, runs, pw } = checklistFixture();
  const steps = bom.buildChecklist(p, runs, pw, null)[1].steps;
  assert.deepEqual(steps, [
    'Plug a portable outdoor GFCI adapter into Porch outlet.',
    'Plug an outdoor timer or smart plug into the GFCI adapter and leave it switched off while you work.',
    'Plug an outdoor power stake (3 outlets each) into the timer so it can feed 2 cords.',
    'Cord 1 of 2: Run a 25 ft, 16 AWG outdoor extension cord from Porch outlet to the left end of Front eave (about 23 ft needed).',
    'Put up 101 all-in-one clips along Front eave, one every 12 in.',
    'Hang the first 3 of the 5 × warm white C9 LED string, 25 bulbs along Front eave, starting at the left end of Front eave. Plug the first string into the cord.',
    'Test: switch the timer on and check that all 3 strings on this cord light. Fix dead bulbs or blown fuses, then switch it off.',
    'Cord 2 of 2: Run 115 ft of 14 AWG outdoor extension cord (100 ft + 15 ft, joined end to end) from Porch outlet to the point 60 ft from the left end of Front eave (about 112 ft needed). Keep the joints off the ground.',
    'Lay a cord cover over the cord where it crosses the walkway.',
    'Hang the last 2 of the 5 × warm white C9 LED string, 25 bulbs along Front eave, starting at the point 60 ft from the left end of Front eave. Plug the first string into the cord.',
    'Put up 26 gutter clips along Side gutter, one every 12 in.',
    'Continue into Side gutter: plug its first string into the last string of Front eave, then hang 1 × warm white C9 LED string, 25 bulbs along Side gutter, starting at the right end of Side gutter.',
    'Test: switch the timer on and check that all 3 strings on this cord light. Fix dead bulbs or blown fuses, then switch it off.',
    'Set the timer on Porch outlet to switch the lights on at dusk and off at bedtime.',
  ]);
});

test('checklist lists runs with no outlet, runs not in the plan, and circuit limits in the safety group', () => {
  const { p, runs, pw } = checklistFixture();
  const groups = bom.buildChecklist(p, runs, pw, null);
  assert.deepEqual(groups[2].steps, [
    'Mark the outlet that will power these lights on the photo, so LightPlan can size the cords and check the circuit.',
    'Cord 1 of 2: Run an outdoor extension cord from the nearest GFCI-protected outdoor outlet to the base of Oak tree.',
    'Wrap 2 × warm white LED tree-wrap string, 150 bulbs (green wire) around Oak tree, starting at the base of Oak tree. Plug the first string into the cord.',
    'Test: plug the cord in and check that all 2 strings on this cord light. Fix dead bulbs or blown fuses, then unplug it.',
    'Cord 2 of 2: Run an outdoor extension cord from the nearest GFCI-protected outdoor outlet to the left end of Garage eave.',
    'Hang 1 × warm white C9 LED string, 25 bulbs along Garage eave, starting at the left end of Garage eave. Plug the first string into the cord.',
    'Test: plug the cord in and check that the string on this cord lights. Fix dead bulbs or blown fuses, then unplug it.',
  ]);
  assert.deepEqual(groups[3].steps, [
    'Back gutter is not in this checklist because it is not measured yet.',
    'Mystery is not in this checklist because no product is available for it.',
  ]);
  const safety = groups[4].steps;
  assert.ok(safety.includes('Porch circuit carries 1,000 W of lights plus 100 W already on it, 76% of its 1,440 W safe limit. Keep heaters and other big loads off it while the lights are on.'));
  assert.ok(safety.includes('Garage circuit is over its safe limit: 2,000 W planned against 1,920 W. Move a run to another circuit before you switch on.'));
  assert.ok(!safety.some((s) => /Spare circuit/.test(s)), 'circuits with no lights are not listed');
  assert.match(safety[safety.length - 1], /not an electrical inspection/);
});

test('buildChecklist never throws and never mutates its inputs', () => {
  const { p, runs, pw } = checklistFixture();
  const frozen = [deepFreeze(p), deepFreeze(runs), deepFreeze(pw)];
  const before = JSON.stringify(frozen);
  const groups = bom.buildChecklist(frozen[0], frozen[1], frozen[2], null);
  assert.equal(JSON.stringify(frozen), before);
  assert.equal(groups.length, 5);
  for (const args of [[], [null, null, null, null], [42, 'runs', [], {}], [{}, [null, { id: 3 }], { feeds: [null, { id: 'f', runIds: 'x' }] }]]) {
    const out = bom.buildChecklist(...args);
    assert.ok(Array.isArray(out));
    assert.equal(out[out.length - 1].title, 'Safety and final test');
  }
});

test('checklist: several power stakes are chained, each into a socket of the one before', () => {
  const feeds = Array.from({ length: 8 }, (_, i) => ({ id: 'f' + i, chainId: 'c' + i, runIds: ['run_w' + i], strings: 1, outletId: 'out_1',
    circuitId: 'cir_1', start: { label: 'top-left corner of Window ' + (i + 1) }, cord: { lengthFt: 10, awg: 16, pieces: [15], voltageDropPct: 0 }, crossesWalkway: false }));
  const runs = feeds.map((f, i) => run('w' + i, { label: 'Window ' + (i + 1), featureType: 'window', productId: 'mini-led-100', quantity: 1 }));
  const pw = power({
    chains: feeds.map((f) => ({ id: f.chainId, runIds: f.runIds, feedIds: [f.id] })), feeds,
    outlets: [{ id: 'out_1', label: 'Porch outlet', circuitId: 'cir_1', feedIds: feeds.map((f) => f.id), watts: 38.4, needsSplitter: true, splitters: 4, timer: true }],
  });
  const p = project({ outlets: [{ id: 'out_1', label: 'Porch outlet', type: 'exteriorGfci', gfci: true, circuitId: 'cir_1' }] });
  const steps = bom.buildChecklist(p, runs, pw, null)[0].steps;
  const stake = steps.find((s) => /power stake/.test(s));
  assert.equal(stake, 'Plug an outdoor power stake (3 outlets) into the timer, then plug each of the other 3 stakes into a free socket of the stake before it. The 4 stakes give 9 sockets for the 8 cords.');
});

test('config clipPackSize and stakes.packSize override the accessory pack sizes when set; unused config keys are gone', () => {
  const runs = [run('eave', { clips: { type: 'allInOne', count: 41 } }), run('win', { clips: { type: 'adhesive', count: 30 } }),
    run('path', { featureType: 'stakes', lightStakes: 30 })];
  const def = bom.buildBom(project(), runs, power(), lib);
  assert.equal(lineBy(def, 'clip-allinone').qty, 1, '46 clips in packs of 100');
  assert.equal(lineBy(def, 'clip-adhesive').qty, 1, '33 clips in packs of 50');
  assert.equal(lineBy(def, 'light-stakes').qty, 2, '30 stakes in packs of 25');
  const cfg = { clipPackSize: 25, stakes: { packSize: 10 } };
  const p = project({ library: { products: null, config: cfg } });
  const custom = bom.buildBom(p, runs, power(), catalog.getLibrary(p));
  assert.equal(lineBy(custom, 'clip-allinone').qty, 2, '46 clips in packs of 25');
  assert.match(lineBy(custom, 'clip-allinone').notes, /in packs of 25\./);
  assert.equal(lineBy(custom, 'clip-adhesive').qty, 2, '33 clips in packs of 25');
  assert.equal(lineBy(custom, 'light-stakes').qty, 3, '30 stakes in packs of 10');
  assert.equal('outletHeightFt' in catalog.DEFAULT_CONFIG.power, false, 'a key nothing reads is not offered for editing');
});
