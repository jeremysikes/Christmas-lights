# LightPlan data model

This is the reference for the data LightPlan keeps and the data it computes from it. It covers Phase 1
(one self-contained HTML file) and how the same model maps onto a Phase 2 backend.

- Machine-readable contract: [`schema/project.schema.json`](../schema/project.schema.json) (JSON Schema draft 2020-12).
  The same object ships in the app as `schema.JSON_SCHEMA`, and a test checks the two stay identical.
- Code: `src/core/schema.js` (factories, normalization, migration, validation, export/import),
  `src/core/plan.js` (derived results), `src/core/bom.js` (BOM, quote, checklist, order sheets),
  `src/core/suppliers.js` (the supplier map: who sells what, with part numbers and links; see §3a).

## 1. The big picture

```
Project ─┬─ settings, customer, quote settings, library overrides, price overrides
         │
         ├─ Image ──────────────── photo of the house (pixels stored under storageKey)
         │   └─ Plane ─────────── wall (perspective rectangle + calibration refs), or roof / ground derived from a wall
         │       └─ Feature ───── traced line or outline: type, points, plane, tape override
         │
         ├─ Outlet ────────────── marked on a photo and plane, belongs to a Circuit
         └─ Circuit ───────────── breaker rating, voltage, load already on it

                  ── plan.computePlan(project) ──▶  derived, never stored as truth

Measurement (per feature: measured length, override, confidence)
  └─ LightRun (per feature: product, strings, clips, watts, start/end point, feed, outlet, circuit)
       └─ Power plan (chains → feeds → outlets → circuits with load, cords, timers)
            └─ BOM (priced lines) ──▶ Quote (customer lines) ──▶ Install checklist
```

**Persisted** means it is part of the project object, autosaved and exported. **Derived** means
`plan.computePlan` recomputes it from the persisted project every time; derived values are never read
back from a file (an import drops any top-level `derived` key).

| Persisted (the project) | Derived (the plan) |
|---|---|
| Images, planes, calibration refs, features, outlets, circuits | Camera intrinsics and pose, plane homographies, roof pitch estimate |
| Tape-measured overrides, product and color choices, outlet assignments | Measured lengths, waste, confidence |
| Settings, customer, quote settings | Light runs, quantities, clips, stakes, watts |
| Product library and config overrides, price overrides | Chains, feeds, cord sizes, circuit loads, warnings |
| Who the project buys from (`library.supplierId`) and how (`library.config.buying`) | BOM with supplier, part number, link and price status per line; order sheets |
| Tap precision beside each tapped point list (`tapErr`) | Quote totals, checklist, summary |

## 2. Units and coordinate systems

| Quantity | Unit / convention |
|---|---|
| Length | feet (floating point). Shown as `32′ 4″` or `32.3 ft` per `settings.lengthFormat`. |
| Image points | `[x, y]` pixels of the **stored** image (long side ≤ 2048 px), origin top-left, y down. |
| Wall plane | `[u, v]` feet. u to the right along the wall, v **up**. Origin = bottom-left corner of the wall rectangle. |
| 3D wall frame | `(u, v, w)` feet; w is the wall normal pointing out toward the camera. The wall is w = 0. |
| Roof / ground plane | `[a, b]` feet. a along the defining line (eave or wall base), b across it (up-slope, or toward the street). |
| Quads | Stored as tapped. `geometry.orderQuad` gives `[TL, TR, BR, BL]`; a rectangle maps TL→(0,H), TR→(W,H), BR→(W,0), BL→(0,0). |
| Homography `H` | Flat row-major 3×3 (9 numbers): `[x,y] → [(h0x+h1y+h2)/(h6x+h7y+h8), (h3x+h4y+h5)/(h6x+h7y+h8)]`. |
| Angles | Degrees (names ending in `Rad` are radians). Roof pitch is rise/run in inches, e.g. 6/12. |
| Power | Watts, amps, volts (120 V North American circuits). Safe continuous limit = breaker A × V × 0.8. |
| Money | USD, rounded to cents on every line and total. |
| Timestamps | ISO 8601 strings, or `null`. Core code never reads the clock; the caller passes times in. |

Ids are strings with a type prefix: `prj_`, `img_`, `pl_`, `ref_`, `ft_`, `out_`, `cir_`. A light run's
id is `run_` + its feature id. `null` always means "not set, use the default".

## 3. Persisted entities

Every field below is always present after `schema.normalizeProject` (factories fill them too).

### Project

| Field | Type | Meaning |
|---|---|---|
| `schema` | `"lightplan/project"` | Format marker. |
| `version` | integer, `1` | Format version (see §6). |
| `id` | string | `prj_…` |
| `name` | string | Usually the street address. |
| `createdAt`, `updatedAt` | ISO string \| null | Set by the UI store, never by core code. |
| `customer` | `{name, address, phone, email}` | Strings, printed on the quote. |
| `settings` | Settings | Project-wide planning settings. |
| `images` | Image[] | Photos. |
| `activeImageId` | string \| null | Photo shown in the editor. |
| `planes` | Plane[] | Measurement planes. |
| `features` | Feature[] | Traced parts of the house that get lights. |
| `outlets` | Outlet[] | Power outlets. |
| `circuits` | Circuit[] | Breaker circuits. A new project has one: `Circuit 1`, 15 A. |
| `library` | `{products, config, supplierId?}` | `products`: full replacement product list or null (catalog defaults). Each product needs a known `category` and `unit`, `price` and `wattsPerUnit` of 0 or more, and `stringLengthFt` and `maxEndToEnd` above 0 (`validateProject` checks this, so a file cannot carry a product planned as 0 W or $0). Optional per product: `maxConnectedW` (the most watts its wiring may carry end to end, its own strings plus anything plugged into them; default `maxEndToEnd × wattsPerUnit`) and `endConnector` (false = no plug at the far end, so nothing can be plugged into it; default false only for per-foot products). `config`: overrides deep-merged into `catalog.DEFAULT_CONFIG`, or null. Cord planning reads `config.power`: `daisyChain` (true: link nearby runs with jumper cords; false: one cord per feed from the outlet), `jumperMaxFt` (30), `jumperDirectFt` (6: the most a jumper may cross open wall; longer ones go down to the ground and back up), `jumperSlackFt` (1.5), `outletHeightFt` (1.5: how far the ground is below an outlet when nothing lower is traced), `openingMarginFt` (0.5: how far beside a window or door a riser stands), `crossingPenaltyFt` (12: added per doorway or walkway crossed when cords are compared, never to the cord bought) and `tapOutlets` (3). Phase 1.1 adds the optional `supplierId` and `config.buying`, and supplier fields on products: see §3a. |
| `pricing` | `{overrides: {sku: price}}` | Unit prices that replace library prices in the BOM, keyed by SKU. |
| `quote` | Quote settings | Installer mode. |

