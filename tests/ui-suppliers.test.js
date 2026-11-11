// Suppliers in the UI (SPEC §8.3 and §8.5): choosing who to buy from, the wording shared by the Design step, the
// Review step and the PDF (ui.export), the product picker groups and the list that is saved after a product edit.
// Expected numbers are read from the plan and the supplier map, never pinned.
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

for (const f of ['persist', 'store', 'imagesource', 'actions', 'export', 'panels']) require(path.join(__dirname, '..', 'src', 'ui', f + '.js'));

const catalog = LP.require('catalog');
const suppliers = LP.require('suppliers');
const schema = LP.require('schema');
const sample = LP.require('sample');
const planModule = LP.require('plan');
const design = LP.require('design');
const bom = LP.require('bom');
const exp = LP.require('ui.export');
const panels = LP.require('ui.panels');
const storeMod = LP.require('ui.store');
const actionsMod = LP.require('ui.actions');

const clone = (v) => JSON.parse(JSON.stringify(v));
const tracedSample = () => schema.normalizeProject(sample.createSample({ traced: true }).project);
function setup(project) {
  const store = storeMod.createStore({ project: project || tracedSample(), persist: null, now: () => '2026-11-11T12:00:00.000Z' });
  return { store, actions: actionsMod.createActions(store) };
}
/** The sample planned for a supplier: {project, plan}. */
function planned(supplierId, buying, mutate) {
  const project = tracedSample();
  project.library = { products: null, config: buying ? { buying } : null, supplierId };
  if (mutate) mutate(project);
  return { project, plan: planModule.computePlan(project) };
}
const DATE = suppliers.formatDate(suppliers.PRICE_AS_OF);   // "Nov 11, 2026"
const SUPPLIER_IDS = suppliers.SUPPLIERS.map((s) => s.id).filter((id) => id !== suppliers.GENERIC_ID);

