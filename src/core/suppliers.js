/* LightPlan core: suppliers (SPEC §8.3).
 * A hand-entered map of two suppliers' catalogs, so a plan can be ordered by their part numbers:
 * who they are, where their category pages are, a small set of products with links, and the bulk C7/C9
 * parts (socket wire by the spool, bulbs by the box, slide-on plugs). Data and tiny lookups only: pure,
 * JSON-able, no DOM, no clock, no network. Nothing here is ever fetched: every URL is a link for a person
 * to open.
 *
 * HOW FAR TO TRUST IT. Every price, part number and spec below was read from search results on
 * 2026-11-11. The suppliers' own pages could not be opened that day, so nothing is confirmed:
 * priceStatus is 'observed' everywhere and the app must say "check the price". Entries the research
 * marked as doubtful were handled like this:
 *  - A part number that may be wrong is left out (supplierSku: null) and the note says to order from the
 *    link. This covers the Christmas Lights Etc spools and stringers (the number seen was the page number,
 *    not the item number), its C7 warm white and cool white bulbs (two numbers were seen) and its 70-light
 *    5 mm set (item number never seen).
 *  - Items seen as out of stock, old product lines, incandescent items, items with no product page and
 *    items with no listed watts are not offered at all (see docs/DATA_MODEL.md for the list).
 *  - Where a colour of a bulb family had no watts of its own, the family's listed figure is used and the
 *    note says so.
 *  - Run limits: bulk socket wire uses the trade rule "250 bulbs or 250 ft of line, whichever comes
 *    first"; the ready-made 25 ft C7/C9 sets are held to the same 250 ft (10 sets) although the supplier's
 *    fuse limit is higher; pre-made sets use the lowest connect count seen.
 *
 * Wholesale (account) prices are not public for either supplier, so the prices here are the public ones.
 * The user overwrites any price with their own (project.pricing.overrides, keyed by `sku`).
 */