### Settings

| Field | Type | Default | Meaning |
|---|---|---|---|
| `wastePct` | number 0–100 | 10 | Added to every linear run and to clip counts. |
| `roofPitch` | `{rise, run}` \| null | null | Project roof pitch. null = estimate from gable rakes traced on a wall, else assume 6/12. |
| `colorMode` | `warmWhite` \| `coolWhite` \| `multicolor` \| `custom` | `warmWhite` | Default light color. |
| `customColors` | hex string[] | `["#ff3b30", "#34c759"]` | Colors for `custom`, cycled along each run. |
| `lengthFormat` | `ft-in` \| `ft-decimal` | `ft-in` | Display only. |

### Image

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `img_…` |
| `name` | string | Original file name. |
| `width`, `height` | number > 0 | Stored image size in pixels. All image points use this pixel grid. |
| `source` | `{kind, capturedAt, attribution}` | `kind`: `upload` \| `camera` \| `sample` \| `streetview` \| `aerial`. |
| `exif` | `{focal35, focalMm, make, model, …}` \| null | Read from the JPEG; may also hold `orientation`, `width`, `height`, `dateTime`. |
| `camera` | `{mode, presetId, focalPx}` | `mode`: `auto` (EXIF, else estimated from a wall rectangle, else phone 1×) \| `exif` \| `preset` \| `manual`. |
| `storageKey` | string \| null | Where the pixels live (IndexedDB/localStorage in Phase 1). Exports carry them as data URLs under this key. |

### Plane (with its calibration)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `pl_…` |
| `imageId` | string \| null | Photo it is traced on. |
| `name` | string | e.g. "Front wall". |
| `kind` | `wall` \| `roof` \| `ground` | Walls are calibrated directly; roof and ground planes hang off a wall. |
| `color` | hex | Overlay color. |
| `rect` | PlaneRect \| null | A real rectangle on the wall seen in perspective. Gives the homography. |
| `refs` | Ref[] | Calibration references on this plane. |
| `derived` | PlaneDerived \| null | Roof/ground only. |

**PlaneRect** `{corners: [4 points], widthFt, heightFt, presetId}`. Both sizes null = size unknown
(the aspect ratio then comes from the camera model and the scale from refs).

**Ref** (calibration reference): `{id, kind: 'line'|'rect', points, presetId, quality: 'high'|'medium'|'low'}`
plus `lengthFt` and `courses` for lines (siding/brick refs store `courses` and `lengthFt = courses × course height`)
or `widthFt` and `heightFt` for rectangles. A line has exactly 2 points, a rect 4.

**PlaneDerived** `{parentPlaneId, line: [2 points] | null, pitch: {rise, run} | null}`. Roof: `line` is the
eave on the parent wall, the plane slopes up and away at `pitch` (null → project pitch → estimate → 6/12).
Ground: `line` is the wall base; the plane is horizontal toward the camera.

**Tap precision (`tapErr`, optional, Phase 1.1).** Beside any tapped point list there may be a `tapErr`
array, index for index with the points: `rect.tapErr` (4 numbers, beside `rect.corners`), `ref.tapErr`
(2 for a line, 4 for a rectangle, beside `ref.points`), `feature.tapErr` (one per point, beside
`feature.points`) and `plane.derived.tapErr` (2, beside `derived.line`). Each number is how far off the tap
is expected to be (one standard deviation), in pixels of the stored photo. The editor sets it when a point
is placed or dragged, from the zoom at that moment: a tap made zoomed out is worth many photo pixels.
`normalizeProject` keeps the array only when it is finite numbers of 0 or more with exactly one entry per
point; anything else is dropped without a message, and it is never added. Missing means "no information":
the 2.5 px of Phase 1 is assumed (the sample house has none).

### Feature (traced feature)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `ft_…` |
| `imageId`, `planeId` | string \| null | Photo and measuring plane. No plane = not measurable yet. |
| `type` | feature type id | `roofline`, `rake`, `gutter`, `ridge`, `window`, `door`, `column`, `railing`, `walkway`, `bush`, `tree`, `stakes` (`catalog.FEATURE_TYPES`). |
| `label` | string | Shown in lists, the BOM notes and the checklist. |
| `points` | point[] | Polyline, polygon, vertical (2 points, base then top) or area outline, per type. Trees, columns and bushes are powered at their lowest point on the photo, whichever way they were traced. |
| `closed` | boolean | Outline loops back (windows, bushes). |
| `overrideFt` | number \| null | Tape-measured length. Lines: length or perimeter. Tree/column: height (wrap is recomputed). Bush: ignored. |
| `productId` | string \| null | null = type default from the library config. |
| `color` | `{mode, colors?}` \| null | null = project color. |
| `params` | object | `mount` (clip type), `diameterIn`, `spiralSpacingIn`, `wrapMode` (`trunk`/`canopy`), `outletId` (force a cord from this outlet), `reverse` (start at the last point), `overrideWidthFt`, `overrideHeightFt` (bushes). null = type default. Optional `ownCord` (boolean, missing = false): give this run its own cord from the outlet, with no jumper to or from another run. |

### Outlet and Circuit

| Outlet field | Type | Meaning |
|---|---|---|
| `id` | string | `out_…` |
| `imageId`, `planeId` | string \| null | Where it is marked; the plane is used to measure cord length. |
| `point` | point \| null | Image position. |
| `label` | string | e.g. "Porch outlet". |
| `type` | `exteriorGfci` \| `garage` \| `interior` \| `other` | |
| `gfci` | boolean | Unprotected outlets get a portable GFCI adapter in the BOM. |
| `circuitId` | string \| null | null = unknown, assumed alone on a 15 A breaker. |
| `receptacles` | integer ≥ 1 | Sockets on the outlet. |

| Circuit field | Type | Meaning |
|---|---|---|
| `id` | string | `cir_…` |
| `name` | string | e.g. "Porch circuit". |
| `breakerAmps` | number > 0 | 15 or 20 in most homes. |
| `voltage` | number > 0 | 120. |
| `existingLoadW` | number ≥ 0 | Watts already used on the circuit while the lights are on. |

