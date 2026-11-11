// Suppliers, bulk C7/C9 and order sheets (docs/SPEC.md section 8.3).
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const suppliers = LP.require('suppliers');
const catalog = LP.require('catalog');
const design = LP.require('design');
const bom = LP.require('bom');
const schema = LP.require('schema');
const planner = LP.require('plan');
const sample = LP.require('sample');
const fx = require('./power-fixtures');

const clone = (o) => JSON.parse(JSON.stringify(o));
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
/** Library for a supplier and buying settings. */
function libFor(supplierId, buying, extra) {
  return catalog.getLibrary({ library: Object.assign({ products: null, config: buying ? { buying } : null, supplierId }, extra || {}) });
}
/** A LightRun of the CLE bulk C9 product (38 ft unless overridden), shaped like design.planRuns output. */
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
function power(o = {}) {
  return Object.assign({
    chains: [], feeds: [], outlets: [], circuits: [], runInfo: {}, cords: [],
    counts: { timers: 0, splitters: 0, cordCovers: 0, gfciAdapters: 0 }, totals: { watts: 0, amps: 0 }, warnings: [],
  }, o);
}
const lineBy = (b, sku) => b.lines.find((l) => l.sku === sku);
const SUPPLIER_FIELDS = ['supplierId', 'supplierName', 'supplierSku', 'url', 'findUrl', 'priceAsOf', 'priceStatus', 'usedQty', 'total', 'buyTotal'];

// ================================================================ the supplier map
/** Every thing that can be ordered from the map: ready-made products, the parts of bulk products, accessories. */
function allOffers() {
  const out = [];
  const seen = new Set();
  const add = (supplierId, where, offer, kind) => {
    if (seen.has(offer)) return; // the plugs are shared by a supplier's C9 and C7 products
    seen.add(offer);
    out.push({ supplierId, where, offer, kind });
  };
  for (const p of suppliers.SUPPLIER_PRODUCTS) {
    if (p.kind === 'bulk') for (const c of suppliers.componentOffers(p)) add(p.supplierId, p.id + ' ' + c.part + (c.variant ? ' ' + c.variant : ''), c.offer, c.part);
    else add(p.supplierId, p.id, p, 'product');
  }
  for (const sid of Object.keys(suppliers.SUPPLIER_ACCESSORIES)) {
    for (const [key, o] of Object.entries(suppliers.SUPPLIER_ACCESSORIES[sid])) add(sid, sid + ' ' + key, o, 'accessory');
  }
  return out;
}
const LISTED_ONLY = 'Seen on the supplier\'s category list only, not on its own page: check the price and details there.';

test('SUPPLIERS: any store, Christmas Lights Etc and 1000Bulbs, with links only on real suppliers', () => {
  assert.deepEqual(suppliers.SUPPLIERS.map((s) => s.id), ['generic', 'cle', '1000bulbs']);
  const generic = suppliers.getSupplier('generic');
  assert.deepEqual([generic.name, generic.url, generic.wholesale, generic.searchUrlTemplate, generic.categoryUrls], ['Any store', null, null, null, {}]);
  const cle = suppliers.getSupplier('cle'), tb = suppliers.getSupplier('1000bulbs');
  assert.equal(cle.name, 'Christmas Lights Etc');
  assert.equal(tb.name, '1000Bulbs');
  // Wholesale facts as the suppliers' own pages state them (docs/SUPPLIER_CHECK.md, "Supplier facts").
  assert.deepEqual([cle.wholesale.url, cle.wholesale.phone, cle.wholesale.email],
    ['https://www.christmaslightsetc.com/wholesale-Christmas-lights-and-trees.htm', '1-855-WGC-7100', 'sales@wintergreencorp.com']);
  assert.match(cle.wholesale.note, /^Christmas Lights Etc is part of the Wintergreen Corporation family\./);
  assert.match(cle.wholesale.note, /lists no discount levels, minimum order, free-shipping amount or payment terms/);
  assert.deepEqual([tb.wholesale.url, tb.wholesale.phone], [null, '1-800-624-4488'], 'no contractor page was seen, so there is no link');
  assert.match(tb.wholesale.note, /^No wholesale or contractor account page was seen/);
  assert.match(tb.wholesale.note, /ships free with orders of \$600 or more/);
  for (const s of [cle, tb]) {
    assert.equal(s.priceAsOf, '2026-11-11');
    assert.ok(s.wholesale.name && s.wholesale.note && s.notes);
    assert.ok(Object.keys(s.categoryUrls).length >= 10);
    for (const role of Object.keys(s.categoryUrls)) {
      assert.ok(suppliers.ROLES.includes(role), s.id + ' uses the role name ' + role);
      assert.equal(suppliers.safeUrl(s.categoryUrls[role]), s.categoryUrls[role]);
      assert.ok(s.categoryUrls[role].startsWith(s.url), s.id + ' ' + role + ' is on the supplier\'s own site');
    }
  }
  // Christmas Lights Etc: its own search address was tested and works. It has no page for plugs alone: the
  // role points at its electrical accessories page (the old address was really the bare-wire page).
  assert.equal(cle.searchUrlTemplate, 'https://www.christmaslightsetc.com/browse/?q={query}');
  assert.equal(cle.searchUrlWorks, true);
  assert.equal(cle.categoryUrls.plugs, 'https://www.christmaslightsetc.com/christmas-light-adapters-and-electrical-accessories--106.htm');
  assert.equal(cle.categoryUrls.treeWrap, undefined, 'no page of its own for tree wraps');
  // 1000Bulbs: the address its own search box uses, recorded as not confirmed because the test was blocked.
  assert.equal(tb.searchUrlTemplate, 'https://www.1000bulbs.com/fil/search?q={query}');
  assert.equal(tb.searchUrlWorks, null);
  assert.match(tb.searchNote, /could not be checked on Nov 11, 2026 \(the site blocked the test\)/);
  // Nothing links to the parent company's site, which could not be reached and so was not checked.
  assert.ok(!suppliers.allLinks().some((l) => /wintergreencorp/i.test(l.url)));
  assert.equal(suppliers.getSupplier('nobody'), null);
  assert.equal(suppliers.knownSupplierId('cle'), 'cle');
  assert.equal(suppliers.knownSupplierId('nobody'), 'generic');
  assert.equal(suppliers.knownSupplierId(null), 'generic');
});

test('supplierSearchUrl and findUrl: category page first, then the supplier\'s own search, else nothing', () => {
  assert.equal(suppliers.supplierSearchUrl('1000bulbs', 'outdoor 3-way tap & "more"'), 'https://www.1000bulbs.com/fil/search?q=outdoor+3-way+tap+%26+%22more%22');
  assert.equal(suppliers.supplierSearchUrl('1000bulbs', '   '), null);
  assert.equal(suppliers.supplierSearchUrl('cle', ' C9  warm white '), 'https://www.christmaslightsetc.com/browse/?q=C9+warm+white');
  assert.equal(suppliers.supplierSearchUrl('cle', ''), null);
  assert.equal(suppliers.supplierSearchUrl('generic', 'clips'), null);
  assert.equal(suppliers.findUrl('cle', 'clips', 'anything'), suppliers.getSupplier('cle').categoryUrls.clips);
  assert.equal(suppliers.findUrl('cle', 'plugs', 'male plug'), suppliers.getSupplier('cle').categoryUrls.plugs);
  assert.equal(suppliers.findUrl('cle', 'treeWrap', 'tree wrap lights'), 'https://www.christmaslightsetc.com/browse/?q=tree+wrap+lights', 'no page for the role: the search');
  assert.equal(suppliers.findUrl('1000bulbs', 'extensionCords', 'outdoor extension cord 25 ft'), 'https://www.1000bulbs.com/fil/search?q=outdoor+extension+cord+25+ft');
  assert.equal(suppliers.findUrl('1000bulbs', 'toString', 'x y'), 'https://www.1000bulbs.com/fil/search?q=x+y', 'inherited keys are not roles');
  assert.equal(suppliers.findUrl('1000bulbs', 'treeWrap', ''), suppliers.getSupplier('1000bulbs').categoryUrls.treeWrap);
  assert.equal(suppliers.findUrl('cle', null, ''), null, 'no role and nothing to search for');
  assert.equal(suppliers.findUrl('generic', 'clips', 'clips'), null);
  assert.equal(suppliers.findUrl('nobody', 'clips', 'clips'), null);
});

test('safeUrl keeps plain https addresses only', () => {
  assert.equal(suppliers.safeUrl('https://www.1000bulbs.com/product/1/A-B.html'), 'https://www.1000bulbs.com/product/1/A-B.html');
  for (const bad of ['http://www.1000bulbs.com/', 'javascript:alert(1)', 'https://', 'https://a b.com/', 'https://x.com/"onclick="1', 'https://x.com/<script>',
    '//x.com/', 'data:text/html,hi', '', null, 42, 'https://x.com/' + 'a'.repeat(2100)]) {
    assert.equal(suppliers.safeUrl(bad), null, String(bad).slice(0, 40));
  }
});

// ---------------------------------------------------------------- data integrity (what was seen on the suppliers' pages on 2026-11-11)
test('data: every offer has a link, the day it was seen and a price status; a verified offer has its part number', () => {
  const offers = allOffers();
  // Christmas Lights Etc: 22 bulk parts, 6 ready-made products, 5 accessories. 1000Bulbs: 20, 5 and 5.
  assert.equal(offers.length, 63);
  const skus = new Set();
  for (const { supplierId, where, offer: o, kind } of offers) {
    assert.ok(['cle', '1000bulbs'].includes(supplierId), where);
    assert.equal(suppliers.safeUrl(o.url), o.url, where + ': an https link');
    assert.ok(o.url.startsWith(suppliers.getSupplier(supplierId).url), where + ': the link is on the supplier\'s own site');
    assert.equal(o.priceAsOf, '2026-11-11', where);
    assert.ok(suppliers.PRICE_STATUSES.includes(o.priceStatus), where + ': ' + o.priceStatus);
    assert.ok(typeof o.supplierSku === 'string' && /^[A-Za-z0-9-]{4,}$/.test(o.supplierSku), where + ': part number ' + o.supplierSku);
    if (o.priceStatus === 'verified') assert.ok(o.supplierSku, where + ': a verified offer has its part number');
    assert.ok(typeof o.price === 'number' && o.price > 0 && Math.abs(o.price * 100 - Math.round(o.price * 100)) < 1e-6, where + ': a price in dollars and cents');
    assert.ok(typeof o.name === 'string' && o.name.length > 10, where);
    // The price key is the supplier and its part number (a ready-made product keeps its product id).
    if (kind === 'product') assert.equal(o.sku, o.id);
    else {
      assert.equal(o.sku, supplierId + ':' + o.supplierSku, where);
      assert.ok(Number.isInteger(o.packQty) && o.packQty >= 1, where + ': pack size');
      if (o.packQty > 1) assert.ok(new RegExp('(pack|box) of ' + o.packQty + '\\b').test(o.name), where + ': the name says the pack size (' + o.name + ')');
    }
    assert.ok(!skus.has(o.sku), 'two offers share the price key ' + o.sku);
    skus.add(o.sku);
    assert.equal(suppliers.catalogPrice(o.sku), o.price, where);
  }
  // Seen on a category list only (the item's own page was not opened): "check the price", and the line says why.
  const observed = offers.filter((x) => x.offer.priceStatus === 'observed');
  assert.deepEqual(observed.map((x) => x.offer.supplierSku).sort(), ['CMS-10093', 'CMS-10323', 'CMS-C7BLU', 'CMS-C9BLU']);
  for (const { offer: o, where } of observed) assert.ok(o.notes.endsWith(LISTED_ONLY), where);
  for (const { offer: o, where } of offers.filter((x) => x.offer.priceStatus === 'verified')) {
    assert.ok(!/category list only/.test((o.notes || '') + (o.orderNote || '')), where);
  }
  assert.equal(offers.filter((x) => x.offer.priceStatus === 'verified').length, 59);
  assert.equal(offers.filter((x) => x.supplierId === 'cle').length, 33);
  assert.ok(offers.filter((x) => x.supplierId === 'cle').every((x) => x.offer.priceStatus === 'verified'), 'every Christmas Lights Etc item was read on its own page');
});

