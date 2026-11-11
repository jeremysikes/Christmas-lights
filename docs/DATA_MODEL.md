# LightPlan data model

This is the reference for the data LightPlan keeps and the data it computes from it. It covers Phase 1
(one self-contained HTML file) and how the same model maps onto a Phase 2 backend.

- Machine-readable contract: [`schema/project.schema.json`](../schema/project.schema.json) (JSON Schema draft 2020-12).
  The same object ships in the app as `schema.JSON_SCHEMA`, and a test checks the two stay identical.
- Code: `src/core/schema.js` (factories, normalization, migration, validation, export/import),
  `src/core/plan.js` (derived results), `src/core/bom.js` (BOM, quote, checklist).

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
| | BOM, quote totals, checklist, summary |

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
| `library` | `{products, config}` | `products`: full replacement product list or null (catalog defaults). Each product needs a known `category` and `unit`, `price` and `wattsPerUnit` of 0 or more, and `stringLengthFt` and `maxEndToEnd` above 0 (`validateProject` checks this, so a file cannot carry a product planned as 0 W or $0). Optional per product: `maxConnectedW` (the most watts its wiring may carry end to end, its own strings plus anything plugged into them; default `maxEndToEnd × wattsPerUnit`) and `endConnector` (false = no plug at the far end, so nothing can be plugged into it; default false only for per-foot products). `config`: overrides deep-merged into `catalog.DEFAULT_CONFIG`, or null. Cord planning reads `config.power`: `daisyChain` (true: link nearby runs with jumper cords; false: one cord per feed from the outlet), `jumperMaxFt` (30), `jumperDirectFt` (6: the most a jumper may cross open wall; longer ones go down to the ground and back up), `jumperSlackFt` (1.5), `outletHeightFt` (1.5: how far the ground is below an outlet when nothing lower is traced), `openingMarginFt` (0.5: how far beside a window or door a riser stands), `crossingPenaltyFt` (12: added per doorway or walkway crossed when cords are compared, never to the cord bought) and `tapOutlets` (3). |
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

## 4. Derived results (`plan.computePlan(project)`)

```
Plan = { library, measured, runs, power, bom, quote, checklist, warnings, summary }
```