### Quote settings

`{enabled, company, laborMethod: 'perFt'|'perHour', ratePerFt, ratePerHour, markupPct, takedownFee,
storageFee, taxPct, validDays, notes}`. Defaults: off, per foot, $3.50/ft, $65/h, 30% markup, $150
takedown, $75 storage, 0% tax, valid 30 days.

## 3a. Suppliers, bulk C7/C9 and buying settings (Phase 1.1)

LightPlan carries a small hand-entered **supplier map** (`src/core/suppliers.js`): who the suppliers are,
where their category pages are, and a starter set of their products with part numbers and links. No
supplier offers a public feed or cart link, so nothing is fetched: every address is a link a person opens.

**How far to trust it.** Everything in the map was read from the suppliers' own pages on 2026-11-11; the
check is written up in `docs/SUPPLIER_CHECK.md`. Every entry has `priceAsOf: '2026-11-11'` and a
`priceStatus`:

- `verified` (59 of the 63 things that can be ordered): the price, part number, pack size and electrical
  figures were read on the item's own product page that day. The app says "as of Nov 11, 2026".
- `observed` (4 items, all 1000Bulbs): the item was seen on the supplier's category list only, its own page
  was not opened. The app adds "check the price", and the line's note says why.
- Nothing else is entered. A price is still a snapshot: every export says "confirm at checkout".
- A cut-to-length (bulk) product as a whole is a kit with no part number, and its per-foot `price` is
  worked out from its parts, not read from a page. It always carries `observed`; its parts carry their own
  status.

Wholesale (account) prices are not public; the user types their own price over any line
(`pricing.overrides`).

### Persisted fields

| Field | Type | Meaning |
|---|---|---|
| `library.supplierId` | string \| null, optional | Who the project buys from: `generic` ("Any store", the Phase 1 behaviour), `cle` (Christmas Lights Etc) or `1000bulbs`. Missing, null or an unknown id = any store. Never added when missing. |
| `library.config.buying.style` | `bulk` \| `strings` | How C7/C9 from the chosen supplier is bought when a run has no product of its own. `bulk` (default): socket wire cut to length, bulbs by the box, slide-on plugs. `strings`: ready-made strings. |
| `library.config.buying.costBasis` | `bought` \| `used` | `bought` (default): the plan costs everything that is ordered. `used`: bulk wire, bulbs and plugs are costed only for the share this job uses, for installers who carry leftovers to the next job. A value that is not one of these words is dropped (the default applies). |

### Supplier (`suppliers.SUPPLIERS`, also `plan.library.suppliers`)

`{ id, name, short, url, wholesale: {name, url | null, phone, email?, note} | null, searchUrlTemplate | null,
searchUrlWorks, searchNote, categoryUrls: {role: url}, priceAsOf, notes }`

- `wholesale` holds what the supplier's own pages say about trade accounts, nothing more.
  - Christmas Lights Etc: part of the Wintergreen Corporation family; wholesale line 1-855-WGC-7100,
    sales@wintergreencorp.com; `url` is its own wholesale page (the one that was read). The sign-up form
    is on Wintergreen's site, which could not be reached and was not checked, so nothing links there.
  - 1000Bulbs: phone 1-800-624-4488; product pages say an item ships free with orders of $600 or more; no
    wholesale or contractor account page was seen, so `url` is **null** (show the phone and the note).
- `searchUrlTemplate` has a `{query}` placeholder; `suppliers.supplierSearchUrl(id, query)` fills it.
  `searchUrlWorks` says whether the address was tested: `true` for Christmas Lights Etc
  (`https://www.christmaslightsetc.com/browse/?q={query}`, tested); `null` for 1000Bulbs (the address its
  own search box uses, but the test was blocked by the site, so it is not confirmed). `searchNote` says the
  same in plain words.
- `categoryUrls` roles: `c9Bulbs c7Bulbs spools stringers plugs clips miniLights icicle net rope treeWrap
  stakes timers extensionCords`. A supplier lists only the roles it has a page for; every address loaded on
  the day of the check. Christmas Lights Etc has no page for plugs alone, so its `plugs` role is its
  electrical accessories page; it has no page for tree wraps, so that role is left out (the search is used).
- `suppliers.findUrl(id, role, query)`: the category page for the role, else the supplier's search for the
  query, else null. `suppliers.allLinks()` lists every link in the map (`{supplierId, kind: 'site' |
  'wholesale' | 'search' | 'category' | 'product', sku, name, url}`) so they can be checked against the live
  sites; `suppliers.linkHosts()` are the host names they use: `www.christmaslightsetc.com` and
  `www.1000bulbs.com` (the only external hosts the build test allows besides Google Fonts).
  `suppliers.safeUrl(u)` returns a link only when it is a plain `https://` address.

### Product fields added for suppliers

A supplier product has the same shape as any product (`catalog.DEFAULT_PRODUCTS`) plus the optional fields
below. `normalizeProject` keeps them all as they are in `library.products`, with two repairs: a `url` that
is not a plain https address is dropped (also inside `components`), and so is a `priceStatus` that is not
one of the two words. Product ids are `<supplierId>:<name>` (for example `cle:c9-bulk-12`); `sku` equals
the id and stays the key for `pricing.overrides`.

| Field | Type | Meaning |
|---|---|---|
| `supplierId` | string | Which supplier it is from. Missing = any store. |
| `supplierSku` | string \| null | The part number to type at the supplier (Christmas Lights Etc: the "Item Number" on the page; 1000Bulbs: the SKU). Every ready-made product has one. null on a bulk product (a kit), and on a user's own product with none. |
| `url` | https address \| null | The product page. |
| `priceAsOf` | `YYYY-MM-DD` | The day the price was seen. |
| `priceStatus` | `verified` \| `observed` | `verified`: read on the item's own product page that day. `observed`: seen on the supplier's category list only (or, for a bulk product, worked out from its parts): say "check the price". |
| `equiv` | product id | The generic product whose job it does (`c9-led`, `c7-led`, `mini-led-100`, `icicle-led-300`, `net-led-4x6`). The planner swaps it in when the project buys from this supplier. When a supplier has two ready-made products for one job, the first in the list is the automatic choice. |
| `kind` | `bulk` or missing | `bulk`: bought as wire, bulbs and plugs (below). Missing: a ready-made product. |
| `components` | object | Bulk only: the parts (below). |
| `maxRunFt`, `maxBulbsPerRun` | number | Bulk only: the limits of one run, 250 and 250 ("250 bulbs or 250 ft of line, whichever comes first"), whatever larger rating a page prints for the wire. |
| `tiers` | `[{qty, each, pctOffList}]` | Quantity prices as the supplier's page prints them (below). Data only. |
| `orderNote` | string | A short caution printed on the BOM line (which size to pick on a page that lists two, "Quantity price from 100 sets: see the supplier's page.", or that the page said stock was limited). |

