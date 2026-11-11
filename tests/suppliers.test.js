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
test('SUPPLIERS: any store, Christmas Lights Etc and 1000Bulbs, with links only on real suppliers', () => {
  assert.deepEqual(suppliers.SUPPLIERS.map((s) => s.id), ['generic', 'cle', '1000bulbs']);
  const generic = suppliers.getSupplier('generic');
  assert.deepEqual([generic.name, generic.url, generic.wholesale, generic.searchUrlTemplate, generic.categoryUrls], ['Any store', null, null, null, {}]);
  const cle = suppliers.getSupplier('cle'), tb = suppliers.getSupplier('1000bulbs');
  assert.equal(cle.name, 'Christmas Lights Etc');
  assert.equal(tb.name, '1000Bulbs');
  assert.equal(cle.wholesale.name, 'Wintergreen Corporation wholesale program');
  assert.match(cle.wholesale.url, /^https:\/\/wintergreencorp\.com\//);
  assert.match(cle.wholesale.phone, /^\d{3}-\d{3}-\d{4}$/);
  assert.match(tb.wholesale.phone, /^\d{3}-\d{3}-\d{4}$/);
  for (const s of [cle, tb]) {
    assert.equal(s.priceAsOf, '2026-11-11');
    assert.ok(Object.keys(s.categoryUrls).length >= 10);
    for (const role of Object.keys(s.categoryUrls)) {
      assert.ok(suppliers.ROLES.includes(role), s.id + ' uses the role name ' + role);
      assert.equal(suppliers.safeUrl(s.categoryUrls[role]), s.categoryUrls[role]);
    }
  }
  // The research only had a Google site search for Christmas Lights Etc, and its "plugs" page was really the wire page.
  assert.equal(cle.searchUrlTemplate, null);
  assert.equal(cle.categoryUrls.plugs, undefined);
  assert.equal(suppliers.getSupplier('nobody'), null);
  assert.equal(suppliers.knownSupplierId('cle'), 'cle');
  assert.equal(suppliers.knownSupplierId('nobody'), 'generic');
  assert.equal(suppliers.knownSupplierId(null), 'generic');
});

test('supplierSearchUrl and findUrl: category page first, then the supplier\'s own search, else nothing', () => {
  assert.equal(suppliers.supplierSearchUrl('1000bulbs', 'outdoor 3-way tap & "more"'), 'https://www.1000bulbs.com/fil/search?q=outdoor+3-way+tap+%26+%22more%22');
  assert.equal(suppliers.supplierSearchUrl('1000bulbs', '   '), null);
  assert.equal(suppliers.supplierSearchUrl('cle', 'clips'), null);
  assert.equal(suppliers.supplierSearchUrl('generic', 'clips'), null);
  assert.equal(suppliers.findUrl('cle', 'clips', 'anything'), suppliers.getSupplier('cle').categoryUrls.clips);
  assert.equal(suppliers.findUrl('cle', 'plugs', 'male plug'), null);
  assert.equal(suppliers.findUrl('1000bulbs', 'extensionCords', 'outdoor extension cord 25 ft'), 'https://www.1000bulbs.com/fil/search?q=outdoor+extension+cord+25+ft');
  assert.equal(suppliers.findUrl('1000bulbs', 'toString', 'x y'), 'https://www.1000bulbs.com/fil/search?q=x+y', 'inherited keys are not roles');
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

test('every supplier product can be planned, is priced as "observed" on 2026-11-11 and passes project validation', () => {
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
    assert.equal(p.priceStatus, 'observed', p.id + ': nothing was confirmed on a live page');
    assert.equal(p.priceAsOf, '2026-11-11');
    assert.equal(design.productDataProblem(p), null, p.id);
    assert.ok(p.wattsPerUnit > 0 && p.price > 0 && p.maxEndToEnd > 0, p.id + ' has watts, a price and a run limit');
    assert.equal(p.tech, 'LED');
    assert.equal(suppliers.safeUrl(p.url), p.url, p.id);
    assert.ok(hosts.includes(new URL(p.url).host), p.id);
    assert.ok(p.supplierSku === null || (typeof p.supplierSku === 'string' && p.supplierSku), p.id);
    if (p.supplierSku === null && p.kind !== 'bulk') assert.match(p.orderNote, /Part number not confirmed: order from the link\./, p.id);
    assert.ok(p.colors.every((c) => schema.ENUMS.colorMode.includes(c)));
  }
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
    assert.equal(p.maxEndToEnd, 250, '250 bulbs or 250 ft of line, whichever comes first');
    assert.equal(p.maxRunFt, 250);
    assert.ok(Math.abs(p.maxConnectedW - 250 * c.bulb.wattsEach) < 1e-9, p.id + ': one run carries at most 250 bulbs');
    assert.ok(p.maxConnectedW <= c.wire.maxAmps * 120 * 0.8, p.id + ': and never more than the wire rating');
    assert.equal(p.equiv, p.category === 'c9' ? 'c9-led' : 'c7-led');
    assert.equal(c.bulb.base, p.category === 'c9' ? 'E17' : 'E12');
    assert.deepEqual([c.wire.spoolFt, c.wire.wireType, c.bulb.packQty, c.bulb.defaultVariant], [1000, 'SPT-1', 25, 'warmWhite']);
    assert.deepEqual(Object.keys(c.bulb.variants), ['warmWhite', 'coolWhite', 'multi', 'red', 'green']);
    const perFoot = c.wire.price / 1000 + c.bulb.variants.warmWhite.price / 25;
    assert.equal(p.price, Math.round(perFoot * 100) / 100, p.id + ': per-foot price is derived from the parts');
    for (const { part, offer } of suppliers.componentOffers(p)) {
      assert.ok(typeof offer.sku === 'string' && offer.sku.startsWith(p.supplierId + ':'), p.id + ' ' + part);
      if (offer.supplierSku) assert.equal(offer.sku, p.supplierId + ':' + offer.supplierSku);
      else assert.match(offer.notes, /Part number not confirmed: order from the link\./);
      assert.ok(offer.price > 0 && offer.packQty > 0 && offer.name);
      assert.deepEqual([offer.priceStatus, offer.priceAsOf], ['observed', '2026-11-11']);
      assert.equal(suppliers.safeUrl(offer.url), offer.url);
      assert.equal(suppliers.catalogPrice(offer.sku), offer.price);
    }
    for (const s of c.wire.sizes || []) assert.ok(s.lengthFt > 0 && s.lengthFt < c.wire.spoolFt && /SPT-1/.test(s.name));
  }
  const [cle9, cle7, tb9, tb7] = bulk;
  assert.deepEqual([cle9.wattsPerUnit, cle7.wattsPerUnit, tb9.wattsPerUnit, tb7.wattsPerUnit], [0.8, 0.8, 0.74, 0.48], 'watts per bulb as each supplier lists them');
  assert.deepEqual(cle9.components.wire.sizes.map((s) => s.lengthFt), [100, 25]);
  assert.deepEqual(tb9.components.wire.sizes.map((s) => [s.lengthFt, s.supplierSku]), [[100, 'CMS-10124']]);
  assert.ok(cle9.components.plugMale && cle9.components.plugFemale);
  assert.equal(tb9.components.plugMale.supplierSku, 'PLUG-10001');
  assert.equal(tb9.components.plugFemale, null, 'the female plug was shown as unavailable, so it is not offered');
});

test('doubtful research entries are left out, and unconfirmed part numbers are not shown as part numbers', () => {
  const text = JSON.stringify([suppliers.SUPPLIER_PRODUCTS, suppliers.SUPPLIER_ACCESSORIES]);
  // Unavailable, old product line, incandescent, no product page, no listed watts.
  for (const gone of ['PLUG-10002', 'SHL-LED70ICEWW', 'TRUNK8CLRG', 'CMS-WIRE1000GR2', 'CMS-25C7-8GWW', 'CMS-10126', 'CMS-10119', '86287', '72526', '85135']) {
    assert.ok(!text.includes('"' + gone + '"') && !text.includes(':' + gone + '"'), gone + ' is not offered');
  }
  const skus = [];
  for (const p of suppliers.SUPPLIER_PRODUCTS) {
    skus.push(p.supplierSku);
    for (const c of suppliers.componentOffers(p)) skus.push(c.offer.supplierSku);
  }
  // Page numbers that were mistaken for item numbers, the two C7 numbers that disagree, and a table id.
  for (const doubtful of ['15085', '15054', '15098', '15100', '87773', '72606', '20275', 'CMS-10284']) assert.ok(!skus.includes(doubtful), doubtful);
  const c7 = suppliers.SUPPLIER_PRODUCTS.find((p) => p.id === 'cle:c7-bulk-12').components.bulb.variants;
  assert.deepEqual([c7.warmWhite.supplierSku, c7.coolWhite.supplierSku, c7.red.supplierSku], [null, null, '72615']);
  assert.equal(c7.warmWhite.sku, 'cle:c7-opticore-warm-white');
  assert.match(c7.warmWhite.url, /C7--Warm-White-OptiCore/);
});

test('SUPPLIER_ACCESSORIES map onto the generic accessory skus', () => {
  const known = new Set(catalog.ACCESSORIES.map((a) => a.sku));
  assert.deepEqual(Object.keys(suppliers.SUPPLIER_ACCESSORIES), ['cle', '1000bulbs']);
  assert.deepEqual(Object.keys(suppliers.SUPPLIER_ACCESSORIES.cle), ['clip-allinone', 'clip-shingle', 'light-stakes', 'timer-outdoor']);
  assert.deepEqual(Object.keys(suppliers.SUPPLIER_ACCESSORIES['1000bulbs']), ['clip-allinone', 'clip-shingle', 'clip-ridge', 'light-stakes', 'timer-outdoor']);
  for (const sid of Object.keys(suppliers.SUPPLIER_ACCESSORIES)) {
    for (const [key, o] of Object.entries(suppliers.SUPPLIER_ACCESSORIES[sid])) {
      assert.ok(known.has(key), key);
      assert.equal(o.sku, sid + ':' + o.supplierSku);
      assert.ok(o.price > 0 && o.packQty >= 1 && o.name);
      assert.deepEqual([o.priceStatus, o.priceAsOf], ['observed', '2026-11-11']);
      assert.deepEqual(suppliers.accessoryOffer(sid, key), o);
    }
  }
  assert.equal(suppliers.accessoryOffer('cle', 'clip-ridge'), null, 'seen out of stock, so not offered');
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
  assert.deepEqual(hosts, ['shop.1000bulbs.com', 'wintergreencorp.com', 'www.1000bulbs.com', 'www.christmaslightsetc.com']);
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
  assert.deepEqual(Array.from(kinds).sort(), ['1000bulbs:category', '1000bulbs:product', '1000bulbs:search', '1000bulbs:site', '1000bulbs:wholesale',
    'cle:category', 'cle:product', 'cle:site', 'cle:wholesale']);
  // Every product, component and accessory link is in the list.
  const urls = new Set(links.map((l) => l.url));
  for (const p of suppliers.SUPPLIER_PRODUCTS) {
    if (p.kind !== 'bulk') assert.ok(urls.has(p.url), p.id);
    for (const c of suppliers.componentOffers(p)) assert.ok(urls.has(c.offer.url), c.offer.sku);
  }
  for (const m of Object.values(suppliers.SUPPLIER_ACCESSORIES)) for (const o of Object.values(m)) assert.ok(urls.has(o.url), o.sku);
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
  // C7 as the roofline default: 1000Bulbs has only the bulk C7 on file.
  const c7 = { typeDefaults: { roofline: 'c7-led' } };
  const tbStrings = catalog.getLibrary({ library: { products: null, supplierId: '1000bulbs', config: Object.assign({ buying: { style: 'strings' } }, c7) } });
  assert.deepEqual(pick('roofline', tbStrings), ['c7-led', 'typeDefault']);
  const tbBulk = catalog.getLibrary({ library: { products: null, supplierId: '1000bulbs', config: c7 } });
  assert.deepEqual(pick('roofline', tbBulk), ['1000bulbs:c7-bulk-12', 'supplier']);
  // The bulk product turned off: the supplier's ready-made string does the job.
  const products = catalog.getLibrary(null).products.map((p) => (p.id === 'cle:c9-bulk-12' ? Object.assign({}, p, { enabled: false }) : p));
  const noBulk = catalog.getLibrary({ library: { products, config: null, supplierId: 'cle' } });
  assert.deepEqual(pick('roofline', noBulk), ['cle:c9-string-25', 'supplier']);
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
  const male = lineBy(b, 'cle:67083'), female = lineBy(b, 'cle:67081');
  assert.deepEqual([male.qty, male.usedQty, female.qty, female.usedQty], [1, 0.4, 1, 0.4]);
  assert.match(male.notes, /^One for each length of wire that is cut: 2 needed, 5 bought\. It goes on the end where the cord arrives\./);
  assert.match(female.notes, /2 needed, 5 bought\. It goes on the far end, so the next run or a jumper cord can plug in\./);
  const wire = b.lines.filter((l) => /socket wire/.test(l.name));
  assert.deepEqual(wire.map((l) => [l.qty, l.unit]), [[3, 'each'], [2, 'each']], '3 x 100 ft + 2 x 25 ft is cheaper than a spool');
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
  assert.match(lineBy(bill, 'cle:67083').notes, /: 2 needed, 5 bought\./);
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
  assert.deepEqual(shape(wireLines(139)), [['cle:c9-stringer-100-spt1', 1, 'each', 54.99, 54.99], ['cle:c9-stringer-25-spt1', 2, 'each', 14.99, 29.98]]);
  assert.deepEqual(shape(wireLines(20)), [['cle:c9-stringer-25-spt1', 1, 'each', 14.99, 14.99]]);
  assert.deepEqual(shape(wireLines(100)), [['cle:c9-stringer-100-spt1', 1, 'each', 54.99, 54.99]]);
  // 760 ft: seven 100 ft lengths and three 25 ft lengths would cost $429.90, a spool is $409.99.
  assert.deepEqual(shape(wireLines(760)), [['cle:c9-spool-1000-spt1', 1, 'spool', 409.99, 409.99]]);
  assert.deepEqual(shape(wireLines(1090)), [['cle:c9-spool-1000-spt1', 1, 'spool', 409.99, 409.99], ['cle:c9-stringer-100-spt1', 1, 'each', 54.99, 54.99]]);
  const [w100, w25] = wireLines(139);
  assert.equal(w100.notes, '139 ft needed for Eave (139 ft). Bought as 1 × 100 ft + 2 × 25 ft = 150 ft, 11 ft left over. Part number not confirmed: order from the link.');
  assert.equal(w25.notes, w100.notes);
  assert.deepEqual([w100.usedQty, w25.usedQty], [0.9267, 1.8533]);
  assert.equal(wireLines(760)[0].notes, '760 ft needed for Eave (760 ft). 1,000 ft bought, 240 ft left over. The page lists 7 A in one place and 8 A in another; LightPlan uses 7 A. ' +
    'Part number not confirmed: order from the link.');
  // Several runs of the same product share the wire; the C7 product has only the spool.
  const b = bom.buildBom(project(), [bulkRun('A', { quantity: 60 }), bulkRun('B', { quantity: 30 }), bulkRun('C', { productId: 'cle:c7-bulk-12', quantity: 12 })], power(), lib);
  const lights = b.lines.filter((l) => l.category === 'lights');
  assert.deepEqual(lights.map((l) => [l.sku, l.qty]), [
    ['cle:c9-stringer-100-spt1', 1], ['cle:72636', 4], ['cle:67083', 1], ['cle:67081', 1],
    ['cle:c7-spool-1000-spt1', 1], ['cle:c7-opticore-warm-white', 1], ['cle:67083', 1], ['cle:67081', 1],
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
  ];
  const b = bom.buildBom(project(), runs, power(), lib);
  const bulbs = b.lines.filter((l) => /bulbs/.test(l.name));
  assert.deepEqual(bulbs.map((l) => [l.sku, l.supplierSku, l.qty, l.usedQty]), [
    ['cle:72636', '72636', 2, 1.68],   // warm white: 38 + 4 of Sky
    ['cle:72639', '72639', 1, 0.56],   // cool white: 10 + 4 of Sky
    ['cle:72642', '72642', 2, 1.2],    // the supplier's multicolor box
    ['cle:72645', '72645', 1, 0.52],   // red: 13 of 25 (the first colour gets the odd one)
    ['cle:72654', '72654', 1, 0.48],   // green: 12 of 25
    ['cle:72636:blue', null, 1, 0.16], // not on file: priced like warm white, no part number
  ]);
  assert.equal(lineBy(b, 'cle:72636').notes, '42 bulbs needed for Warm (38), Sky (4). 50 bought, 8 spare.');
  assert.equal(lineBy(b, 'cle:72645').notes, '13 bulbs needed for Candy (13). 25 bought, 12 spare. ' +
    'Watts are the bulb family\'s listed figure; this colour\'s own page did not show them.');
  const blue = lineBy(b, 'cle:72636:blue');
  assert.equal(blue.name, 'C9 OptiCore LED bulbs, faceted, box of 25 - Blue (choose the colour at the supplier)');
  assert.deepEqual([blue.unitPrice, blue.url, blue.findUrl, blue.supplierId, blue.priceStatus], [32.99, null, suppliers.getSupplier('cle').categoryUrls.c9Bulbs, 'cle', 'observed']);
  assert.match(blue.notes, /^4 bulbs needed for Sky \(4\)\. 25 bought, 21 spare\. No blue bulb is on file for this supplier, so it is priced like warm white: choose the colour at the supplier\.$/);
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
  assert.match(lineBy(none, 'cle:67083').notes, /: 3 needed, 5 bought\./);
  assert.match(lineBy(none, 'cle:67081').notes, /: 3 needed, 5 bought\./);
  // A and B are one cut length (one feed); C is on a feed of its own; a feed of other lights does not count.
  const feeds = [{ id: 'fd_1', runIds: ['run_A', 'run_B'] }, { id: 'fd_2', runIds: ['run_C'] }, { id: 'fd_3', runIds: ['run_other'] }];
  const two = bom.buildBom(project(), runs, power({ feeds }), lib);
  assert.match(lineBy(two, 'cle:67083').notes, /: 2 needed, 5 bought\./);
  assert.deepEqual([lineBy(two, 'cle:67083').qty, lineBy(two, 'cle:67083').usedQty], [1, 0.4]);
  // A split run (two feeds) needs two pairs; a run on no feed still needs one.
  const split = bom.buildBom(project(), runs, power({ feeds: [{ id: 'fd_1', runIds: ['run_A'] }, { id: 'fd_2', runIds: ['run_A'] }, { id: 'fd_3', runIds: ['run_B'] }] }), lib);
  assert.match(lineBy(split, 'cle:67083').notes, /: 4 needed, 5 bought\./);
  const six = bom.buildBom(project(), ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => bulkRun(n)), power(), lib);
  assert.deepEqual([lineBy(six, 'cle:67083').qty, lineBy(six, 'cle:67081').qty], [2, 2]);
  assert.match(lineBy(six, 'cle:67083').notes, /Pack size not confirmed \(the page address says 1-pack\): check it before you order\.$/);
  // 1000Bulbs has no female plug on file: a plain line with a link to its plug page.
  const tb = bom.buildBom(project(), [bulkRun('A', { productId: '1000bulbs:c9-bulk-12' })], power(), libFor('1000bulbs'));
  const male = lineBy(tb, '1000bulbs:PLUG-10001'), female = lineBy(tb, 'plug-spt1-female');
  assert.deepEqual([male.supplierId, male.supplierSku, male.unitPrice, male.priceStatus], ['1000bulbs', 'PLUG-10001', 6.73, 'observed']);
  assert.deepEqual([female.name, female.supplierId, female.supplierName, female.supplierSku, female.url, female.findUrl, female.unitPrice, female.priceStatus, female.category],
    ['Slide-on female plugs for SPT-1 socket wire, pack of 10', null, 'Any store', null, null, 'https://www.1000bulbs.com/category/christmas-light-plugs', 7.99, 'default', 'lights']);
  assert.match(female.notes, /No part number is on file for this plug: pick the one that matches the wire\.$/);
});

test('bulk BOM: cost basis "used" charges only the share used and buys wire by the cheapest foot', () => {
  const runs = [bulkRun('Eave', { quantity: 139 })];
  const bought = bom.buildBom(project(), runs, power(), libFor('cle'));
  const used = bom.buildBom(project(), runs, power(), libFor('cle', { costBasis: 'used' }));
  const row = (b) => b.lines.map((l) => [l.sku, l.qty, l.usedQty, l.total, l.buyTotal]);
  assert.deepEqual(row(bought), [
    ['cle:c9-stringer-100-spt1', 1, 0.9267, 54.99, 54.99], ['cle:c9-stringer-25-spt1', 2, 1.8533, 29.98, 29.98],
    ['cle:72636', 6, 5.56, 197.94, 197.94], ['cle:67083', 1, 0.2, 6.2, 6.2], ['cle:67081', 1, 0.2, 6.2, 6.2],
  ]);
  assert.deepEqual(row(used), [
    ['cle:c9-spool-1000-spt1', 1, 0.139, 56.99, 409.99],   // 139 ft at $0.41 a foot; the rest of the spool goes to the next job
    ['cle:72636', 6, 5.56, 183.42, 197.94],                  // 139 bulbs at $1.32
    ['cle:67083', 1, 0.2, 1.24, 6.2], ['cle:67081', 1, 0.2, 1.24, 6.2],
  ]);
  for (const b of [bought, used]) {
    for (const l of b.lines) {
      assert.equal(l.lineTotal, l.total);
      assert.equal(l.buyTotal, bom.round2(l.qty * l.unitPrice));
    }
    assert.equal(b.subtotal, bom.round2(b.lines.reduce((s, l) => s + l.total, 0)));
    assert.equal(b.byCategory.lights, b.subtotal);
  }
  assert.equal(bought.subtotal, 295.31);
  assert.equal(used.subtotal, 242.89);
  // The order sheet always lists what is ordered, whatever the basis.
  assert.equal(bom.orderSheets(used, libFor('cle', { costBasis: 'used' }))[0].subtotal, 620.33);
  // Lines that are not bulk parts are never charged by share.
  const mixed = bom.buildBom(project(), runs.concat([bulkRun('Win', { productId: 'cle:mini-5mm-70', unit: 'string', quantity: 3, clips: { type: 'adhesive', count: 30 } })]),
    power(), libFor('cle', { costBasis: 'used' }));
  for (const l of mixed.lines.filter((x) => /mini string|clips/i.test(x.name))) assert.deepEqual([l.usedQty, l.total], [l.qty, l.buyTotal]);
});

test('bulk BOM: your own prices drive the choice and are marked "yours"; a broken product falls back to a per-foot line', () => {
  const runs = [bulkRun('Eave', { quantity: 139 })];
  const lib = libFor('cle');
  // An account price for the spool that beats the ready-made lengths.
  const b = bom.buildBom(project({ pricing: { overrides: { 'cle:c9-spool-1000-spt1': 60, 'cle:72636': 20 } } }), runs, power(), lib);
  const spool = lineBy(b, 'cle:c9-spool-1000-spt1');
  assert.deepEqual([spool.qty, spool.unitPrice, spool.defaultPrice, spool.overridden, spool.priceStatus, spool.priceAsOf], [1, 60, 409.99, true, 'yours', null]);
  assert.deepEqual([lineBy(b, 'cle:72636').unitPrice, lineBy(b, 'cle:72636').priceStatus], [20, 'yours']);
  assert.deepEqual([lineBy(b, 'cle:67083').priceStatus, lineBy(b, 'cle:67083').priceAsOf], ['observed', '2026-11-11']);
  // A price edited in the project's own product list is "yours" too.
  const edited = clone(lib);
  edited.products.find((p) => p.id === 'cle:c9-bulk-12').components.bulb.variants.warmWhite.price = 27.5;
  const e = lineBy(bom.buildBom(project(), runs, power(), edited), 'cle:72636');
  assert.deepEqual([e.unitPrice, e.overridden, e.priceStatus, e.priceAsOf], [27.5, false, 'yours', null]);
  // Components that cannot be priced: one per-foot line at the product's own price, like any per-foot product.
  const broken = clone(lib);
  delete broken.products.find((p) => p.id === 'cle:c9-bulk-12').components.bulb;
  const f = bom.buildBom(project(), runs, power(), broken);
  assert.deepEqual(f.lines.map((l) => [l.sku, l.qty, l.unit, l.unitPrice, l.supplierId]), [['cle:c9-bulk-12', 139, 'foot', 1.73, 'cle']]);
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
    ['cle:82761', 1, 13.99, '82761', 'observed'],
    ['clip-gutter', 1, 9.99, null, 'default'],
    ['cle:83965', 1, 25, '83965', 'observed'],
    ['clip-ridge', 1, 11.99, null, 'default'],
    ['cord-16-25', 1, 14.99, null, 'default'],
    ['cle:80056', 1, 29.99, '80056', 'observed'],
    ['tap-3way', 1, 6.99, null, 'default'],
    ['cle:84144', 1, 9.99, '84144', 'observed'],
  ]);
  const cats = suppliers.getSupplier('cle').categoryUrls;
  const link = (b, sku) => { const l = lineBy(b, sku); return [l.supplierId, l.url, l.findUrl]; };
  assert.deepEqual(link(cle, 'cle:82761'), ['cle', suppliers.SUPPLIER_ACCESSORIES.cle['clip-allinone'].url, null]);
  assert.deepEqual(link(cle, 'clip-gutter'), [null, null, cats.clips]);
  assert.deepEqual(link(cle, 'cord-16-25'), [null, null, cats.extensionCords]);
  assert.deepEqual(link(cle, 'tap-3way'), [null, null, null], 'no page and no search at this supplier');
  assert.deepEqual(link(cle, 'treewrap-led'), [null, null, null]);
  assert.equal(lineBy(cle, 'cle:82761').name, 'All-in-one light clips (gutter or shingle), pack of 100');
  assert.equal(lineBy(cle, 'cle:84144').notes, '21 stakes for Stakes, in packs of 25.');

  const tb = bom.buildBom(project(), houseRuns().map((r) => (r.productId === 'cle:c9-bulk-12' ? Object.assign(r, { productId: '1000bulbs:c9-bulk-12' }) : r)), housePower(), libFor('1000bulbs'));
  assert.deepEqual(rest(tb), [
    ['treewrap-led', 2, 16.99, null, 'default'],
    ['1000bulbs:CLIP-10007', 1, 6.83, 'CLIP-10007', 'observed'],   // 40 clips in packs of 50
    ['clip-gutter', 1, 9.99, null, 'default'],
    ['1000bulbs:CLIP-10005', 1, 13.52, 'CLIP-10005', 'observed'],
    ['1000bulbs:CLIP-10003', 2, 17.59, 'CLIP-10003', 'observed'],  // 40 ridge clips in packs of 25
    ['cord-16-25', 1, 14.99, null, 'default'],
    ['1000bulbs:PLTS-12336', 1, 11.44, 'PLTS-12336', 'observed'],
    ['tap-3way', 1, 6.99, null, 'default'],
    ['1000bulbs:STAKE-10001', 1, 6.29, 'STAKE-10001', 'observed'],
  ]);
  assert.equal(lineBy(tb, '1000bulbs:CLIP-10003').notes, '36 clips + 10% spare = 40, in packs of 25.');
  assert.equal(lineBy(tb, 'tap-3way').findUrl, 'https://www.1000bulbs.com/fil/search?q=Outdoor+3-way+tap');
  assert.equal(lineBy(tb, 'cord-16-25').findUrl, 'https://www.1000bulbs.com/fil/search?q=outdoor+extension+cord+25+ft');
  assert.equal(lineBy(tb, 'treewrap-led').findUrl, suppliers.getSupplier('1000bulbs').categoryUrls.treeWrap);
  assert.match(lineBy(tb, '1000bulbs:STAKE-10001').notes, /check that it takes C7 or C9 before you order\.$/);
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
    if (l.supplierId) assert.deepEqual([l.supplierName, l.priceAsOf, l.priceStatus, l.findUrl === null || l.url === null], ['Christmas Lights Etc', '2026-11-11', 'observed', true]);
    else assert.deepEqual([l.supplierName, l.supplierSku, l.url, l.priceAsOf, l.priceStatus], ['Any store', null, null, null, 'default']);
    for (const u of [l.url, l.findUrl]) assert.ok(u === null || suppliers.safeUrl(u) === u);
  }
  // A product explicitly picked from another supplier keeps that supplier on its line.
  const other = bom.buildBom(project(), [bulkRun('Eave', { productId: '1000bulbs:c9-string-17', unit: 'string', quantity: 3 })], power(), libFor('cle'));
  assert.deepEqual([other.lines[0].supplierId, other.lines[0].supplierSku, other.lines[0].findUrl], ['1000bulbs', 'CMS-25C9-8GWW', null]);
  // The 70-light mini set has no confirmed part number: the line has the link and says so.
  const mini = bom.buildBom(project(), [bulkRun('Win', { productId: 'cle:mini-5mm-70', unit: 'string', quantity: 3 })], power(), libFor('cle')).lines[0];
  assert.deepEqual([mini.supplierId, mini.supplierSku, mini.priceStatus], ['cle', null, 'observed']);
  assert.match(mini.url, /^https:\/\/www\.christmaslightsetc\.com\//);
  assert.equal(mini.notes, 'For Win (3). The page lists more than one size: pick the 70-light set with bulbs 4 in apart. Part number not confirmed: order from the link.');
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
    ['cle', 'Christmas Lights Etc', 'https://www.christmaslightsetc.com/', 9],
    ['1000bulbs', '1000Bulbs', 'https://www.1000bulbs.com/', 1],
    ['generic', 'Any store', null, 5],
  ]);
  assert.equal(sheets[0].wholesale.phone, '855-942-7100');
  assert.equal(sheets[2].wholesale, null);
  assert.deepEqual([sheets[0].priceAsOf, sheets[2].priceAsOf], ['2026-11-11', null]);
  for (const s of sheets) {
    assert.equal(s.subtotal, bom.round2(s.lines.reduce((t, l) => t + l.total, 0)));
    for (const l of s.lines) assert.deepEqual(Object.keys(l), ['supplierSku', 'name', 'qty', 'unit', 'unitPrice', 'total', 'url', 'findUrl', 'priceStatus', 'priceAsOf', 'notes', 'sku']);
  }
  assert.equal(bom.round2(sheets.reduce((t, s) => t + s.subtotal, 0)), bom.round2(b.lines.reduce((t, l) => t + l.buyTotal, 0)));
  const bulbs = sheets[0].lines.find((l) => l.supplierSku === '72636');
  assert.deepEqual([bulbs.qty, bulbs.unit, bulbs.unitPrice, bulbs.total, bulbs.url], [6, 'pack', 32.99, 197.94, 'https://www.christmaslightsetc.com/p/C9--Warm-White-OptiCore-LED-Replacement-Bulbs-13603.htm']);
  assert.deepEqual(sheets[2].lines.map((l) => l.sku), ['treewrap-led', 'clip-gutter', 'clip-ridge', 'cord-16-25', 'tap-3way']);
  // No supplier: one "Any store" sheet. Nothing to order: no sheets. Bad input: no sheets, no throw.
  const plain = bom.buildBom(project(), [bulkRun('E', { productId: 'c9-led', unit: 'string', quantity: 2 })], power(), libFor('generic'));
  assert.deepEqual(bom.orderSheets(plain, libFor('generic')).map((s) => [s.supplierId, s.lines.length, s.subtotal]), [['generic', 1, 65.98]]);
  assert.deepEqual(bom.orderSheets(bom.emptyBom(), lib), []);
  assert.deepEqual(bom.orderSheets(null, null), []);
  assert.deepEqual(bom.orderSheets({ lines: [null, 7, { qty: 0 }] }, 'x'), []);

  // Text and CSV of one sheet.
  const text = bom.orderSheetToText(sheets[0]).split('\n');
  assert.equal(text[0], 'Order from Christmas Lights Etc (https://www.christmaslightsetc.com/)');
  assert.ok(text.includes('6 × Part 72636: C9 OptiCore LED bulbs, warm white, faceted, box of 25 - $32.99 each = $197.94 (as of Nov 11, 2026 (check the price))'), text.join('\n'));
  assert.ok(text.includes('  https://www.christmaslightsetc.com/p/C9--Warm-White-OptiCore-LED-Replacement-Bulbs-13603.htm'));
  assert.equal(text[text.length - 2], 'Subtotal: $' + sheets[0].subtotal.toFixed(2));
  assert.equal(text[text.length - 1], 'Prices were last checked on Nov 11, 2026; confirm at checkout. Account (wholesale) prices differ: edit any price.');
  const csv = bom.orderSheetToCsv(sheets[0]);
  const rows = csv.trim().split('\r\n');
  assert.equal(rows[0], 'Part number,Item,Qty,Unit,Unit Price,Total,Price status,Link,Notes');
  assert.equal(rows.length, 1 + 9 + 4);
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
  assert.match(bulbs, /,Christmas Lights Etc,72636,"?as of Nov 11, 2026 \(check the price\)"?,https:\/\/www\.christmaslightsetc\.com\/p\/C9--Warm-White-OptiCore-LED-Replacement-Bulbs-13603\.htm$/);
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
  assert.deepEqual(b.lines.map((l) => [l.sku, l.qty]), [['1000bulbs:CMS-10105', 1], ['1000bulbs:CMS-10294:red', 2], ['plug-spt1-male', 1], ['plug-spt1-female', 1]]);
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
      if (l.supplierId) assert.deepEqual([l.supplierId, l.priceStatus, l.priceAsOf], [sid, 'observed', '2026-11-11'], tag + ' ' + l.name);
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
  assert.deepEqual(lights.map((l) => [l.sku, l.qty]), [['cle:c9-stringer-100-spt1', 1], ['cle:c9-stringer-25-spt1', 2], ['cle:72636', 6], ['cle:67083', 1], ['cle:67081', 1]]);
  assert.match(lights[0].notes, /^139 ft needed for Front eave \(38 ft\), Garage gutter \(25 ft\)/);
  assert.match(lights[3].notes, /: 3 needed, 5 bought\./);
  assert.equal(plan.summary.watts, 339.2);
  // Installer basis: the same order, a smaller job cost.
  const used = samplePlan('cle', { style: 'bulk', costBasis: 'used' }).plan;
  assert.ok(used.bom.subtotal < plan.bom.subtotal);
  assert.ok(bom.orderSheets(used.bom, used.library)[0].subtotal > bom.orderSheets(plan.bom, plan.library)[0].subtotal, 'a whole spool is ordered');
});