test('data: no link points at a host outside linkHosts()', () => {
  const hosts = suppliers.linkHosts();
  assert.deepEqual(hosts, ['www.1000bulbs.com', 'www.christmaslightsetc.com']);
  for (const { offer: o, where } of allOffers()) assert.ok(hosts.includes(new URL(o.url).host), where + ': ' + o.url);
  for (const p of suppliers.SUPPLIER_PRODUCTS) assert.ok(hosts.includes(new URL(p.url).host), p.id);
  for (const s of suppliers.SUPPLIERS) {
    for (const u of [s.url, s.wholesale && s.wholesale.url].concat(Object.values(s.categoryUrls))) {
      if (u !== null && u !== undefined) assert.ok(hosts.includes(new URL(u).host), s.id + ': ' + u);
    }
    if (s.searchUrlTemplate) assert.ok(hosts.includes(new URL(s.searchUrlTemplate.replace('{query}', 'x')).host), s.id);
  }
  // Every address anywhere in the data is one of those hosts (notes included).
  const text = JSON.stringify([suppliers.SUPPLIERS, suppliers.SUPPLIER_PRODUCTS, suppliers.SUPPLIER_ACCESSORIES]);
  for (const u of text.match(/https?:\/\/[^\s"\\]+/g)) assert.ok(u.startsWith('https://') && hosts.includes(new URL(u.replace('{query}', 'x')).host), u);
});

test('data: watts and a run limit on every product, taken from its page; the lower figure where a page gives two', () => {
  for (const p of suppliers.SUPPLIER_PRODUCTS) {
    assert.ok(typeof p.wattsPerUnit === 'number' && p.wattsPerUnit > 0, p.id + ': watts');
    assert.ok(Number.isInteger(p.maxEndToEnd) && p.maxEndToEnd > 0, p.id + ': run limit');
    assert.ok(p.bulbsPerUnit > 0 && p.stringLengthFt > 0 && p.bulbSpacingIn > 0, p.id);
    if (p.kind === 'bulk') assert.ok(p.components.bulb.wattsEach > 0, p.id);
    else assert.ok(new RegExp('\\b' + String(p.wattsPerUnit).replace('.', '\\.') + ' W per (set|net)').test(p.notes), p.id + ': the description says the watts (' + p.notes + ')');
  }
  const by = (id) => suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === id);
  const limits = (id) => { const p = by(id); return [p.supplierSku, p.price, p.bulbsPerUnit, p.stringLengthFt, p.wattsPerUnit, p.maxEndToEnd]; };
  // [part number, price, bulbs, lit feet, watts, most sets end to end]
  assert.deepEqual(limits('cle:c9-string-25'), ['77667', 49.99, 25, 25, 20, 10]);
  assert.deepEqual(limits('cle:c9-string-17'), ['84095', 14.99, 25, 16, 2.4, 90]);
  assert.deepEqual(limits('cle:c7-string-25'), ['77653', 39.99, 25, 25, 20, 10]);
  assert.deepEqual(limits('cle:mini-5mm-70'), ['83768', 19.99, 70, 23, 4.8, 45]);
  assert.deepEqual(limits('cle:icicle-70'), ['85686', 21.99, 70, 7, 4.8, 45]);
  assert.deepEqual(limits('cle:net-4x6-100'), ['85472', 34.99, 100, 6, 12, 18]);
  assert.deepEqual(limits('1000bulbs:c9-string-17'), ['CMS-25C9-8GWW', 13.97, 25, 16.5, 2.4, 90]);
  assert.deepEqual(limits('1000bulbs:c7-string-17'), ['CMS-25C7-8GWW', 12.35, 25, 16, 2.4, 90]);
  assert.deepEqual(limits('1000bulbs:mini-5mm-50'), ['CMS-50WA-6GWW', 14.31, 50, 25, 4.8, 45]);
  assert.deepEqual(limits('1000bulbs:icicle-70'), ['SHL-LED70ICEWW', 21.72, 70, 7, 4.8, 45]);
  assert.deepEqual(limits('1000bulbs:net-4x6-100'), ['CMS-100L5MMNETWWG', 33.08, 100, 6, 9.6, 22]);
  // Two figures on one page: the table says 45 sets and the text says 90. The lower one is used, and the description says so.
  assert.match(by('1000bulbs:mini-5mm-50').notes, /two limits for sets joined end to end \(45 in its table, 90 in its text\): LightPlan uses 45\./);
  // The net's page says 25 nets (240 W); the plan stays at 22 (216 W).
  assert.match(by('1000bulbs:net-4x6-100').notes, /The page says up to 25 nets end to end \(240 W\); LightPlan plans at most 22 \(216 W\)/);
  assert.ok(by('1000bulbs:net-4x6-100').maxEndToEnd * 9.6 <= 216);
  // The 25-bulb, 25 ft sets: the page gives no connect limit, so the trade rule for the wire is used (250 bulbs).
  for (const id of ['cle:c9-string-25', 'cle:c7-string-25']) {
    assert.equal(by(id).maxEndToEnd * by(id).bulbsPerUnit, 250);
    assert.match(by(id).notes, /gives no limit for sets joined end to end: LightPlan plans at most 10 sets \(250 ft, 250 bulbs\) on one run/);
  }
  // Every LED set stays within 216 W end to end.
  for (const p of suppliers.SUPPLIER_PRODUCTS.filter((x) => x.kind !== 'bulk')) assert.ok(p.maxEndToEnd * p.wattsPerUnit <= 216 + 1e-9, p.id);
  // Icicle sets: 15 drops 6 in apart across 7 ft, in the order each page lists the drop lengths.
  assert.deepEqual([by('cle:icicle-70').bulbSpacingIn, by('cle:icicle-70').dropLengthsIn], [6, [18, 15, 9]]);
  assert.deepEqual([by('1000bulbs:icicle-70').bulbSpacingIn, by('1000bulbs:icicle-70').dropLengthsIn], [6, [15, 18, 9]]);
});

test('data: quantity prices printed on a page are kept as the page words them, with a short note, and never change a price', () => {
  const tiered = allOffers().filter((x) => x.offer.tiers !== undefined);
  assert.equal(tiered.length, 16, '12 bulb boxes and 4 ready-made sets');
  assert.ok(tiered.every((x) => x.supplierId === 'cle'), '1000Bulbs pages showed no quantity prices');
  for (const { offer: o, where, kind } of tiered) {
    assert.ok(Array.isArray(o.tiers) && o.tiers.length >= 1, where);
    let last = o.price;
    for (const t of o.tiers) {
      assert.deepEqual(Object.keys(t), ['qty', 'each', 'pctOffList'], where);
      assert.match(t.qty, /^\d+( - \d+|\+)( boxes)?$/, where + ': the range as the page prints it');
      assert.ok(t.each > 0 && t.each <= last, where + ': each step is cheaper');
      assert.ok(t.pctOffList > 0 && t.pctOffList < 100, where);
      last = t.each;
    }
    const from = /^(\d+)/.exec(o.tiers[0].qty)[1];
    const note = kind === 'product' ? o.orderNote : o.notes;
    assert.match(note, new RegExp('Quantity price from ' + from + ' (boxes|sets|nets): see the supplier\'s page\\.$'), where);
  }
  const c9 = suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === 'cle:c9-bulk-12').components.bulb.variants;
  const c7 = suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === 'cle:c7-bulk-12').components.bulb.variants;
  assert.deepEqual(c9.warmWhite.tiers, [{ qty: '20 - 40 boxes', each: 28.7, pctOffList: 30 }, { qty: '40+ boxes', each: 26.65, pctOffList: 35 }]);
  assert.deepEqual(c7.red.tiers, [{ qty: '10 - 20 boxes', each: 24.94, pctOffList: 25 }, { qty: '20 - 40 boxes', each: 23.28, pctOffList: 30 }, { qty: '40+ boxes', each: 21.61, pctOffList: 35 }]);
  assert.equal(c9.warmWhite.notes, 'Quantity price from 20 boxes: see the supplier\'s page.');
  assert.equal(c7.red.notes, 'Quantity price from 10 boxes: see the supplier\'s page.');
  assert.notEqual(c9.warmWhite.tiers, c9.red.tiers, 'each offer has its own copy');
  const mini = suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === 'cle:mini-5mm-70');
  assert.deepEqual(mini.tiers, [{ qty: '100 - 192', each: 18.89, pctOffList: 30 }, { qty: '192+', each: 14.84, pctOffList: 45 }]);
  // 45 boxes are still priced at the one-box price: the ranges are data, not a price list the plan applies.
  const b = bom.buildBom(project(), [bulkRun('Long', { quantity: 1125 })], power(), libFor('cle'));
  const boxes = lineBy(b, 'cle:72636');
  assert.deepEqual([boxes.qty, boxes.unitPrice, boxes.lineTotal], [45, 29.99, 1349.55]);
  assert.match(boxes.notes, /Quantity price from 20 boxes: see the supplier's page\.$/);
});

test('every supplier product can be planned and passes project validation; ready-made products were read on their own pages', () => {
  const generic = new Set(catalog.DEFAULT_PRODUCTS.map((p) => p.id));
  const hosts = suppliers.linkHosts();
  const ids = new Set();
  for (const p of suppliers.SUPPLIER_PRODUCTS) {
    assert.ok(['cle', '1000bulbs'].includes(p.supplierId), p.id);
    assert.ok(p.id.startsWith(p.supplierId + ':') && p.id.length > p.supplierId.length + 1, p.id);
    assert.equal(p.sku, p.id);
    assert.ok(!ids.has(p.id), 'duplicate id ' + p.id);
    ids.add(p.id);
    assert.ok(generic.has(p.equiv), p.id + ' fills the role of a generic product');
    assert.equal(p.priceAsOf, '2026-11-11');
    assert.equal(design.productDataProblem(p), null, p.id);
    assert.ok(p.wattsPerUnit > 0 && p.price > 0 && p.maxEndToEnd > 0, p.id + ' has watts, a price and a run limit');
    assert.equal(p.tech, 'LED');
    assert.equal(suppliers.safeUrl(p.url), p.url, p.id);
    assert.ok(hosts.includes(new URL(p.url).host), p.id);
    // A ready-made product is one item with a part number, read on its own page. A cut-to-length product is a
    // kit: no part number of its own, and a per-foot price that is worked out, so it is never "verified".
    if (p.kind === 'bulk') assert.deepEqual([p.supplierSku, p.priceStatus], [null, 'observed'], p.id);
    else assert.ok(typeof p.supplierSku === 'string' && p.supplierSku && p.priceStatus === 'verified', p.id);
    assert.ok(p.colors.every((c) => schema.ENUMS.colorMode.includes(c)));
  }
  assert.deepEqual(suppliers.SUPPLIER_PRODUCTS.map((p) => p.id), [
    'cle:c9-bulk-12', 'cle:c7-bulk-12', 'cle:c9-string-25', 'cle:c9-string-17', 'cle:c7-string-25', 'cle:mini-5mm-70', 'cle:icicle-70', 'cle:net-4x6-100',
    '1000bulbs:c9-bulk-12', '1000bulbs:c7-bulk-12', '1000bulbs:c9-string-17', '1000bulbs:c7-string-17', '1000bulbs:mini-5mm-50', '1000bulbs:icicle-70', '1000bulbs:net-4x6-100',
  ]);
  // The whole library (defaults + supplier products) is a valid custom product list.
  const prj = schema.createProject({ id: 'prj_x' });
  prj.library.products = catalog.getLibrary(null).products;
  assert.deepEqual(schema.validateProject(prj).errors, []);
  assert.deepEqual(schema.normalizeProject(prj).library.products, prj.library.products, 'supplier fields survive normalization as they are');
});

test('bulk C7/C9 products are per-foot products with derived limits and priced components', () => {
  const bulk = suppliers.SUPPLIER_PRODUCTS.filter((p) => p.kind === 'bulk');
  assert.deepEqual(bulk.map((p) => p.id), ['cle:c9-bulk-12', 'cle:c7-bulk-12', '1000bulbs:c9-bulk-12', '1000bulbs:c7-bulk-12']);
  for (const p of bulk) {
    const c = p.components;
    assert.deepEqual([p.unit, p.stringLengthFt, p.leadFt, p.endConnector, p.clipEligible, p.supplierSku], ['foot', 1, 0, true, true, null], p.id);
    assert.equal(p.bulbsPerUnit, 12 / p.bulbSpacingIn);
    assert.ok(Math.abs(p.wattsPerUnit - c.bulb.wattsEach * p.bulbsPerUnit) < 1e-9);
    // The trade rule, whatever larger rating a page prints for the wire: 250 ft or 250 bulbs on one run.
    assert.equal(p.maxEndToEnd, 250, '250 bulbs or 250 ft of line, whichever comes first');
    assert.equal(p.maxRunFt, 250);
    assert.equal(p.maxBulbsPerRun, 250);
    assert.ok(Math.abs(p.maxConnectedW - 250 * c.bulb.wattsEach) < 1e-9, p.id + ': one run carries at most 250 bulbs');
    const amps = [c.wire].concat(c.wire.sizes).map((w) => w.maxAmps).filter((a) => a !== undefined);
    for (const a of amps) assert.ok(p.maxConnectedW <= a * 120 * 0.8, p.id + ': and never more than any amp rating printed for the wire');
    assert.equal(p.equiv, p.category === 'c9' ? 'c9-led' : 'c7-led');
    assert.equal(c.bulb.base, p.category === 'c9' ? 'E17' : 'E12');
    assert.deepEqual([c.wire.spoolFt, c.wire.wireType, c.wire.wireGauge, c.bulb.packQty, c.bulb.defaultVariant], [1000, 'SPT-1', 18, 25, 'warmWhite']);
    assert.deepEqual(Object.keys(c.bulb.variants), ['warmWhite', 'coolWhite', 'multi', 'red', 'green', 'blue']);
    const perFoot = c.wire.price / 1000 + c.bulb.variants.warmWhite.price / 25;
    assert.equal(p.price, Math.round(perFoot * 100) / 100, p.id + ': per-foot price is derived from the parts');
    assert.equal(p.url, c.wire.url);
    for (const { part, offer } of suppliers.componentOffers(p)) {
      assert.ok(typeof offer.sku === 'string' && offer.sku === p.supplierId + ':' + offer.supplierSku, p.id + ' ' + part);
      assert.ok(offer.price > 0 && offer.packQty > 0 && offer.name);
      assert.ok(['verified', 'observed'].includes(offer.priceStatus) && offer.priceAsOf === '2026-11-11');
      assert.equal(suppliers.safeUrl(offer.url), offer.url);
      assert.equal(suppliers.catalogPrice(offer.sku), offer.price);
    }
    // Slide-on plugs match the wire, 10 to a pack.
    for (const plug of [c.plugMale, c.plugFemale]) assert.deepEqual([plug.wireType, plug.packQty, plug.priceStatus], [c.wire.wireType, 10, 'verified'], p.id);
    assert.match(c.plugMale.name, /^Slide-on male plug for SPT-1 wire/);
    assert.match(c.plugFemale.name, /^Slide-on female plug for SPT-1 wire/);
  }
  const [cle9, cle7, tb9, tb7] = bulk;
  assert.deepEqual([cle9.wattsPerUnit, cle7.wattsPerUnit, tb9.wattsPerUnit, tb7.wattsPerUnit], [0.8, 0.8, 0.74, 0.48], 'watts per bulb as each supplier lists them');
  assert.deepEqual([cle9.maxConnectedW, cle7.maxConnectedW, tb9.maxConnectedW, tb7.maxConnectedW], [200, 200, 185, 120]);
  assert.deepEqual([cle9.price, cle7.price, tb9.price, tb7.price], [1.61, 1.37, 1.41, 1.23]);
  const wire = (p) => [[1000, p.components.wire.supplierSku, p.components.wire.price]].concat(p.components.wire.sizes.map((s) => [s.lengthFt, s.supplierSku, s.price]));
  assert.deepEqual(wire(cle9), [[1000, '15085', 409.99], [500, '81832', 219.99], [100, '15098', 49.99], [25, '15100', 15.99]]);
  assert.deepEqual(wire(cle7), [[1000, '15054', 369.99], [500, '72912', 199.99], [100, '15067', 44.99], [25, '15071', 11.99]]);
  assert.deepEqual(wire(tb9), [[1000, 'CMS-10105', 391.13], [500, 'CMS-10110', 224.4], [100, 'CMS-10124', 39.43]]);
  assert.deepEqual(wire(tb7), [[1000, 'CMS-10095', 481.47], [500, 'CMS-10093', 229.77], [100, 'CMS-10323', 57.64]]);
  const bulbs = (p) => Object.values(p.components.bulb.variants).map((o) => [o.supplierSku, o.price]);
  assert.deepEqual(bulbs(cle9), [['72636', 29.99], ['72639', 29.99], ['72642', 29.99], ['72645', 29.99], ['72654', 29.99], ['72648', 29.99]]);
  assert.deepEqual(bulbs(cle7), [['72609', 24.99], ['72606', 24.99], ['72612', 24.99], ['72615', 24.99], ['72624', 24.99], ['72618', 24.99]]);
  assert.deepEqual(bulbs(tb9), [['CMS-10294', 25.42], ['CMS-10293', 26.15], ['CMS-10298', 25.52], ['CMS-10288', 25.03], ['CMS-10291', 26.07], ['CMS-C9BLU', 22.33]]);
  assert.deepEqual(bulbs(tb7), [['CMS-10285', 18.62], ['CMS-10281', 19.31], ['CMS-10286', 19.03], ['CMS-10276', 19.69], ['CMS-10279', 19.72], ['CMS-C7BLU', 17.29]]);
  const plugs = (p) => [p.components.plugMale, p.components.plugFemale].map((o) => [o.supplierSku, o.price]);
  assert.deepEqual(plugs(cle9), [['88283', 12.4], ['88287', 12.4]]);
  assert.deepEqual(plugs(tb9), [['PLUG-10001', 6.73], ['PLUG-10002', 6.73]]);
  assert.equal(cle7.components.plugMale, cle9.components.plugMale, 'C9 and C7 wire take the same SPT-1 plugs');
  assert.equal(tb7.components.plugFemale, tb9.components.plugFemale);
  // Lowest amp figure each page prints (table against text): 7 A on the spools, 5 A on the 25 ft C9 length.
  assert.deepEqual([cle9.components.wire].concat(cle9.components.wire.sizes).map((w) => w.maxAmps), [7, 7, 7, 5]);
  assert.deepEqual([cle7.components.wire].concat(cle7.components.wire.sizes).map((w) => w.maxAmps), [7, 7, 7, 8]);
  // 1000Bulbs spool pages print no amp rating: none is made up. Its 100 ft C9 length says 5 A.
  assert.deepEqual([tb9.components.wire].concat(tb9.components.wire.sizes).map((w) => w.maxAmps), [undefined, undefined, 5]);
  assert.ok([tb7.components.wire].concat(tb7.components.wire.sizes).every((w) => !('maxAmps' in w)));
});