**Offer** (a bulk component or a supplier accessory): `{ sku, supplierSku, name, url, price, packQty,
priceAsOf, priceStatus, notes?, tiers? }`. `sku` is `<supplierId>:<supplierSku>`, the key for
`pricing.overrides`. `notes` is a short caution printed on the BOM line. Every offer in the map has a part
number, an https link on the supplier's own site, the date and a status; the tests check this.

**Quantity prices (`tiers`).** Christmas Lights Etc prints "Bulk Discounts" on some pages (bulb boxes, the
mini, icicle and net sets). They are stored as the page words them, for example
`[{ qty: '20 - 40 boxes', each: 28.7, pctOffList: 30 }, { qty: '40+ boxes', each: 26.65, pctOffList: 35 }]`:
`qty` is the page's own text of the range, `each` the price per box or set at that quantity, `pctOffList`
the percent off the list price. The line gets the note "Quantity price from 20 boxes: see the supplier's
page." **The BOM never prices with them**: the ranges are ambiguous (does "20 - 40" include 40?) and were
not tested in a cart. 1000Bulbs pages showed none.

**Bulk C7/C9** is how wholesale C7/C9 is bought. It is a per-foot product (`unit: 'foot'`,
`stringLengthFt: 1`, `leadFt: 0`) so measuring, chaining and power feeds work unchanged:
`bulbsPerUnit = 12 / bulbSpacingIn`, `wattsPerUnit = wattsEach × bulbsPerUnit`, `maxEndToEnd` = the feet one
run may be (250), `maxConnectedW` = the watts one run may carry (`maxBulbsPerRun × wattsEach`, and never more
than 80% of the lowest amp rating printed for any length of the wire, at 120 V), `endConnector: true`,
`clipEligible: true`. `price` is a per-foot equivalent of the 1,000 ft spool and the default bulbs, for
display only: the BOM prices the parts.

```
components: {
  wire:       Offer + { spoolFt, wireType: 'SPT-1' | 'SPT-2', wireGauge, maxAmps?, plugsIncluded: false,
                        sizes?: [Offer + { lengthFt, wireType, wireGauge, maxAmps?, plugsIncluded }] },
  bulb:       { name, packQty, wattsEach, base: 'E17' | 'E12', defaultVariant,
                variants: { colour: Offer + { wattsEach? } } },
  plugMale:   Offer + { wireType, maxAmps } | null,   // null = none on file: the BOM lists a plain plug line with a link to look
  plugFemale: Offer + { wireType, maxAmps } | null
}
```

- `variants` keys are colours the supplier sells: `warmWhite coolWhite multi red green blue` on all four
  bulk products (also `orange yellow purple pink teal` when on file). A variant carries its own `wattsEach`
  only when it differs from the family's (the 1000Bulbs blue bulbs are another bulb line); the plan still
  counts the family figure, and the offer's note says so.
- `sizes` are other lengths of **the same wire** that can be bought instead of a whole spool: a 500 ft
  spool, and ready-made 100 ft and 25 ft lengths, longest first. A size is entered only when its wire type
  and gauge match the spool's (the tests check it); a 20-gauge length is never a size of 18-gauge wire.
  `plugsIncluded` is `false` (bare), `'both'` (a plug on each end) or `'male'` (a male plug only), and the
  offer's name says the same in words.
- `maxAmps` is the lowest figure the item's page prints (Christmas Lights Etc pages give one figure in the
  table and another in the text). It is left out where the page prints none (the 1000Bulbs spools).

**Supplier accessories** (`suppliers.SUPPLIER_ACCESSORIES[supplierId][accessorySku]` → Offer) map a
supplier's own item onto a generic accessory sku from `catalog.ACCESSORIES`: `clip-allinone`,
`clip-shingle`, `clip-ridge`, `light-stakes`, `timer-outdoor` (both suppliers have all five). Extension
cords, taps, power stakes, cord covers, gutter hooks, adhesive clips and GFCI adapters stay generic. Two
generic accessories exist for bulk wire: `plug-spt1-male` and `plug-spt1-female` (used only when a bulk
product has no plug of its own on file).

### What is in the catalog (as of 2026-11-11)

Part number, price and pack for everything entered. All `verified` unless marked *listed only* (`observed`).

**Christmas Lights Etc (`cle`)**

| What | Part number, price |
|---|---|
| C9 socket wire, SPT-1, 18 gauge, socket every 12 in, green | 1,000 ft spool 15085 $409.99 · 500 ft spool 81832 $219.99 · 100 ft with plugs 15098 $49.99 · 25 ft with plugs 15100 $15.99 |
| C7 socket wire, same | 1,000 ft spool 15054 $369.99 · 500 ft spool 72912 $199.99 · 100 ft with plugs 15067 $44.99 · 25 ft with plugs 15071 $11.99 |
| C9 OptiCore bulbs, 0.8 W, box of 25, $29.99 | warm white 72636 · cool white 72639 · multicolor 72642 · red 72645 · green 72654 · blue 72648 (quantity prices from 20 boxes) |
| C7 OptiCore bulbs, 0.8 W, box of 25, $24.99 | warm white 72609 · cool white 72606 · multicolor 72612 · red 72615 · green 72624 · blue 72618 (quantity prices from 10 boxes) |
| SPT-1 slide-on plugs, pack of 10, $12.40 | male 88283 · female 88287 |
| Ready-made strings | C9 OptiCore 25 bulbs on 25 ft 77667 $49.99 (20 W) · C7 OptiCore 25 bulbs on 25 ft 77653 $39.99 (20 W) · sealed C9 set, 25 bulbs on 17 ft 84095 $14.99 (2.4 W, 90 sets) |
| Other sets | 5 mm mini, 70 bulbs 83768 $19.99 (4.8 W, 45 sets) · icicle, 70 bulbs 85686 $21.99 (4.8 W, 45 sets) · 4 × 6 ft net 85472 $34.99 (12 W, 18 nets) |
| Accessories | all-in-one clips 82761 $13.99 / 100 · shingle tabs 83965 $24.99 / 100 · ridge clips 88780 $26.25 / 25 · light stakes 84144 $9.99 / 25 · outdoor timer 80056 $34.99 (15 A) |