| Part | Shape (abridged) | Notes |
|---|---|---|
| `library` | `{products, config, accessories}` | Catalog defaults with the project overrides applied. |
| `measured.planes[id]` | `{ok, mode, Himg2plane, Hplane2img, scale, refResults, disagreementPct, viewAngleDeg, pose, K, pitch, …}` | One solution per plane; `mode` says how it was calibrated. |
| `measured.features[id]` | `{ok, method, measuredFt, wrapFt, lengthFt, withWasteFt, areaSqFt, widthFt, heightFt, lights, overridden, confidence: {level, score, reasons}}` | `lengthFt = overrideFt ?? wrapFt ?? measuredFt`. |
| `runs[]` (LightRun) | `{id, featureId, productId, productName, unit, colorMode, colors, lengthFt, withWasteFt, quantity, hung?, bulbs, watts, amps, clips: {type, count}, lightStakes, method, detail, warnings, start, end, reversed, chainId, feedIds, outletId, circuitId, sourceFeedId}` | One per feature. `quantity` is strings, nets, sets or feet to buy; strings are counted along each chain, so a run the previous run's last string carries on along can buy 0. `hung` is the strings hung on it; `watts`/`amps` are the live load (spares from waste rounding are not plugged in). `start`/`end` are image points of where the run begins and ends after power planning. `sourceFeedId` is the feed the run's first feed is jumpered from (null: its cord comes from the outlet). |
| `power.feeds[]` | `{id, chainId, runIds, strings, watts, amps, start: {point, label, toward?}, outletId, circuitId, source, parentFeedId, childFeedIds, depth, supplyW, throughW, pathDropPct, taps, plugIn, cord: {kind, lengthFt, boughtFt, awg, pieces, voltageDropPct, route: [{kind, lengthFt, planeId, from, to}], routeText}, cordPath, cordUnknown, crossesWalkway, crossesDoorway, doorway?, portions: [{runId, units, total, startsRun, endsRun}]}` | A feed is the part of a chain on one cord, limited by the product's max end-to-end. `strings` counts hung strings. `source` is `{kind: 'outlet', outletId}` (a **home run**: its cord comes from the outlet) or `{kind: 'feed', feedId, port}` (a **jumper** from a powered feed: `port` `'end'` = the end plug of its last string, so the load passes through its strings; `'start'` = a 3-way tap where its own cord arrives). `outletId`/`circuitId` are the outlet at the root of its supply tree. `supplyW` is what its cord carries (itself and everything hanging off it), `throughW` what passes through its strings, `pathDropPct` the voltage drop summed over the cords back to the outlet, `taps` the 3-way taps it needs. `cord.kind` is `'home'` or `'jumper'`; `cord.route` lists the pieces of the route in order (`drop`, `ground`, `rise`, `hop`, `roof`, `wall`, `direct`; lengths in feet before the routing factor and slack; `from`/`to` are image points) and `cord.routeText` says it in words ("down 1.5 ft, 18 ft along the ground, up 8.5 ft beside Window left"). `cordPath` is the same route as an image polyline. `plugIn: true` (with `cord: null`) means the run plugs straight into its source with no cord. The cord gauge and voltage drop are worked out on the pieces bought (`boughtFt`) for the watts carried (`supplyW`). |
| `power.chains[]` | `{id, productId, runIds, reversed, strings, spares, watts, feedIds}` | `strings` hung, `spares` bought for waste, `watts` live. |
| `power.outlets[]` | `{id, label, circuitId, feedIds, directFeedIds, watts, needsSplitter, splitters, timer, limitW, overloaded, incandescentW}` | `feedIds`: every feed in the outlet's supply trees; `directFeedIds`: its home runs. Power stakes (`splitters`) are counted from the home runs only. Everything on one outlet shares its receptacle, timer and chained power stakes (15 A gear, `limitW` = 1,440 W at 80%). |
| `power.groups[]` | `{id, outletId, rootFeedId, feedIds, watts, homeRunFt, jumperFt}` | One supply tree per home run: `feedIds` in depth-first order from the root, `watts` on the home-run cord, cord feet bought for the home run and for the jumpers below it. |
| `power.counts` | `{timers, splitters, cordCovers, gfciAdapters, taps, homeRuns, jumpers}` | `jumpers` counts jumper cords (runs that plug straight in need none). `power.cords[]` (`{awg, lengthFt, count}`) lists every cord piece to buy, home runs and jumpers together. |
| `power.circuits[]` | `{id, name, breakerAmps, voltage, limitW, loadW, existingLoadW, utilizationPct, outletIds, overloaded}` | Load per circuit against the 80% rule. |
| `bom` | `{ok, lines: [{sku, category, name, qty, unit, unitPrice, defaultPrice, overridden, lineTotal, notes}], subtotal, byCategory}` | Categories: lights, clips, cords, power, hardware. |
| `quote` | `{enabled, materialsCost, markupPct, materialsPrice, laborMethod, linearFt, laborHours, laborCost, takedownFee, storageFee, taxPct, tax, total, lines: [{description, amount}], validDays, notes}` | Lines are customer-facing: Materials, Installation labor (X ft, Y h), Takedown, Storage, Tax, Total. |
| `checklist[]` | `{outletId, title, steps: [string]}` | One group per outlet, then runs with no outlet, runs not in the plan, and a safety/test group. |
| `warnings[]` | `{level: 'danger'|'warn'|'info', code, message, featureId?, planeId?, outletId?, circuitId?, stage?}` | Deduplicated, danger first. A failed stage adds `code: 'internal-error'`. |
| `summary` | `{totalFt, totalWithWasteFt, byType, strings, clips, cords, timers, homeRuns, jumpers, taps, watts, amps, circuits, outletsUsed, cost, quoteTotal}` | `cords` counts every cord piece bought; `homeRuns` the cords that go back to an outlet. `quoteTotal` is null when installer mode is off. |

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
  and `color`. Known fields are always normalized; an unknown key never overrides one.
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
| `products` | `org_id`, full Product fields | `library.products` (org-wide library instead of per project) |
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