LP.define('suppliers', [], function () {
  'use strict';

  const PRICE_AS_OF = '2026-11-11';
  const GENERIC_ID = 'generic';
  /** Category-page roles (SPEC §8.3). A supplier lists only the roles it has a page for. */
  const ROLES = ['c9Bulbs', 'c7Bulbs', 'spools', 'stringers', 'plugs', 'clips', 'miniLights', 'icicle', 'net', 'rope', 'treeWrap', 'stakes', 'timers', 'extensionCords'];
  const PRICE_STATUSES = ['verified', 'observed'];
  /** Bulb colour variants a bulk product may list, in the order BOM lines are written. */
  const VARIANT_ORDER = ['warmWhite', 'coolWhite', 'multi', 'red', 'green', 'blue', 'orange', 'yellow', 'purple', 'pink', 'teal'];
  const VARIANT_LABELS = { warmWhite: 'Warm white', coolWhite: 'Cool white', multi: 'Multicolor', red: 'Red', green: 'Green', blue: 'Blue',
    orange: 'Orange', yellow: 'Yellow', purple: 'Purple', pink: 'Pink', teal: 'Teal' };

  const LINE_TYPES = ['roofline', 'rake', 'gutter', 'ridge', 'window', 'door', 'railing', 'walkway', 'stakes'];
  const MINI_TYPES = ['window', 'door', 'railing', 'bush', 'tree', 'column', 'roofline', 'gutter', 'rake'];
  const ALL_COLORS = ['warmWhite', 'coolWhite', 'multicolor', 'custom'];
  const CLE = 'https://www.christmaslightsetc.com/';
  const TB = 'https://www.1000bulbs.com/';

  // ---------------------------------------------------------------- suppliers
  const SUPPLIERS = [
    {
      id: GENERIC_ID, name: 'Any store', short: 'Any store', url: null, wholesale: null, searchUrlTemplate: null, categoryUrls: {}, priceAsOf: null,
      notes: 'Typical retail products and prices, not one brand: no part numbers and no links. Check the box label.',
    },
    {
      id: 'cle', name: 'Christmas Lights Etc', short: 'CLE', url: CLE,
      wholesale: {
        name: 'Wintergreen Corporation wholesale program',
        url: 'https://wintergreencorp.com/wholesale-application.htm',
        phone: '855-942-7100',
        note: 'Christmas Lights Etc is the retail site of Wintergreen Corporation. Trade prices are on Wintergreen\'s own site behind a login: ' +
          'apply as a professional installer and a representative replies within about one business day. The retail site also takes money off ' +
          'bulb boxes when you buy 10 or more.',
      },
      // The research found only a Google site-search fallback, not the site's own search address, so there is none.
      searchUrlTemplate: null,
      categoryUrls: {
        c9Bulbs: CLE + 'c9-led-replacement-lamp-bulbs--790.htm',
        c7Bulbs: CLE + 'c7-led-replacement-bulbs--789.htm',
        spools: CLE + 'c7-c9-christmas-light-strings-spools-8015.htm',
        stringers: CLE + 'c7-c9-christmas-light-strings-spools-8015.htm',
        clips: CLE + 'c7-c9-light-clips-and-hangers--753.htm',
        miniLights: CLE + 'Wide-Angle-Lens-LED-Lights--864.htm',
        icicle: CLE + 'Icicle-Lights.htm',
        net: CLE + 'led-net-lights--819.htm',
        rope: CLE + 'LED-Rope-Lights--130.htm',
        stakes: CLE + 'c7-c9-christmas-light-stakes--798.htm',
        timers: CLE + 'christmas-light-timers-and-controllers--107.htm',
        extensionCords: CLE + 'christmas-extension-cords--104.htm',
      },
      priceAsOf: PRICE_AS_OF,
      notes: 'Public prices seen in search results on 2026-11-11, not confirmed on the supplier\'s pages. Some part numbers could not be ' +
        'confirmed: those lines have a link and no part number.',
    },
    {
      id: '1000bulbs', name: '1000Bulbs', short: '1000Bulbs', url: TB,
      wholesale: {
        name: '1000Bulbs business accounts',
        url: 'https://shop.1000bulbs.com/business-owners/',
        phone: '855-400-3240',
        note: 'There is no published trade price list. Call the business line or fill in the form and a lighting specialist sets up the account ' +
          '(volume pricing, payment terms, tax-exempt orders).',
      },
      searchUrlTemplate: TB + 'fil/search?q={query}',
      categoryUrls: {
        c9Bulbs: TB + 'category/c9-led-light-bulb-replacements',
        c7Bulbs: TB + 'category/c7-led-light-bulb-replacements',
        spools: TB + 'category/commercial-christmas-light-spools',
        stringers: TB + 'category/commercial-christmas-stringers',
        plugs: TB + 'category/christmas-light-plugs',
        clips: TB + 'category/christmas-light-mounting-clips',
        miniLights: TB + 'category/led-mini-light-strings',
        icicle: TB + 'category/led-christmas-icicle-light-strings',
        net: TB + 'category/led-christmas-net-lights',
        rope: TB + 'category/warm-white-rope-lights',
        treeWrap: TB + 'category/tree-wrap-lights',
        stakes: TB + 'category/christmas-light-mounting-stakes',
        timers: TB + 'category/christmas-light-timers',
      },
      priceAsOf: PRICE_AS_OF,
      notes: 'Public prices seen in search results on 2026-11-11, not confirmed on the supplier\'s pages. This supplier\'s prices moved a lot ' +
        'between listings of the same item, and promo codes are common: check each price.',
    },
  ];

  // ---------------------------------------------------------------- builders
  const round = (v, d) => { const k = Math.pow(10, d); return Math.round(v * k) / k; };
  const NOT_CONFIRMED = 'Part number not confirmed: order from the link.';

  /**
   * One thing you can order (SPEC "Offer"). `supplierSku` null means the part number could not be confirmed;
   * the `sku` (price-override key) then uses `extra.slug` instead.
   */
  function offer(supplierId, supplierSku, name, url, price, packQty, extra) {
    const x = extra || {};
    const out = {
      sku: supplierId + ':' + (supplierSku || x.slug), supplierSku: supplierSku || null, name, url, price, packQty,
      priceAsOf: PRICE_AS_OF, priceStatus: 'observed',
    };
    for (const k of Object.keys(x)) if (k !== 'slug') out[k] = x[k];
    if (!supplierSku) out.notes = (out.notes ? out.notes + ' ' : '') + NOT_CONFIRMED;
    return out;
  }

  /**
   * Bulk C7/C9: socket wire cut to length + one bulb per socket + slide-on plugs, as a per-foot Product so
   * measuring, chaining and power feeds work unchanged (SPEC §8.3). Derived figures:
   * bulbsPerUnit = 12 / spacing, wattsPerUnit = wattsEach × bulbsPerUnit, maxEndToEnd = the feet one run may
   * be (maxRunFt, and never more sockets than maxBulbsPerRun), maxConnectedW = the watts one run may carry
   * (maxBulbsPerRun × wattsEach, and never more than 80% of the wire's amp rating at 120 V), and `price` = a
   * per-foot equivalent of wire + default bulbs (display and fallback only; the BOM prices the components).
   */
  function bulkProduct(spec) {
    const spacing = spec.bulbSpacingIn;
    const perFt = 12 / spacing;
    const c = spec.components;
    const maxRunFt = spec.maxRunFt || 250;
    const maxBulbs = spec.maxBulbsPerRun || 250;
    const def = c.bulb.variants[c.bulb.defaultVariant];
    const wireW = c.wire.maxAmps > 0 ? c.wire.maxAmps * 120 * 0.8 : Infinity;
    return {
      id: spec.id, sku: spec.id, supplierId: spec.supplierId, supplierSku: null, equiv: spec.equiv, kind: 'bulk',
      name: spec.name, category: spec.category, tech: 'LED', unit: 'foot',
      bulbSpacingIn: spacing, stringLengthFt: 1, leadFt: 0, bulbsPerUnit: round(perFt, 4), wattsPerUnit: round(c.bulb.wattsEach * perFt, 4),
      maxEndToEnd: Math.floor(Math.min(maxRunFt, maxBulbs / perFt)), maxRunFt, maxBulbsPerRun: maxBulbs,
      maxConnectedW: round(Math.min(maxBulbs * c.bulb.wattsEach, wireW), 2), endConnector: true,
      price: round(c.wire.price / c.wire.spoolFt + perFt * def.price / c.bulb.packQty, 2),
      colors: ALL_COLORS.slice(), clipEligible: true, enabled: true, suitableFor: LINE_TYPES.slice(),
      url: c.wire.url, priceAsOf: PRICE_AS_OF, priceStatus: 'observed', notes: spec.notes, components: c,
    };
  }

  /** A ready-made supplier product (same shape as catalog.DEFAULT_PRODUCTS plus the supplier fields). */
  function product(supplierId, slug, supplierSku, fields) {
    const id = supplierId + ':' + slug;
    const out = Object.assign({ id, sku: id, supplierId, supplierSku: supplierSku || null }, fields,
      { enabled: true, priceAsOf: PRICE_AS_OF, priceStatus: 'observed' });
    // orderNote: a short caution printed on the shopping-list line (notes is the longer description).
    if (!supplierSku) out.orderNote = (out.orderNote ? out.orderNote + ' ' : '') + NOT_CONFIRMED;
    return out;
  }

  const RUN_RULE = 'One run: at most 250 ft of wire or 250 bulbs, whichever comes first (the trade rule for 18-gauge socket wire).';
  const FAMILY_WATTS = 'Watts are the bulb family\'s listed figure; this colour\'s own page did not show them.';

  // ---------------------------------------------------------------- Christmas Lights Etc
  const cleBulb = (item, slug, colour, page, base, price, extra) => offer('cle', item,
    `${base} OptiCore LED bulbs, ${colour}, faceted, box of 25`, CLE + 'p/' + page, price, 25, Object.assign({ slug }, extra));

  const CLE_C9_BULK = bulkProduct({
    id: 'cle:c9-bulk-12', supplierId: 'cle', equiv: 'c9-led', category: 'c9', bulbSpacingIn: 12,
    name: 'C9 LED on socket wire, a bulb every 12 in (cut to length)',
    notes: 'Bought as socket wire, boxes of 25 screw-in bulbs and slide-on plugs. 0.8 W per bulb as the supplier lists it. ' + RUN_RULE,
    components: {
      wire: offer('cle', null, 'C9 socket wire, 1,000 ft spool, a socket every 12 in, green SPT-1 (no plugs)',
        CLE + 'p/C9-Christmas-Lights-Spool-1000-ft-Length-12-inch-Spacing-7-Amp-Green-Wire--15085.htm', 409.99, 1, {
          slug: 'c9-spool-1000-spt1', spoolFt: 1000, wireType: 'SPT-1', maxAmps: 7,
          notes: 'The page lists 7 A in one place and 8 A in another; LightPlan uses 7 A.',
          sizes: [
            offer('cle', null, 'C9 socket wire, 100 ft ready-made length, a socket every 12 in, green SPT-1 (comes with a fused plug)',
              CLE + 'p/C9-Christmas-Lights-String-100-ft-Length-12-inch-Spacing-7-Amp-Green-Wire--15098.htm', 54.99, 1, { slug: 'c9-stringer-100-spt1', lengthFt: 100 }),
            offer('cle', null, 'C9 socket wire, 25 ft ready-made length, a socket every 12 in, green SPT-1 (comes with a fused plug)',
              CLE + 'p/C9-Christmas-Lights-String-25-ft-Length-12-inch-Spacing-Green-Wire--15100.htm', 14.99, 1, { slug: 'c9-stringer-25-spt1', lengthFt: 25 }),
          ],
        }),
      bulb: {
        name: 'C9 OptiCore LED bulbs, faceted, box of 25', packQty: 25, wattsEach: 0.8, base: 'E17', defaultVariant: 'warmWhite',
        variants: {
          warmWhite: cleBulb('72636', null, 'warm white', 'C9--Warm-White-OptiCore-LED-Replacement-Bulbs-13603.htm', 'C9', 32.99),
          coolWhite: cleBulb('72639', null, 'cool white', 'C9--Cool-White-OptiCore-LED-Replacement-Bulbs-13604.htm', 'C9', 32.99, { notes: FAMILY_WATTS }),
          multi: cleBulb('72642', null, 'multicolor', 'C9--Multicolor-OptiCore-LED-Replacement-Bulbs-13605.htm', 'C9', 32.99),
          red: cleBulb('72645', null, 'red', 'C9--Red-OptiCore-LED-Replacement-Bulbs-13606.htm', 'C9', 32.99, { notes: FAMILY_WATTS }),
          green: cleBulb('72654', null, 'green', 'C9--Green-OptiCore-LED-Replacement-Bulbs-13609.htm', 'C9', 32.99, { notes: FAMILY_WATTS }),
        },
      },
      plugMale: offer('cle', '67083', 'Slide-on male plug for SPT-1 wire, green, pack of 5',
        CLE + 'p/Male-Zip-Plug-SPT1-Polarized-Male-Plug-Green-1-Pack-56874.htm', 6.2, 5,
        { notes: 'Pack size not confirmed (the page address says 1-pack): check it before you order.' }),
      plugFemale: offer('cle', '67081', 'Slide-on female plug for SPT-1 wire, green, pack of 5',
        CLE + 'p/Female-Zip-Plug-SPT1-Green-1-Pack-56873.htm', 6.2, 5,
        { notes: 'Pack size not confirmed (the page address says 1-pack): check it before you order.' }),
    },
  });

  const CLE_C7_BULK = bulkProduct({
    id: 'cle:c7-bulk-12', supplierId: 'cle', equiv: 'c7-led', category: 'c7', bulbSpacingIn: 12,
    name: 'C7 LED on socket wire, a bulb every 12 in (cut to length)',
    notes: 'Bought as socket wire, boxes of 25 screw-in bulbs and slide-on plugs. 0.8 W per bulb as the supplier lists it. ' + RUN_RULE,
    components: {
      wire: offer('cle', null, 'C7 socket wire, 1,000 ft spool, a socket every 12 in, green SPT-1 (no plugs)',
        CLE + 'p/C7-Christmas-Lights-Spool-1000-ft-Length-12-inch-Spacing-7-Amp-Green-Wire--15054.htm', 369.99, 1, {
          slug: 'c7-spool-1000-spt1', spoolFt: 1000, wireType: 'SPT-1', maxAmps: 7,
          notes: 'The page lists 7 A in one place and 8 A in another; LightPlan uses 7 A.',
        }),
      bulb: {
        name: 'C7 OptiCore LED bulbs, faceted, box of 25', packQty: 25, wattsEach: 0.8, base: 'E12', defaultVariant: 'warmWhite',
        variants: {
          // Two different item numbers were seen for the warm white and cool white boxes, so neither is given.
          warmWhite: cleBulb(null, 'c7-opticore-warm-white', 'warm white', 'C7--Warm-White-OptiCore-LED-Replacement-Bulbs-13593.htm', 'C7', 24.99),
          coolWhite: cleBulb(null, 'c7-opticore-cool-white', 'cool white', 'C7--Cool-White-OptiCore-LED-Replacement-Bulbs-13594.htm', 'C7', 24.99, { notes: FAMILY_WATTS }),
          multi: cleBulb('72612', null, 'multicolor', 'C7--Multicolor-OptiCore-LED-Replacement-Bulbs-13595.htm', 'C7', 24.99, { notes: FAMILY_WATTS }),
          red: cleBulb('72615', null, 'red', 'C7--Red-OptiCore-LED-Replacement-Bulbs-13596.htm', 'C7', 24.99, { notes: FAMILY_WATTS }),
          green: cleBulb('72624', null, 'green', 'C7--Green-OptiCore-LED-Replacement-Bulbs-13599.htm', 'C7', 24.99, { notes: FAMILY_WATTS }),
        },
      },
      plugMale: CLE_C9_BULK.components.plugMale,
      plugFemale: CLE_C9_BULK.components.plugFemale,
    },
  });

  const SET_RULE = 'LightPlan plans at most 10 sets (250 ft) on one run, the trade rule for this wire; the supplier\'s fuse limit is higher (960 W).';
  const CLE_PRODUCTS = [
    CLE_C9_BULK,
    CLE_C7_BULK,
    product('cle', 'c9-string-25', '77667', {
      equiv: 'c9-led', name: 'C9 OptiCore LED string, 25 bulbs on 25 ft, ready to hang', category: 'c9', tech: 'LED', unit: 'string',
      bulbSpacingIn: 12, stringLengthFt: 25, leadFt: 0.5, bulbsPerUnit: 25, wattsPerUnit: 20, maxEndToEnd: 10, price: 47.99,
      colors: ['warmWhite'], clipEligible: true, suitableFor: LINE_TYPES.slice(),
      url: CLE + 'p/C9-Warm-White-Opticore-Commercial-LED-Christmas-String-Lights-14953.htm',
      notes: 'Ready-made: bulbs already in, plug on each end. 20 W per set (0.8 W per bulb). ' + SET_RULE,
    }),
    product('cle', 'c7-string-25', '77653', {
      equiv: 'c7-led', name: 'C7 OptiCore LED string, 25 bulbs on 25 ft, ready to hang', category: 'c7', tech: 'LED', unit: 'string',
      bulbSpacingIn: 12, stringLengthFt: 25, leadFt: 0.5, bulbsPerUnit: 25, wattsPerUnit: 20, maxEndToEnd: 10, price: 34.99,
      colors: ['warmWhite'], clipEligible: true, suitableFor: LINE_TYPES.slice(),
      url: CLE + 'p/C7-Warm-White-Opticore-Commercial-LED-Christmas-String-Lights-14949.htm',
      notes: 'Ready-made: bulbs already in, plug on each end. 20 W per set (0.8 W per bulb). ' + SET_RULE,
    }),
    product('cle', 'mini-5mm-70', null, {
      equiv: 'mini-led-100', name: '5 mm LED mini string, 70 bulbs, 4 in apart, green wire', category: 'mini', tech: 'LED', unit: 'string',
      bulbSpacingIn: 4, stringLengthFt: 23, leadFt: 0.5, bulbsPerUnit: 70, wattsPerUnit: 4.8, maxEndToEnd: 45, price: 19.99,
      colors: ['warmWhite'], clipEligible: false, suitableFor: MINI_TYPES.slice(),
      url: CLE + '5mm-LED-Wide-Angle-Warm-White-Prelamped-Light-Set--Green-Wire-7190.htm',
      notes: '4.8 W per set, up to 45 sets end to end. The supplier lists 24 ft overall; the lit length (23 ft) is worked out from 70 bulbs 4 in apart.',
      orderNote: 'The page lists more than one size: pick the 70-light set with bulbs 4 in apart.',
    }),
    product('cle', 'icicle-70', '85686', {
      equiv: 'icicle-led-300', name: '5 mm LED icicle lights, 70 bulbs, 7 ft lit, white wire', category: 'icicle', tech: 'LED', unit: 'string',
      bulbSpacingIn: 6, stringLengthFt: 7, leadFt: 0.5, bulbsPerUnit: 70, wattsPerUnit: 4.8, maxEndToEnd: 45, dropLengthsIn: [18, 15, 9], price: 21.99,
      colors: ['warmWhite'], clipEligible: true, suitableFor: ['roofline', 'gutter', 'railing'],
      url: CLE + 'p/5mm-Warm-White-LED-Icicle-Lights-5889.htm',
      notes: '15 drops of 18, 15 and 9 in. 4.8 W per set, up to 45 sets end to end.',
    }),
    product('cle', 'net-4x6-100', '85472', {
      equiv: 'net-led-4x6', name: '5 mm LED net lights, 4 x 6 ft, 100 bulbs, green wire', category: 'net', tech: 'LED', unit: 'net',
      bulbSpacingIn: 6, stringLengthFt: 6, leadFt: 2, bulbsPerUnit: 100, wattsPerUnit: 12, maxEndToEnd: 18, coverageSqFt: 24, price: 39.99,
      colors: ['warmWhite'], clipEligible: false, suitableFor: ['bush'],
      url: CLE + 'p/5mm-Warm-White-LED-Net-Lights-Green-Wire-6621.htm',
      notes: 'One net covers about 24 sq ft. 12 W per net, up to 18 nets end to end.',
    }),
  ];

  // ---------------------------------------------------------------- 1000Bulbs
  const tbUrl = (id, sku) => TB + 'product/' + id + '/' + sku + '.html';
  const tbBulb = (sku, id, base, colour, price, extra) => offer('1000bulbs', sku,
    `${base} VividCore Premium LED bulbs, ${colour}, faceted, pack of 25`, tbUrl(id, sku), price, 25, extra);
  const TB_WIRE_AMPS = 'The listing gives no amp rating; 5 A is the supplier\'s planning figure for 18-gauge runs longer than 150 ft.';

  const TB_PLUG_MALE = offer('1000bulbs', 'PLUG-10001', 'Slide-on male plug for SPT-1 wire, green, pack of 10', tbUrl(223184, 'PLUG-10001'), 6.73, 10);

  const TB_C9_BULK = bulkProduct({
    id: '1000bulbs:c9-bulk-12', supplierId: '1000bulbs', equiv: 'c9-led', category: 'c9', bulbSpacingIn: 12,
    name: 'C9 LED on socket wire, a bulb every 12 in (cut to length)',
    notes: 'Bought as socket wire, packs of 25 screw-in bulbs and slide-on plugs. 0.74 W per bulb as the supplier lists it. ' + RUN_RULE,
    components: {
      wire: offer('1000bulbs', 'CMS-10105', 'C9 socket wire, 1,000 ft spool, a socket every 12 in, green SPT-1, 18 gauge (no plugs)',
        tbUrl(221836, 'CMS-10105'), 391.13, 1, {
          spoolFt: 1000, wireType: 'SPT-1', maxAmps: 5, notes: TB_WIRE_AMPS,
          sizes: [
            offer('1000bulbs', 'CMS-10124', 'C9 socket wire, 100 ft ready-made length, a socket every 12 in, green SPT-1, 18 gauge (comes with a male plug only)',
              tbUrl(221897, 'CMS-10124'), 39.43, 1, { lengthFt: 100 }),
          ],
        }),
      bulb: {
        name: 'C9 VividCore Premium LED bulbs, faceted, pack of 25', packQty: 25, wattsEach: 0.74, base: 'E17', defaultVariant: 'warmWhite',
        variants: {
          warmWhite: tbBulb('CMS-10294', 225409, 'C9', 'warm white', 25.53),
          coolWhite: tbBulb('CMS-10293', 225408, 'C9', 'cool white', 26.15, { notes: 'Other listings showed $21.29 to $23.77.' }),
          multi: tbBulb('CMS-10298', 225413, 'C9', 'multicolor', 25.52),
          red: tbBulb('CMS-10288', 225403, 'C9', 'red', 25.03),
          green: tbBulb('CMS-10291', 225406, 'C9', 'green', 26.07),
        },
      },
      plugMale: TB_PLUG_MALE,
      // The matching female plug (PLUG-10002) was shown as unavailable when last seen, so it is not offered:
      // the BOM lists a plain "female slide-on plug" line with a link to the supplier's plug page instead.
      plugFemale: null,
    },
  });

  const TB_C7_BULK = bulkProduct({
    id: '1000bulbs:c7-bulk-12', supplierId: '1000bulbs', equiv: 'c7-led', category: 'c7', bulbSpacingIn: 12,
    name: 'C7 LED on socket wire, a bulb every 12 in (cut to length)',
    notes: 'Bought as socket wire, packs of 25 screw-in bulbs and slide-on plugs. 0.48 W per bulb as the supplier lists it. ' + RUN_RULE,
    components: {
      wire: offer('1000bulbs', 'CMS-10095', 'C7 socket wire, 1,000 ft spool, a socket every 12 in, green SPT-1, 18 gauge (no plugs)',
        tbUrl(221781, 'CMS-10095'), 322.45, 1, {
          spoolFt: 1000, wireType: 'SPT-1', maxAmps: 5,
          notes: TB_WIRE_AMPS + ' Other listings showed this spool at $415.96 and $481.47.',
        }),
      bulb: {
        name: 'C7 VividCore Premium LED bulbs, faceted, pack of 25', packQty: 25, wattsEach: 0.48, base: 'E12', defaultVariant: 'warmWhite',
        variants: {
          // The plain warm white pack (CMS-10284) had no product page in the research, so the "deluxe" warm white stands in.
          warmWhite: tbBulb('CMS-10285', 225400, 'C7', 'warm white deluxe', 18.62),
          coolWhite: tbBulb('CMS-10281', 225396, 'C7', 'cool white', 19.31),
          multi: tbBulb('CMS-10286', 225401, 'C7', 'multicolor', 19.03, { notes: FAMILY_WATTS }),
          red: tbBulb('CMS-10276', 225391, 'C7', 'red', 19.69),
          green: tbBulb('CMS-10279', 225394, 'C7', 'green', 18.78, { notes: FAMILY_WATTS }),
        },
      },
      plugMale: TB_PLUG_MALE,
      plugFemale: null,
    },
  });

  const TB_PRODUCTS = [
    TB_C9_BULK,
    TB_C7_BULK,
    product('1000bulbs', 'c9-string-17', 'CMS-25C9-8GWW', {
      equiv: 'c9-led', name: 'C9 LED string, 25 bulbs on 17 ft, sealed set, green wire', category: 'c9', tech: 'LED', unit: 'string',
      bulbSpacingIn: 8, stringLengthFt: 16, leadFt: 0.5, bulbsPerUnit: 25, wattsPerUnit: 2.4, maxEndToEnd: 90, price: 13.93,
      colors: ['warmWhite'], clipEligible: true, suitableFor: LINE_TYPES.slice(),
      url: tbUrl(111494, 'CMS-25C9-8GWW'),
      notes: 'Ready-made, 17 ft overall (not 25 ft), bulbs sealed in. 2.4 W per set, up to 90 sets end to end. ' +
        'The 8 in spacing and 16 ft lit length are taken from the matching C7 set; this set\'s own page did not show them.',
    }),
    product('1000bulbs', 'mini-5mm-50', 'CMS-50WA-6GWW', {
      equiv: 'mini-led-100', name: '5 mm LED mini string, 50 bulbs, 6 in apart, green wire', category: 'mini', tech: 'LED', unit: 'string',
      bulbSpacingIn: 6, stringLengthFt: 25, leadFt: 0.5, bulbsPerUnit: 50, wattsPerUnit: 4.8, maxEndToEnd: 45, price: 14.31,
      colors: ['warmWhite'], clipEligible: false, suitableFor: MINI_TYPES.slice(),
      url: tbUrl(111472, 'CMS-50WA-6GWW'),
      notes: '26 ft overall, 25 ft lit. The page gave two figures (45 and 90 sets end to end); LightPlan uses the safer pair, 4.8 W and 45 sets.',
    }),
    product('1000bulbs', 'net-4x6-100', 'CMS-100L5MMNETWWG', {
      equiv: 'net-led-4x6', name: '5 mm LED net lights, 4 x 6 ft, 100 bulbs, green wire', category: 'net', tech: 'LED', unit: 'net',
      bulbSpacingIn: 6, stringLengthFt: 6, leadFt: 1, bulbsPerUnit: 100, wattsPerUnit: 9.6, maxEndToEnd: 22, coverageSqFt: 24, price: 32.97,
      colors: ['warmWhite'], clipEligible: false, suitableFor: ['bush'],
      url: tbUrl(202090, 'CMS-100L5MMNETWWG'),
      notes: 'One net covers about 24 sq ft. 9.6 W per net. The listing says 25 nets end to end, which is more than the usual 216 W limit for ' +
        'LED sets allows; LightPlan uses 22.',
    }),
  ];

  const SUPPLIER_PRODUCTS = CLE_PRODUCTS.concat(TB_PRODUCTS);

  // ---------------------------------------------------------------- accessories
  /** Supplier offers for the generic accessory skus in catalog.ACCESSORIES (clips are keyed by mount type there). */
  const SUPPLIER_ACCESSORIES = {
    cle: {
      'clip-allinone': offer('cle', '82761', 'All-in-one light clips (gutter or shingle), pack of 100',
        CLE + 'p/Wintergreen-Lighting-All-In-One-Christmas-Light-Clip-100-Pack-65767.htm', 13.99, 100),
      'clip-shingle': offer('cle', '83965', 'Shingle tab clips for C7 and C9, pack of 100',
        CLE + 'p/Wintergreen-Lighting-Christmas-Light-Shingle-Tab-100-Pack-65866.htm', 25, 100),
      'light-stakes': offer('cle', '84144', 'Light stakes for C7 and C9, 5 in tall, pack of 25',
        CLE + 'p/5-Inch-Wintergreen-Lighting-PathPRO-Christmas-Light-Stake-25-Pack-65885.htm', 9.99, 25),
      'timer-outdoor': offer('cle', '80056', 'Outdoor plug-in timer, mechanical, 15 A',
        CLE + 'p/15-Amp-Heavy-Duty-Grounded-Timer-Outdoor-65107.htm', 29.99, 1, { maxAmps: 15 }),
    },
    '1000bulbs': {
      'clip-allinone': offer('1000bulbs', 'CLIP-10007', 'Light clips for shingles and gutters, C7 and C9, pack of 50', tbUrl(223218, 'CLIP-10007'), 6.83, 50),
      'clip-shingle': offer('1000bulbs', 'CLIP-10005', 'Shingle tab clips for C7 and C9, pack of 50', tbUrl(223216, 'CLIP-10005'), 13.52, 50),
      'clip-ridge': offer('1000bulbs', 'CLIP-10003', 'Roof ridge clips for C7, C9 and rope light, pack of 25', tbUrl(223214, 'CLIP-10003'), 17.59, 25),
      'light-stakes': offer('1000bulbs', 'STAKE-10001', 'Lawn light stakes, 5 in tall, pack of 25', tbUrl(223227, 'STAKE-10001'), 6.29, 25,
        { notes: 'The listing seen did not say which bulb sizes it holds: check that it takes C7 or C9 before you order.' }),
      'timer-outdoor': offer('1000bulbs', 'PLTS-12336', 'Outdoor plug-in timer with dusk sensor, 2 outlets, 1,000 W maximum', tbUrl(223548, 'PLTS-12336'), 11.44, 1,
        { maxWatts: 1000, notes: 'Rated for 1,000 W at most.' }),
    },
  };

  // ---------------------------------------------------------------- lookups
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  /** The supplier with this id, or null (ids: 'generic', 'cle', '1000bulbs'). */
  function getSupplier(id) {
    return SUPPLIERS.find((s) => s.id === id) || null;
  }
  /** The id itself when it names a known supplier, else 'generic'. */
  function knownSupplierId(id) {
    return typeof id === 'string' && getSupplier(id) ? id : GENERIC_ID;
  }
  /**
   * The text when it is a plain https:// address that is safe to put in a link, else null. Product data can
   * come from an imported file, so every link the BOM hands to the UI goes through this.
   */
  function safeUrl(u) {
    if (typeof u !== 'string' || u.length > 2000) return null;
    if (!/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/[^\s"'<>\\`{}]*)?$/i.test(u)) return null;
    return u;
  }
  /** The supplier's own search page for `query`, or null when it has none (or the query is empty). */
  function supplierSearchUrl(supplierId, query) {
    const s = getSupplier(supplierId);
    const q = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';
    if (!s || !s.searchUrlTemplate || !q) return null;
    return safeUrl(s.searchUrlTemplate.replace('{query}', encodeURIComponent(q).replace(/%20/g, '+')));
  }
  /** Where to look for something at a supplier: its category page for `role`, else its search for `query`, else null. */
  function findUrl(supplierId, role, query) {
    const s = getSupplier(supplierId);
    if (!s || s.id === GENERIC_ID) return null;
    const cat = typeof role === 'string' && Object.prototype.hasOwnProperty.call(s.categoryUrls, role) ? safeUrl(s.categoryUrls[role]) : null;
    return cat || supplierSearchUrl(supplierId, query);
  }
  /** A supplier's catalog products (clones). */
  function productsOf(supplierId) {
    return clone(SUPPLIER_PRODUCTS.filter((p) => p.supplierId === supplierId));
  }
  /** The supplier's Offer for a generic accessory sku ('clip-allinone', 'light-stakes', 'timer-outdoor'...), or null. */
  function accessoryOffer(supplierId, accessorySku) {
    const m = SUPPLIER_ACCESSORIES[supplierId];
    return m && Object.prototype.hasOwnProperty.call(m, accessorySku) ? clone(m[accessorySku]) : null;
  }

  /** Every Offer inside a bulk product's components, with what it is: [{part, variant|null, offer}]. */
  function componentOffers(productOrComponents) {
    const c = isObj(productOrComponents) && isObj(productOrComponents.components) ? productOrComponents.components : productOrComponents;
    const out = [];
    if (!isObj(c)) return out;
    if (isObj(c.wire)) {
      out.push({ part: 'wire', variant: null, offer: c.wire });
      for (const s of Array.isArray(c.wire.sizes) ? c.wire.sizes : []) if (isObj(s)) out.push({ part: 'wire', variant: null, offer: s });
    }
    if (isObj(c.bulb) && isObj(c.bulb.variants)) {
      for (const v of Object.keys(c.bulb.variants)) if (isObj(c.bulb.variants[v])) out.push({ part: 'bulb', variant: v, offer: c.bulb.variants[v] });
    }
    if (isObj(c.plugMale)) out.push({ part: 'plugMale', variant: null, offer: c.plugMale });
    if (isObj(c.plugFemale)) out.push({ part: 'plugFemale', variant: null, offer: c.plugFemale });
    return out;
  }

  /** sku → the catalog's own price for every product, component and accessory here (to tell an edited price from ours). */
  const CATALOG_PRICES = (function () {
    const m = {};
    for (const p of SUPPLIER_PRODUCTS) {
      m[p.sku] = p.price;
      for (const c of componentOffers(p)) m[c.offer.sku] = c.offer.price;
    }
    for (const sid of Object.keys(SUPPLIER_ACCESSORIES)) for (const k of Object.keys(SUPPLIER_ACCESSORIES[sid])) m[SUPPLIER_ACCESSORIES[sid][k].sku] = SUPPLIER_ACCESSORIES[sid][k].price;
    return m;
  })();
  /** The price this catalog holds for a sku, or null when the sku is not from this catalog. */
  function catalogPrice(sku) {
    return Object.prototype.hasOwnProperty.call(CATALOG_PRICES, sku) ? CATALOG_PRICES[sku] : null;
  }

  /**
   * Every link in the supplier map, so a later step can check each one against the live site:
   * [{supplierId, kind: 'site'|'wholesale'|'search'|'category'|'product', sku|null, name, url}].
   * The search entry is the template filled with a sample query. One entry per distinct URL and kind.
   */
  function allLinks() {
    const out = [];
    const seen = new Set();
    const add = (supplierId, kind, sku, name, url) => {
      if (typeof url !== 'string' || !url) return;
      const key = supplierId + '|' + kind + '|' + url + '|' + (sku || '');
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ supplierId, kind, sku: sku || null, name, url });
    };
    for (const s of SUPPLIERS) {
      if (s.id === GENERIC_ID) continue;
      add(s.id, 'site', null, s.name, s.url);
      if (s.wholesale) add(s.id, 'wholesale', null, s.wholesale.name, s.wholesale.url);
      if (s.searchUrlTemplate) add(s.id, 'search', null, s.name + ' search', supplierSearchUrl(s.id, 'c9 led bulbs'));
      for (const role of Object.keys(s.categoryUrls)) add(s.id, 'category', null, role, s.categoryUrls[role]);
      for (const p of SUPPLIER_PRODUCTS) {
        if (p.supplierId !== s.id) continue;
        if (p.kind === 'bulk') {
          for (const c of componentOffers(p)) add(s.id, 'product', c.offer.supplierSku || c.offer.sku, c.offer.name, c.offer.url);
        } else add(s.id, 'product', p.supplierSku || p.sku, p.name, p.url);
      }
      const acc = SUPPLIER_ACCESSORIES[s.id] || {};
      for (const k of Object.keys(acc)) add(s.id, 'product', acc[k].supplierSku || acc[k].sku, acc[k].name, acc[k].url);
    }
    return out;
  }
  /** The host names those links use, sorted (the build test allows exactly these as link targets). */
  function linkHosts() {
    const hosts = new Set();
    for (const l of allLinks()) {
      const m = /^https:\/\/([^/:?#]+)/i.exec(l.url);
      if (m) hosts.add(m[1].toLowerCase());
    }
    return Array.from(hosts).sort();
  }

  /** "Nov 11, 2026" from "2026-11-11" (the text itself when it is not a date). */
  function formatDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof iso === 'string' ? iso : '');
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (!m || !(Number(m[2]) >= 1 && Number(m[2]) <= 12)) return typeof iso === 'string' ? iso : '';
    return names[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
  }

  return {
    SUPPLIERS, SUPPLIER_PRODUCTS, SUPPLIER_ACCESSORIES, GENERIC_ID, ROLES, PRICE_STATUSES, PRICE_AS_OF, VARIANT_ORDER, VARIANT_LABELS,
    getSupplier, knownSupplierId, supplierSearchUrl, findUrl, safeUrl, productsOf, accessoryOffer, componentOffers, catalogPrice,
    bulkProduct, allLinks, linkHosts, formatDate,
  };
});