**1000Bulbs (`1000bulbs`)**

| What | Part number, price |
|---|---|
| C9 socket wire, SPT-1, 18 gauge, socket every 12 in, green | 1,000 ft spool CMS-10105 $391.13 · 500 ft spool CMS-10110 $224.40 · 100 ft with a male plug CMS-10124 $39.43 |
| C7 socket wire, same | 1,000 ft spool CMS-10095 $481.47 · 500 ft spool CMS-10093 $229.77 *listed only* · 100 ft with plugs CMS-10323 $57.64 *listed only* |
| C9 VividCore Premium bulbs, 0.74 W, pack of 25 | warm white CMS-10294 $25.42 · cool white CMS-10293 $26.15 · multicolor CMS-10298 $25.52 · red CMS-10288 $25.03 · green CMS-10291 $26.07 · blue (standard line, 0.5 W) CMS-C9BLU $22.33 *listed only* |
| C7 VividCore Premium bulbs, 0.48 W, pack of 25 | warm white deluxe CMS-10285 $18.62 · cool white CMS-10281 $19.31 · multicolor CMS-10286 $19.03 · red CMS-10276 $19.69 · green CMS-10279 $19.72 · blue (standard line, 0.54 W) CMS-C7BLU $17.29 *listed only* |
| SPT-1 slide-on plugs, pack of 10, $6.73 | male PLUG-10001 · female PLUG-10002 |
| Ready-made strings | C9, 25 bulbs on 17 ft CMS-25C9-8GWW $13.97 (2.4 W, 90 sets) · C7, 25 bulbs on 17 ft CMS-25C7-8GWW $12.35 (2.4 W, 90 sets) |
| Other sets | 5 mm mini, 50 bulbs CMS-50WA-6GWW $14.31 (4.8 W, 45 sets) · icicle, 70 bulbs SHL-LED70ICEWW $21.72 (4.8 W, 45 sets) · 4 × 6 ft net CMS-100L5MMNETWWG $33.08 (9.6 W, 22 nets) |
| Accessories | all-in-one clips CLIP-10007 $6.83 / 50 · shingle tabs CLIP-10005 $15.49 / 50 · ridge clips CLIP-10003 $17.59 / 25 · lawn stakes STAKE-10001 $7.31 / 25 · outdoor timer PLTS-12336 $15.73 (15 A, 1,000 W) |

**Decisions where a page was not clear-cut**

- **Two figures on one page: the lower is used.** Christmas Lights Etc wire: 7 A in the table against 8 A
  in the text (5 A in the table for the 25 ft C9 length). 1000Bulbs mini string: 45 sets in the table, 90
  in the text. 1000Bulbs ridge clip: 25 to a pack in the title and price, 50 in the table.
- **A page's figure the plan stays below.** The 1000Bulbs net page says 25 nets end to end (240 W); the
  plan uses 22 (216 W). The 1000Bulbs 25 ft stringer pages say 1,800 W on 20-gauge wire: not used at all.
- **No figure on the page.** The Christmas Lights Etc 25-bulb, 25 ft OptiCore strings give no connect
  limit: the plan uses 10 sets (250 bulbs), the trade rule for the wire. 1000Bulbs spool pages give no amp
  rating: none is entered. Lit lengths the pages do not state (the 5 mm set and the sealed C9 set at
  Christmas Lights Etc) are worked out from bulb count and spacing, and the description says so.
- **A stand-in.** The 1000Bulbs plain warm white C7 pack (CMS-10284, 0.54 W) was "temporarily unavailable",
  so the warm white deluxe pack (CMS-10285, 0.48 W), which could be ordered, is the warm white; its note
  says so. No VividCore Premium blue was seen at 1000Bulbs, so blue is its standard bulb (other watts,
  *listed only*).

### What was left out, and why

