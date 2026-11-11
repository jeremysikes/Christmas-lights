/* LightPlan core: suppliers (SPEC §8.3).
 * A hand-entered map of two suppliers' catalogs, so a plan can be ordered by their part numbers:
 * who they are, where their category pages are, a small set of products with links, and the bulk C7/C9
 * parts (socket wire by the spool, bulbs by the box, slide-on plugs). Data and tiny lookups only: pure,
 * JSON-able, no DOM, no clock, no network. Nothing here is ever fetched: every URL is a link for a person
 * to open.
 *
 * HOW FAR TO TRUST IT. Everything below was read from the suppliers' own pages on 2026-11-11 (the check
 * is written up in docs/SUPPLIER_CHECK.md). Each price is a snapshot of that day.
 *  - priceStatus 'verified': the price, part number, pack size and electrical figures were read on the
 *    item's own product page that day.
 *  - priceStatus 'observed': the item was seen on the supplier's category list only (its own page was not
 *    opened), so the app says "check the price". Seven 1000Bulbs items are like this (two spools or lengths of
 *    C7 wire, three 50 ft lengths of wire and the two blue bulbs).
 *  - A cut-to-length product as a whole (kind 'bulk') has no part number and its per-foot price is worked
 *    out from its parts, not read from a page, so it is never 'verified': its parts carry their own status.
 *  - Nothing else is entered. Items that could not be ordered that day, items with no watts on their page,
 *    and items whose shape the planner cannot handle are left out (docs/DATA_MODEL.md lists them).
 *  - Where a page gives two different amp or connect-limit figures, the lower one is used.
 *  - Run limits: bulk socket wire uses the trade rule "250 bulbs or 250 ft of line, whichever comes
 *    first", whatever larger rating a page prints for the wire.
 *  - Quantity prices printed on Christmas Lights Etc pages are stored as `tiers` (the page's own wording
 *    of each range) and mentioned in a note. They are never used to price a plan: the ranges are ambiguous.
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
      // Read from the supplier's wholesale page. Its sign-up form is on the parent company's own site, which was
      // not checked, so there is no link to it here: the link is the wholesale page that was read.
      wholesale: {
        name: 'Christmas Lights Etc wholesale program',
        url: CLE + 'wholesale-Christmas-lights-and-trees.htm',
        phone: '1-855-WGC-7100',
        email: 'sales@wintergreencorp.com',
        note: 'Christmas Lights Etc is part of the Wintergreen Corporation family. Its wholesale page promises wholesale pricing, large-order ' +
          'discounts, same-day shipping and shipping straight to your clients, but lists no discount levels, minimum order, free-shipping amount ' +
          'or payment terms. The sign-up form is on Wintergreen\'s own site, which was not checked.',
      },
      // The site's own search form. Tested on 2026-11-11: the results page loaded and listed products.
      searchUrlTemplate: CLE + 'browse/?q={query}',
      searchUrlWorks: true,
      searchNote: 'Checked on Nov 11, 2026: the search page loaded and listed products.',
      categoryUrls: {
        c9Bulbs: CLE + 'c9-led-replacement-lamp-bulbs--790.htm',
        c7Bulbs: CLE + 'c7-led-replacement-bulbs--789.htm',
        spools: CLE + 'c7-c9-christmas-light-strings-spools-8015.htm',
        stringers: CLE + 'c7-c9-christmas-light-strings-spools-8015.htm',
        // There is no page for plugs alone: they are on the electrical accessories page (filter "Electrical Plugs").
        plugs: CLE + 'christmas-light-adapters-and-electrical-accessories--106.htm',
        // The parent clips page ("Christmas Light Clips & Hangers"): it leads to the C7/C9 clips, the all-in-one clips
        // and the mini-light clips, so the find link fits adhesive mini-light clips and zip ties as well.
        clips: CLE + 'christmas-light-clips-and-hangers--102.htm',
        miniLights: CLE + 'Wide-Angle-Lens-LED-Lights--864.htm',
        icicle: CLE + 'Icicle-Lights.htm',
        net: CLE + 'led-net-lights--819.htm',
        rope: CLE + 'LED-Rope-Lights--130.htm',
        stakes: CLE + 'c7-c9-christmas-light-stakes--798.htm',
        timers: CLE + 'christmas-light-timers-and-controllers--107.htm',
        extensionCords: CLE + 'christmas-extension-cords--104.htm',
      },
      priceAsOf: PRICE_AS_OF,
      notes: 'Public prices read from the supplier\'s own product pages on Nov 11, 2026. Order by the Item Number shown on each page. ' +
        'Bulb boxes, mini light sets, icicle sets and nets cost less in quantity: the supplier\'s page shows the price breaks.',
    },
    {
      id: '1000bulbs', name: '1000Bulbs', short: '1000Bulbs', url: TB,
      // No wholesale, contractor or business-account page was seen on the site, so there is no link: only the
      // phone number from its home page and the free-shipping line from its product pages.
      wholesale: {
        name: '1000Bulbs lighting specialists (by phone)',
        url: null,
        phone: '1-800-624-4488',
        note: 'No wholesale or contractor account page was seen on the site when it was checked. The phone number is the one on its home page. ' +
          'Product pages say an item ships free with orders of $600 or more.',
      },
      // The address the site's own search box uses. The test on 2026-11-11 was blocked by the site, so it is not confirmed.
      searchUrlTemplate: TB + 'fil/search?q={query}',
      searchUrlWorks: null,
      searchNote: 'This is the address the site\'s own search box uses. It could not be checked on Nov 11, 2026 (the site blocked the test).',
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
      notes: 'Public prices read from the supplier\'s own product pages on Nov 11, 2026. A few items were seen on its category lists only and ' +
        'say "check the price". Its pages showed no quantity price breaks.',
    },
  ];

  // ---------------------------------------------------------------- builders
  const round = (v, d) => { const k = Math.pow(10, d); return Math.round(v * k) / k; };
  /** Printed on the line of anything that was seen on a category list only (priceStatus 'observed'). */
  const LISTED_ONLY = 'Seen on the supplier\'s category list only, not on its own page: check the price and details there.';
  const LIMITED = 'The page said "Limited Quantity Available" when it was checked.';
  /** The short sentence for a page's quantity prices: "Quantity price from 20 boxes: see the supplier's page." */
  function tierNote(tiers, unit) {
    const m = /^\s*(\d+)/.exec(tiers[0].qty);
    return `Quantity price from ${m[1]} ${unit}: see the supplier's page.`;
  }
  const copyTiers = (tiers) => tiers.map((t) => Object.assign({}, t));

  /**
   * One thing you can order (SPEC "Offer"): a bulk part or an accessory. `sku` (the price-override key) is
   * "<supplierId>:<part number>". Read on its own product page unless `extra.listedOnly` (seen on a category
   * list only → 'observed', with a note). `extra.tiers` + `extra.tierUnit`: the page's quantity prices, kept as
   * data and mentioned in the note. Every other key of `extra` is copied onto the offer.
   */
  function offer(supplierId, supplierSku, name, url, price, packQty, extra) {
    const x = extra || {};
    const out = {
      sku: supplierId + ':' + supplierSku, supplierSku, name, url, price, packQty,
      priceAsOf: PRICE_AS_OF, priceStatus: x.listedOnly ? 'observed' : 'verified',
    };
    for (const k of Object.keys(x)) if (!['listedOnly', 'tierUnit', 'tiers', 'notes'].includes(k)) out[k] = x[k];
    const notes = [];
    if (x.notes) notes.push(x.notes);
    if (x.tiers) { out.tiers = copyTiers(x.tiers); notes.push(tierNote(x.tiers, x.tierUnit || 'packs')); }
    if (x.listedOnly) notes.push(LISTED_ONLY);
    if (notes.length) out.notes = notes.join(' ');
    return out;
  }

  /**
   * Bulk C7/C9: socket wire cut to length + one bulb per socket + slide-on plugs, as a per-foot Product so
   * measuring, chaining and power feeds work unchanged (SPEC §8.3). Derived figures:
   * bulbsPerUnit = 12 / spacing, wattsPerUnit = wattsEach × bulbsPerUnit, maxEndToEnd = the feet one run may
   * be (maxRunFt, and never more sockets than maxBulbsPerRun), maxConnectedW = the watts one run may carry
   * (maxBulbsPerRun × the highest wattsEach of any bulb colour on file, so a full run of the hungriest colour
   * still fits, and never more than 80% of the lowest amp rating printed for any length of the wire, at
   * 120 V), and `price` = a per-foot equivalent of the spool + default bulbs (display and
   * fallback only; the BOM prices the components). The product itself has no part number and its price is
   * worked out, not read from a page, so its priceStatus is 'observed' whatever its parts are.
   */
  function bulkProduct(spec) {
    const spacing = spec.bulbSpacingIn;
    const perFt = 12 / spacing;
    const c = spec.components;
    const maxRunFt = spec.maxRunFt || 250;
    const maxBulbs = spec.maxBulbsPerRun || 250;
    const def = c.bulb.variants[c.bulb.defaultVariant];
    const amps = [c.wire].concat(Array.isArray(c.wire.sizes) ? c.wire.sizes : []).map((w) => w && w.maxAmps).filter((a) => a > 0);
    const wireW = amps.length ? Math.min.apply(null, amps) * 120 * 0.8 : Infinity;
    const topW = Math.max.apply(null, [c.bulb.wattsEach].concat(Object.keys(c.bulb.variants).map((v) => c.bulb.variants[v].wattsEach).filter((w) => w > 0)));
    return {
      id: spec.id, sku: spec.id, supplierId: spec.supplierId, supplierSku: null, equiv: spec.equiv, kind: 'bulk',
      name: spec.name, category: spec.category, tech: 'LED', unit: 'foot',
      bulbSpacingIn: spacing, stringLengthFt: 1, leadFt: 0, bulbsPerUnit: round(perFt, 4), wattsPerUnit: round(c.bulb.wattsEach * perFt, 4),
      maxEndToEnd: Math.floor(Math.min(maxRunFt, maxBulbs / perFt)), maxRunFt, maxBulbsPerRun: maxBulbs,
      maxConnectedW: round(Math.min(maxBulbs * topW, wireW), 2), endConnector: true,
      price: round(c.wire.price / c.wire.spoolFt + perFt * def.price / c.bulb.packQty, 2),
      colors: ALL_COLORS.slice(), clipEligible: true, enabled: true, suitableFor: LINE_TYPES.slice(),
      url: c.wire.url, priceAsOf: PRICE_AS_OF, priceStatus: 'observed', notes: spec.notes, components: c,
    };
  }

  /**
   * A ready-made supplier product (same shape as catalog.DEFAULT_PRODUCTS plus the supplier fields), read on
   * its own product page. `fields.tiers` + `fields.tierUnit`: the page's quantity prices, kept as data and
   * mentioned in orderNote (the short caution printed on the shopping-list line; `notes` is the longer
   * description shown in the product library).
   */
  function product(supplierId, slug, supplierSku, fields) {
    const id = supplierId + ':' + slug;
    const out = { id, sku: id, supplierId, supplierSku };
    for (const k of Object.keys(fields)) if (!['tierUnit', 'tiers', 'orderNote'].includes(k)) out[k] = fields[k];
    Object.assign(out, { enabled: true, priceAsOf: PRICE_AS_OF, priceStatus: 'verified' });
    const order = [];
    if (fields.orderNote) order.push(fields.orderNote);
    if (fields.tiers) { out.tiers = copyTiers(fields.tiers); order.push(tierNote(fields.tiers, fields.tierUnit || 'sets')); }
    if (order.length) out.orderNote = order.join(' ');
    return out;
  }

  const RUN_RULE = 'One run: at most 250 ft of wire or 250 bulbs, whichever comes first (the trade rule for 18-gauge socket wire).';
  /** What a length of socket wire comes with, said on the BOM line because slide-on plugs are counted for every cut length. */
  const PLUGS_BOTH = 'It comes with a plug on each end, so a length you use uncut needs no slide-on plugs.';
  const PLUG_MALE_ONLY = 'It comes with a male plug only, so a length you use uncut needs no slide-on male plug.';

  // ---------------------------------------------------------------- Christmas Lights Etc
  // Quantity prices as the bulb pages print them ("Bulk Discounts": range, price per box, percent off list).
  const CLE_C9_BULB_TIERS = [{ qty: '20 - 40 boxes', each: 28.7, pctOffList: 30 }, { qty: '40+ boxes', each: 26.65, pctOffList: 35 }];
  const CLE_C7_BULB_TIERS = [{ qty: '10 - 20 boxes', each: 24.94, pctOffList: 25 }, { qty: '20 - 40 boxes', each: 23.28, pctOffList: 30 },
    { qty: '40+ boxes', each: 21.61, pctOffList: 35 }];
  const cleBulb = (item, colour, page, base, price, tiers) => offer('cle', item,
    `${base} OptiCore LED bulbs, ${colour}, faceted, box of 25`, CLE + 'p/' + page, price, 25, { tiers, tierUnit: 'boxes' });
  /** Socket wire at Christmas Lights Etc: 18-gauge SPT-1 (the pages say "SPT1W"), a socket every 12 in, green. */
  const cleWire = (item, name, page, price, extra) => offer('cle', item, name, CLE + 'p/' + page, price, 1,
    Object.assign({ wireType: 'SPT-1', wireGauge: 18 }, extra));
  const CLE_AMPS = 'The supplier\'s pages give this wire 7 A in the table and 8 A in the text. LightPlan takes the lowest figure a page gives, ' +
    'and 250 bulbs (200 W) stay far inside it.';

  // SPT-1 slide-on plugs, green, packs of 10 (the packs of 5 could not be ordered on 2026-11-11).
  const CLE_PLUG_MALE = offer('cle', '88283', 'Slide-on male plug for SPT-1 wire, green, pack of 10',
    CLE + 'p/Male-Zip-Plug-SPT1-2-Prong-Male-Plug-Green-10-Pack-67468.htm', 12.4, 10, { wireType: 'SPT-1', maxAmps: 10 });
  const CLE_PLUG_FEMALE = offer('cle', '88287', 'Slide-on female plug for SPT-1 wire, green, pack of 10',
    CLE + 'p/Female-Zip-Plug-with-Knockout-Tab-SPT1-Green-10-Pack-67469.htm', 12.4, 10, { wireType: 'SPT-1', maxAmps: 10 });

  const CLE_C9_BULK = bulkProduct({
    id: 'cle:c9-bulk-12', supplierId: 'cle', equiv: 'c9-led', category: 'c9', bulbSpacingIn: 12,
    name: 'C9 LED on socket wire, a bulb every 12 in (cut to length)',
    notes: 'Bought as socket wire, boxes of 25 screw-in bulbs and slide-on plugs. 0.8 W per bulb as the supplier lists it. ' + RUN_RULE + ' ' + CLE_AMPS +
      ' (The table for the 25 ft length says 5 A.)',
    components: {
      wire: cleWire('15085', 'C9 socket wire, 1,000 ft spool, a socket every 12 in, green SPT-1 (no plugs)',
        'C9-Christmas-Lights-Spool-1000-ft-Length-12-inch-Spacing-7-Amp-Green-Wire--15085.htm', 409.99, {
          spoolFt: 1000, maxAmps: 7, plugsIncluded: false,
          sizes: [
            cleWire('81832', 'C9 socket wire, 500 ft spool, a socket every 12 in, green SPT-1 (no plugs)',
              '500-foot-c9-commercial-light-spool-spt1-green-wire-61557.htm', 219.99, { lengthFt: 500, maxAmps: 7, plugsIncluded: false }),
            cleWire('15098', 'C9 socket wire, 100 ft ready-made length, a socket every 12 in, green SPT-1 (plugs on both ends)',
              'C9-Christmas-Lights-String-100-ft-Length-12-inch-Spacing-7-Amp-Green-Wire--15098.htm', 49.99,
              { lengthFt: 100, maxAmps: 7, plugsIncluded: 'both', notes: PLUGS_BOTH }),
            cleWire('15106', 'C9 socket wire, 50 ft ready-made length, a socket every 12 in, green SPT-1 (plugs on both ends)',
              'C9-Christmas-Lights-String-50-ft-Length-12-inch-Spacing-5-Amp-Green-Wire--15106.htm', 27.99,
              { lengthFt: 50, maxAmps: 7, plugsIncluded: 'both', notes: PLUGS_BOTH }),
            cleWire('15100', 'C9 socket wire, 25 ft ready-made length, a socket every 12 in, green SPT-1 (plugs on both ends)',
              'C9-Christmas-Lights-String-25-ft-Length-12-inch-Spacing-Green-Wire--15100.htm', 15.99,
              { lengthFt: 25, maxAmps: 5, plugsIncluded: 'both', notes: PLUGS_BOTH }),
          ],
        }),
      bulb: {
        name: 'C9 OptiCore LED bulbs, faceted, box of 25', packQty: 25, wattsEach: 0.8, base: 'E17', defaultVariant: 'warmWhite',
        variants: {
          warmWhite: cleBulb('72636', 'warm white', 'C9--Warm-White-OptiCore-LED-Replacement-Bulbs-13603.htm', 'C9', 29.99, CLE_C9_BULB_TIERS),
          coolWhite: cleBulb('72639', 'cool white', 'C9--Cool-White-OptiCore-LED-Replacement-Bulbs-13604.htm', 'C9', 29.99, CLE_C9_BULB_TIERS),
          multi: cleBulb('72642', 'multicolor', 'C9--Multicolor-OptiCore-LED-Replacement-Bulbs-13605.htm', 'C9', 29.99, CLE_C9_BULB_TIERS),
          red: cleBulb('72645', 'red', 'C9--Red-OptiCore-LED-Replacement-Bulbs-13606.htm', 'C9', 29.99, CLE_C9_BULB_TIERS),
          green: cleBulb('72654', 'green', 'C9--Green-OptiCore-LED-Replacement-Bulbs-13609.htm', 'C9', 29.99, CLE_C9_BULB_TIERS),
          blue: cleBulb('72648', 'blue', 'C9--Blue-OptiCore-LED-Replacement-Bulbs-13607.htm', 'C9', 29.99, CLE_C9_BULB_TIERS),
        },
      },
      plugMale: CLE_PLUG_MALE,
      plugFemale: CLE_PLUG_FEMALE,
    },
  });

  const CLE_C7_BULK = bulkProduct({
    id: 'cle:c7-bulk-12', supplierId: 'cle', equiv: 'c7-led', category: 'c7', bulbSpacingIn: 12,
    name: 'C7 LED on socket wire, a bulb every 12 in (cut to length)',
    notes: 'Bought as socket wire, boxes of 25 screw-in bulbs and slide-on plugs. 0.8 W per bulb as the supplier lists it. ' + RUN_RULE + ' ' + CLE_AMPS +
      ' (The table for the 50 ft length says 5 A.)',
    components: {
      wire: cleWire('15054', 'C7 socket wire, 1,000 ft spool, a socket every 12 in, green SPT-1 (no plugs)',
        'C7-Christmas-Lights-Spool-1000-ft-Length-12-inch-Spacing-7-Amp-Green-Wire--15054.htm', 369.99, {
          spoolFt: 1000, maxAmps: 7, plugsIncluded: false,
          sizes: [
            cleWire('72912', 'C7 socket wire, 500 ft spool, a socket every 12 in, green SPT-1 (no plugs)',
              '500-foot-c7-commercial-light-spool-spt1-green-wire-61546.htm', 199.99, { lengthFt: 500, maxAmps: 7, plugsIncluded: false }),
            cleWire('15067', 'C7 socket wire, 100 ft ready-made length, a socket every 12 in, green SPT-1 (plugs on both ends)',
              'C7-Christmas-Lights-String-100-ft-Length-12-inch-Spacing-5-Amp-Green-Wire--15067.htm', 44.99,
              { lengthFt: 100, maxAmps: 7, plugsIncluded: 'both', notes: PLUGS_BOTH }),
            cleWire('15077', 'C7 socket wire, 50 ft ready-made length, a socket every 12 in, green SPT-1 (plugs on both ends)',
              'C7-Christmas-Lights-String-50-ft-Length-12-inch-Spacing-Green-Wire--15077.htm', 22.99,
              { lengthFt: 50, maxAmps: 5, plugsIncluded: 'both', notes: PLUGS_BOTH }),
            cleWire('15071', 'C7 socket wire, 25 ft ready-made length, a socket every 12 in, green SPT-1 (plugs on both ends)',
              'C7-Christmas-Lights-String-25-ft-Length-12-inch-Spacing-Green-Wire--15071.htm', 11.99,
              { lengthFt: 25, maxAmps: 8, plugsIncluded: 'both', notes: PLUGS_BOTH }),
          ],
        }),
      bulb: {
        name: 'C7 OptiCore LED bulbs, faceted, box of 25', packQty: 25, wattsEach: 0.8, base: 'E12', defaultVariant: 'warmWhite',
        variants: {
          warmWhite: cleBulb('72609', 'warm white', 'C7--Warm-White-OptiCore-LED-Replacement-Bulbs-13593.htm', 'C7', 24.99, CLE_C7_BULB_TIERS),
          coolWhite: cleBulb('72606', 'cool white', 'C7--Cool-White-OptiCore-LED-Replacement-Bulbs-13594.htm', 'C7', 24.99, CLE_C7_BULB_TIERS),
          multi: cleBulb('72612', 'multicolor', 'C7--Multicolor-OptiCore-LED-Replacement-Bulbs-13595.htm', 'C7', 24.99, CLE_C7_BULB_TIERS),
          red: cleBulb('72615', 'red', 'C7--Red-OptiCore-LED-Replacement-Bulbs-13596.htm', 'C7', 24.99, CLE_C7_BULB_TIERS),
          green: cleBulb('72624', 'green', 'C7--Green-OptiCore-LED-Replacement-Bulbs-13599.htm', 'C7', 24.99, CLE_C7_BULB_TIERS),
          blue: cleBulb('72618', 'blue', 'C7--Blue-OptiCore-LED-Replacement-Bulbs-13597.htm', 'C7', 24.99, CLE_C7_BULB_TIERS),
        },
      },
      plugMale: CLE_PLUG_MALE,
      plugFemale: CLE_PLUG_FEMALE,
    },
  });

  const SET_RULE = 'LightPlan plans at most 10 sets (250 ft, 250 bulbs, 200 W) on one run, the trade rule for this wire, ' +
    'whatever larger figure the supplier\'s page prints for sets joined end to end.';
  /** These pages offer the same string in more than one size: the line says which one the part number is. */
  const sizeNote = (item) => `The page offers more than one size: pick the 25-light, 25 ft set (item ${item}).`;
  const CLE_PRODUCTS = [
    CLE_C9_BULK,
    CLE_C7_BULK,
    product('cle', 'c9-string-25', '77667', {
      equiv: 'c9-led', name: 'C9 OptiCore LED string, 25 bulbs on 25 ft, ready to hang', category: 'c9', tech: 'LED', unit: 'string',
      bulbSpacingIn: 12, stringLengthFt: 25, leadFt: 0.5, bulbsPerUnit: 25, wattsPerUnit: 20, maxEndToEnd: 10, price: 49.99,
      colors: ['warmWhite'], clipEligible: true, suitableFor: LINE_TYPES.slice(),
      url: CLE + 'p/C9-Warm-White-Opticore-Commercial-LED-Christmas-String-Lights-14953.htm',
      orderNote: sizeNote('77667'),
      notes: 'Ready-made: screw-in bulbs already in, on 18-gauge SPT-1 wire with a fused plug. 20 W per set (0.8 W per bulb). ' + SET_RULE,
    }),
    product('cle', 'c9-string-17', '84095', {
      equiv: 'c9-led', name: 'C9 LED string, 25 bulbs on 17 ft, sealed set, green wire', category: 'c9', tech: 'LED', unit: 'string',
      bulbSpacingIn: 8, stringLengthFt: 16, leadFt: 0.5, bulbsPerUnit: 25, wattsPerUnit: 2.4, maxEndToEnd: 90, price: 14.99,
      colors: ['warmWhite'], clipEligible: true, suitableFor: LINE_TYPES.slice(),
      url: CLE + 'C9-LED-Faceted-Warm-White-Prelamped-Light-Set--Green-Wire-7195.htm',
      tiers: [{ qty: '192+', each: 12.64, pctOffList: 45 }], tierUnit: 'sets',
      notes: 'Ready-made, 17 ft overall, bulbs 8 in apart and sealed in (they cannot be changed). 2.4 W per set, up to 90 sets end to end. ' +
        'The lit length (16 ft) is worked out from 25 bulbs 8 in apart.',
    }),
    product('cle', 'c7-string-25', '77653', {
      equiv: 'c7-led', name: 'C7 OptiCore LED string, 25 bulbs on 25 ft, ready to hang', category: 'c7', tech: 'LED', unit: 'string',
      bulbSpacingIn: 12, stringLengthFt: 25, leadFt: 0.5, bulbsPerUnit: 25, wattsPerUnit: 20, maxEndToEnd: 10, price: 39.99,
      colors: ['warmWhite'], clipEligible: true, suitableFor: LINE_TYPES.slice(),
      url: CLE + 'p/C7-Warm-White-Opticore-Commercial-LED-Christmas-String-Lights-14949.htm',
      orderNote: sizeNote('77653'),
      notes: 'Ready-made: screw-in bulbs already in, on 18-gauge SPT-1 wire with a fused plug. 20 W per set (0.8 W per bulb). ' + SET_RULE,
    }),
    product('cle', 'mini-5mm-70', '83768', {
      equiv: 'mini-led-100', name: '5 mm LED mini string, 70 bulbs, 4 in apart, green wire', category: 'mini', tech: 'LED', unit: 'string',
      bulbSpacingIn: 4, stringLengthFt: 23, leadFt: 0.5, bulbsPerUnit: 70, wattsPerUnit: 4.8, maxEndToEnd: 45, price: 19.99,
      colors: ['warmWhite'], clipEligible: false, suitableFor: MINI_TYPES.slice(),
      url: CLE + '5mm-LED-Wide-Angle-Warm-White-Prelamped-Light-Set--Green-Wire-7190.htm',
      tiers: [{ qty: '100 - 192', each: 18.89, pctOffList: 30 }, { qty: '192+', each: 14.84, pctOffList: 45 }], tierUnit: 'sets',
      notes: '4.8 W per set, up to 45 sets end to end. 24 ft overall; the lit length (23 ft) is worked out from 70 bulbs 4 in apart.',
      orderNote: 'The page lists two sizes: pick the set with bulbs 4 in apart (item 83768).',
    }),
    product('cle', 'icicle-70', '85686', {
      equiv: 'icicle-led-300', name: '5 mm LED icicle lights, 70 bulbs, 7 ft lit, white wire', category: 'icicle', tech: 'LED', unit: 'string',
      bulbSpacingIn: 6, stringLengthFt: 7, leadFt: 0.5, bulbsPerUnit: 70, wattsPerUnit: 4.8, maxEndToEnd: 45, dropLengthsIn: [18, 15, 9], price: 21.99,
      colors: ['warmWhite'], clipEligible: true, suitableFor: ['roofline', 'gutter', 'railing'],
      url: CLE + 'p/5mm-Warm-White-LED-Icicle-Lights-5889.htm',
      tiers: [{ qty: '100+', each: 20.99, pctOffList: 25 }], tierUnit: 'sets',
      notes: '15 drops of 18, 15 and 9 in, 6 in apart; 8 ft overall. 4.8 W per set, up to 45 sets end to end.',
    }),
    product('cle', 'net-4x6-100', '85472', {
      equiv: 'net-led-4x6', name: '5 mm LED net lights, 4 x 6 ft, 100 bulbs, green wire', category: 'net', tech: 'LED', unit: 'net',
      bulbSpacingIn: 6, stringLengthFt: 6, leadFt: 2, bulbsPerUnit: 100, wattsPerUnit: 12, maxEndToEnd: 18, coverageSqFt: 24, price: 34.99,
      colors: ['warmWhite'], clipEligible: false, suitableFor: ['bush'],
      url: CLE + 'p/5mm-Warm-White-LED-Net-Lights-Green-Wire-6621.htm',
      tiers: [{ qty: '100+', each: 33.74, pctOffList: 25 }], tierUnit: 'nets',
      notes: 'One net covers about 24 sq ft. 12 W per net, up to 18 nets end to end.',
    }),
  ];

  // ---------------------------------------------------------------- 1000Bulbs
  const tbUrl = (id, sku) => TB + 'product/' + id + '/' + sku + '.html';
  const tbBulb = (sku, id, base, colour, price, extra) => offer('1000bulbs', sku,
    `${base} VividCore Premium LED bulbs, ${colour}, faceted, pack of 25`, tbUrl(id, sku), price, 25, extra);
  /**
   * Socket wire at 1000Bulbs: 18-gauge SPT-1, a socket every 12 in, green. Its 25 ft lengths are 20-gauge, so they
   * are not offered as a size of it; its 50 ft lengths are 18-gauge and were seen on its category list.
   */
  const tbWire = (sku, id, name, price, extra) => offer('1000bulbs', sku, name, tbUrl(id, sku), price, 1,
    Object.assign({ wireType: 'SPT-1', wireGauge: 18 }, extra));
  const TB_AMPS = 'This supplier\'s spool pages give no amp rating for the wire; the page for its 100 ft length of C9 socket wire, the same ' +
    '18-gauge wire, says 5 A. LightPlan holds a run to 250 bulbs, far inside that.';

  // SPT-1 slide-on plugs, green, packs of 10.
  const TB_PLUG_MALE = offer('1000bulbs', 'PLUG-10001', 'Slide-on male plug for SPT-1 wire, green, pack of 10', tbUrl(223184, 'PLUG-10001'), 6.73, 10,
    { wireType: 'SPT-1', maxAmps: 10 });
  const TB_PLUG_FEMALE = offer('1000bulbs', 'PLUG-10002', 'Slide-on female plug for SPT-1 wire, green, pack of 10', tbUrl(223291, 'PLUG-10002'), 6.73, 10,
    { wireType: 'SPT-1', maxAmps: 10 });

  const TB_C9_BULK = bulkProduct({
    id: '1000bulbs:c9-bulk-12', supplierId: '1000bulbs', equiv: 'c9-led', category: 'c9', bulbSpacingIn: 12,
    name: 'C9 LED on socket wire, a bulb every 12 in (cut to length)',
    notes: 'Bought as socket wire, packs of 25 screw-in bulbs and slide-on plugs. 0.74 W per bulb as the supplier lists it. ' + RUN_RULE + ' ' + TB_AMPS,
    components: {
      wire: tbWire('CMS-10105', 221836, 'C9 socket wire, 1,000 ft spool, a socket every 12 in, green SPT-1, 18 gauge (no plugs)', 391.13, {
        spoolFt: 1000, plugsIncluded: false,
        sizes: [
          tbWire('CMS-10110', 221841, 'C9 socket wire, 500 ft spool, a socket every 12 in, green SPT-1, 18 gauge (no plugs)', 224.4,
            { lengthFt: 500, plugsIncluded: false }),
          tbWire('CMS-10124', 221897, 'C9 socket wire, 100 ft ready-made length, a socket every 12 in, green SPT-1, 18 gauge (male plug only)', 39.43,
            { lengthFt: 100, maxAmps: 5, plugsIncluded: 'male', notes: PLUG_MALE_ONLY }),
          // Seen on the supplier's category list only (its own page was not opened).
          tbWire('CMS-10319', 231931, 'C9 socket wire, 50 ft ready-made length, a socket every 12 in, green SPT-1, 18 gauge (plugs on both ends)', 26.98,
            { lengthFt: 50, plugsIncluded: 'both', listedOnly: true, notes: PLUGS_BOTH }),
        ],
      }),
      bulb: {
        name: 'C9 VividCore Premium LED bulbs, faceted, pack of 25', packQty: 25, wattsEach: 0.74, base: 'E17', defaultVariant: 'warmWhite',
        variants: {
          warmWhite: tbBulb('CMS-10294', 225409, 'C9', 'warm white', 25.42),
          coolWhite: tbBulb('CMS-10293', 225408, 'C9', 'cool white', 26.15),
          multi: tbBulb('CMS-10298', 225413, 'C9', 'multicolor', 25.52, { notes: LIMITED }),
          red: tbBulb('CMS-10288', 225403, 'C9', 'red', 25.03),
          green: tbBulb('CMS-10291', 225406, 'C9', 'green', 26.07, { notes: LIMITED }),
          // No VividCore Premium blue was seen: this is the supplier's standard blue bulb, from its category list.
          blue: offer('1000bulbs', 'CMS-C9BLU', 'C9 LED bulbs, blue, faceted, pack of 25 (standard line)', tbUrl(204203, 'CMS-C9BLU'), 22.33, 25, {
            listedOnly: true, wattsEach: 0.5,
            notes: 'A different bulb line from the other colours (standard, not VividCore Premium): 0.5 W per bulb as listed; the plan counts 0.74 W, like the other colours, to stay on the safe side.',
          }),
        },
      },
      plugMale: TB_PLUG_MALE,
      plugFemale: TB_PLUG_FEMALE,
    },
  });

  const TB_C7_BULK = bulkProduct({
    id: '1000bulbs:c7-bulk-12', supplierId: '1000bulbs', equiv: 'c7-led', category: 'c7', bulbSpacingIn: 12,
    name: 'C7 LED on socket wire, a bulb every 12 in (cut to length)',
    notes: 'Bought as socket wire, packs of 25 screw-in bulbs and slide-on plugs. 0.48 W per bulb as the supplier lists it. ' + RUN_RULE + ' ' + TB_AMPS,
    components: {
      wire: tbWire('CMS-10095', 221781, 'C7 socket wire, 1,000 ft spool, a socket every 12 in, green SPT-1, 18 gauge (no plugs)', 481.47, {
        spoolFt: 1000, plugsIncluded: false,
        sizes: [
          tbWire('CMS-10093', 221779, 'C7 socket wire, 500 ft spool, a socket every 12 in, green SPT-1, 18 gauge (no plugs)', 229.77,
            { lengthFt: 500, plugsIncluded: false, listedOnly: true }),
          tbWire('CMS-10323', 233211, 'C7 socket wire, 100 ft ready-made length, a socket every 12 in, green SPT-1, 18 gauge (plugs on both ends)', 57.64,
            { lengthFt: 100, plugsIncluded: 'both', listedOnly: true, notes: PLUGS_BOTH }),
          // Two 50 ft lengths are on the category list: one with a male plug only, one with a plug on each end.
          tbWire('CMS-10122', 221895, 'C7 socket wire, 50 ft ready-made length, a socket every 12 in, green SPT-1, 18 gauge (male plug only)', 18.85,
            { lengthFt: 50, plugsIncluded: 'male', listedOnly: true, notes: PLUG_MALE_ONLY }),
          tbWire('CMS-10318', 231930, 'C7 socket wire, 50 ft ready-made length, a socket every 12 in, green SPT-1, 18 gauge (plugs on both ends)', 30.44,
            { lengthFt: 50, plugsIncluded: 'both', listedOnly: true, notes: PLUGS_BOTH }),
        ],
      }),
      bulb: {
        name: 'C7 VividCore Premium LED bulbs, faceted, pack of 25', packQty: 25, wattsEach: 0.48, base: 'E12', defaultVariant: 'warmWhite',
        variants: {
          // The plain warm white pack (CMS-10284, 0.54 W) was "temporarily unavailable" on 2026-11-11, so the
          // warm white deluxe pack, which could be ordered, stands in.
          warmWhite: tbBulb('CMS-10285', 225400, 'C7', 'warm white deluxe', 18.62,
            { notes: 'The plain warm white pack (CMS-10284) could not be ordered when checked, so the warm white deluxe pack stands in.' }),
          coolWhite: tbBulb('CMS-10281', 225396, 'C7', 'cool white', 19.31),
          multi: tbBulb('CMS-10286', 225401, 'C7', 'multicolor', 19.03),
          red: tbBulb('CMS-10276', 225391, 'C7', 'red', 19.69),
          green: tbBulb('CMS-10279', 225394, 'C7', 'green', 19.72),
          // No VividCore Premium blue was seen: this is the supplier's standard blue bulb, from its category list.
          blue: offer('1000bulbs', 'CMS-C7BLU', 'C7 LED bulbs, blue, faceted, pack of 25 (standard line)', tbUrl(204195, 'CMS-C7BLU'), 17.29, 25, {
            listedOnly: true, wattsEach: 0.54,
            notes: 'A different bulb line from the other colours (standard, not VividCore Premium): 0.54 W per bulb as listed, a little more than the 0.48 W of the other colours, so the plan counts 0.54 W for each blue bulb.',
          }),
        },
      },
      plugMale: TB_PLUG_MALE,
      plugFemale: TB_PLUG_FEMALE,
    },
  });

  const TB_PRODUCTS = [
    TB_C9_BULK,
    TB_C7_BULK,
    product('1000bulbs', 'c9-string-17', 'CMS-25C9-8GWW', {
      equiv: 'c9-led', name: 'C9 LED string, 25 bulbs on 17 ft, ready-made, green wire', category: 'c9', tech: 'LED', unit: 'string',
      bulbSpacingIn: 8, stringLengthFt: 16.5, leadFt: 0.5, bulbsPerUnit: 25, wattsPerUnit: 2.4, maxEndToEnd: 90, price: 13.97,
      colors: ['warmWhite'], clipEligible: true, suitableFor: LINE_TYPES.slice(),
      url: tbUrl(111494, 'CMS-25C9-8GWW'),
      notes: 'Ready-made, 17.3 ft overall and 16.5 ft lit (not 25 ft), bulbs 8 in apart. 2.4 W per set, up to 90 sets end to end.',
    }),
    product('1000bulbs', 'c7-string-17', 'CMS-25C7-8GWW', {
      equiv: 'c7-led', name: 'C7 LED string, 25 bulbs on 17 ft, ready-made, green wire', category: 'c7', tech: 'LED', unit: 'string',
      bulbSpacingIn: 8, stringLengthFt: 16, leadFt: 0.5, bulbsPerUnit: 25, wattsPerUnit: 2.4, maxEndToEnd: 90, price: 12.35,
      colors: ['warmWhite'], clipEligible: true, suitableFor: LINE_TYPES.slice(),
      url: tbUrl(111493, 'CMS-25C7-8GWW'),
      notes: 'Ready-made, 16.6 ft overall and 16 ft lit (not 25 ft), bulbs 8 in apart. 2.4 W per set, up to 90 sets end to end.',
      orderNote: LIMITED,
    }),
    product('1000bulbs', 'mini-5mm-50', 'CMS-50WA-6GWW', {
      equiv: 'mini-led-100', name: '5 mm LED mini string, 50 bulbs, 6 in apart, green wire', category: 'mini', tech: 'LED', unit: 'string',
      bulbSpacingIn: 6, stringLengthFt: 25, leadFt: 0.5, bulbsPerUnit: 50, wattsPerUnit: 4.8, maxEndToEnd: 45, price: 14.31,
      colors: ['warmWhite'], clipEligible: false, suitableFor: MINI_TYPES.slice(),
      url: tbUrl(111472, 'CMS-50WA-6GWW'),
      notes: '26 ft overall, 25 ft lit. 4.8 W per set. The page gives two limits for sets joined end to end (45 in its table, 90 in its text): LightPlan uses 45.',
      orderNote: LIMITED,
    }),
    product('1000bulbs', 'icicle-70', 'SHL-LED70ICEWW', {
      equiv: 'icicle-led-300', name: '5 mm LED icicle lights, 70 bulbs, 7 ft lit, white wire', category: 'icicle', tech: 'LED', unit: 'string',
      bulbSpacingIn: 6, stringLengthFt: 7, leadFt: 0.5, bulbsPerUnit: 70, wattsPerUnit: 4.8, maxEndToEnd: 45, dropLengthsIn: [15, 18, 9], price: 21.72,
      colors: ['warmWhite'], clipEligible: true, suitableFor: ['roofline', 'gutter', 'railing'],
      url: tbUrl(6212, 'SHL-LED70ICEWW'),
      notes: '15 drops of 15, 18 and 9 in, 6 in apart; 7.5 ft overall. 4.8 W per set, up to 45 sets end to end.',
    }),
    product('1000bulbs', 'net-4x6-100', 'CMS-100L5MMNETWWG', {
      equiv: 'net-led-4x6', name: '5 mm LED net lights, 4 x 6 ft, 100 bulbs, green wire', category: 'net', tech: 'LED', unit: 'net',
      bulbSpacingIn: 6, stringLengthFt: 6, leadFt: 1, bulbsPerUnit: 100, wattsPerUnit: 9.6, maxEndToEnd: 22, coverageSqFt: 24, price: 33.08,
      colors: ['warmWhite'], clipEligible: false, suitableFor: ['bush'],
      url: tbUrl(202090, 'CMS-100L5MMNETWWG'),
      notes: 'One net covers about 24 sq ft. 9.6 W per net. The page says up to 25 nets end to end (240 W); LightPlan plans at most 22 (216 W), ' +
        'the most this supplier\'s other LED sets add up to.',
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
        CLE + 'p/Wintergreen-Lighting-Christmas-Light-Shingle-Tab-100-Pack-65866.htm', 24.99, 100),
      'clip-ridge': offer('cle', '88780', 'Roof ridge clips for C7 and C9, pack of 25',
        CLE + 'p/Canny-Ridge-Clip-Pro-X2-25-Pack-67572.htm', 26.25, 25),
      'light-stakes': offer('cle', '84144', 'Light stakes for C7 and C9, 5 in tall, pack of 25',
        CLE + 'p/5-Inch-Wintergreen-Lighting-PathPRO-Christmas-Light-Stake-25-Pack-65885.htm', 9.99, 25),
      'timer-outdoor': offer('cle', '80056', 'Outdoor plug-in timer, grounded, 15 A',
        CLE + 'p/15-Amp-Heavy-Duty-Grounded-Timer-Outdoor-65107.htm', 34.99, 1, { maxAmps: 15 }),
    },
    '1000bulbs': {
      'clip-allinone': offer('1000bulbs', 'CLIP-10007', 'Light clips for shingles and gutters, C7 and C9, pack of 50', tbUrl(223218, 'CLIP-10007'), 6.83, 50),
      'clip-shingle': offer('1000bulbs', 'CLIP-10005', 'Shingle tab clips for C7 and C9, pack of 50', tbUrl(223216, 'CLIP-10005'), 15.49, 50),
      'clip-ridge': offer('1000bulbs', 'CLIP-10003', 'Roof ridge clips for C7, C9 and rope light, pack of 25', tbUrl(223214, 'CLIP-10003'), 17.59, 25,
        { notes: 'The page says 25 to a pack in its title and price, and 50 in its table: LightPlan counts 25. ' + LIMITED }),
      'light-stakes': offer('1000bulbs', 'STAKE-10001', 'Lawn light stakes for C7 and C9, 5 in tall, pack of 25', tbUrl(223227, 'STAKE-10001'), 7.31, 25),
      'timer-outdoor': offer('1000bulbs', 'PLTS-12336', 'Outdoor plug-in timer with dusk sensor, 2 outlets, 15 A, 1,000 W maximum', tbUrl(223548, 'PLTS-12336'), 15.73, 1,
        { maxAmps: 15, maxWatts: 1000, notes: 'Rated for 1,000 W at most.' }),
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
  /**
   * Colour family of a hex colour, as bulbs are sold: warmWhite, coolWhite, red, orange, yellow, green, teal,
   * blue, purple or pink. Pale or grey colours are a white (warm when it leans red, else cool).
   */
  function colourFamily(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3,4}$/i.test(h)) h = h.slice(0, 3).split('').map((ch) => ch + ch).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return 'warmWhite';
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    const sat = d < 1e-9 ? 0 : d / (1 - Math.abs(2 * l - 1) + 1e-9);
    if (sat < 0.18 || l > 0.9 || l < 0.08) return r - b > 0.04 ? 'warmWhite' : 'coolWhite';
    let hue;
    if (max === r) hue = ((g - b) / d) % 6; else if (max === g) hue = (b - r) / d + 2; else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
    if (hue < 15 || hue >= 345) return 'red';
    if (hue < 40) return l >= 0.68 ? 'warmWhite' : 'orange';
    if (hue < 65) return l >= 0.8 ? 'warmWhite' : 'yellow';
    if (hue < 165) return 'green';
    if (hue < 190) return 'teal';
    if (hue < 255) return 'blue';
    if (hue < 290) return 'purple';
    return 'pink';
  }
  /**
   * The bulb colours along a run ({colorMode, colors}), one entry per position of its repeating pattern: warm
   * white and cool white are one colour, "multicolor" is the supplier's mixed box ('multi'), and a custom
   * pattern lists the family of each of its colours (red, green → half red, half green).
   */
  function bulbPattern(run) {
    const mode = isObj(run) && typeof run.colorMode === 'string' ? run.colorMode : 'warmWhite';
    if (mode === 'coolWhite') return ['coolWhite'];
    if (mode === 'multicolor') return ['multi'];
    if (mode === 'custom') {
      const list = (Array.isArray(run.colors) ? run.colors : []).filter((c) => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c)).map(colourFamily);
      if (list.length) return list;
    }
    return ['warmWhite'];
  }
  /** Plain names of a list of hex colours, each family once, in order: "red and green". '' when there are none. */
  function colourNames(colors) {
    const names = [];
    for (const c of Array.isArray(colors) ? colors : []) {
      if (typeof c !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(c)) continue;
      const n = (VARIANT_LABELS[colourFamily(c)] || '').toLowerCase();
      if (n && !names.includes(n)) names.push(n);
    }
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  /**
   * Watts of the bulbs along `sockets` sockets of a bulk product in the run's colours: each colour's own
   * wattsEach when the supplier lists one that is higher than the family figure, never less than the family
   * figure (so the load is not under-counted when a colour is a hungrier bulb line).
   */
  function bulkWatts(product, run, sockets) {
    const bulb = isObj(product) && isObj(product.components) && isObj(product.components.bulb) ? product.components.bulb : null;
    const n = Number.isFinite(sockets) && sockets > 0 ? sockets : 0;
    if (!bulb || !(bulb.wattsEach >= 0)) return null;
    const pattern = bulbPattern(run);
    let watts = 0;
    pattern.forEach((family, i) => {
      const count = Math.floor(n / pattern.length) + (i < n % pattern.length ? 1 : 0);
      const v = isObj(bulb.variants) && isObj(bulb.variants[family]) ? bulb.variants[family].wattsEach : null;
      watts += count * Math.max(bulb.wattsEach, Number.isFinite(v) && v > 0 ? v : 0);
    });
    return watts;
  }

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
    bulkProduct, allLinks, linkHosts, formatDate, colourFamily, bulbPattern, colourNames, bulkWatts,
  };
});