// ---------------------------------------------------------------- choosing who to buy from
test('setSupplier: every run on Auto switches to the supplier\'s product, a run with its own product keeps it, and it is one undo step', () => {
  const { store, actions } = setup();
  const before = store.plan();
  const total = before.bom.subtotal;
  const firstRun = before.runs[0];
  // One run gets a product of its own first: it must stay through every supplier change.
  const pinned = before.runs.find((r) => r.featureType === 'window');
  actions.updateFeature(pinned.featureId, { productId: 'rope-led-18' });
  const pinnedPlan = store.plan();
  const pinnedTotal = pinnedPlan.bom.subtotal;

  for (const sid of SUPPLIER_IDS) {
    assert.equal(actions.setSupplier(sid), true, 'choosing ' + sid + ' changes the project');
    assert.equal(store.project().library.supplierId, sid);
    assert.equal(store.undoLabel(), 'Buy from ' + suppliers.getSupplier(sid).name);
    const plan = store.plan();
    assert.equal(plan.library.supplierId, sid);
    const equivs = new Set(suppliers.SUPPLIER_PRODUCTS.filter((p) => p.supplierId === sid).map((p) => p.equiv));
    for (const run of plan.runs) {
      const was = pinnedPlan.runs.find((r) => r.featureId === run.featureId);
      if (run.featureId === pinned.featureId) { assert.equal(run.productId, 'rope-led-18', 'the run with its own product keeps it'); continue; }
      if (equivs.has(was.productId)) {
        const product = catalog.getProduct(plan.library.products, run.productId);
        assert.equal(product.supplierId, sid, run.label + ' now uses a ' + sid + ' product');
        assert.equal(product.equiv, was.productId, 'and it is the one that does the same job');
      } else assert.equal(run.productId, was.productId, run.label + ' has nothing on file at ' + sid + ' and stays');
    }
    assert.ok(plan.runs.some((r) => r.supplierId === sid), 'some runs switched');
    assert.equal(actions.setSupplier(sid), false, 'choosing the same supplier again is not a change');
  }
  // Back to any store: the field is cleared and the totals are exactly what they were.
  assert.equal(actions.setSupplier('generic'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(store.project().library, 'supplierId'), false, 'any store leaves no supplier field behind');
  assert.equal(store.undoLabel(), 'Buy from any store');
  assert.equal(store.plan().bom.subtotal, pinnedTotal);
  assert.deepEqual(store.plan().bom.lines.map((l) => [l.sku, l.qty, l.lineTotal]), pinnedPlan.bom.lines.map((l) => [l.sku, l.qty, l.lineTotal]));
  // Undo walks back one choice at a time.
  store.undo();
  assert.equal(store.project().library.supplierId, SUPPLIER_IDS[SUPPLIER_IDS.length - 1]);
  for (let i = 0; i < SUPPLIER_IDS.length; i++) store.undo();
  assert.equal(store.plan().bom.subtotal, pinnedTotal, 'undoing every choice is any store again');
  store.undo();
  assert.equal(store.plan().bom.subtotal, total, 'and one more undo takes the product choice back');
  assert.equal(store.plan().runs[0].productId, firstRun.productId);
  // An unknown supplier is any store.
  assert.equal(actions.setSupplier('nobody'), false);
  assert.equal(actions.setSupplier('cle'), true);
  assert.equal(actions.setSupplier('nobody'), true);
  assert.equal(store.plan().library.supplierId, 'generic');
});

test('setBuying: style and cost basis are stored only when they differ from the default, validated, and undoable', () => {
  const { store, actions } = setup();
  actions.setSupplier('cle');
  const bulkPlan = store.plan();
  assert.equal(bulkPlan.library.config.buying.style, 'bulk');
  assert.ok(bulkPlan.runs.some((r) => r.productKind === 'bulk'), 'cut-to-length is the default way to buy C7 and C9');

  assert.equal(actions.setBuying({ style: 'strings' }), true);
  assert.deepEqual(store.project().library.config, { buying: { style: 'strings' } });
  assert.equal(store.undoLabel(), 'Change how C7 and C9 are bought');
  const strings = store.plan();
  assert.ok(!strings.runs.some((r) => r.productKind === 'bulk'), 'ready-made strings: no cut-to-length run is left');
  assert.ok(strings.runs.some((r) => r.supplierId === 'cle'), 'and the strings are still the supplier\'s');
  assert.ok(strings.bom.lines.every((l) => l.usedQty === l.qty), 'nothing is bought by the spool or box any more');

  assert.equal(actions.setBuying({ costBasis: 'used' }), true);
  assert.deepEqual(store.project().library.config, { buying: { style: 'strings', costBasis: 'used' } });
  assert.equal(store.undoLabel(), 'Change what the job is charged for');
  assert.equal(actions.setBuying({ costBasis: 'used' }), false, 'the same value again is not a change');
  assert.equal(actions.setBuying({ style: 'by the yard', costBasis: 7 }), false, 'words the planner does not know are ignored');
  assert.equal(actions.setBuying(null), false);

  // Back to the defaults: nothing is left in the stored config.
  actions.setBuying({ style: 'bulk' });
  actions.setBuying({ costBasis: 'bought' });
  assert.equal(store.project().library.config, null);
  assert.equal(store.plan().bom.subtotal, bulkPlan.bom.subtotal);
  // Other rules of thumb survive a buying change.
  actions.setLibraryConfig({ clipSpacingIn: 6 });
  actions.setBuying({ costBasis: 'used' });
  assert.deepEqual(store.project().library.config, { clipSpacingIn: 6, buying: { costBasis: 'used' } });
  actions.setBuying({ costBasis: 'bought' });
  assert.deepEqual(store.project().library.config, { clipSpacingIn: 6 });
  store.undo();
  assert.deepEqual(store.project().library.config, { clipSpacingIn: 6, buying: { costBasis: 'used' } }, 'one undo step per change');
});

test('cost basis "used" charges the job for the share it uses; the order sheets still total what is ordered', () => {
  // "Only what is used" is an installer's costing: it applies with installer mode on (review finding U04).
  const installer = (p) => { p.quote = Object.assign({}, p.quote, { enabled: true }); };
  const bought = planned('cle', null, installer);
  const used = planned('cle', { costBasis: 'used' }, installer);
  assert.deepEqual(planned('cle', { costBasis: 'used' }).plan.bom.subtotal, planned('cle').plan.bom.subtotal, 'installer mode off: priced as everything ordered');
  const shares = used.plan.bom.lines.filter((l) => l.usedQty < l.qty);
  assert.ok(shares.length >= 3, 'wire, bulbs and plugs are bought by the spool, box and pack');
  assert.ok(used.plan.bom.subtotal < bought.plan.bom.subtotal, 'the job costs less when leftovers are kept');
  for (const l of shares) assert.ok(l.lineTotal < l.buyTotal, l.name + ' is charged for less than the whole order');
  const sheets = bom.orderSheets(used.plan.bom, used.plan.library);
  const orderTotal = sheets.reduce((t, s) => t + s.subtotal, 0);
  const buyTotal = used.plan.bom.lines.reduce((t, l) => t + l.buyTotal, 0);
  assert.ok(Math.abs(orderTotal - buyTotal) < 0.005, 'order sheets add up to what is ordered');
});

// ---------------------------------------------------------------- wording shared with the PDF (ui.export)
test('priceStatusLabel says how fresh a price is in a few words', () => {
  assert.deepEqual(exp.priceStatusLabel({ priceStatus: 'verified', priceAsOf: suppliers.PRICE_AS_OF }), { kind: 'checked', text: 'as of ' + DATE + ' · checked', date: DATE });
  assert.deepEqual(exp.priceStatusLabel({ priceStatus: 'observed', priceAsOf: suppliers.PRICE_AS_OF }), { kind: 'check', text: 'as of ' + DATE + ' · check price', date: DATE });
  assert.equal(exp.priceStatusLabel({ priceStatus: 'yours', priceAsOf: null }).text, 'your price');
  assert.equal(exp.priceStatusLabel({ priceStatus: 'verified', priceAsOf: suppliers.PRICE_AS_OF, overridden: true }).kind, 'yours', 'an edited line is the user\'s price whatever it was');
  assert.equal(exp.priceStatusLabel({ priceStatus: 'default' }).text, 'typical price');
  assert.equal(exp.priceStatusLabel(null).kind, 'typical');
  assert.equal(exp.priceStatusLabel({ priceStatus: 'observed' }).text, 'check price', 'no date, no "as of"');
});

test('priceSentence is built from the dates and statuses of the items it is about', () => {
  const v = { priceStatus: 'verified', priceAsOf: '2026-11-11' };
  const o = { priceStatus: 'observed', priceAsOf: '2026-11-11' };
  const account = 'Your account price may be lower: edit any price.';
  assert.equal(exp.priceSentence([v, v]), 'Prices are as of Nov 11, 2026, checked on the supplier\'s page. ' + account);
  assert.equal(exp.priceSentence([o]), 'Prices are as of Nov 11, 2026, seen in a listing, not confirmed. ' + account);
  assert.equal(exp.priceSentence([v, v, o]), 'Prices are as of Nov 11, 2026: 2 checked on the supplier\'s page, 1 seen in a listing, not confirmed. ' + account);
  assert.equal(exp.priceSentence([v, o], { account: false }), 'Prices are as of Nov 11, 2026: 1 checked on the supplier\'s page, 1 seen in a listing, not confirmed.');
  assert.equal(exp.priceSentence([v, { priceStatus: 'verified', priceAsOf: '2026-10-02' }]).slice(0, 30), 'Prices are as of Oct 2, 2026, ', 'the oldest date is the honest one');
  assert.equal(exp.priceSentence([{ priceStatus: 'default' }]), 'Typical store prices, not one brand: check the price where you buy.');
  assert.equal(exp.priceSentence([{ priceStatus: 'yours' }]), 'These are your own prices.');
  assert.match(exp.priceSentence([v, { priceStatus: 'yours' }, { priceStatus: 'default' }]), /checked on the supplier's page\. 1 is your own price\. The 1 any-store item is a typical price\. Your account price/);
  assert.equal(exp.priceSentence([]), '');
  assert.equal(exp.priceSentence(null), '');
});

test('supplierFacts reads the supplier map and invents nothing', () => {
  for (const s of suppliers.SUPPLIERS) {
    const f = exp.supplierFacts(catalog.getLibrary(null), s.id);
    assert.equal(f.id, s.id);
    assert.equal(f.name, s.name);
    assert.equal(f.generic, s.id === suppliers.GENERIC_ID);
    assert.equal(f.url, s.url || null);
    if (!s.wholesale) { assert.equal(f.wholesale, null); assert.equal(f.phone, ''); assert.equal(f.freeShipping, ''); continue; }
    assert.equal(f.wholesale.name, s.wholesale.name);
    assert.equal(f.wholesale.url, s.wholesale.url || null, 'a supplier with no account page gets no link');
    assert.equal(f.wholesale.phone, s.wholesale.phone);
    assert.equal(f.phone, s.wholesale.phone);
    assert.equal(f.wholesale.email, s.wholesale.email || '');
    assert.equal(f.wholesale.note, s.wholesale.note);
    // The free-shipping line is a whole sentence of the supplier's own note, or nothing.
    if (f.freeShipping) assert.ok(s.wholesale.note.includes(f.freeShipping) && /ships? free|free shipping/i.test(f.freeShipping));
    assert.equal(f.searchChecked, s.searchUrlWorks === true);
    assert.equal(f.searchNote, s.searchNote);
  }
  // As entered on 2026-11-11: one supplier's pages name a free-shipping amount, the other's wholesale page lists none.
  const withLine = suppliers.SUPPLIERS.filter((s) => s.wholesale && /ships free/.test(s.wholesale.note));
  for (const s of withLine) assert.match(exp.supplierFacts(null, s.id).freeShipping, /ships free with orders of \$\d+/);
  const without = suppliers.SUPPLIERS.filter((s) => s.wholesale && !/ships free/.test(s.wholesale.note));
  for (const s of without) assert.equal(exp.supplierFacts(null, s.id).freeShipping, '', s.name + ': "lists no free-shipping amount" is not a free-shipping offer');
  assert.equal(exp.freeShippingLine('Orders ship free over $99. Call us.'), 'Orders ship free over $99.');
  assert.equal(exp.freeShippingLine(''), '');
  // A search link is flagged only when its address was never confirmed.
  for (const s of suppliers.SUPPLIERS.filter((x) => x.searchUrlTemplate)) {
    const f = exp.supplierFacts(null, s.id);
    const link = suppliers.supplierSearchUrl(s.id, 'c9 bulbs');
    assert.equal(exp.isUncheckedSearch(f, link), s.searchUrlWorks !== true, s.name);
    assert.equal(exp.isUncheckedSearch(f, s.url), false, 'the home page is not a search link');
  }
  assert.equal(exp.supplierFacts(null, 'nobody').generic, true, 'an unknown supplier is any store');
  assert.equal(exp.hostOf('https://www.Example.com/a?b'), 'example.com');
  assert.equal(exp.hostOf('http://example.com/'), '', 'only https links count');
});

test('supplierItems lists everything on file at a supplier, with the user\'s own prices marked', () => {
  const lib = catalog.getLibrary(null);
  for (const sid of SUPPLIER_IDS) {
    const items = exp.supplierItems(lib, sid);
    const skus = new Set();
    for (const p of suppliers.SUPPLIER_PRODUCTS.filter((x) => x.supplierId === sid)) {
      if (p.kind === 'bulk') for (const c of suppliers.componentOffers(p)) skus.add(c.offer.sku); else skus.add(p.sku);
    }
    for (const k of Object.keys(suppliers.SUPPLIER_ACCESSORIES[sid] || {})) skus.add(suppliers.SUPPLIER_ACCESSORIES[sid][k].sku);
    assert.deepEqual(items.map((i) => i.sku).sort(), Array.from(skus).sort(), sid + ': every part, product and accessory once, and no kit');
    assert.ok(items.every((i) => i.supplierSku && i.url && i.priceAsOf), 'each has a part number, a link and a date');
    assert.ok(!items.some((i) => suppliers.SUPPLIER_PRODUCTS.some((p) => p.kind === 'bulk' && p.sku === i.sku)), 'the kit itself is not something to order');
    // The sentence on the Buy-from card counts what the map holds.
    const seen = items.filter((i) => i.priceStatus === 'observed').length;
    const sentence = exp.priceSentence(items);
    assert.ok(sentence.includes('as of ' + DATE) && sentence.includes('checked on the supplier\'s page') && sentence.endsWith('Your account price may be lower: edit any price.'));
    assert.equal(/seen in a listing, not confirmed/.test(sentence), seen > 0, sid + ': "seen in a listing" only when something was');
    if (seen) assert.ok(sentence.includes((items.length - seen) + ' checked on the supplier\'s page, ' + seen + ' seen in a listing'));
    // A typed price and an edited library price are "yours".
    const one = items[0];
    const mine = exp.supplierItems(lib, sid, { [one.sku]: 1.23 }).find((i) => i.sku === one.sku);
    assert.deepEqual([mine.price, mine.priceStatus, mine.priceAsOf], [1.23, 'yours', null]);
  }
  const edited = clone(lib);
  const prod = edited.products.find((p) => p.supplierId === 'cle' && p.kind !== 'bulk');
  prod.price += 1;
  assert.equal(exp.supplierItems(edited, 'cle').find((i) => i.sku === prod.sku).priceStatus, 'yours');
  assert.deepEqual(exp.supplierItems(lib, 'generic'), []);
});

test('orderUseText says what a spool, box or pack leaves over, and nothing for a line that is used whole', () => {
  const lib = catalog.getLibrary(null);
  // The example from the brief: one 1,000 ft spool with 143 ft used.
  const spool = suppliers.SUPPLIER_PRODUCTS.find((p) => p.kind === 'bulk' && p.components.wire.spoolFt === 1000).components.wire;
  assert.equal(exp.orderUseText({ sku: spool.sku, qty: 1, unit: 'spool', usedQty: 0.143 }, lib), '1 spool (1,000 ft): 143 ft used, 857 ft left');
  for (const sid of SUPPLIER_IDS) {
    const { plan } = planned(sid);
    const index = exp.bulkPartIndex(plan.library);
    let wireUsed = 0, wireBought = 0, withText = 0;
    for (const l of plan.bom.lines) {
      const text = exp.orderUseText(l, index);
      assert.equal(text, exp.orderUseText(l, plan.library), 'the library or its index give the same answer');
      if (!(l.usedQty < l.qty)) { assert.equal(text, '', l.name + ' is used whole'); continue; }
      withText += 1;
      const wire = /^([\d,]+) (spools?|lengths?) \(([\d,]+) ft\): ([\d,]+) ft used, ([\d,]+) ft left$/.exec(text);
      const packs = /^([\d,]+) (boxes|box|packs?) \(([\d,]+) (bulbs|plugs)\): ([\d,]+) used, ([\d,]+) spare$/.exec(text);
      assert.ok(wire || packs, sid + ' ' + l.name + ': ' + text);
      const nums = (wire || packs).filter((x) => /^[\d,]+$/.test(x || '')).map((x) => Number(x.replace(/,/g, '')));
      const [count, boughtN, usedN, leftN] = nums;
      assert.equal(count, l.qty);
      assert.equal(usedN + leftN, boughtN, 'used and left add up to what is bought');
      if (wire) { wireUsed += usedN; wireBought += boughtN; }
      // A pack the supplier calls a box is counted in boxes.
      if (packs && /box of/i.test(l.name)) assert.match(packs[2], /^box/);
    }
    assert.ok(withText >= 3, sid + ': wire, bulbs and plugs each say what is left');
    const bulkFt = plan.runs.filter((r) => r.productKind === 'bulk').reduce((t, r) => t + r.quantity, 0);
    assert.ok(Math.abs(wireUsed - Math.ceil(bulkFt)) <= 1, sid + ': wire used (' + wireUsed + ' ft) is the feet of the cut-to-length runs (' + bulkFt + ')');
    assert.ok(wireBought >= wireUsed);
  }
  // A colour the supplier does not list is priced like its default colour: the line's sku is "<default sku>:<colour>".
  const def = suppliers.SUPPLIER_PRODUCTS.find((p) => p.kind === 'bulk').components.bulb;
  const defSku = def.variants[def.defaultVariant].sku;
  assert.match(exp.orderUseText({ sku: defSku + ':purple', qty: 2, unit: 'pack', usedQty: 1.2 }, lib), /^2 (boxes|packs) \(50 bulbs\): 30 used, 20 spare$/);
  assert.equal(exp.orderUseText({ sku: 'unknown-part', qty: 4, unit: 'pack', usedQty: 1 }, lib), '4 ordered: about 25% used on this job');
  assert.equal(exp.orderUseText(null, lib), '');
});

test('describeBulk says what a cut-to-length product is ordered as, its limit and the status of every part', () => {
  const lib = catalog.getLibrary(null);
  for (const p of lib.products.filter((x) => x.kind === 'bulk')) {
    const d = exp.describeBulk(p);
    const c = p.components;
    assert.match(d.summary, /^Ordered as parts: socket wire by the spool/);
    assert.equal(/ready-made length/.test(d.summary), (c.wire.sizes || []).some((s) => s.plugsIncluded), p.id + ': "ready-made length" only when one is on file');
    assert.ok(d.summary.includes('of ' + c.bulb.packQty + ' by colour'), 'bulbs by the box of ' + c.bulb.packQty);
    // Plugs are counted for the ends that are cut (review finding D2): the summary no longer promises a pair per length.
    assert.ok(d.summary.includes('slide-on plugs for the ends you cut'));
    assert.match(d.summary, /SPT-1 is the thin two-wire cord the sockets and plugs are made for\.$/);
    assert.equal(d.short, 'Socket wire, bulbs and slide-on plugs, cut to fit each run.');
    assert.ok(d.limit.includes(p.maxRunFt + ' ft') && d.limit.includes(p.maxBulbsPerRun + ' bulbs'), 'the limit of one cord: ' + d.limit);
    assert.match(d.perFoot, /^about \$\d+\.\d\d per ft with bulbs$/);
    // Every part of the kit is listed with its own part number and status.
    const offers = suppliers.componentOffers(p).map((x) => x.offer);
    assert.deepEqual(d.parts.map((x) => x.sku).sort(), offers.map((o) => o.sku).sort());
    for (const part of d.parts) {
      const o = offers.find((x) => x.sku === part.sku);
      assert.equal(part.supplierSku, String(o.supplierSku));
      assert.equal(part.url, o.url);
      assert.equal(part.status.kind, o.priceStatus === 'verified' ? 'checked' : 'check');
    }
    assert.deepEqual(d.parts.map((x) => x.group).filter((g, i, a) => a.indexOf(g) === i), ['wire', 'bulb', 'plug'], 'wire, then bulbs, then plugs');
    // The kit has no part number and a worked-out price: it never says "check price" unless a part does.
    const listed = offers.filter((o) => o.priceStatus !== 'verified').length;
    assert.equal(d.statuses.some((s) => s.kind === 'check'), listed > 0, p.id + ': "check price" only for parts seen in a listing');
    if (!listed) assert.deepEqual(d.statuses, [{ kind: 'checked', text: 'all ' + offers.length + ' parts as of ' + DATE + ' · checked' }]);
    else assert.ok(d.statuses.some((s) => s.kind === 'checked' && s.text.includes('as of ' + DATE)) && d.statuses.some((s) => s.kind === 'check' && /^(1 part|\d+ parts): check price$/.test(s.text)));
    assert.equal(/seen in a listing, not confirmed/.test(d.prices), listed > 0);
    assert.ok(!/account price/.test(d.prices), 'the account sentence is said once, on the Buy-from card');
    // A price the user typed for a part shows as theirs, and moves the per-foot guide.
    const mine = exp.describeBulk(p, { [c.wire.sku]: c.wire.price * 2 });
    assert.equal(mine.parts.find((x) => x.sku === c.wire.sku).status.kind, 'yours');
    assert.ok(mine.statuses.some((s) => s.kind === 'yours' && s.text === '1 part at your price'));
    assert.notEqual(mine.perFoot, d.perFoot);
  }
  assert.ok(lib.products.some((x) => x.kind === 'bulk' && exp.describeBulk(x).statuses.length === 1), 'at least one kit has every part checked');
  assert.equal(exp.describeBulk(lib.products.find((x) => x.kind !== 'bulk')), null);
  assert.equal(exp.describeBulk(null), null);
});

test('whereToBuy gives one entry per order sheet with the supplier\'s facts, and orderSheetText adds its phone and free-shipping line', () => {
  for (const sid of SUPPLIER_IDS) {
    const { plan } = planned(sid);
    const list = exp.whereToBuy(plan);
    const sheets = bom.orderSheets(plan.bom, plan.library);
    assert.deepEqual(list.map((e) => e.supplierId), sheets.map((s) => s.supplierId));
    assert.equal(list[0].supplierId, sid, 'the supplier comes before any store');
    assert.equal(list[list.length - 1].supplierId, 'generic');
    const e = list[0];
    const s = suppliers.getSupplier(sid);
    assert.equal(e.name, s.name);
    assert.equal(e.phone, s.wholesale.phone);
    assert.equal(e.subtotal, sheets[0].subtotal);
    assert.equal(e.lines.length, plan.bom.lines.filter((l) => l.supplierId === sid).length);
    assert.equal(e.sentence, exp.priceSentence(sheets[0].lines));
    const text = exp.orderSheetText(e);
    assert.ok(text.startsWith(bom.orderSheetToText(sheets[0])), 'the core order text comes first');
    assert.ok(text.includes('Phone: ' + s.wholesale.phone));
    assert.equal(text.includes('ships free'), /ships free/.test(s.wholesale.note));
    for (const l of e.lines) assert.ok(text.includes('Part ' + l.supplierSku + ': '), 'part number ' + l.supplierSku);
    const any = list[list.length - 1];
    assert.equal(any.generic, true);
    assert.equal(any.phone, '');
    assert.equal(exp.orderSheetText(any), bom.orderSheetToText(sheets[sheets.length - 1]));
  }
  assert.deepEqual(exp.whereToBuy(null), []);
  const none = exp.whereToBuy(planModule.computePlan(tracedSample()));
  assert.deepEqual(none.map((e) => e.supplierId), ['generic'], 'any store: one sheet');
});

test('a typed price flips a shopping-list line to "your price" and back', () => {
  const base = planned('cle');
  const line = base.plan.bom.lines.find((l) => l.supplierId === 'cle' && l.priceStatus === 'verified');
  assert.equal(exp.priceStatusLabel(line).kind, 'checked');
  const { store, actions } = setup(base.project);
  actions.setPriceOverride(line.sku, line.unitPrice - 1);
  const mine = store.plan().bom.lines.find((l) => l.sku === line.sku);
  assert.deepEqual([mine.priceStatus, mine.overridden, mine.unitPrice], ['yours', true, Math.round((line.unitPrice - 1) * 100) / 100]);
  assert.equal(exp.priceStatusLabel(mine).text, 'your price');
  assert.equal(mine.priceAsOf, null, 'a price that is yours has no supplier date');
  actions.setPriceOverride(line.sku, null);
  assert.equal(exp.priceStatusLabel(store.plan().bom.lines.find((l) => l.sku === line.sku)).text, 'as of ' + DATE + ' · checked');
});

// ---------------------------------------------------------------- pickers and the product list that is saved
test('productGroups puts the chosen supplier first, then any store, then the other suppliers, with part number and price', () => {
  for (const sid of ['generic'].concat(SUPPLIER_IDS)) {
    const lib = catalog.getLibrary({ library: { products: null, config: null, supplierId: sid } });
    const suitable = design.suitableProducts('roofline', lib, { allSuppliers: true });
    const groups = panels.productGroups(suitable, lib);
    const others = SUPPLIER_IDS.filter((x) => x !== sid);
    assert.deepEqual(groups.map((g) => g.supplierId), sid === 'generic' ? ['generic'].concat(SUPPLIER_IDS) : [sid, 'generic'].concat(others));
    assert.deepEqual(groups.map((g) => g.label), groups.map((g) => (g.supplierId === 'generic' ? 'Any store' : suppliers.getSupplier(g.supplierId).name)));
    assert.equal(groups.reduce((n, g) => n + g.options.length, 0), suitable.length, 'every suitable product is offered once');
    for (const g of groups) {
      for (const [id, text] of g.options) {
        const p = catalog.getProduct(lib.products, id);
        assert.equal(catalog.isSupplierProduct(p) ? p.supplierId : 'generic', g.supplierId);
        assert.ok(text.startsWith(p.name));
        if (p.kind === 'bulk') {
          assert.match(text, / · sold as parts · about \$\d+\.\d\d per ft$/);
          assert.ok(!/part number|check/.test(text), 'a kit has no part number and is never "check the price"');
        } else {
          assert.ok(text.endsWith(' · $' + p.price.toFixed(2)), text);
          assert.equal(text.includes(' · part number ' + p.supplierSku + ' · '), !!p.supplierSku, text);
        }
      }
    }
  }
  assert.deepEqual(panels.productGroups([], catalog.getLibrary(null)), []);
  // A product from a supplier the map does not know still gets a group of its own, after the known ones.
  const lib = catalog.getLibrary(null);
  const odd = [{ id: 'acme:x', name: 'Acme string', supplierId: 'acme', supplierSku: 'A1', price: 5, unit: 'string' }, lib.products[0]];
  assert.deepEqual(panels.productGroups(odd, lib).map((g) => [g.supplierId, g.label]), [['generic', 'Any store'], ['acme', 'acme']]);
});

test('productsToSave keeps a supplier\'s catalog entries only when one of them was changed', () => {
  const lib = catalog.getLibrary(null);
  const generic = lib.products.filter((p) => !catalog.isSupplierProduct(p));
  // Turning a generic product off saves the generic list only: the supplier catalog is added back by getLibrary.
  const a = clone(lib.products);
  a[0].enabled = false;
  const savedA = panels.productsToSave(a);
  assert.deepEqual(savedA.map((p) => p.id), generic.map((p) => p.id));
  const libA = catalog.getLibrary({ library: { products: savedA, config: null } });
  assert.deepEqual(libA.products.map((p) => p.id), lib.products.map((p) => p.id), 'the library the planner sees is whole, in the same order');
  // Editing one supplier product keeps that supplier's whole list (its order decides the automatic choice), and
  // leaves the other supplier's out.
  const b = clone(lib.products);
  const target = b.find((p) => p.supplierId === 'cle' && p.kind !== 'bulk');
  target.price += 2;
  const savedB = panels.productsToSave(b);
  const cleIds = lib.products.filter((p) => p.supplierId === 'cle').map((p) => p.id);
  assert.deepEqual(savedB.filter((p) => p.supplierId === 'cle').map((p) => p.id), cleIds);
  assert.ok(!savedB.some((p) => p.supplierId === '1000bulbs'));
  const libB = catalog.getLibrary({ library: { products: savedB, config: null, supplierId: 'cle' } });
  assert.equal(catalog.getProduct(libB.products, target.id).price, target.price);
  for (const style of catalog.BUYING_STYLES) {
    const pick = (l) => design.resolveProduct({ type: 'roofline', productId: null }, Object.assign({}, l, { supplierId: 'cle', config: Object.assign({}, l.config, { buying: { style, costBasis: 'bought' } }) })).product.id;
    assert.equal(pick(libB), pick(lib), 'the automatic choice (' + style + ') is the same after the edit is saved');
  }
  // The edited price is the user's own on the shopping list; the untouched supplier's prices are still its own.
  const project = tracedSample();
  project.library = { products: savedB, config: { buying: { style: 'strings' } }, supplierId: 'cle' };
  const plan = planModule.computePlan(project);
  const line = plan.bom.lines.find((l) => l.sku === target.sku);
  if (line) assert.equal(line.priceStatus, 'yours');
  assert.ok(plan.bom.lines.filter((l) => l.supplierId === 'cle' && l.sku !== target.sku).every((l) => l.priceStatus !== 'yours'));
  assert.deepEqual(panels.productsToSave(null), []);
});

test('the bush rule of thumb shown on screen is read from the settings', () => {
  const cfg = catalog.DEFAULT_CONFIG;
  const b = cfg.bush;
  const text = panels.bushRuleText(cfg);
  assert.equal(text, b.lightsPerUnit + ' lights for every ' + b.heightUnitFt + ' ft of height and every ' + b.widthUnitFt + ' ft of width');
  const mine = catalog.deepMerge(cfg, { bush: { lightsPerUnit: 150, heightUnitFt: 2, widthUnitFt: 2.5 } });
  assert.equal(panels.bushRuleText(mine), '150 lights for every 2 ft of height and every 2.5 ft of width');
  assert.equal(panels.bushRuleText({ bush: {} }), '', 'no rule, no sentence');
  assert.equal(panels.bushRuleText(null), '');
});

test('supplierOfUrl names the supplier a link belongs to by its host', () => {
  const lib = catalog.getLibrary(null);
  for (const s of suppliers.SUPPLIERS.filter((x) => x.url)) {
    for (const role of Object.keys(s.categoryUrls)) assert.equal(panels.supplierOfUrl(lib, s.categoryUrls[role]).id, s.id);
  }
  assert.equal(panels.supplierOfUrl(lib, 'https://example.com/'), null);
  assert.equal(panels.supplierOfUrl(lib, 'javascript:alert(1)'), null);
  assert.equal(panels.supplierOfUrl(lib, null), null);
});

test('writeClipboard resolves false, never throws, where there is no clipboard and no page', async () => {
  assert.equal(await panels.writeClipboard('https://www.christmaslightsetc.com/'), false);
});