- **Could not be ordered on 2026-11-11:** Christmas Lights Etc SPT-1 plug 5-packs 67083 and 67081 and
  ridge clip 86287 (replaced by 88283, 88287 and 88780); 1000Bulbs blank SPT-2 wire CMS-WIRE1000GR2 ("not
  for sale"); 1000Bulbs plain warm white C7 bulbs CMS-10284 (see the stand-in above).
- **Not the same wire as the spool:** the 1000Bulbs 25 ft stringers CMS-10126 and CMS-10119 are 20 gauge,
  so the 1000Bulbs wire has no 25 ft size.
- **A shape the planner cannot handle:** trunk-wrap nets (Christmas Lights Etc 72526, 2 × 6 ft, 6.86 W;
  1000Bulbs HLS-TRUNK8CLRG, 8 × 2 ft, incandescent, 60 W). The planner wraps trunks with a string by its
  length; it has no rule for a net that wraps a trunk, so neither supplier has a tree-wrap product and
  the generic string stays. Rope light by the 150 ft spool (80349 has no watts on its page; FT2-L120HA12150
  needs power cords and end caps that are not on file). Case packs that are a second pack size of an item
  already entered (C9 bulbs by 500 82958, mini sets by 24 84222 and CMS-50WW6B).
- **No rating on the page:** Christmas Lights Etc photocell 85135.
- **Outside the starter set:** SPT-2 wire and plugs, 15 in spacing, blank wire, 50 ft ready-made lengths,
  magnetic, "plus" and C9-only clips, a second all-in-one clip and shingle tab at 1000Bulbs (listed only), bulb
  colours with no slot (warm white deluxe and pure white C9), the standard-line warm white C7 bulb
  CMS-C7SWW, and the 1000Bulbs 100 ft C9 length with two plugs CMS-10324 (the male-plug-only CMS-10124 is
  the same wire, cheaper and read on its own page).

## 4. Derived results (`plan.computePlan(project)`)

```
Plan = { library, measured, runs, power, bom, quote, checklist, warnings, summary }
```

| Part | Shape (abridged) | Notes |
|---|---|---|
| `library` | `{products, config, accessories, supplierId, suppliers}` | Catalog defaults with the project overrides applied. `products` = the project's own list (or the defaults) followed by every supplier product whose id is not already in it, so a saved, edited copy of a supplier product wins. `supplierId` = `library.supplierId` when it names a known supplier, else `generic`. `suppliers` = the supplier map (§3a). `config.buying` always holds a valid `style` and `costBasis`. |
| `measured.planes[id]` | `{ok, mode, Himg2plane, Hplane2img, scale, refResults, disagreementPct, viewAngleDeg, pose, K, pitch, …}` | One solution per plane; `mode` says how it was calibrated. |
| `measured.features[id]` | `{ok, method, measuredFt, wrapFt, lengthFt, withWasteFt, areaSqFt, widthFt, heightFt, lights, overridden, confidence: {level, score, reasons}}` | `lengthFt = overrideFt ?? wrapFt ?? measuredFt`. |
| `runs[]` (LightRun) | `{id, featureId, productId, productName, unit, colorMode, colors, lengthFt, withWasteFt, quantity, hung?, bulbs, watts, amps, clips: {type, count}, lightStakes, method, detail, warnings, start, end, reversed, chainId, feedIds, outletId, circuitId, sourceFeedId, supplierId?, productKind?}` | One per feature. **Product choice:** the run's own `productId` always wins (it may be any supplier's product); otherwise the type default, replaced by the chosen supplier's product whose `equiv` names it (buying style `bulk`: its cut-to-length product, else its ready-made one; `strings`: only a ready-made one, never cut-to-length wire); otherwise the generic product stays. Another supplier's catalog is never chosen automatically. `supplierId` is set on runs of supplier products and `productKind: 'bulk'` on cut-to-length runs (then `unit` is `foot`, `quantity` is feet of socket wire, `bulbs` is sockets, and clips are one per socket). `quantity` is strings, nets, sets or feet to buy; strings are counted along each chain, so a run the previous run's last string carries on along can buy 0. `hung` is the strings hung on it; `watts`/`amps` are the live load (spares from waste rounding are not plugged in). `start`/`end` are image points of where the run begins and ends after power planning. `sourceFeedId` is the feed the run's first feed is jumpered from (null: its cord comes from the outlet). |
| `power.feeds[]` | `{id, chainId, runIds, strings, watts, amps, start: {point, label, toward?}, outletId, circuitId, source, parentFeedId, childFeedIds, depth, supplyW, throughW, pathDropPct, taps, plugIn, cord: {kind, lengthFt, boughtFt, awg, pieces, voltageDropPct, route: [{kind, lengthFt, planeId, from, to}], routeText}, cordPath, cordUnknown, crossesWalkway, crossesDoorway, doorway?, portions: [{runId, units, total, startsRun, endsRun}]}` | A feed is the part of a chain on one cord, limited by the product's max end-to-end. `strings` counts hung strings. `source` is `{kind: 'outlet', outletId}` (a **home run**: its cord comes from the outlet) or `{kind: 'feed', feedId, port}` (a **jumper** from a powered feed: `port` `'end'` = the end plug of its last string, so the load passes through its strings; `'start'` = a 3-way tap where its own cord arrives). `outletId`/`circuitId` are the outlet at the root of its supply tree. `supplyW` is what its cord carries (itself and everything hanging off it), `throughW` what passes through its strings, `pathDropPct` the voltage drop summed over the cords back to the outlet, `taps` the 3-way taps it needs. `cord.kind` is `'home'` or `'jumper'`; `cord.route` lists the pieces of the route in order (`drop`, `ground`, `rise`, `hop`, `roof`, `wall`, `direct`; lengths in feet before the routing factor and slack; `from`/`to` are image points) and `cord.routeText` says it in words ("down 1.5 ft, 18 ft along the ground, up 8.5 ft beside Window left"). `cordPath` is the same route as an image polyline. `plugIn: true` (with `cord: null`) means the run plugs straight into its source with no cord. The cord gauge and voltage drop are worked out on the pieces bought (`boughtFt`) for the watts carried (`supplyW`). |
| `power.chains[]` | `{id, productId, runIds, reversed, strings, spares, watts, feedIds}` | `strings` hung, `spares` bought for waste, `watts` live. |
| `power.outlets[]` | `{id, label, circuitId, feedIds, directFeedIds, watts, needsSplitter, splitters, timer, limitW, overloaded, incandescentW}` | `feedIds`: every feed in the outlet's supply trees; `directFeedIds`: its home runs. Power stakes (`splitters`) are counted from the home runs only. Everything on one outlet shares its receptacle, timer and chained power stakes (15 A gear, `limitW` = 1,440 W at 80%). |
| `power.groups[]` | `{id, outletId, rootFeedId, feedIds, watts, homeRunFt, jumperFt}` | One supply tree per home run: `feedIds` in depth-first order from the root, `watts` on the home-run cord, cord feet bought for the home run and for the jumpers below it. |
| `power.counts` | `{timers, splitters, cordCovers, gfciAdapters, taps, homeRuns, jumpers}` | `jumpers` counts jumper cords (runs that plug straight in need none). `power.cords[]` (`{awg, lengthFt, count}`) lists every cord piece to buy, home runs and jumpers together. |
| `power.circuits[]` | `{id, name, breakerAmps, voltage, limitW, loadW, existingLoadW, utilizationPct, outletIds, overloaded}` | Load per circuit against the 80% rule. |
| `bom` | `{ok, lines: [{sku, category, name, qty, unit, unitPrice, defaultPrice, overridden, lineTotal, notes, supplierId, supplierName, supplierSku, url, findUrl, priceAsOf, priceStatus, usedQty, total, buyTotal}], subtotal, byCategory}` | Categories: lights, clips, cords, power, hardware. See "BOM lines and order sheets" below. |
| `quote` | `{enabled, materialsCost, markupPct, materialsPrice, laborMethod, linearFt, laborHours, laborCost, takedownFee, storageFee, taxPct, tax, total, lines: [{description, amount}], validDays, notes}` | Lines are customer-facing: Materials, Installation labor (X ft, Y h), Takedown, Storage, Tax, Total. |
| `checklist[]` | `{outletId, title, steps: [string]}` | One group per outlet, then runs with no outlet, runs not in the plan, and a safety/test group. |
| `warnings[]` | `{level: 'danger'|'warn'|'info', code, message, featureId?, planeId?, outletId?, circuitId?, stage?}` | Deduplicated, danger first. A failed stage adds `code: 'internal-error'`. |
| `summary` | `{totalFt, totalWithWasteFt, byType, strings, clips, cords, timers, homeRuns, jumpers, taps, watts, amps, circuits, outletsUsed, cost, quoteTotal}` | `cords` counts every cord piece bought; `homeRuns` the cords that go back to an outlet. `quoteTotal` is null when installer mode is off. |