test('data: every other length of socket wire is the same wire as the spool, and its name says whether plugs come with it', () => {
  for (const p of suppliers.SUPPLIER_PRODUCTS.filter((x) => x.kind === 'bulk')) {
    const spool = p.components.wire;
    assert.match(spool.name, new RegExp('^' + p.category.toUpperCase() + ' socket wire, 1,000 ft spool, a socket every 12 in, green SPT-1.* \\(no plugs\\)$'), p.id);
    assert.equal(spool.plugsIncluded, false);
    assert.ok(spool.sizes.length >= 2, p.id);
    let last = spool.spoolFt;
    for (const s of spool.sizes) {
      assert.deepEqual([s.wireType, s.wireGauge], [spool.wireType, spool.wireGauge], p.id + ' ' + s.supplierSku + ': the spool\'s wire type and gauge');
      assert.ok(s.lengthFt > 0 && s.lengthFt < last, p.id + ': shorter lengths, longest first');
      last = s.lengthFt;
      assert.ok(s.name.startsWith(p.category.toUpperCase() + ' socket wire, ') && /a socket every 12 in, green SPT-1/.test(s.name), s.name);
      assert.ok(s.name.includes(s.lengthFt + ' ft '), s.name);
      const says = { false: /\(no plugs\)$/, both: /\(plugs on both ends\)$/, male: /\(male plug only\)$/ }[String(s.plugsIncluded)];
      assert.ok(says && says.test(s.name), p.id + ' ' + s.supplierSku + ': ' + s.name);
      assert.equal(/spool/.test(s.name), s.plugsIncluded === false, 'spools come bare, ready-made lengths with a plug');
      if (s.plugsIncluded !== false) assert.match(s.notes, /^It comes with a (plug on each end|male plug only), so a length you use uncut needs no slide-on (plugs|male plug)\./);
    }
  }
  // A 20-gauge stringer is never a size of 18-gauge wire: the 1000Bulbs 25 ft lengths are 20 gauge, so its wire has no 25 ft size.
  const sizes = (id) => suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === id).components.wire.sizes.map((s) => s.lengthFt);
  assert.deepEqual(sizes('cle:c9-bulk-12'), [500, 100, 25]);
  assert.deepEqual(sizes('cle:c7-bulk-12'), [500, 100, 25]);
  assert.deepEqual(sizes('1000bulbs:c9-bulk-12'), [500, 100]);
  assert.deepEqual(sizes('1000bulbs:c7-bulk-12'), [500, 100]);
});

test('what could not be ordered or planned on the day of the check is left out, and the replacements are in', () => {
  const text = JSON.stringify([suppliers.SUPPLIER_PRODUCTS, suppliers.SUPPLIER_ACCESSORIES]);
  const offered = (n) => text.includes('"' + n + '"') || text.includes(':' + n + '"');
  // Not for sale that day; a bulb pack that was "temporarily unavailable"; 20-gauge 25 ft lengths; 2 ft wide trunk-wrap
  // nets (not a string the planner can wrap); an incandescent wrap; items with no watts on their page; wrong old numbers.
  for (const out of ['67083', '67081', '86287', 'CMS-WIRE1000GR2', 'CMS-10284', 'CMS-10126', 'CMS-10119', '72526', 'HLS-TRUNK8CLRG', 'TRUNK8CLRG',
    '85135', '80349', '87773', '20349', '20275']) {
    assert.ok(!offered(out), out + ' is not offered');
  }
  // The replacements the suppliers' pages show.
  for (const inn of ['88283', '88287', '88780', 'PLUG-10002']) assert.ok(offered(inn), inn + ' is offered');
  assert.equal(suppliers.accessoryOffer('cle', 'clip-ridge').supplierSku, '88780');
  // Part numbers the first pass held back are the real Item Numbers.
  const c7 = suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === 'cle:c7-bulk-12').components.bulb.variants;
  assert.deepEqual([c7.warmWhite.supplierSku, c7.coolWhite.supplierSku, c7.red.supplierSku], ['72609', '72606', '72615']);
  assert.deepEqual([c7.warmWhite.sku, c7.warmWhite.priceStatus], ['cle:72609', 'verified']);
  assert.match(c7.warmWhite.url, /C7--Warm-White-OptiCore/);
  assert.equal(suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === 'cle:mini-5mm-70').supplierSku, '83768');
  // The 1000Bulbs plain warm white C7 pack could not be ordered: the warm white deluxe pack stands in, and says so.
  const tb7 = suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === '1000bulbs:c7-bulk-12').components.bulb.variants;
  assert.deepEqual([tb7.warmWhite.supplierSku, tb7.warmWhite.priceStatus], ['CMS-10285', 'verified']);
  assert.equal(tb7.warmWhite.notes, 'The plain warm white pack (CMS-10284) could not be ordered when checked, so the warm white deluxe pack stands in.');
  // Its blue bulbs are another bulb line, seen on a category list only: the line says both, and the watts as listed.
  assert.deepEqual([tb7.blue.wattsEach, tb7.blue.priceStatus], [0.54, 'observed']);
  assert.match(tb7.blue.notes, /^A different bulb line from the other colours \(standard, not VividCore Premium\): 0\.54 W per bulb as listed, a little more than the 0\.48 W the plan counts\. Seen on the supplier's category list only/);
  // No supplier product is a tree wrap: the generic tree-wrap string stays.
  assert.ok(suppliers.SUPPLIER_PRODUCTS.every((p) => p.category !== 'treewrap' && !/trunk|tree/i.test(p.name)));
});

test('SUPPLIER_ACCESSORIES map onto the generic accessory skus', () => {
  const known = new Set(catalog.ACCESSORIES.map((a) => a.sku));
  assert.deepEqual(Object.keys(suppliers.SUPPLIER_ACCESSORIES), ['cle', '1000bulbs']);
  assert.deepEqual(Object.keys(suppliers.SUPPLIER_ACCESSORIES.cle), ['clip-allinone', 'clip-shingle', 'clip-ridge', 'light-stakes', 'timer-outdoor']);
  assert.deepEqual(Object.keys(suppliers.SUPPLIER_ACCESSORIES['1000bulbs']), ['clip-allinone', 'clip-shingle', 'clip-ridge', 'light-stakes', 'timer-outdoor']);
  for (const sid of Object.keys(suppliers.SUPPLIER_ACCESSORIES)) {
    for (const [key, o] of Object.entries(suppliers.SUPPLIER_ACCESSORIES[sid])) {
      assert.ok(known.has(key), key);
      assert.equal(o.sku, sid + ':' + o.supplierSku);
      assert.ok(o.price > 0 && o.packQty >= 1 && o.name);
      assert.deepEqual([o.priceStatus, o.priceAsOf], ['verified', '2026-11-11']);
      assert.deepEqual(suppliers.accessoryOffer(sid, key), o);
    }
  }
  const row = (sid) => Object.values(suppliers.SUPPLIER_ACCESSORIES[sid]).map((o) => [o.supplierSku, o.price, o.packQty]);
  assert.deepEqual(row('cle'), [['82761', 13.99, 100], ['83965', 24.99, 100], ['88780', 26.25, 25], ['84144', 9.99, 25], ['80056', 34.99, 1]]);
  assert.deepEqual(row('1000bulbs'), [['CLIP-10007', 6.83, 50], ['CLIP-10005', 15.49, 50], ['CLIP-10003', 17.59, 25], ['STAKE-10001', 7.31, 25], ['PLTS-12336', 15.73, 1]]);
  // The 1000Bulbs ridge clip page says 25 in one place and 50 in another: the smaller pack is counted, and the line says so.
  assert.match(suppliers.accessoryOffer('1000bulbs', 'clip-ridge').notes, /^The page says 25 to a pack in its title and price, and 50 in its table: LightPlan counts 25\./);
  assert.deepEqual([suppliers.accessoryOffer('1000bulbs', 'timer-outdoor').maxWatts, suppliers.accessoryOffer('cle', 'timer-outdoor').maxAmps], [1000, 15]);
  assert.equal(suppliers.accessoryOffer('cle', 'tap-3way'), null);
  assert.equal(suppliers.accessoryOffer('generic', 'clip-allinone'), null);
  assert.equal(suppliers.accessoryOffer('cle', 'constructor'), null);
  assert.equal(catalog.accessoryRole('clip-gutter'), 'clips');
  assert.equal(catalog.accessoryRole('cord-16-25'), 'extensionCords');
  assert.equal(catalog.accessoryRole('tap-3way'), null);
});

test('allLinks lists every link once with its kind, and linkHosts are the hosts they use', () => {
  const links = suppliers.allLinks();
  const hosts = suppliers.linkHosts();
  assert.deepEqual(hosts, ['www.1000bulbs.com', 'www.christmaslightsetc.com']);
  const kinds = new Set();
  const seen = new Set();
  for (const l of links) {
    assert.deepEqual(Object.keys(l), ['supplierId', 'kind', 'sku', 'name', 'url']);
    assert.ok(['cle', '1000bulbs'].includes(l.supplierId));
    assert.ok(['product', 'category', 'search', 'site', 'wholesale'].includes(l.kind), l.kind);
    assert.equal(suppliers.safeUrl(l.url), l.url, l.url);
    assert.ok(hosts.includes(new URL(l.url).host), l.url);
    assert.ok(!/<\/script/i.test(l.url) && !/[<>"'\s]/.test(l.url), l.url);
    assert.ok(l.name);
    const key = l.kind + '|' + l.url + '|' + l.sku;
    assert.ok(!seen.has(key), 'listed twice: ' + key);
    seen.add(key);
    kinds.add(l.supplierId + ':' + l.kind);
  }
  // 1000Bulbs has no wholesale page on file, so no wholesale link.
  assert.deepEqual(Array.from(kinds).sort(), ['1000bulbs:category', '1000bulbs:product', '1000bulbs:search', '1000bulbs:site',
    'cle:category', 'cle:product', 'cle:search', 'cle:site', 'cle:wholesale']);
  assert.equal(links.find((l) => l.kind === 'search' && l.supplierId === 'cle').url, 'https://www.christmaslightsetc.com/browse/?q=c9+led+bulbs');
  // Every product, component and accessory link is in the list.
  const urls = new Set(links.map((l) => l.url));
  for (const p of suppliers.SUPPLIER_PRODUCTS) {
    if (p.kind !== 'bulk') assert.ok(urls.has(p.url), p.id);
    for (const c of suppliers.componentOffers(p)) assert.ok(urls.has(c.offer.url), c.offer.sku);
  }
  for (const m of Object.values(suppliers.SUPPLIER_ACCESSORIES)) for (const o of Object.values(m)) assert.ok(urls.has(o.url), o.sku);
  assert.equal(links.filter((l) => l.kind === 'product').length, 63, 'one link per thing that can be ordered');
  assert.equal(suppliers.formatDate('2026-11-11'), 'Nov 11, 2026');
  assert.equal(suppliers.formatDate('soon'), 'soon');
});

// ================================================================ library
test('getLibrary: any store by default, supplier products appended, a saved copy wins, bad settings fall back', () => {
  const lib = catalog.getLibrary(null);
  assert.deepEqual(Object.keys(lib), ['products', 'config', 'accessories', 'supplierId', 'suppliers']);
  assert.equal(lib.supplierId, 'generic');
  assert.deepEqual(lib.suppliers.map((s) => s.id), ['generic', 'cle', '1000bulbs']);
  assert.deepEqual(lib.config.buying, { style: 'bulk', costBasis: 'bought' });
  assert.deepEqual(lib.products.map((p) => p.id), catalog.DEFAULT_PRODUCTS.map((p) => p.id).concat(suppliers.SUPPLIER_PRODUCTS.map((p) => p.id)));
  lib.products[lib.products.length - 1].price = 1;
  lib.suppliers[1].name = 'changed';
  assert.notEqual(catalog.getLibrary(null).products.slice(-1)[0].price, 1, 'the library is a copy');
  assert.equal(suppliers.getSupplier('cle').name, 'Christmas Lights Etc');

  assert.equal(libFor('cle').supplierId, 'cle');
  assert.equal(libFor('1000bulbs').supplierId, '1000bulbs');
  for (const bad of ['nobody', '', null, 7, undefined]) assert.equal(libFor(bad).supplierId, 'generic');

  // A project list that already holds an (edited) supplier product keeps its copy; the rest are added after it.
  const mine = clone(suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === 'cle:c9-string-25'));
  mine.price = 39.5;
  const own = catalog.getLibrary({ library: { products: [catalog.DEFAULT_PRODUCTS[0], mine], config: null } });
  assert.deepEqual(own.products.slice(0, 2).map((p) => [p.id, p.price]), [['c9-led', 32.99], ['cle:c9-string-25', 39.5]]);
  assert.equal(own.products.filter((p) => p.id === 'cle:c9-string-25').length, 1);
  assert.equal(own.products.length, 2 + suppliers.SUPPLIER_PRODUCTS.length - 1);

  assert.deepEqual(libFor('cle', { style: 'strings', costBasis: 'used' }).config.buying, { style: 'strings', costBasis: 'used' });
  assert.deepEqual(libFor('cle', { style: 'crates', costBasis: 7 }).config.buying, { style: 'bulk', costBasis: 'bought' });
  assert.deepEqual(catalog.getLibrary({ library: { config: { buying: 'yes' } } }).config.buying, { style: 'bulk', costBasis: 'bought' });
});

// ================================================================ automatic product choice
function featureOf(type, o = {}) { return Object.assign({ id: 'ft_1', type, label: 'It', productId: null, params: {} }, o); }
const pick = (type, lib, o) => { const r = design.resolveProduct(featureOf(type, o), lib); return [r.product && r.product.id, r.source]; };

test('automatic choice: the chosen supplier\'s product replaces the generic default, by buying style', () => {
  assert.deepEqual(pick('roofline', libFor('generic')), ['c9-led', 'typeDefault']);
  assert.deepEqual(pick('roofline', libFor('cle')), ['cle:c9-bulk-12', 'supplier']);
  assert.deepEqual(pick('roofline', libFor('cle', { style: 'bulk' })), ['cle:c9-bulk-12', 'supplier']);
  assert.deepEqual(pick('roofline', libFor('cle', { style: 'strings' })), ['cle:c9-string-25', 'supplier']);
  assert.deepEqual(pick('roofline', libFor('1000bulbs')), ['1000bulbs:c9-bulk-12', 'supplier']);
  assert.deepEqual(pick('roofline', libFor('1000bulbs', { style: 'strings' })), ['1000bulbs:c9-string-17', 'supplier']);
  assert.deepEqual(pick('window', libFor('cle')), ['cle:mini-5mm-70', 'supplier']);
  assert.deepEqual(pick('bush', libFor('1000bulbs', { style: 'strings' })), ['1000bulbs:mini-5mm-50', 'supplier']);
  // Icicle lights or nets as the default for a type: the supplier's own set does that job too.
  const withDefaults = (sid, typeDefaults) => catalog.getLibrary({ library: { products: null, supplierId: sid, config: { typeDefaults } } });
  assert.deepEqual(pick('gutter', withDefaults('cle', { gutter: 'icicle-led-300' })), ['cle:icicle-70', 'supplier']);
  assert.deepEqual(pick('gutter', withDefaults('1000bulbs', { gutter: 'icicle-led-300' })), ['1000bulbs:icicle-70', 'supplier']);
  assert.deepEqual(pick('bush', withDefaults('cle', { bush: 'net-led-4x6' })), ['cle:net-4x6-100', 'supplier']);
  assert.deepEqual(pick('bush', withDefaults('1000bulbs', { bush: 'net-led-4x6' })), ['1000bulbs:net-4x6-100', 'supplier']);
  // No product of the supplier fills the role: the generic product stays.
  assert.deepEqual(pick('tree', libFor('cle')), ['treewrap-led', 'typeDefault']);
  assert.deepEqual(pick('walkway', libFor('1000bulbs')), ['path-stakes', 'typeDefault']);
  assert.deepEqual(design.resolveProduct(featureOf('roofline'), libFor('cle')).warnings, []);
});

test('automatic choice: a product picked on the run always wins and may be another supplier\'s', () => {
  assert.deepEqual(pick('roofline', libFor('cle'), { productId: '1000bulbs:c9-string-17' }), ['1000bulbs:c9-string-17', 'feature']);
  assert.deepEqual(pick('roofline', libFor('cle'), { productId: 'c9-led' }), ['c9-led', 'feature']);
  assert.deepEqual(pick('roofline', libFor('generic'), { productId: 'cle:c9-bulk-12' }), ['cle:c9-bulk-12', 'feature']);
  assert.deepEqual(pick('roofline', libFor('cle', { style: 'strings' }), { productId: 'cle:c9-bulk-12' }), ['cle:c9-bulk-12', 'feature']);
});

test('automatic choice: ready-made buyers never get cut-to-length wire, bulk buyers fall back to ready-made', () => {
  // C7 as the roofline default: 1000Bulbs sells it both ways.
  const c7 = { typeDefaults: { roofline: 'c7-led' } };
  const tbStrings = catalog.getLibrary({ library: { products: null, supplierId: '1000bulbs', config: Object.assign({ buying: { style: 'strings' } }, c7) } });
  assert.deepEqual(pick('roofline', tbStrings), ['1000bulbs:c7-string-17', 'supplier']);
  const tbBulk = catalog.getLibrary({ library: { products: null, supplierId: '1000bulbs', config: c7 } });
  assert.deepEqual(pick('roofline', tbBulk), ['1000bulbs:c7-bulk-12', 'supplier']);
  // Its ready-made C7 string turned off: a ready-made buyer keeps the generic string, never the cut-to-length wire.
  const noString = Object.assign({}, tbStrings, { products: tbStrings.products.map((p) => (p.id === '1000bulbs:c7-string-17' ? Object.assign({}, p, { enabled: false }) : p)) });
  assert.deepEqual(pick('roofline', noString), ['c7-led', 'typeDefault']);
  // The bulk product turned off: the supplier's ready-made string does the job.
  const products = catalog.getLibrary(null).products.map((p) => (p.id === 'cle:c9-bulk-12' ? Object.assign({}, p, { enabled: false }) : p));
  const noBulk = catalog.getLibrary({ library: { products, config: null, supplierId: 'cle' } });
  assert.deepEqual(pick('roofline', noBulk), ['cle:c9-string-25', 'supplier']);
  // Christmas Lights Etc lists two ready-made C9 strings: the automatic choice is the first, the 25 ft set
  // (the same 25 bulbs on 25 ft as the generic string). The sealed 17 ft set is there to be picked by hand.
  assert.deepEqual(pick('roofline', libFor('cle', { style: 'strings' })), ['cle:c9-string-25', 'supplier']);
  assert.deepEqual(pick('roofline', libFor('cle', { style: 'strings' }), { productId: 'cle:c9-string-17' }), ['cle:c9-string-17', 'feature']);
  // A type default that already is a supplier product is used as it is.
  const direct = catalog.getLibrary({ library: { products: null, supplierId: 'cle', config: { typeDefaults: { roofline: '1000bulbs:c9-string-17' } } } });
  assert.deepEqual(pick('roofline', direct), ['1000bulbs:c9-string-17', 'typeDefault']);
});

test('automatic choice: another supplier\'s catalog never leaks into a plan', () => {
  const off = (lib, id) => Object.assign({}, lib, { products: lib.products.map((p) => (p.id === id ? Object.assign({}, p, { enabled: false }) : p)) });
  // Any store, C9 LED turned off: the stand-in is the generic C7 LED, not a supplier's C9.
  const generic = off(libFor('generic'), 'c9-led');
  const r = design.resolveProduct(featureOf('roofline'), generic);
  assert.deepEqual([r.product.id, r.source], ['c7-led', 'suitable']);
  assert.match(r.warnings[0], /C9 LED string, 25 bulbs is turned off in the product library, so C7 LED string, 25 bulbs is used for eaves instead\./);
  assert.ok(design.suitableProducts('roofline', libFor('generic')).every((p) => !p.supplierId));
  assert.ok(design.suitableProducts('roofline', libFor('cle')).every((p) => !p.supplierId || p.supplierId === 'cle'));
  assert.ok(design.suitableProducts('roofline', libFor('cle')).some((p) => p.id === 'cle:c9-bulk-12'));
  const all = design.suitableProducts('roofline', libFor('generic'), { allSuppliers: true }).map((p) => p.id);
  assert.ok(all.includes('cle:c9-bulk-12') && all.includes('1000bulbs:c9-string-17') && all.includes('c9-led'));
  // Buying from 1000Bulbs with its C9 products and the generic C9 LED all off: generic C7 LED, swapped for the supplier's C7.
  let tb = libFor('1000bulbs');
  for (const id of ['c9-led', '1000bulbs:c9-bulk-12', '1000bulbs:c9-string-17']) tb = off(tb, id);
  assert.deepEqual(pick('roofline', tb), ['1000bulbs:c7-bulk-12', 'suitable']);
});

test('a bulk run is planned by the foot: sockets, watts, one clip per socket and a plain explanation', () => {
  const p = fx.project({ features: [fx.feature('ft_eave', 'roofline', [fx.F(10, 10), fx.F(50, 10)], { label: 'Front eave' })], library: { products: null, config: null, supplierId: 'cle' } });
  const lib = catalog.getLibrary(p);
  const [run] = design.planRuns(p, fx.measure(p), lib);
  assert.deepEqual([run.productId, run.unit, run.method, run.supplierId, run.productKind], ['cle:c9-bulk-12', 'foot', 'per-foot', 'cle', 'bulk']);
  assert.deepEqual([run.lengthFt, run.withWasteFt, run.quantity, run.bulbs, run.watts], [40, 44, 44, 44, 35.2]);
  assert.deepEqual(run.clips, { type: 'allInOne', count: 41 });
  assert.equal(run.detail, '40.0 ft + 10% = 44.0 ft, rounded up = 44 ft of socket wire = 44 sockets (one every 12 in), one bulb each');
  assert.deepEqual(run.warnings, []);
  // A generic run carries neither field, so Phase 1 plans are unchanged.
  const g = fx.project({ features: p.features });
  const [plain] = design.planRuns(g, fx.measure(g), catalog.getLibrary(g));
  assert.equal(plain.productId, 'c9-led');
  assert.ok(!('supplierId' in plain) && !('productKind' in plain));
  // Clips follow the socket spacing of the wire, not the library's clip spacing.
  const wide = catalog.getLibrary({ library: { products: null, supplierId: 'cle', config: { clipSpacingIn: 6 } } });
  assert.equal(design.planRuns(p, fx.measure(p), wide)[0].clips.count, 41);
  // Multicolor is sold for bulk (a mixed box); the ready-made warm white set says it is not.
  const multi = fx.project({ features: [fx.feature('ft_eave', 'roofline', [fx.F(10, 10), fx.F(50, 10)], { color: { mode: 'multicolor' } })], library: p.library });
  assert.deepEqual(design.planRuns(multi, fx.measure(multi), lib)[0].warnings, []);
  const strings = libFor('cle', { style: 'strings' });
  assert.match(design.planRuns(multi, fx.measure(multi), strings)[0].warnings[0], /is not sold in multicolor/);
});

// ================================================================ ready-made supplier sets
test('ready-made supplier sets are planned from their own size, watts and connect limit', () => {
  for (const sid of ['cle', '1000bulbs']) {
    // Icicle sets picked for a 50 ft gutter: 50 ft + 10% = 55 ft / 7 ft lit per set = 8 sets of 70 bulbs at 4.8 W.
    const p = fx.project({
      features: [fx.feature('ft_gut', 'gutter', [fx.F(10, 10), fx.F(60, 10)], { label: 'Gutter', productId: sid + ':icicle-70' })],
      outlets: [fx.outlet('out_1', fx.F(9, 1.5))],
      library: { products: null, config: null, supplierId: sid },
    });
    const lib = catalog.getLibrary(p);
    const r = fx.plan(p, lib);
    const run = r.runs[0];
    assert.deepEqual([run.productId, run.unit, run.quantity, run.bulbs, run.watts, run.supplierId], [sid + ':icicle-70', 'string', 8, 560, 38.4, sid], sid);
    assert.deepEqual(run.clips, { type: 'gutter', count: 51 }, sid);
    assert.deepEqual(r.power.feeds.map((f) => [f.strings, f.watts]), [[8, 38.4]], sid);
    assert.deepEqual(fx.checkPlan(p, r.measured, r.power, lib, { runs: r.runs }), [], sid);
    assert.deepEqual(r.power.warnings.filter((w) => w.level === 'danger'), [], sid);
    const line = bom.buildBom(p, planner.mergeRunInfo(r.runs, r.power), r.power, lib).lines[0];
    const want = { cle: ['85686', 21.99, 175.92], '1000bulbs': ['SHL-LED70ICEWW', 21.72, 173.76] }[sid];
    assert.deepEqual([line.supplierSku, line.qty, line.unitPrice, line.lineTotal, line.priceStatus], [want[0], 8, want[1], want[2], 'verified'], sid);
    // A 400 ft gutter: 63 sets are bought (10% extra) and 58 are hung (400 ft / 7 ft). No more than 45 go end to end,
    // so it is fed in two parts.
    const long = fx.project({
      features: [fx.feature('ft_gut', 'gutter', [fx.F(0, 10), fx.F(290, 10)], { label: 'Gutter', productId: sid + ':icicle-70', overrideFt: 400 })],
      outlets: [fx.outlet('out_1', fx.F(1, 1.5))],
      library: p.library,
    });
    const rl = fx.plan(long, lib);
    assert.equal(rl.runs[0].quantity, 63, sid);
    assert.deepEqual(rl.power.feeds.map((f) => f.strings), [45, 13], sid);
    assert.ok(rl.power.feeds.every((f) => f.watts <= 216), sid);
  }
  // A bush 4.5 ft wide and 3 ft tall (about 300 lights by the rule of thumb), with each supplier's mini string or net.
  const bushPlan = (sid, productId) => {
    const p = fx.project({ features: [fx.feature('ft_bush', 'bush', [fx.F(10, 0), fx.F(14.5, 0), fx.F(14.5, 3), fx.F(10, 3)], { label: 'Bush', productId })], library: { products: null, config: null, supplierId: sid } });
    const m = fx.measure(p);
    Object.assign(m.features.ft_bush, { lengthFt: null, withWasteFt: null, widthFt: 4.5, heightFt: 3, lights: 300 });
    const run = design.planRuns(p, m, catalog.getLibrary(p))[0];
    return [run.productId, run.method, run.quantity, run.bulbs, run.watts];
  };
  assert.deepEqual(bushPlan('cle', null), ['cle:mini-5mm-70', 'bush-rule', 5, 350, 24]);              // 300 lights / 70 per string
  assert.deepEqual(bushPlan('1000bulbs', null), ['1000bulbs:mini-5mm-50', 'bush-rule', 6, 300, 28.8]); // 300 lights / 50 per string
  assert.deepEqual(bushPlan('cle', 'cle:net-4x6-100'), ['cle:net-4x6-100', 'bush-net', 1, 100, 12]);   // 4.5 × 3 × 1.5 to drape = 20.25 sq ft: one 24 sq ft net
  assert.deepEqual(bushPlan('1000bulbs', '1000bulbs:net-4x6-100'), ['1000bulbs:net-4x6-100', 'bush-net', 1, 100, 9.6]);
});

// ================================================================ power with bulk products
test('power: a 300 ft bulk roofline is split into feeds at 250 ft, and each feed is one cut length with its own plugs', () => {
  const p = fx.project({
    features: [fx.feature('ft_long', 'roofline', [fx.F(0, 12), fx.F(300, 12)], { label: 'Long eave', overrideFt: 300 })],
    outlets: [fx.outlet('out_1', fx.F(1, 1.5))],
    library: { products: null, config: null, supplierId: 'cle' },
  });
  const lib = catalog.getLibrary(p);
  const { runs, measured, power: pw } = fx.plan(p, lib);
  assert.deepEqual([runs[0].productId, runs[0].quantity, runs[0].watts], ['cle:c9-bulk-12', 330, 264]);
  assert.deepEqual(pw.feeds.map((f) => [f.strings, f.watts]), [[250, 200], [80, 64]]);
  assert.deepEqual(pw.feeds.map((f) => f.runIds), [['run_ft_long'], ['run_ft_long']]);
  assert.deepEqual(fx.checkPlan(p, measured, pw, lib, { runs }), []);
  assert.deepEqual(pw.warnings.filter((w) => w.level === 'danger'), []);
  assert.equal(pw.totals.watts, 264);
  // BOM: 330 ft of wire, 330 bulbs, and one male and one female plug for each of the 2 feeds.
  const merged = planner.mergeRunInfo(runs, pw);
  const b = bom.buildBom(p, merged, pw, lib);
  const male = lineBy(b, 'cle:88283'), female = lineBy(b, 'cle:88287');
  assert.deepEqual([male.qty, male.usedQty, female.qty, female.usedQty], [1, 0.2, 1, 0.2]);
  assert.equal(male.notes, 'One for each length of wire that is cut: 2 needed, 10 bought. It goes on the end where the cord arrives.');
  assert.match(female.notes, /2 needed, 10 bought\. It goes on the far end, so the next run or a jumper cord can plug in\./);
  const wire = b.lines.filter((l) => /socket wire/.test(l.name));
  assert.deepEqual(wire.map((l) => [l.supplierSku, l.qty, l.unit]), [['15098', 3, 'each'], ['15100', 2, 'each']], '3 x 100 ft + 2 x 25 ft ($181.95) is cheaper than a 500 ft spool ($219.99)');
  assert.match(wire[0].notes, /^330 ft needed for Long eave \(330 ft\)\. Bought as 3 × 100 ft \+ 2 × 25 ft = 350 ft, 20 ft left over\./);
  assert.deepEqual([lineBy(b, 'cle:72636').qty, lineBy(b, 'cle:72636').usedQty], [14, 13.2]);
  // Checklist: each feed is cut, plugged and lamped on the ground, then hung.
  const steps = bom.buildChecklist(p, merged, pw, measured).flatMap((g) => g.steps);
  const cut = steps.filter((s) => /^On the ground, cut one length of socket wire/.test(s));
  assert.equal(cut.length, 2);
  assert.match(cut[0], /for Long eave: 250 ft \(250 sockets\)\. Slide a male plug onto the end that meets the cord and a female plug onto the far end, then screw a warm white bulb into every socket\./);
  assert.match(cut[1], /: 80 ft \(80 sockets\)/);
  assert.ok(steps.some((s) => /^Hang the wire along Long eave \(250 of its 330 ft\), starting at the .*\. Plug its male plug into the cord\.$/.test(s)), steps.join('\n'));
  assert.ok(steps.some((s) => /^Put up 301 all-in-one clips along Long eave, one every 12 in\.$/.test(s)));
});

test('power: two bulk runs are linked by a jumper when one run can carry both, and not when it cannot', () => {
  const build = (aFt, bFt) => fx.project({
    features: [
      fx.feature('ft_a', 'roofline', [fx.F(10, 10), fx.F(10 + aFt, 10)], { label: 'Eave A' }),
      fx.feature('ft_b', 'roofline', [fx.F(15 + aFt, 10), fx.F(15 + aFt + bFt, 10)], { label: 'Eave B' }),
    ],
    outlets: [fx.outlet('out_1', fx.F(9, 1.5))],
    library: { products: null, config: null, supplierId: 'cle' },
  });
  // 55 ft (44 W) + 44 ft (35.2 W): B hangs off the end of A with a short jumper, and A carries both.
  let p = build(50, 40);
  let lib = catalog.getLibrary(p);
  let r = fx.plan(p, lib);
  let a = fx.feedOf(r.power, 'run_ft_a'), b = fx.feedOf(r.power, 'run_ft_b');
  assert.notEqual(a.id, b.id, 'a 5 ft gap is too wide to be one cut length');
  assert.deepEqual(a.source, { kind: 'outlet', outletId: 'out_1' });
  assert.deepEqual(b.source, { kind: 'feed', feedId: a.id, port: 'end' });
  assert.equal(b.cord.kind, 'jumper');
  assert.deepEqual([a.watts, b.watts, a.throughW], [44, 35.2, 35.2]);
  assert.ok(a.watts + a.throughW <= catalog.getProduct(lib.products, 'cle:c9-bulk-12').maxConnectedW);
  assert.deepEqual(fx.checkPlan(p, r.measured, r.power, lib, { runs: r.runs }), []);
  assert.deepEqual([r.power.counts.homeRuns, r.power.counts.jumpers], [1, 1]);
  // Two cut lengths, so two plugs of each kind.
  const bill = bom.buildBom(p, planner.mergeRunInfo(r.runs, r.power), r.power, lib);
  assert.match(lineBy(bill, 'cle:88283').notes, /: 2 needed, 10 bought\./);
  // 165 ft (132 W) + 110 ft (88 W) = 220 W is more than one run may carry (200 W): B is not fed through A's wire.
  p = build(150, 100);
  lib = catalog.getLibrary(p);
  r = fx.plan(p, lib);
  a = fx.feedOf(r.power, 'run_ft_a'); b = fx.feedOf(r.power, 'run_ft_b');
  assert.deepEqual([a.watts, b.watts], [132, 88]);
  assert.ok(!(b.source.kind === 'feed' && b.source.feedId === a.id && b.source.port === 'end'), 'B must not pass through A');
  assert.ok(!(a.source.kind === 'feed' && a.source.feedId === b.id && a.source.port === 'end'), 'A must not pass through B');
  assert.ok(a.watts + (a.throughW || 0) <= 200 && b.watts + (b.throughW || 0) <= 200);
  assert.deepEqual(fx.checkPlan(p, r.measured, r.power, lib, { runs: r.runs }), []);
});

// ================================================================ BOM: bulk products
test('bulk BOM: wire is the cheapest mix that covers the feet, with feet needed and left over', () => {
  const lib = libFor('cle');
  const wireLines = (feet) => bom.buildBom(project(), [bulkRun('Eave', { quantity: feet })], power(), lib).lines.filter((l) => /socket wire/.test(l.name));
  const shape = (ls) => ls.map((l) => [l.sku, l.qty, l.unit, l.unitPrice, l.lineTotal]);
  // Christmas Lights Etc C9 wire: 1,000 ft $409.99, 500 ft $219.99, 100 ft $49.99, 25 ft $15.99.
  assert.deepEqual(shape(wireLines(139)), [['cle:15098', 1, 'each', 49.99, 49.99], ['cle:15100', 2, 'each', 15.99, 31.98]]);
  assert.deepEqual(shape(wireLines(20)), [['cle:15100', 1, 'each', 15.99, 15.99]]);
  assert.deepEqual(shape(wireLines(100)), [['cle:15098', 1, 'each', 49.99, 49.99]]);
  // 760 ft: a 500 ft spool, two 100 ft and three 25 ft lengths ($367.94 for 775 ft) beat the 1,000 ft spool ($409.99).
  assert.deepEqual(shape(wireLines(760)), [['cle:81832', 1, 'each', 219.99, 219.99], ['cle:15098', 2, 'each', 49.99, 99.98], ['cle:15100', 3, 'each', 15.99, 47.97]]);
  // 950 ft: two 500 ft spools would be $439.98, so the 1,000 ft spool is the buy.
  assert.deepEqual(shape(wireLines(950)), [['cle:15085', 1, 'spool', 409.99, 409.99]]);
  assert.deepEqual(shape(wireLines(1090)), [['cle:15085', 1, 'spool', 409.99, 409.99], ['cle:15098', 1, 'each', 49.99, 49.99]]);
  const [w100, w25] = wireLines(139);
  assert.equal(w100.notes, '139 ft needed for Eave (139 ft). Bought as 1 × 100 ft + 2 × 25 ft = 150 ft, 11 ft left over. ' +
    'It comes with a plug on each end, so a length you use uncut needs no slide-on plugs.');
  assert.equal(w25.notes, w100.notes);
  assert.deepEqual([w100.usedQty, w25.usedQty], [0.9267, 1.8533]);
  assert.deepEqual([w100.supplierSku, w100.priceStatus, w100.priceAsOf, w100.url], ['15098', 'verified', '2026-11-11',
    'https://www.christmaslightsetc.com/p/C9-Christmas-Lights-String-100-ft-Length-12-inch-Spacing-7-Amp-Green-Wire--15098.htm']);
  assert.equal(wireLines(950)[0].notes, '950 ft needed for Eave (950 ft). 1,000 ft bought, 50 ft left over.');
  // 1000Bulbs C9 wire has no 25 ft size (its 25 ft lengths are a thinner wire): 139 ft is two 100 ft lengths.
  const tbWire = bom.buildBom(project(), [bulkRun('Eave', { productId: '1000bulbs:c9-bulk-12', quantity: 139 })], power(), libFor('1000bulbs')).lines.filter((x) => /socket wire/.test(x.name));
  assert.deepEqual(shape(tbWire), [['1000bulbs:CMS-10124', 2, 'each', 39.43, 78.86]]);
  assert.equal(tbWire[0].notes, '139 ft needed for Eave (139 ft). 200 ft bought, 61 ft left over. It comes with a male plug only, so a length you use uncut needs no slide-on male plug.');
  // 1000Bulbs C7 wire: two 500 ft spools ($459.54) cost less than its 1,000 ft spool ($481.47). They were seen on a
  // category list only, so the line says to check the price.
  const tb7 = bom.buildBom(project(), [bulkRun('Eave', { productId: '1000bulbs:c7-bulk-12', quantity: 900 })], power(), libFor('1000bulbs')).lines.filter((x) => /socket wire/.test(x.name));
  assert.deepEqual(shape(tb7), [['1000bulbs:CMS-10093', 2, 'each', 229.77, 459.54]]);
  assert.deepEqual([tb7[0].priceStatus, bom.priceStatusText(tb7[0])], ['observed', 'as of Nov 11, 2026 (check the price)']);
  assert.match(tb7[0].notes, /100 ft left over\. Seen on the supplier's category list only, not on its own page: check the price and details there\.$/);
  // Several runs of the same product share the wire; a short C7 run is one 25 ft length.
  const b = bom.buildBom(project(), [bulkRun('A', { quantity: 60 }), bulkRun('B', { quantity: 30 }), bulkRun('C', { productId: 'cle:c7-bulk-12', quantity: 12 })], power(), lib);
  const lights = b.lines.filter((l) => l.category === 'lights');
  assert.deepEqual(lights.map((l) => [l.sku, l.qty]), [
    ['cle:15098', 1], ['cle:72636', 4], ['cle:88283', 1], ['cle:88287', 1],
    ['cle:15071', 1], ['cle:72609', 1], ['cle:88283', 1], ['cle:88287', 1],
  ]);
  assert.match(lights[0].notes, /^90 ft needed for A \(60 ft\), B \(30 ft\)\. 100 ft bought, 10 ft left over\./);
  assert.deepEqual(bom.cheapestMix(30, [{ lengthFt: 25, price: 10 }, { lengthFt: 50, price: 20 }]).map((m) => [m.size.lengthFt, m.count]), [[50, 1]], 'same cost: fewer pieces');
  assert.deepEqual(bom.cheapestMix(25, [{ lengthFt: 12.5, price: 1 }, { lengthFt: 100, price: 50 }]).map((m) => [m.size.lengthFt, m.count]), [[12.5, 3]], 'a 12.5 ft piece only counts for 12 whole feet');
  assert.deepEqual(bom.cheapestMix(0.2, [{ lengthFt: 25, price: 10 }]).map((m) => m.count), [1]);
});

test('bulk BOM: bulbs are counted per socket and split by each run\'s colour pattern', () => {
  const lib = libFor('cle');
  const runs = [
    bulkRun('Warm', { quantity: 38 }),
    bulkRun('Candy', { quantity: 25, colorMode: 'custom', colors: ['#ff0000', '#00ff00'] }),
    bulkRun('Party', { quantity: 30, colorMode: 'multicolor', colors: ['#ff3b30', '#34c759'] }),
    bulkRun('Ice', { quantity: 10, colorMode: 'coolWhite', colors: ['#dfeaff'] }),
    bulkRun('Sky', { quantity: 12, colorMode: 'custom', colors: ['#2f7bff', '#ffffff', '#ffc46b'] }),
    bulkRun('Dusk', { quantity: 8, colorMode: 'custom', colors: ['#b44dff'] }),
  ];
  const b = bom.buildBom(project(), runs, power(), lib);
  const bulbs = b.lines.filter((l) => /bulbs/.test(l.name));
  assert.deepEqual(bulbs.map((l) => [l.sku, l.supplierSku, l.qty, l.usedQty]), [
    ['cle:72636', '72636', 2, 1.68],     // warm white: 38 + 4 of Sky
    ['cle:72639', '72639', 1, 0.56],     // cool white: 10 + 4 of Sky
    ['cle:72642', '72642', 2, 1.2],      // the supplier's multicolor box
    ['cle:72645', '72645', 1, 0.52],     // red: 13 of 25 (the first colour gets the odd one)
    ['cle:72654', '72654', 1, 0.48],     // green: 12 of 25
    ['cle:72648', '72648', 1, 0.16],     // blue: 4 of Sky, the supplier's blue box
    ['cle:72636:purple', null, 1, 0.32], // not on file: priced like warm white, no part number
  ]);
  for (const l of bulbs.slice(0, 6)) assert.deepEqual([l.unitPrice, l.priceStatus, l.priceAsOf, l.findUrl], [29.99, 'verified', '2026-11-11', null], l.sku);
  assert.equal(lineBy(b, 'cle:72636').notes, '42 bulbs needed for Warm (38), Sky (4). 50 bought, 8 spare. Quantity price from 20 boxes: see the supplier\'s page.');
  assert.equal(lineBy(b, 'cle:72645').notes, '13 bulbs needed for Candy (13). 25 bought, 12 spare. Quantity price from 20 boxes: see the supplier\'s page.');
  const blue = lineBy(b, 'cle:72648');
  assert.deepEqual([blue.name, blue.url], ['C9 OptiCore LED bulbs, blue, faceted, box of 25', 'https://www.christmaslightsetc.com/p/C9--Blue-OptiCore-LED-Replacement-Bulbs-13607.htm']);
  const purple = lineBy(b, 'cle:72636:purple');
  assert.equal(purple.name, 'C9 OptiCore LED bulbs, faceted, box of 25 - Purple (choose the colour at the supplier)');
  assert.deepEqual([purple.unitPrice, purple.url, purple.findUrl, purple.supplierId], [29.99, null, suppliers.getSupplier('cle').categoryUrls.c9Bulbs, 'cle']);
  assert.match(purple.notes, /^8 bulbs needed for Dusk \(8\)\. 25 bought, 17 spare\. No purple bulb is on file for this supplier, so it is priced like warm white: choose the colour at the supplier\.$/);
  // 1000Bulbs blue is another bulb line seen on a category list only: the line carries its part number, says so, and says "check the price".
  const tbBlue = bom.buildBom(project(), [bulkRun('Sky', { productId: '1000bulbs:c7-bulk-12', quantity: 30, colorMode: 'custom', colors: ['#2f7bff'] })], power(), libFor('1000bulbs'))
    .lines.find((l) => /bulbs/.test(l.name));
  assert.deepEqual([tbBlue.sku, tbBlue.supplierSku, tbBlue.qty, tbBlue.unitPrice, tbBlue.priceStatus], ['1000bulbs:CMS-C7BLU', 'CMS-C7BLU', 2, 17.29, 'observed']);
  assert.equal(tbBlue.name, 'C7 LED bulbs, blue, faceted, pack of 25 (standard line)');
  assert.match(tbBlue.notes, /0\.54 W per bulb as listed, a little more than the 0\.48 W the plan counts\. Seen on the supplier's category list only, not on its own page: check the price and details there\.$/);
  // Sockets follow the spacing of the wire: 12 in gives one per foot.
  const wide = clone(lib);
  const prod = wide.products.find((p) => p.id === 'cle:c9-bulk-12');
  prod.bulbSpacingIn = 15;
  assert.match(lineBy(bom.buildBom(project(), [bulkRun('Warm', { quantity: 38 })], power(), wide), 'cle:72636').notes, /^31 bulbs needed/);
  for (const [hex, family] of [['#ff3b30', 'red'], ['#34c759', 'green'], ['#2f7bff', 'blue'], ['#ffc46b', 'warmWhite'], ['#dfeaff', 'coolWhite'], ['#ffffff', 'coolWhite'],
    ['#fff', 'coolWhite'], ['#ff8a3d', 'orange'], ['#ffb000', 'yellow'], ['#b44dff', 'purple'], ['#ff4f9a', 'pink'], ['#00c8c8', 'teal'], ['nonsense', 'warmWhite']]) {
    assert.equal(bom.colourFamily(hex), family, hex);
  }
});

test('bulk BOM: plugs are one male and one female per power feed, or per run when there is no power plan', () => {
  const lib = libFor('cle');
  const runs = [bulkRun('A'), bulkRun('B'), bulkRun('C')];
  const none = bom.buildBom(project(), runs, power(), lib);
  assert.match(lineBy(none, 'cle:88283').notes, /: 3 needed, 10 bought\./);
  assert.match(lineBy(none, 'cle:88287').notes, /: 3 needed, 10 bought\./);
  // A and B are one cut length (one feed); C is on a feed of its own; a feed of other lights does not count.
  const feeds = [{ id: 'fd_1', runIds: ['run_A', 'run_B'] }, { id: 'fd_2', runIds: ['run_C'] }, { id: 'fd_3', runIds: ['run_other'] }];
  const two = bom.buildBom(project(), runs, power({ feeds }), lib);
  assert.match(lineBy(two, 'cle:88283').notes, /: 2 needed, 10 bought\./);
  assert.deepEqual([lineBy(two, 'cle:88283').qty, lineBy(two, 'cle:88283').usedQty], [1, 0.2]);
  // A split run (two feeds) needs two pairs; a run on no feed still needs one.
  const split = bom.buildBom(project(), runs, power({ feeds: [{ id: 'fd_1', runIds: ['run_A'] }, { id: 'fd_2', runIds: ['run_A'] }, { id: 'fd_3', runIds: ['run_B'] }] }), lib);
  assert.match(lineBy(split, 'cle:88283').notes, /: 4 needed, 10 bought\./);
  // Eleven cut lengths: two packs of ten of each.
  const eleven = bom.buildBom(project(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'].map((n) => bulkRun(n)), power(), lib);
  assert.deepEqual([lineBy(eleven, 'cle:88283').qty, lineBy(eleven, 'cle:88287').qty], [2, 2]);
  const m = lineBy(eleven, 'cle:88283');
  assert.deepEqual([m.name, m.supplierSku, m.unitPrice, m.lineTotal, m.priceStatus], ['Slide-on male plug for SPT-1 wire, green, pack of 10', '88283', 12.4, 24.8, 'verified']);
  assert.equal(m.notes, 'One for each length of wire that is cut: 11 needed, 20 bought. It goes on the end where the cord arrives.');
  // 1000Bulbs: both plugs are on file with their part numbers.
  const tb = bom.buildBom(project(), [bulkRun('A', { productId: '1000bulbs:c9-bulk-12' })], power(), libFor('1000bulbs'));
  const male = lineBy(tb, '1000bulbs:PLUG-10001'), female = lineBy(tb, '1000bulbs:PLUG-10002');
  assert.deepEqual([male.supplierId, male.supplierSku, male.unitPrice, male.priceStatus], ['1000bulbs', 'PLUG-10001', 6.73, 'verified']);
  assert.deepEqual([female.supplierId, female.supplierSku, female.unitPrice, female.priceStatus, female.url, female.findUrl],
    ['1000bulbs', 'PLUG-10002', 6.73, 'verified', 'https://www.1000bulbs.com/product/223291/PLUG-10002.html', null]);
  assert.equal(female.name, 'Slide-on female plug for SPT-1 wire, green, pack of 10');
  // A bulk product with no plug on file (an edited or imported one): a plain line with a link to the supplier's plug page.
  const noPlug = clone(libFor('1000bulbs'));
  noPlug.products.find((p) => p.id === '1000bulbs:c9-bulk-12').components.plugFemale = null;
  const plain = lineBy(bom.buildBom(project(), [bulkRun('A', { productId: '1000bulbs:c9-bulk-12' })], power(), noPlug), 'plug-spt1-female');
  assert.deepEqual([plain.name, plain.supplierId, plain.supplierName, plain.supplierSku, plain.url, plain.findUrl, plain.unitPrice, plain.priceStatus, plain.category],
    ['Slide-on female plugs for SPT-1 socket wire, pack of 10', null, 'Any store', null, null, 'https://www.1000bulbs.com/category/christmas-light-plugs', 7.99, 'default', 'lights']);
  assert.match(plain.notes, /No part number is on file for this plug: pick the one that matches the wire\.$/);
  // At Christmas Lights Etc the same line points at its electrical accessories page (it has no page for plugs alone).
  const clePlain = clone(lib);
  clePlain.products.find((p) => p.id === 'cle:c9-bulk-12').components.plugMale = null;
  assert.equal(lineBy(bom.buildBom(project(), [bulkRun('A')], power(), clePlain), 'plug-spt1-male').findUrl,
    'https://www.christmaslightsetc.com/christmas-light-adapters-and-electrical-accessories--106.htm');
});

test('bulk BOM: cost basis "used" charges only the share used and buys wire by the cheapest foot', () => {
  const runs = [bulkRun('Eave', { quantity: 139 })];
  const bought = bom.buildBom(project(), runs, power(), libFor('cle'));
  const used = bom.buildBom(project(), runs, power(), libFor('cle', { costBasis: 'used' }));
  const row = (b) => b.lines.map((l) => [l.sku, l.qty, l.usedQty, l.total, l.buyTotal]);
  assert.deepEqual(row(bought), [
    ['cle:15098', 1, 0.9267, 49.99, 49.99], ['cle:15100', 2, 1.8533, 31.98, 31.98],
    ['cle:72636', 6, 5.56, 179.94, 179.94], ['cle:88283', 1, 0.1, 12.4, 12.4], ['cle:88287', 1, 0.1, 12.4, 12.4],
  ]);
  assert.deepEqual(row(used), [
    ['cle:15085', 1, 0.139, 56.99, 409.99],        // 139 ft at $0.41 a foot (the 1,000 ft spool is the cheapest foot); the rest goes to the next job
    ['cle:72636', 6, 5.56, 166.74, 179.94],        // 139 bulbs at $1.20
    ['cle:88283', 1, 0.1, 1.24, 12.4], ['cle:88287', 1, 0.1, 1.24, 12.4],   // 1 plug of each kind out of a pack of 10
  ]);
  for (const b of [bought, used]) {
    for (const l of b.lines) {
      assert.equal(l.lineTotal, l.total);
      assert.equal(l.buyTotal, bom.round2(l.qty * l.unitPrice));
    }
    assert.equal(b.subtotal, bom.round2(b.lines.reduce((s, l) => s + l.total, 0)));
    assert.equal(b.byCategory.lights, b.subtotal);
  }
  assert.equal(bought.subtotal, 286.71);
  assert.equal(used.subtotal, 226.21);
  // The order sheet always lists what is ordered, whatever the basis.
  assert.equal(bom.orderSheets(used, libFor('cle', { costBasis: 'used' }))[0].subtotal, 614.73);
  // Lines that are not bulk parts are never charged by share.
  const mixed = bom.buildBom(project(), runs.concat([bulkRun('Win', { productId: 'cle:mini-5mm-70', unit: 'string', quantity: 3, clips: { type: 'adhesive', count: 30 } })]),
    power(), libFor('cle', { costBasis: 'used' }));
  for (const l of mixed.lines.filter((x) => /mini string|clips/i.test(x.name))) assert.deepEqual([l.usedQty, l.total], [l.qty, l.buyTotal]);
});

test('bulk BOM: your own prices drive the choice and are marked "yours"; a broken product falls back to a per-foot line', () => {
  const runs = [bulkRun('Eave', { quantity: 139 })];
  const lib = libFor('cle');
  // An account price for the spool that beats the ready-made lengths.
  const b = bom.buildBom(project({ pricing: { overrides: { 'cle:15085': 60, 'cle:72636': 20 } } }), runs, power(), lib);
  const spool = lineBy(b, 'cle:15085');
  assert.deepEqual([spool.qty, spool.unitPrice, spool.defaultPrice, spool.overridden, spool.priceStatus, spool.priceAsOf], [1, 60, 409.99, true, 'yours', null]);
  assert.deepEqual([lineBy(b, 'cle:72636').unitPrice, lineBy(b, 'cle:72636').priceStatus], [20, 'yours']);
  assert.deepEqual([lineBy(b, 'cle:88283').priceStatus, lineBy(b, 'cle:88283').priceAsOf], ['verified', '2026-11-11']);
  // A price edited in the project's own product list is "yours" too.
  const edited = clone(lib);
  edited.products.find((p) => p.id === 'cle:c9-bulk-12').components.bulb.variants.warmWhite.price = 27.5;
  const e = lineBy(bom.buildBom(project(), runs, power(), edited), 'cle:72636');
  assert.deepEqual([e.unitPrice, e.overridden, e.priceStatus, e.priceAsOf], [27.5, false, 'yours', null]);
  // Components that cannot be priced: one per-foot line at the product's own price, like any per-foot product.
  const broken = clone(lib);
  delete broken.products.find((p) => p.id === 'cle:c9-bulk-12').components.bulb;
  const f = bom.buildBom(project(), runs, power(), broken);
  assert.deepEqual(f.lines.map((l) => [l.sku, l.qty, l.unit, l.unitPrice, l.supplierId]), [['cle:c9-bulk-12', 139, 'foot', 1.61, 'cle']]);
  // That per-foot figure is worked out from the parts, not read from a page: the line says "check the price".
  assert.deepEqual([f.lines[0].supplierSku, f.lines[0].priceStatus, bom.priceStatusText(f.lines[0])], [null, 'observed', 'as of Nov 11, 2026 (check the price)']);
  assert.equal(f.ok, true);
  // A bulk product with no supplier (a user's own) is a plain "any store" kit.
  const own = clone(lib);
  const mine = own.products.find((p) => p.id === 'cle:c9-bulk-12');
  delete mine.supplierId;
  const g = bom.buildBom(project(), runs, power(), Object.assign(own, { supplierId: 'generic' }));
  assert.ok(g.lines.length >= 4 && g.lines.every((l) => l.supplierId === null && l.supplierName === 'Any store' && l.url === null && l.priceStatus === 'default'));
});

// ================================================================ BOM: accessories, links, order sheets
function houseRuns() {
  return [
    bulkRun('Eave', { quantity: 38, clips: { type: 'allInOne', count: 36 } }),
    bulkRun('Rake', { quantity: 18, clips: { type: 'shingle', count: 17 } }),
    bulkRun('Ridge', { quantity: 38, clips: { type: 'ridge', count: 36 } }),
    bulkRun('Gutter', { quantity: 25, clips: { type: 'gutter', count: 23 } }),
    bulkRun('Stakes', { featureType: 'stakes', quantity: 20, lightStakes: 21 }),
    bulkRun('Tree', { featureType: 'tree', productId: 'treewrap-led', productName: 'LED tree-wrap string', unit: 'string', quantity: 2, method: 'spiral' }),
  ];
}
function housePower(watts) {
  return power({
    outlets: [{ id: 'out_1', label: 'Porch outlet', feedIds: ['fd_1'], timer: true, splitters: 0, watts: watts || 120 }],
    cords: [{ awg: 16, lengthFt: 25, count: 1 }],
    counts: { timers: 1, splitters: 0, cordCovers: 0, gfciAdapters: 0, taps: 1 },
  });
}

test('accessories: the chosen supplier\'s own clips, stakes and timer replace the generic ones; the rest get a link to look', () => {
  const cle = bom.buildBom(project(), houseRuns(), housePower(), libFor('cle'));
  const rest = (b) => b.lines.filter((l) => l.category !== 'lights' || /tree-wrap/.test(l.name)).map((l) => [l.sku, l.qty, l.unitPrice, l.supplierSku, l.priceStatus]);
  assert.deepEqual(rest(cle), [
    ['treewrap-led', 2, 16.99, null, 'default'],
    ['cle:82761', 1, 13.99, '82761', 'verified'],
    ['clip-gutter', 1, 9.99, null, 'default'],
    ['cle:83965', 1, 24.99, '83965', 'verified'],
    ['cle:88780', 2, 26.25, '88780', 'verified'],   // 40 ridge clips in packs of 25
    ['cord-16-25', 1, 14.99, null, 'default'],
    ['cle:80056', 1, 34.99, '80056', 'verified'],
    ['tap-3way', 1, 6.99, null, 'default'],
    ['cle:84144', 1, 9.99, '84144', 'verified'],
  ]);
  const cats = suppliers.getSupplier('cle').categoryUrls;
  const link = (b, sku) => { const l = lineBy(b, sku); return [l.supplierId, l.url, l.findUrl]; };
  assert.deepEqual(link(cle, 'cle:82761'), ['cle', suppliers.SUPPLIER_ACCESSORIES.cle['clip-allinone'].url, null]);
  assert.deepEqual(link(cle, 'clip-gutter'), [null, null, cats.clips]);
  assert.deepEqual(link(cle, 'cord-16-25'), [null, null, cats.extensionCords]);
  // No page for these at this supplier: its own search.
  assert.deepEqual(link(cle, 'tap-3way'), [null, null, 'https://www.christmaslightsetc.com/browse/?q=Outdoor+3-way+tap']);
  assert.deepEqual(link(cle, 'treewrap-led'), [null, null, 'https://www.christmaslightsetc.com/browse/?q=LED+tree-wrap+string+150+bulbs']);
  assert.equal(lineBy(cle, 'cle:82761').name, 'All-in-one light clips (gutter or shingle), pack of 100');
  assert.equal(lineBy(cle, 'cle:84144').notes, '21 stakes for Stakes, in packs of 25.');
  assert.deepEqual([lineBy(cle, 'cle:88780').name, lineBy(cle, 'cle:88780').notes, lineBy(cle, 'cle:88780').url],
    ['Roof ridge clips for C7 and C9, pack of 25', '36 clips + 10% spare = 40, in packs of 25.', 'https://www.christmaslightsetc.com/p/Canny-Ridge-Clip-Pro-X2-25-Pack-67572.htm']);
  assert.equal(lineBy(cle, 'cle:80056').notes, 'One for each outlet used: Porch outlet.');

  const tb = bom.buildBom(project(), houseRuns().map((r) => (r.productId === 'cle:c9-bulk-12' ? Object.assign(r, { productId: '1000bulbs:c9-bulk-12' }) : r)), housePower(), libFor('1000bulbs'));
  assert.deepEqual(rest(tb), [
    ['treewrap-led', 2, 16.99, null, 'default'],
    ['1000bulbs:CLIP-10007', 1, 6.83, 'CLIP-10007', 'verified'],   // 40 clips in packs of 50
    ['clip-gutter', 1, 9.99, null, 'default'],
    ['1000bulbs:CLIP-10005', 1, 15.49, 'CLIP-10005', 'verified'],
    ['1000bulbs:CLIP-10003', 2, 17.59, 'CLIP-10003', 'verified'],  // 40 ridge clips in packs of 25
    ['cord-16-25', 1, 14.99, null, 'default'],
    ['1000bulbs:PLTS-12336', 1, 15.73, 'PLTS-12336', 'verified'],
    ['tap-3way', 1, 6.99, null, 'default'],
    ['1000bulbs:STAKE-10001', 1, 7.31, 'STAKE-10001', 'verified'],
  ]);
  assert.equal(lineBy(tb, '1000bulbs:CLIP-10003').notes, '36 clips + 10% spare = 40, in packs of 25. ' +
    'The page says 25 to a pack in its title and price, and 50 in its table: LightPlan counts 25. The page said "Limited Quantity Available" when it was checked.');
  assert.equal(lineBy(tb, 'tap-3way').findUrl, 'https://www.1000bulbs.com/fil/search?q=Outdoor+3-way+tap');
  assert.equal(lineBy(tb, 'cord-16-25').findUrl, 'https://www.1000bulbs.com/fil/search?q=outdoor+extension+cord+25+ft');
  assert.equal(lineBy(tb, 'treewrap-led').findUrl, suppliers.getSupplier('1000bulbs').categoryUrls.treeWrap);
  assert.deepEqual([lineBy(tb, '1000bulbs:STAKE-10001').name, lineBy(tb, '1000bulbs:STAKE-10001').notes],
    ['Lawn light stakes for C7 and C9, 5 in tall, pack of 25', '21 stakes for Stakes, in packs of 25.']);
  // The 1000Bulbs timer is rated 1,000 W: the line says so when an outlet carries more.
  assert.equal(lineBy(tb, '1000bulbs:PLTS-12336').notes, 'One for each outlet used: Porch outlet. Rated for 1,000 W at most.');
  const heavy = bom.buildBom(project(), houseRuns(), housePower(1200), libFor('1000bulbs'));
  assert.match(lineBy(heavy, '1000bulbs:PLTS-12336').notes, /Porch outlet \(1,200 W\) carries more than this timer's 1,000 W limit: use a heavier timer there\./);
  // A supplier's pack is what can be ordered, so the library's pack-size override does not apply to it.
  const packs = catalog.getLibrary({ library: { products: null, supplierId: 'cle', config: { clipPackSize: 10 } } });
  const p10 = bom.buildBom(project(), houseRuns(), housePower(), packs);
  assert.deepEqual([lineBy(p10, 'cle:82761').qty, lineBy(p10, 'clip-gutter').qty], [1, 3]);
});

test('every line says where it is bought; with no supplier chosen that is "Any store" with no links', () => {
  const generic = bom.buildBom(project(), houseRuns().map((r) => Object.assign(r, { productId: r.productId === 'cle:c9-bulk-12' ? 'c9-led' : r.productId, unit: 'string' })),
    housePower(), libFor('generic'));
  assert.ok(generic.lines.length >= 9);
  for (const l of generic.lines) {
    for (const k of SUPPLIER_FIELDS) assert.ok(k in l, k);
    assert.deepEqual([l.supplierId, l.supplierName, l.supplierSku, l.url, l.findUrl, l.priceAsOf, l.priceStatus], [null, 'Any store', null, null, null, null, 'default']);
    assert.deepEqual([l.usedQty, l.total, l.buyTotal], [l.qty, l.lineTotal, l.lineTotal]);
  }
  const cle = bom.buildBom(project(), houseRuns(), housePower(), libFor('cle'));
  for (const l of cle.lines) {
    for (const k of SUPPLIER_FIELDS) assert.ok(k in l, k);
    assert.ok(['verified', 'observed', 'default', 'yours'].includes(l.priceStatus));
    if (l.supplierId) assert.deepEqual([l.supplierName, l.priceAsOf, l.priceStatus, l.findUrl === null || l.url === null], ['Christmas Lights Etc', '2026-11-11', 'verified', true]);
    if (l.supplierId) assert.ok(l.supplierSku && l.url, l.name + ': a line from the supplier has its part number and its page');
    else assert.deepEqual([l.supplierName, l.supplierSku, l.url, l.priceAsOf, l.priceStatus], ['Any store', null, null, null, 'default']);
    for (const u of [l.url, l.findUrl]) assert.ok(u === null || suppliers.safeUrl(u) === u);
  }
  // A product explicitly picked from another supplier keeps that supplier on its line.
  const other = bom.buildBom(project(), [bulkRun('Eave', { productId: '1000bulbs:c9-string-17', unit: 'string', quantity: 3 })], power(), libFor('cle'));
  assert.deepEqual([other.lines[0].supplierId, other.lines[0].supplierSku, other.lines[0].findUrl], ['1000bulbs', 'CMS-25C9-8GWW', null]);
  // The 70-light mini set shares its page with another size: the line has the part number and says which to pick.
  const mini = bom.buildBom(project(), [bulkRun('Win', { productId: 'cle:mini-5mm-70', unit: 'string', quantity: 3 })], power(), libFor('cle')).lines[0];
  assert.deepEqual([mini.supplierId, mini.supplierSku, mini.unitPrice, mini.priceStatus], ['cle', '83768', 19.99, 'verified']);
  assert.equal(mini.url, 'https://www.christmaslightsetc.com/5mm-LED-Wide-Angle-Warm-White-Prelamped-Light-Set--Green-Wire-7190.htm');
  assert.equal(mini.notes, 'For Win (3). The page lists two sizes: pick the set with bulbs 4 in apart (item 83768). Quantity price from 100 sets: see the supplier\'s page.');
});

test('links from product data are https only, and unknown suppliers are treated as any store', () => {
  const lib = clone(libFor('cle'));
  const s = lib.products.find((p) => p.id === 'cle:c9-string-25');
  s.url = 'javascript:alert(1)';
  s.priceStatus = 'guessed';
  lib.products.push(Object.assign({}, catalog.DEFAULT_PRODUCTS[0], { id: 'acme:c9', sku: 'acme:c9', supplierId: 'acme', supplierSku: 'A-1', url: 'https://acme.example/c9', priceStatus: 'verified', priceAsOf: '2026-01-01' }));
  const b = bom.buildBom(project(), [bulkRun('A', { productId: 'cle:c9-string-25', unit: 'string', quantity: 2 }), bulkRun('B', { productId: 'acme:c9', unit: 'string', quantity: 1 })], power(), lib);
  assert.deepEqual([b.lines[0].supplierId, b.lines[0].supplierSku, b.lines[0].url, b.lines[0].priceStatus], ['cle', '77667', null, 'observed']);
  assert.deepEqual([b.lines[1].supplierId, b.lines[1].supplierName, b.lines[1].supplierSku, b.lines[1].url, b.lines[1].priceAsOf, b.lines[1].priceStatus], [null, 'Any store', null, null, null, 'default']);
  assert.ok(!JSON.stringify(b).includes('javascript:'));
});

test('orderSheets: one sheet per supplier, then "Any store", with what is ordered and its links', () => {
  const lib = libFor('cle');
  const runs = houseRuns().concat([bulkRun('Porch', { productId: '1000bulbs:c9-string-17', unit: 'string', quantity: 2 })]);
  const b = bom.buildBom(project(), runs, housePower(), lib);
  const sheets = bom.orderSheets(b, lib);
  assert.deepEqual(sheets.map((s) => [s.supplierId, s.supplierName, s.url, s.lines.length]), [
    ['cle', 'Christmas Lights Etc', 'https://www.christmaslightsetc.com/', 10],
    ['1000bulbs', '1000Bulbs', 'https://www.1000bulbs.com/', 1],
    ['generic', 'Any store', null, 4],
  ]);
  assert.deepEqual([sheets[0].wholesale.phone, sheets[0].wholesale.email, sheets[0].wholesale.url],
    ['1-855-WGC-7100', 'sales@wintergreencorp.com', 'https://www.christmaslightsetc.com/wholesale-Christmas-lights-and-trees.htm']);
  assert.deepEqual([sheets[1].wholesale.phone, sheets[1].wholesale.url], ['1-800-624-4488', null]);
  assert.equal(sheets[2].wholesale, null);
  assert.deepEqual([sheets[0].priceAsOf, sheets[2].priceAsOf], ['2026-11-11', null]);
  for (const s of sheets) {
    assert.equal(s.subtotal, bom.round2(s.lines.reduce((t, l) => t + l.total, 0)));
    for (const l of s.lines) assert.deepEqual(Object.keys(l), ['supplierSku', 'name', 'qty', 'unit', 'unitPrice', 'total', 'url', 'findUrl', 'priceStatus', 'priceAsOf', 'notes', 'sku']);
  }
  assert.equal(bom.round2(sheets.reduce((t, s) => t + s.subtotal, 0)), bom.round2(b.lines.reduce((t, l) => t + l.buyTotal, 0)));
  const bulbs = sheets[0].lines.find((l) => l.supplierSku === '72636');
  assert.deepEqual([bulbs.qty, bulbs.unit, bulbs.unitPrice, bulbs.total, bulbs.url], [6, 'pack', 29.99, 179.94, 'https://www.christmaslightsetc.com/p/C9--Warm-White-OptiCore-LED-Replacement-Bulbs-13603.htm']);
  assert.deepEqual(sheets[0].lines.map((l) => l.supplierSku), ['15098', '15100', '72636', '88283', '88287', '82761', '83965', '88780', '80056', '84144']);
  assert.deepEqual(sheets[1].lines.map((l) => [l.supplierSku, l.qty, l.unitPrice]), [['CMS-25C9-8GWW', 2, 13.97]]);
  assert.deepEqual(sheets[2].lines.map((l) => l.sku), ['treewrap-led', 'clip-gutter', 'cord-16-25', 'tap-3way']);
  // No supplier: one "Any store" sheet. Nothing to order: no sheets. Bad input: no sheets, no throw.
  const plain = bom.buildBom(project(), [bulkRun('E', { productId: 'c9-led', unit: 'string', quantity: 2 })], power(), libFor('generic'));
  assert.deepEqual(bom.orderSheets(plain, libFor('generic')).map((s) => [s.supplierId, s.lines.length, s.subtotal]), [['generic', 1, 65.98]]);
  assert.deepEqual(bom.orderSheets(bom.emptyBom(), lib), []);
  assert.deepEqual(bom.orderSheets(null, null), []);
  assert.deepEqual(bom.orderSheets({ lines: [null, 7, { qty: 0 }] }, 'x'), []);

  // Text and CSV of one sheet.
  const text = bom.orderSheetToText(sheets[0]).split('\n');
  assert.equal(text[0], 'Order from Christmas Lights Etc (https://www.christmaslightsetc.com/)');
  assert.ok(text.includes('6 × Part 72636: C9 OptiCore LED bulbs, warm white, faceted, box of 25 - $29.99 each = $179.94 (as of Nov 11, 2026)'), text.join('\n'));
  assert.ok(text.includes('  https://www.christmaslightsetc.com/p/C9--Warm-White-OptiCore-LED-Replacement-Bulbs-13603.htm'));
  assert.equal(text[text.length - 2], 'Subtotal: $' + sheets[0].subtotal.toFixed(2));
  assert.equal(text[text.length - 1], 'Prices were last checked on Nov 11, 2026; confirm at checkout. Account (wholesale) prices differ: edit any price.');
  const csv = bom.orderSheetToCsv(sheets[0]);
  const rows = csv.trim().split('\r\n');
  assert.equal(rows[0], 'Part number,Item,Qty,Unit,Unit Price,Total,Price status,Link,Notes');
  assert.equal(rows.length, 1 + 10 + 4);
  assert.match(rows[rows.length - 3], /^Subtotal,\d+\.\d\d,/);
  assert.match(rows[rows.length - 2], /^Supplier,Christmas Lights Etc,/);
  assert.match(rows[rows.length - 1], /^Note,"Prices were last checked on Nov 11, 2026; confirm at checkout\./);
  assert.ok(!bom.orderSheetToText(sheets[2]).includes('Prices were last checked'), 'no supplier prices on the any-store sheet');
});

test('bomToCsv adds supplier columns only when the plan buys from a supplier', () => {
  const lib = libFor('cle');
  const b = bom.buildBom(project(), houseRuns(), housePower(), lib);
  const rows = bom.bomToCsv(b).trim().split('\r\n');
  assert.equal(rows[0], 'SKU,Item,Category,Qty,Unit,Unit Price,Line Total,Notes,Supplier,Part number,Price status,Link');
  const bulbs = rows.find((r) => r.startsWith('cle:72636,'));
  assert.match(bulbs, /,Christmas Lights Etc,72636,"as of Nov 11, 2026",https:\/\/www\.christmaslightsetc\.com\/p\/C9--Warm-White-OptiCore-LED-Replacement-Bulbs-13603\.htm$/);
  const gutter = rows.find((r) => r.startsWith('clip-gutter,'));
  assert.match(gutter, /,Any store,,,https:\/\/www\.christmaslightsetc\.com\/c7-c9-light-clips-and-hangers--753\.htm$/);
  assert.match(rows[rows.length - 2], /^Subtotal,\d+\.\d\d,,,,,,,,,,$/);
  assert.match(rows[rows.length - 1], /^Note,"Prices were last checked on Nov 11, 2026; confirm at checkout\. Account \(wholesale\) prices differ: edit any price\.",/);
  // No supplier: the Phase 1 columns, byte for byte.
  const plain = bom.buildBom(project(), [bulkRun('E', { productId: 'c9-led', unit: 'string', quantity: 2 })], power(), libFor('generic'));
  assert.equal(bom.bomToCsv(plain), 'SKU,Item,Category,Qty,Unit,Unit Price,Line Total,Notes\r\nc9-led,C9 LED string, 25 bulbs - Warm white,lights,2,string,32.99,65.98,For E (2).\r\n'.replace('C9 LED string, 25 bulbs - Warm white', '"C9 LED string, 25 bulbs - Warm white"') +
    ',,,,,,,\r\nSubtotal,65.98,,,,,,\r\n');
  assert.equal(bom.priceNote(plain), '');
  assert.equal(bom.priceNote(b), 'Prices were last checked on Nov 11, 2026; confirm at checkout. Account (wholesale) prices differ: edit any price.');
  assert.equal(bom.priceStatusText({ priceStatus: 'observed', priceAsOf: '2026-11-11' }), 'as of Nov 11, 2026 (check the price)');
  assert.equal(bom.priceStatusText({ priceStatus: 'verified', priceAsOf: '2026-11-11' }), 'as of Nov 11, 2026');
  assert.equal(bom.priceStatusText({ priceStatus: 'yours', priceAsOf: null }), 'your price');
  assert.equal(bom.priceStatusText({ priceStatus: 'default', priceAsOf: null }), '');
});

test('buildBom with suppliers never throws or mutates its inputs', () => {
  const lib = deepFreeze(libFor('cle', { costBasis: 'used' }));
  const runs = deepFreeze(houseRuns());
  const pw = deepFreeze(housePower());
  const prj = deepFreeze(project({ pricing: { overrides: { 'cle:72636': 20 } } }));
  const a = bom.buildBom(prj, runs, pw, lib);
  assert.equal(a.ok, true);
  assert.deepEqual(bom.buildBom(prj, runs, pw, lib), a, 'same input, same bill');
  const odd = clone(libFor('1000bulbs'));
  const prod = odd.products.find((p) => p.id === '1000bulbs:c9-bulk-12');
  prod.components.wire.sizes = [null, 'x', { lengthFt: -5, price: 1, sku: 'a' }, { lengthFt: 50, price: 'free', sku: 'b' }];
  prod.components.bulb.variants.red = 'red';
  prod.components.plugMale = { sku: '', price: 2 };
  const b = bom.buildBom(project(), [bulkRun('A', { productId: prod.id, colorMode: 'custom', colors: ['#ff0000'] })], 'power', odd);
  assert.equal(b.ok, true);
  assert.deepEqual(b.lines.map((l) => [l.sku, l.qty]), [['1000bulbs:CMS-10105', 1], ['1000bulbs:CMS-10294:red', 2], ['plug-spt1-male', 1], ['1000bulbs:PLUG-10002', 1]]);
});

// ================================================================ the sample house, end to end
function samplePlan(supplierId, buying) {
  const p = sample.createSample().project;
  p.library = Object.assign({}, p.library, { supplierId, config: buying ? { buying } : null });
  return { project: p, plan: planner.computePlan(p) };
}

test('sample house: buying from a supplier changes the lights and accessories, not the layout or the safety of the plan', () => {
  const base = planner.computePlan(sample.createSample().project);
  assert.equal(base.library.supplierId, 'generic');
  assert.ok(base.bom.lines.every((l) => l.supplierId === null && l.priceStatus === 'default' && l.findUrl === null));
  assert.deepEqual(bom.orderSheets(base.bom, base.library).map((s) => [s.supplierId, s.subtotal]), [['generic', base.bom.subtotal]]);
  for (const [sid, style] of [['cle', 'bulk'], ['cle', 'strings'], ['1000bulbs', 'bulk'], ['1000bulbs', 'strings']]) {
    const { project: prj, plan } = samplePlan(sid, { style });
    const tag = sid + '/' + style;
    assert.equal(plan.library.supplierId, sid);
    assert.deepEqual(plan.warnings.filter((w) => w.level === 'danger' || w.code === 'internal-error'), [], tag);
    assert.equal(plan.power.feeds.length, base.power.feeds.length, tag + ': the same runs are fed');
    assert.equal(plan.summary.totalFt, base.summary.totalFt, tag);
    assert.ok(plan.power.feeds.every((f) => f.outletId), tag + ': every run has power');
    const eaves = plan.runs.filter((r) => ['roofline', 'rake', 'gutter', 'ridge'].includes(r.featureType));
    const want = { 'cle/bulk': 'cle:c9-bulk-12', 'cle/strings': 'cle:c9-string-25', '1000bulbs/bulk': '1000bulbs:c9-bulk-12', '1000bulbs/strings': '1000bulbs:c9-string-17' }[tag];
    assert.ok(eaves.length >= 5 && eaves.every((r) => r.productId === want), tag);
    const sheets = bom.orderSheets(plan.bom, plan.library);
    assert.deepEqual(sheets.map((s) => s.supplierId), [sid, 'generic'], tag);
    assert.equal(bom.round2(sheets[0].subtotal + sheets[1].subtotal), plan.bom.subtotal, tag);
    assert.ok(sheets[0].lines.length >= 5, tag);
    for (const l of plan.bom.lines) {
      // Everything this house needs from either supplier was read on its own product page.
      if (l.supplierId) assert.deepEqual([l.supplierId, l.priceStatus, l.priceAsOf], [sid, 'verified', '2026-11-11'], tag + ' ' + l.name);
      if (l.supplierId) assert.ok(l.supplierSku && l.url, tag + ' ' + l.name + ': part number and page');
      for (const u of [l.url, l.findUrl]) assert.ok(u === null || suppliers.linkHosts().includes(new URL(u).host), tag + ' ' + u);
    }
    // The project still validates and survives a save and reload unchanged.
    assert.deepEqual(schema.validateProject(prj).errors, [], tag);
    assert.deepEqual(schema.normalizeProject(prj), prj, tag);
    assert.deepEqual(planner.computePlan(schema.importProject(schema.exportProject(prj, null, {}, null)).project).bom, plan.bom, tag);
  }
  // Bulk: 139 ft of wire and 139 bulbs for the six roof edges, three cut lengths.
  const { plan } = samplePlan('cle', { style: 'bulk' });
  const lights = plan.bom.lines.filter((l) => l.category === 'lights').slice(0, 5);
  assert.deepEqual(lights.map((l) => [l.sku, l.qty, l.lineTotal]), [['cle:15098', 1, 49.99], ['cle:15100', 2, 31.98], ['cle:72636', 6, 179.94], ['cle:88283', 1, 12.4], ['cle:88287', 1, 12.4]]);
  assert.match(lights[0].notes, /^139 ft needed for Front eave \(38 ft\), Garage gutter \(25 ft\)/);
  assert.match(lights[3].notes, /: 3 needed, 10 bought\./);
  assert.equal(plan.summary.watts, 224);
  // What each way of buying costs for this house (materials), and what goes on the supplier's order sheet.
  const cost = (sid, style) => { const r = samplePlan(sid, { style }).plan; return [r.bom.subtotal, bom.orderSheets(r.bom, r.library)[0].subtotal, r.summary.watts]; };
  assert.deepEqual(cost('cle', 'bulk'), [1133.74, 807.99, 224]);
  assert.deepEqual(cost('cle', 'strings'), [1146.97, 821.22, 232.8]);
  assert.deepEqual(cost('1000bulbs', 'bulk'), [974.37, 648.62, 234.86]);
  assert.deepEqual(cost('1000bulbs', 'strings'), [869.23, 543.48, 156]);
  assert.equal(base.bom.subtotal, 767.51);
  // Installer basis: the same order, a smaller job cost.
  const used = samplePlan('cle', { style: 'bulk', costBasis: 'used' }).plan;
  assert.ok(used.bom.subtotal < plan.bom.subtotal);
  assert.ok(bom.orderSheets(used.bom, used.library)[0].subtotal > bom.orderSheets(plan.bom, plan.library)[0].subtotal, 'a whole spool is ordered');
});