### BOM lines and order sheets (Phase 1.1)

Every BOM line says where it is bought:

| Field | Meaning |
|---|---|
| `supplierId`, `supplierName` | The supplier the line is ordered from, or `null` and "Any store". |
| `supplierSku` | The part number to type at the supplier; null when the line has none or it is not confirmed. |
| `url` | The supplier's product page (https only), or null. |
| `findUrl` | For a line with no product page while the project buys from a supplier: that supplier's category page for this kind of item, else its search for it, else null. |
| `priceAsOf` | The day the supplier price was seen; null for generic prices and for your own prices. |
| `priceStatus` | `verified` or `observed` (a supplier price), `default` (a typical retail price from the library) or `yours` (`pricing.overrides` has the line's `sku`, or the price of a supplier item was edited in the project's own product list). A supplier price is never shown as current: say "as of <date>" and, for `observed`, "check the price" (`bom.priceStatusText(line)`). |
| `qty`, `usedQty` | `qty` is what to order. `usedQty` is the share of it this job uses: less than `qty` only for bulk wire (feet used ÷ feet bought), bulbs (bulbs ÷ pack size) and plugs. |
| `buyTotal`, `total`, `lineTotal` | `buyTotal = qty × unitPrice`. `total` follows `config.buying.costBasis`: `buyTotal`, or `usedQty × unitPrice` for bulk parts when the basis is `used`. `lineTotal` equals `total` (kept for Phase 1 readers). `subtotal` and `byCategory` add up `total`. |

**Bulk products** are gathered per product across the whole job and bought as parts (all in category
`lights`):

- **Wire:** feet needed = the sum of the runs' feet (waste included). With cost basis `bought`, the cheapest
  mix of the sizes on file that covers it (a 139 ft job buys a 100 ft and two 25 ft lengths, not a 1,000 ft
  spool); with `used`, the size that is cheapest per foot. Each line's note says feet needed, bought and left
  over. Your own prices (`pricing.overrides`) are used for the comparison.
- **Bulbs:** one per socket (`ceil(run feet × 12 / bulbSpacingIn)` per run), split by the run's colour
  pattern: warm white, cool white, "multicolor" = the supplier's mixed box, and a custom pattern by the
  family of each colour (red, green → half and half; the first colour gets the odd bulb). A colour the
  supplier has no bulb for is priced like the default colour, has no part number, links to the supplier's
  bulb page and says "choose the colour at the supplier". Packs = `ceil(bulbs / packQty)`; the note says
  bulbs needed and spare.
- **Plugs:** one male and one female for every length of wire that is cut = every power feed of that
  product (every run when there is no power plan).
- **Clips:** one per socket for clip-mounted runs.

**Accessories.** When the chosen supplier has its own item for a generic accessory (clips by mount type,
light stakes, timer), the line takes its `sku`, name, pack size, price and link; the library's pack-size
overrides do not apply to a supplier's pack. Other accessories stay generic with a `findUrl`.

**Order sheets.** `bom.orderSheets(plan.bom, plan.library)` groups the lines per supplier (in the suppliers'
order), then "Any store":

```
[{ supplierId, supplierName, url, wholesale, priceAsOf,
   lines: [{ supplierSku, name, qty, unit, unitPrice, total, url, findUrl, priceStatus, priceAsOf, notes, sku }],
   subtotal }]
```

A sheet's totals are always what is ordered (`buyTotal`), whatever the cost basis. `bom.orderSheetToCsv(sheet)`
and `bom.orderSheetToText(sheet)` write one sheet. `bom.priceNote(bom)` is the sentence every export carries
when the plan uses supplier prices: "Prices were last checked on Nov 11, 2026; confirm at checkout. Account
(wholesale) prices differ: edit any price." `bom.bomToCsv(bom)` adds the columns Supplier, Part number, Price
status and Link (and that sentence as a last row) when any line names a supplier or carries a link; a plan
with no supplier keeps the Phase 1 columns.

**Checklist.** A feed of bulk wire starts with "On the ground, cut one length of socket wire for …: N ft
(N sockets). Slide a male plug onto the end that meets the cord and a female plug onto the far end, then
screw a warm white bulb into every socket.", then "Hang the wire along …" and "Carry the same wire on along …".

## 5. Compact example

A one-wall project with one eave and one outlet (persisted part only):

```json
{
  "schema": "lightplan/project", "version": 1, "id": "prj_ab12cd34", "name": "123 Maple St",
  "createdAt": "2026-11-08T17:00:00.000Z", "updatedAt": "2026-11-08T17:20:00.000Z",
  "customer": { "name": "", "address": "", "phone": "", "email": "" },
  "settings": { "wastePct": 10, "roofPitch": null, "colorMode": "warmWhite", "customColors": ["#ff3b30", "#34c759"], "lengthFormat": "ft-in" },
  "images": [{ "id": "img_1", "name": "front.jpg", "width": 2048, "height": 1536,
    "source": { "kind": "upload", "capturedAt": null, "attribution": null },
    "exif": { "focal35": 26, "focalMm": 5.96, "make": "Apple", "model": "iPhone 15" },
    "camera": { "mode": "auto", "presetId": "phone1x", "focalPx": null }, "storageKey": "img_1" }],
  "activeImageId": "img_1",
  "planes": [{ "id": "pl_front", "imageId": "img_1", "name": "Front wall", "kind": "wall", "color": "#4f9dff",
    "rect": { "corners": [[812, 902], [1490, 935], [1488, 1210], [815, 1236]], "widthFt": 16, "heightFt": 7, "presetId": "garage-double" },
    "refs": [{ "id": "ref_1", "kind": "line", "points": [[420, 1250], [421, 880]], "lengthFt": 6.6667,
      "presetId": "door-height", "courses": null, "quality": "high" }],
    "derived": null }],
  "features": [{ "id": "ft_1", "imageId": "img_1", "planeId": "pl_front", "type": "roofline", "label": "Front eave",
    "points": [[160, 610], [1540, 668]], "closed": false, "overrideFt": null, "productId": null, "color": null,
    "params": { "mount": null, "diameterIn": null, "spiralSpacingIn": null, "wrapMode": null, "outletId": null,
      "reverse": false, "overrideWidthFt": null, "overrideHeightFt": null } }],
  "outlets": [{ "id": "out_1", "imageId": "img_1", "planeId": "pl_front", "point": [640, 1180], "label": "Porch outlet",
    "type": "exteriorGfci", "gfci": true, "circuitId": "cir_1", "receptacles": 2 }],
  "circuits": [{ "id": "cir_1", "name": "Porch circuit", "breakerAmps": 15, "voltage": 120, "existingLoadW": 0 }],
  "library": { "products": null, "config": null },
  "pricing": { "overrides": { "c9-led": 29.99 } },
  "quote": { "enabled": false, "company": "", "laborMethod": "perFt", "ratePerFt": 3.5, "ratePerHour": 65,
    "markupPct": 30, "takedownFee": 150, "storageFee": 75, "taxPct": 0, "validDays": 30, "notes": "" }
}
```

A JSON export wraps it: `{schema: "lightplan/export", version: 1, exportedAt, project, images: {storageKey: dataUrl}, derived}`,
where `derived` is the plan above at export time (informative for Phase 2 consumers, ignored on import).

## 6. Storage, versioning and migration

**Phase 1 storage.** The project JSON is autosaved to `localStorage`; photo pixels go to IndexedDB under
each image's `storageKey`. Every access is wrapped in try/catch because either store may be unavailable.

**Reading any project** goes through one path: `migrateProject` → `normalizeProject` → `validateProject`
(`importProject` does all three and throws one plain-language Error if the file cannot be used).

- `normalizeProject` is tolerant and deterministic. It fills missing fields with defaults, coerces numeric
  strings, replaces unknown enum values with defaults, gives missing or duplicate ids position-based ids,
  sets references to deleted items to null, infers a missing `imageId` from the item's plane or the active
  photo, drops calibration refs with the wrong number of points, keeps unknown keys (so newer optional
  fields survive a round trip) and drops a top-level `derived` key. Unknown keys are kept on the project,
  on every entity and on every nested object it rebuilds: `settings`, `customer`, `quote`, `library`,
  `pricing`, an image's `source`, `camera` and `exif`, a plane's `rect` and `derived`, a feature's `params`
  and `color`. Known fields are always normalized; an unknown key never overrides one. The Phase 1.1 fields
  (`library.supplierId`, `config.buying`, supplier fields on products, `tapErr`) are optional: they are kept
  and repaired when present and never added when missing, so a project saved before them is unchanged.
- `validateProject` returns readable sentences, e.g. `Feature "Front eave" has an unknown type "spaceship".`

**Versioning policy.**

1. `schema` + integer `version` identify the format. The export wrapper has its own version.
2. Adding an optional field with a safe default does **not** bump the version: older files simply get the
   default from `normalizeProject`, and older apps keep the unknown field untouched.
3. Renaming a field, changing a unit or changing what a value means **does** bump the version, and adds an
   upgrader `MIGRATIONS[n]` (version n → n + 1) in `schema.js`. Upgraders run in sequence, each on a deep copy,
   and must be pure.
4. A project with no `version` is treated as version 1 (drafts from before the field existed).
5. A version newer than the app is refused with: "This project was saved by a newer version of LightPlan
   (format version N). Update LightPlan to open it." Nothing is guessed or downgraded.
6. Derived results are never migrated; they are recomputed.

## 7. Phase 2 mapping

The persisted model maps onto relational tables one to one. Point lists, rectangles and small option
objects fit well in JSON(B) columns; ids keep their prefixes so exports and API payloads stay readable.

| Table | Columns (beyond `id`) | From |
|---|---|---|
| `projects` | `org_id`, `name`, `customer` (json), `settings` (json), `quote_settings` (json), `library_overrides` (json), `active_image_id`, `schema_version`, `created_at`, `updated_at` | Project |
| `images` | `project_id`, `name`, `width`, `height`, `source` (json), `exif` (json), `camera` (json), `object_key` | Image (`storageKey` → object storage key) |
| `planes` | `project_id`, `image_id`, `name`, `kind`, `color`, `rect` (json), `derived` (json), `parent_plane_id` | Plane |
| `calibration_refs` | `plane_id`, `kind`, `points` (json), `length_ft`, `courses`, `width_ft`, `height_ft`, `preset_id`, `quality` | Ref |
| `features` | `project_id`, `image_id`, `plane_id`, `type`, `label`, `points` (json), `closed`, `override_ft`, `product_id`, `color` (json), `params` (json), `sort_order` | Feature |
| `outlets` | `project_id`, `image_id`, `plane_id`, `point` (json), `label`, `type`, `gfci`, `circuit_id`, `receptacles` | Outlet |
| `circuits` | `project_id`, `name`, `breaker_amps`, `voltage`, `existing_load_w` | Circuit |
| `products` | `org_id`, full Product fields (incl. `supplier_id`, `supplier_sku`, `url`, `price_as_of`, `price_status`, `equiv`, `kind`, `components` json) | `library.products` (org-wide library instead of per project) |
| `suppliers`, `supplier_offers` | supplier: `name`, `url`, `wholesale` (json), `search_url_template`, `category_urls` (json); offer: `supplier_id`, `sku`, `supplier_sku`, `name`, `url`, `price`, `pack_qty`, `price_as_of`, `price_status` | `suppliers.SUPPLIERS`, `SUPPLIER_PRODUCTS` and `SUPPLIER_ACCESSORIES` (kept fresh by a price-check job instead of hand entry) |
| `price_overrides` | `org_id` or `project_id`, `sku`, `unit_price` | `pricing.overrides` |
| `plan_snapshots` | `project_id`, `computed_at`, `app_version`, `plan` (json), `quote_total` | Derived plan, saved when a quote or report is issued |

**What moves to the backend unchanged.** The core modules are pure functions with no DOM, no clock and no
storage access, and they run under Node 22 today (the unit tests prove it):

- `geometry`, `camera`, `exif` (parse EXIF on upload), `catalog`, `measure`, `design`, `power`, `bom`
  (BOM, quote, checklist, CSV), `schema` (validate and normalize every API write, migrate stored rows on
  read) and `plan.computePlan` (the server recomputes the plan to issue authoritative quotes).
- They load through the same `LP.define` registry (`tests/loader.js` shows how in Node).

**What stays in the client.** `src/ui/*`: the store with undo/redo, canvas viewport and gestures, glowing
bulb preview, PDF writer and download plumbing. In Phase 2 the store's autosave swaps `localStorage` for
API calls; the project object it sends is the same JSON described here.
