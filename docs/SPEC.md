# LightPlan Phase 1 — Build Contract (internal)

This document is the contract between modules. Every module author codes against the
signatures here. If you must deviate, keep the documented signature working and note the
deviation at the top of your file in a comment. **Do not edit files you do not own.**

> **Phase 2 readers:** this contract was written before the build. Where the shipped code differs (extra fields,
> refined definitions, widened result sets), the code wins; **§7 Implementation notes** lists every such
> deviation, and each source file repeats its own list in its header comment.

LightPlan measures a house from one photo, designs a Christmas-light layout, and produces a
bill of materials (BOM), a power/circuit plan, a quote and an install checklist.
Phase 1 ships as **one self-contained HTML file** (`dist/lightplan.html`) built from small
modules. All calculations are **pure functions** in `src/core/` so they can move to a
backend unchanged in Phase 2.

---------------------------------------------------------------------------------------------

## 1. Hard platform constraints (the HTML runs inside the claude.ai Artifact viewer)

- No external network except Google Fonts stylesheet. No CDN libraries. Everything inline.
- `alert()`, `confirm()`, `prompt()` do nothing in the viewer. Build confirmations in-page.
- `window.print()` does nothing. PDF must be generated in JS (own minimal PDF writer).
- `<a download>` / blob-URL downloads are blocked inside the viewer. Save files via
  `window.claude.use('downloads')` → `downloads.save({filename, data: Blob})` when available;
  fall back to a blob-URL `<a download>` when `window.claude` is absent (standalone file).
  `claude.use()` may take up to 10 s to resolve `null`; call it once at startup and cache the promise.
  Allowed extensions include pdf, csv, json, png, jpg.
- Live camera APIs are blocked. Camera capture = `<input type="file" accept="image/*" capture="environment">`.
- localStorage / IndexedDB may throw or be empty. Wrap **every** access in try/catch.
- Must work at 360–400 px wide, one-handed, large tap targets (≥ 44 px). No horizontal page scroll.
- The artifact fragment must not contain `<!doctype>`, `<html>`, `<head>`, `<body>` tags
  (the build produces a separate full-document standalone file).
- No source file may contain the literal `</script` (the build fails on it).
- Respect `prefers-reduced-motion` (twinkle off by default when reduced motion is set).

## 2. Files, ownership, module system

```
build.js                 inlines everything into dist/ (owner: lead)
package.json             scripts: build, test, e2e (owner: lead)
src/template.html        markup skeleton with @@STYLES / @@SCRIPTS markers (owner: ui-shell)
src/styles.css           all CSS (owner: ui-shell)
src/core/lp.js           module registry (owner: lead)
src/core/geometry.js     2D/3D math, homography               (owner: lead — WRITTEN; measure may APPEND functions)
src/core/camera.js       intrinsics, focal estimation, pose     (owner: measure)
src/core/exif.js         JPEG EXIF focal-length parser          (owner: measure)
src/core/measure.js      calibration, planes, measurement, confidence (owner: measure)
src/core/catalog.js      feature types, product library, config (owner: lead — WRITTEN; read it, don't rewrite it)
src/core/design.js       auto-plan of light runs                (owner: design-power)
src/core/power.js        chains, feeds, outlets, circuits, cords, warnings (owner: design-power)
src/core/bom.js          BOM, quote, checklist                  (owner: bom-schema)
src/core/schema.js       data model factories, validation, migration, JSON Schema (owner: bom-schema)
src/core/plan.js         computePlan orchestrator               (owner: bom-schema)
src/core/sample.js       3D sample house generator + ground truth (owner: sample)
src/ui/persist.js        autosave/load (localStorage + IndexedDB) (owner: ui-shell)
src/ui/store.js          state, undo/redo, gestures, plan memo   (owner: ui-shell)
src/ui/imagesource.js    ImageSource interface + implementations (owner: ui-shell)
src/ui/actions.js        all user-intent mutations               (owner: ui-shell)
src/ui/panels.js         step panels (DOM)                       (owner: ui-shell)
src/ui/app.js            bootstrap                               (owner: ui-shell)
src/ui/viewport.js       canvas, pan/zoom/pinch, tools, overlay  (owner: ui-canvas)
src/ui/preview.js        glowing bulbs renderer, snapshots       (owner: ui-canvas)
src/ui/export.js         PDF writer, CSV, JSON, downloads        (owner: export)
tests/loader.js          loads core modules in Node (owner: lead)
tests/*.test.js          node:test unit tests (each owner writes tests for its modules)
tests/e2e/*.mjs          Playwright smoke tests (owner: integration)
docs/*.md                docs
schema/project.schema.json  JSON Schema (owner: bom-schema)
```

### Module registry (`src/core/lp.js`, already written)

Every source file (core and ui) is wrapped exactly like this:

```js
LP.define('measure', ['geometry', 'camera', 'catalog'], function (geometry, camera, catalog) {
  'use strict';
  // ...
  return { solvePlane, measureProject /* ... */ };
});
```

`LP.require(name)` instantiates lazily and caches. Module names: `geometry, camera, exif,
catalog, measure, design, power, bom, schema, plan, sample, ui.persist, ui.store,
ui.imagesource, ui.actions, ui.preview, ui.viewport, ui.export, ui.panels, ui.app`.

- Core modules must not touch `window`, `document`, `localStorage`, `Date.now()` inside
  calculations, or any DOM API. They run in Node 22 for tests (`tests/loader.js`).
- Core functions never mutate their inputs.
- Language: modern JS (ES2020). No TypeScript, no imports, no external packages.
- Build script order: lp, geometry, camera, exif, catalog, measure, design, power, bom,
  schema, plan, sample, ui.persist, ui.store, ui.imagesource, ui.actions, ui.preview,
  ui.viewport, ui.export, ui.panels, ui.app, then `LP.require('ui.app').start()`.

### Tests

`npm test` runs `node --test` (no arguments — `node --test tests/` does NOT work). Run one file with
`node --test tests/measure.test.js`. Each test file starts with
`const LP = require('./loader');` then `LP.require('measure')` etc. Use `node:test` and
`node:assert/strict`. Tests must be deterministic.

---------------------------------------------------------------------------------------------

## 3. Coordinate systems and units

- **Image points**: `[x, y]` arrays, pixels of the *stored* image (already downscaled),
  origin top-left, y down.
- **Wall-plane coordinates**: `[u, v]` in **feet**. u to the right along the wall, v **up**.
  For a plane with a rectangle, the rectangle's bottom-left corner is the origin.
- **3D wall frame** (for camera pose): `(u, v, w)` feet, w = wall normal pointing **out of
  the wall toward the camera/street**. The wall plane is w = 0.
- **Roof/ground plane coordinates**: `[a, b]` feet; a along the defining line (eave or wall
  base), b perpendicular along the plane surface (up-slope for roof, toward street for ground).
- Lengths are feet (floats). Angles stored in degrees unless named `...Rad`.
- 3×3 matrices are flat row-major arrays of 9 numbers. A homography `H` maps `[x,y]` →
  `[(h0x+h1y+h2)/(h6x+h7y+h8), (h3x+h4y+h5)/(h6x+h7y+h8)]`.
- Quad corner order everywhere: `[TL, TR, BR, BL]` in image space (clockwise on screen).
  Rectangle mapping: TL→(0,H), TR→(W,H), BR→(W,0), BL→(0,0).

---------------------------------------------------------------------------------------------

## 4. Data model (persisted project — portable to Phase 2)

All ids are strings with a prefix (`prj_`, `img_`, `pl_`, `ref_`, `ft_`, `out_`, `cir_`).
`null` means "not set / use default". Numbers are plain JSON numbers.

```jsonc
{
  "schema": "lightplan/project",
  "version": 1,
  "id": "prj_ab12cd",
  "name": "123 Maple St",
  "createdAt": "2026-11-08T17:00:00.000Z",
  "updatedAt": "2026-11-08T17:20:00.000Z",
  "customer": { "name": "", "address": "", "phone": "", "email": "" },
  "settings": {
    "wastePct": 10,
    "roofPitch": { "rise": 6, "run": 12 },        // project default; null (what createProject sets) = unknown → estimate
    "colorMode": "warmWhite",                      // warmWhite | coolWhite | multicolor | custom
    "customColors": ["#ff3b30", "#34c759"],
    "lengthFormat": "ft-in"                        // ft-in | ft-decimal
  },
  "images": [{
    "id": "img_1", "name": "front.jpg", "width": 2048, "height": 1536,
    "source": { "kind": "upload", "capturedAt": null, "attribution": null },   // kind: upload|camera|sample|streetview|aerial
    "exif": { "focal35": 26, "focalMm": 5.96, "make": "Apple", "model": "iPhone 15" },   // or null
    "camera": { "mode": "auto", "presetId": "phone1x", "focalPx": null },     // mode: auto|exif|preset|manual
    "storageKey": "img_1"                          // pixels live in IndexedDB/localStorage under this key
  }],
  "activeImageId": "img_1",
  "planes": [{
    "id": "pl_front", "imageId": "img_1", "name": "Front wall",
    "kind": "wall",                                // wall | roof | ground
    "color": "#4f9dff",
    "rect": {                                      // perspective rectangle on this wall, or null
      "corners": [[x,y],[x,y],[x,y],[x,y]],        // stored as tapped; order with geometry.orderQuad
      "widthFt": 16, "heightFt": 7,                // both null = size unknown
      "presetId": "garage-double"
    },
    "refs": [                                      // calibration references on this plane
      { "id": "ref_1", "kind": "line", "points": [[x,y],[x,y]], "lengthFt": 6.6667,
        "presetId": "door-height", "courses": null, "quality": "high" },
      { "id": "ref_2", "kind": "rect", "points": [[x,y],[x,y],[x,y],[x,y]],
        "widthFt": 3, "heightFt": 6.6667, "presetId": "door-rect", "quality": "high" }
    ],
    "derived": null                                // for roof/ground planes:
    // { "parentPlaneId": "pl_front", "line": [[x,y],[x,y]], "pitch": {"rise":6,"run":12} | null }
    // roof: line = eave (on parent wall), slopes up and away from camera at pitch (null → project/estimated)
    // ground: line = wall base (on parent wall), plane is horizontal, extends toward the camera; pitch ignored
  }],
  "features": [{
    "id": "ft_1", "imageId": "img_1", "planeId": "pl_front",
    "type": "roofline",                            // see FEATURE_TYPES
    "label": "Front eave",
    "points": [[x,y], [x,y]],
    "closed": false,
    "overrideFt": null,                            // tape-measured length (ft) replaces measured length
    "productId": null,                             // null = auto-plan default for the type
    "color": null,                                 // null = project colorMode; else {"mode":"multicolor"} or {"mode":"custom","colors":["#hex"]}
    "params": {
      "mount": null,                               // gutter|shingle|allInOne|ridge|adhesive|zipTie|stake|none ; null = type default
      "diameterIn": null,                          // tree / column
      "spiralSpacingIn": null,                     // tree / column
      "wrapMode": null,                            // tree: trunk | canopy
      "outletId": null,                            // force this run's power to an outlet
      "reverse": false,                            // force run direction (start at the last point)
      "overrideWidthFt": null,                     // bush: tape-measured width (ft)
      "overrideHeightFt": null                     // bush: tape-measured height (ft)
    }
    // overrideFt meaning by geometry: polyline/polygon → length (perimeter); vertical (tree, column) → HEIGHT
    // (wrap length is recomputed from it); area (bush) → ignored (use overrideWidthFt/overrideHeightFt).
  }],
  "outlets": [{
    "id": "out_1", "imageId": "img_1", "planeId": "pl_front", "point": [x,y],
    "label": "Porch outlet", "type": "exteriorGfci",   // exteriorGfci | garage | interior | other
    "gfci": true, "circuitId": "cir_1", "receptacles": 2
  }],
  "circuits": [{ "id": "cir_1", "name": "Porch circuit", "breakerAmps": 15, "voltage": 120, "existingLoadW": 0 }],
  "library": { "products": null, "config": null },   // null = defaults; products = full replacement list; config = deep-merged overrides
  "pricing": { "overrides": { } },                    // sku -> unit price
  "quote": {
    "enabled": false, "company": "", "laborMethod": "perFt",   // perFt | perHour
    "ratePerFt": 3.5, "ratePerHour": 65, "markupPct": 30,
    "takedownFee": 150, "storageFee": 75, "taxPct": 0, "validDays": 30, "notes": ""
  }
}
```

Derived results (never trusted from input; always recomputed by `plan.computePlan`) are
included in JSON exports under a top-level `"derived"` key for Phase 2 consumers.

---------------------------------------------------------------------------------------------

## 5. Core module APIs

### 5.1 geometry (pure math) — ALREADY IMPLEMENTED in src/core/geometry.js (read it)

Also exports: `normalizeH, scaleMatrix(sx,sy), m3col(m,i), clamp, median, rng(seed)` (mulberry32 PRNG → fn), `hashString`.

```
solveLinear(A /*n×n array of rows*/, b /*n*/) → x | null      // partial pivoting; null if singular
homographyFromPoints(src /*[[x,y]×4..n]*/, dst) → H | null      // DLT, h8=1 for 4 pts; least squares for n>4
applyH(H, p) → [x,y] | null                                     // null if w≈0
invertH(H) → H | null ; multiplyH(A,B) → H ; scaleH(Sx,Sy) style helpers allowed
dist(a,b), polylineLength(pts, closed=false), polygonArea(pts) /*abs*/, bbox(pts) → {minX,minY,maxX,maxY,w,h}
centroid(pts), lerp(a,b,t), pointSegmentDistance(p,a,b) → {d, t, point}
segmentsIntersect(a,b,c,d) → bool (proper or touching)
pointInPolygon(p, poly) → bool
orderQuad(pts4) → [TL,TR,BR,BL]                                 // robust to tap order; sorts by angle around centroid
isConvexQuad(pts4) → bool
localScale(H, p) → {scale /*sqrt|det J|*/, sMin, sMax}           // plane units per pixel at image point p
pointAtDistance(pts, d) → {point, segIndex}                      // walk polyline
resampleByDistance(pts, step, closed) → pts                     // equal arc-length samples incl. endpoints
angleDeg(a,b) → degrees of vector b-a from +x (image or plane space as given)
// 3D helpers (arrays of 3): v3add, v3sub, v3scale, v3dot, v3cross, v3len, v3norm
// mat3: m3mul, m3mulv, m3transpose, m3inv, m3det, m3fromCols(c0,c1,c2)
```

### 5.2 camera (single-view metrology)

Camera intrinsics: `K = {f, cx, cy}` (pixels; square pixels, no skew; cx,cy = image center).

```
CAMERA_PRESETS = [
  {id:'phone1x',   label:'Phone main camera (1×)', f35:26},
  {id:'phone2x',   label:'Phone 2× zoom',          f35:52},
  {id:'phone3x',   label:'Phone 3× telephoto',     f35:77},
  {id:'phone05x',  label:'Phone 0.5× ultra-wide',  f35:13},
  {id:'streetview',label:'Street View screenshot', hfovDeg:90},
  {id:'camera50',  label:'Camera 50 mm',           f35:50}
]
focalFromF35(f35, width, height) → f   // f35 * hypot(w,h) / 43.2666
focalFromHfov(hfovDeg, width) → f      // (w/2)/tan(hfov/2)
focalFromPreset(presetId, width, height) → f
estimateFocalFromQuad(quad /*[TL,TR,BR,BL]*/, cx, cy) → {ok, f, relStd, reason}
    // H_s maps unit square (BL=(0,0),BR=(1,0),TR=(1,1),TL=(0,1)) to centered image coords.
    // Orthogonality of the rectangle's sides: f² = -(h0*h1 + h3*h4)/(h6*h7) using H_s columns.
    // ok only if f² > 0, f within [0.25, 6]·max(w,h) (pass w,h via cx*2, cy*2), and a ±2px corner
    // perturbation study gives relStd ≤ 0.15. Otherwise ok:false with a plain reason
    // ("photo is nearly straight-on, so focal length can't be measured from the rectangle").
resolveCamera(image, planes, opts?) → {f, cx, cy, source, label, relStd, rectEstimate, focalQuad, exifIgnored}
    // image.camera.mode: 'manual' (focalPx) | 'preset' (presetId) | 'exif' | 'auto'.
    // auto: EXIF focal35 → else best ok estimateFocalFromQuad over the image's wall rects (lowest relStd)
    //       → else preset 'phone1x'. source ∈ 'manual'|'preset'|'exif'|'rectangle'|'default'.
    // EXIF focal35 is ignored (exifIgnored: plain reason) when EXIF PixelX/YDimension do not fit the stored photo
    // (different aspect ratio, or a different size while the photo is below opts.maxImageSide = 2048): a crop.
    // rectEstimate {f, relStd, planeId, planeName, what, refId} | null: best rectangle estimate whatever the source
    // (for the lens-mismatch check); focalQuad {planeId, refId} when source is 'rectangle'.
focalFromQuadQuick(quad /*ordered*/, cx, cy) → f | null       // orthogonality estimate without the stability study
rectAspectFromQuad(quad, K) → W/H ratio    // ||K⁻¹h1|| / ||K⁻¹h2|| with H from unit square
poseFromHomography(Hplane2img, K) → {ok, R /*3x3 flat, cols r1 r2 r3*/, t /*[3]*/, C /*camera center in wall frame*/}
    // M = K⁻¹H; λ = 2/(|m1|+|m2|); r1=λm1, r2=λm2, t=λm3; if t[2]<0 negate; r3=r1×r2;
    // re-orthonormalize R (nearest rotation via SVD-free polar iteration or Gram–Schmidt);
    // C = -Rᵀt. With u right / v up / image y down, r3 points toward the camera → C[2] (w) > 0.
viewAngleDeg(pose, planePoint3) → angle between wall normal and the ray to that point (0 = straight on)
rayThroughPixel(px, K, pose) → {origin:[3], dir:[3] unit}     // in wall frame
projectPoint(X3, K, pose) → [x,y]                              // wall frame → image
roofFrame(A3, B3, rise, run) → {origin, e1, e2, n}              // eave A→B on wall (w≈0); e1 horizontal along eave
    // (v-component removed); e2 = cosθ·h + sinθ·(0,1,0), h = horizontal ⟂ e1 pointing INTO the house (w<0);
    // θ = atan(rise/run)
groundFrame(A3, B3) → {origin, e1, e2, n}                       // base line A→B; e2 horizontal ⟂ e1 pointing toward camera (w>0)
homographyForFrame(frame, K, pose) → Hframe2img                // H = K [R·e1, R·e2, R·origin + t]
orthoPitchLength(du, dv, rise, run) → sqrt(du² + (dv/sinθ)²)    // fallback when no pose (camera at infinity)
```

### 5.3 exif

```
parseExif(arrayBuffer) → null | {focal35, focalMm, make, model, orientation, width, height, dateTime}
    // JPEG APP1 "Exif\0\0", TIFF II/MM, IFD0 → ExifIFD (0x8769): FocalLengthIn35mmFilm 0xA405,
    // FocalLength 0x920A (rational), Orientation 0x0112, Make 0x010F, Model 0x0110, DateTimeOriginal 0x9003.
    // Never throws (returns null on a malformed TIFF header or IFD entry table). One entry whose value lies outside
    // the EXIF block is skipped (that field reads null). Also handles non-JPEG (returns null).
```

### 5.4 catalog (data only + tiny lookups) — ALREADY IMPLEMENTED in src/core/catalog.js (read it)

Also exports: `LINEAR_TYPES` (types where waste applies), `CORD_PRICES`, `cordSku(awg, lengthFt)` → 'cord-16-25',
`getAccessory(accessories, sku)`, `resolveColors(featureColor, settings)` → {mode, colors}, `deepMerge`, `deepClone`, `isPlainObject`.
Accessory shape: `{sku, name, category: 'clips'|'cords'|'power'|'hardware', unit: 'pack'|'each', packSize, price, awg?, lengthFt?}`.
Clip pack size comes from each accessory's `packSize` (adhesive clips = 50) unless `config.clipPackSize` is set (null by default).

```
FEATURE_TYPES: { [id]: {id, label, short, geometry, color, offPlane, defaultProduct, defaultMount, closedDefault, minPoints, maxPoints} }
  geometry: 'polyline' | 'polygon' | 'vertical'(exactly 2 points, base→top) | 'area'(polygon)
  ids and defaults:
    roofline  'Roofline / eave'         polyline  c9-led       allInOne
    rake      'Gable rake'              polyline  c9-led       shingle
    gutter    'Gutter'                  polyline  c9-led       gutter
    ridge     'Ridge'                   polyline  c9-led       ridge     offPlane:true (unless on a roof plane)
    window    'Window outline'          polygon   mini-led-100 adhesive  closedDefault:true
    door      'Door outline'            polyline  mini-led-100 adhesive  (open 3-sided by default)
    column    'Column / post'           vertical  treewrap-led none
    railing   'Railing'                 polyline  mini-led-100 zipTie
    walkway   'Walkway / driveway edge' polyline  path-stakes  stake     (best on a ground plane)
    bush      'Bush (area)'             area      mini-led-100 none      offPlane:true
    tree      'Tree (wrap)'             vertical  treewrap-led none      offPlane:true
    stakes    'Ground stakes'           polyline  c9-led       stake     (best on a ground plane)
TYPE_ORDER: array of ids in the order above
DEFAULT_PRODUCTS: array of Product (editable JSON) — see below
DEFAULT_CONFIG: rules of thumb (editable) — see below
ACCESSORIES: array of priced non-light SKUs (clips, cords, timers, splitters, cord covers, light stakes, GFCI adapter)
COLOR_MODES: { warmWhite:{label, colors:['#ffc46b']}, coolWhite:{...['#dfeaff']}, multicolor:{...['#ff3b30','#34c759','#2f7bff','#ffb000','#b44dff']}, custom:{label:'Custom'} }
CLIP_TYPES: { allInOne, gutter, shingle, ridge, adhesive, zipTie } → {label, sku}
CORD_GAUGES: [{awg:16, ampacity:13, ohmsPer1000ft:4.016}, {awg:14, ampacity:15, ohmsPer1000ft:2.525}, {awg:12, ampacity:20, ohmsPer1000ft:1.588}]
CORD_LENGTHS: [6, 15, 25, 50, 100]
getLibrary(project) → {products, config, accessories}   // applies project.library overrides (config deep-merged)
getProduct(products, id) → product | null
```

**Product** fields:
```
{ id, name, category: 'c9'|'c7'|'mini'|'icicle'|'net'|'rope'|'track'|'path'|'treewrap',
  tech: 'LED'|'incandescent', unit: 'string'|'net'|'set'|'foot',
  bulbSpacingIn, stringLengthFt /*lit length per unit*/, leadFt, bulbsPerUnit,
  wattsPerUnit /*per string/net/set; per foot when unit='foot'*/, maxEndToEnd /*units*/,
  coverageSqFt /*net only*/, stakesPerSet /*path only*/, stakeSpacingIn /*path only*/,
  dropLengthsIn /*icicle preview, e.g. [4,6,8]*/,
  price, sku, colors: ['warmWhite','coolWhite','multicolor','custom'], clipEligible: bool,
  enabled: bool, suitableFor: [feature type ids], notes }
```
Required default products (typical values, editable):
`c9-led` (25 bulbs, 12in, 25 ft, 9.6 W, max 30, $32.99, clipEligible), `c9-incan` (25×7 W = 175 W, max 3, $18.99),
`c7-led` (25 bulbs, 12in, 25 ft, 7.2 W, max 40, $27.99, clipEligible), `c7-incan` (125 W, max 5, $14.99),
`mini-led-100` (100 bulbs, 4in, 33 ft lit, 4.8 W, max 43, $12.99), `mini-incan-100` (40.8 W, max 3, $6.99),
`icicle-led-300` (300 bulbs, 16.5 ft, 14.4 W, max 20, $24.99, clipEligible), `net-led-4x6` (150 bulbs, 24 sq ft, 7.2 W, max 30, $22.99),
`rope-led-18` (18 ft, 1in spacing, 10.8 W, max 8, $29.99), `track-permanent` (unit foot, 6in pixels, 1.2 W/ft, $28/ft, enabled:false),
`path-stakes` (set of 10 stakes, 18in spacing, 3 W/set, max 25, $29.99), `treewrap-led` (150 bulbs, 3in, 37.5 ft, 7.2 W, max 30, $16.99).

**DEFAULT_CONFIG**:
```
{
  typeDefaults: { roofline:'c9-led', rake:'c9-led', gutter:'c9-led', ridge:'c9-led', window:'mini-led-100',
                  door:'mini-led-100', column:'treewrap-led', railing:'mini-led-100', walkway:'path-stakes',
                  bush:'mini-led-100', tree:'treewrap-led', stakes:'c9-led' },
  clipSpacingIn: 12, clipPackSize: null,          // null = each clip accessory's packSize; a number overrides
  bush: { lightsPerUnit: 100, heightUnitFt: 1.5, widthUnitFt: 1, netCoverFactor: 1.5 },
  tree: { defaultDiameterIn: 10, spiralSpacingIn: 4, canopyLightsPerFtHeight: 100 },
  column: { defaultDiameterIn: 8, spiralSpacingIn: 6 },
  stakes: { spacingIn: 12, packSize: null },      // null = the light-stakes accessory packSize (25)
  power: { voltage: 120, continuousFactor: 0.8 /* (0, 1]; 80 reads as 80% */, maxVoltageDropPct: 3, cordSlackFt: 4,
           routingFactor: 1.15, chainGapFt: 3, timerPerOutlet: true, splitterOutlets: 3,
           plugAmps: 15 /* plug-in cords, timers, stakes, outlets */, timerTungstenW: 1250 /* incandescent through a timer */ },
  labor: { ftPerHour: 40, setupHours: 1, hoursPerTree: 0.75, hoursPerBush: 0.25 },
  refDisagreementWarnPct: 5,
  confidence: { highMin: 75, mediumMin: 50 },
  maxImageSide: 2048
}
```

### 5.5 measure

```
REF_PRESETS: [
  {id:'door-height',    label:'Entry door height (80 in)', kind:'line', lengthIn:80, quality:'high'},
  {id:'door-width',     label:'Entry door width (36 in)',  kind:'line', lengthIn:36, quality:'high'},
  {id:'door-rect',      label:'Entry door (36 × 80 in)',   kind:'rect', widthIn:36, heightIn:80, quality:'high'},
  {id:'garage-single',  label:'Single garage door (9 × 7 ft)', kind:'rect', widthIn:108, heightIn:84, quality:'high'},
  {id:'garage-double',  label:'Double garage door (16 × 7 ft)',kind:'rect', widthIn:192, heightIn:84, quality:'high'},
  {id:'garage-height',  label:'Garage door height (7 ft)', kind:'line', lengthIn:84, quality:'high'},
  {id:'siding-4',       label:'Vinyl siding, 4 in courses', kind:'courses', courseIn:4, quality:'medium'},
  {id:'siding-5',       label:'Vinyl siding, 5 in courses', kind:'courses', courseIn:5, quality:'medium'},
  {id:'brick',          label:'Brick courses (3 ≈ 8 in)', kind:'courses', courseIn:8/3, quality:'medium'},
  {id:'custom-line',    label:'Custom length',  kind:'line', quality:'high'},
  {id:'custom-rect',    label:'Custom rectangle', kind:'rect', quality:'high'}
]
// 'courses' refs are stored as kind:'line' with courses:N and lengthFt = N*courseIn/12.
refFromPreset(presetId, points, {lengthFt, widthFt, heightFt, courses}) → ref object (schema §4)
WALL_RECT_PRESETS: door-rect, garage-single, garage-double, custom-rect, plus {id:'unknown', label:'Size unknown (e.g. house corners)'}

solvePlanes(project, config) → {
  cameras: { [imageId]: K & {source,label,relStd} },
  planes:  { [planeId]: PlaneSolution },
  pitch:   { rise, run, source: 'user'|'estimated'|'default', angleDeg|null, samples }
}
PlaneSolution = {
  ok, planeId, kind,
  mode: 'rect-known'|'rect-refs'|'refs-only'|'roof-3d'|'roof-ortho'|'ground-3d'|'uncalibrated',
  Himg2plane, Hplane2img,        // image px ↔ plane feet (null when !ok)
  scale: {sx, sy, anisotropic: bool},
  refResults: [{refId, label, expectedFt, measuredFt, errorPct}],   // measured with the FINAL solution
  disagreementPct,               // spread (max/min ratio − 1)·100 over independent checks (step 3), null if none
  checks: number,                // count of independent size constraints beyond the first
  viewAngleDeg, pose, K,         // pose/K null when unavailable
  pitch: {rise, run, source} | null,   // roof planes
  extent: {minU,minV,maxU,maxV} | null, // plane-space bbox of the rect (for extrapolation checks)
  warnings: [string], notes: [string],
  // also: disagreementZ, poseConsistencyPct, poseTolerancePct, focalMismatchPct, pitchInfo {onEave, spread, samples},
  //       uncertaintyPct (typical item on the plane), confidence (plane-level rating), calib {..., rectProblem,
  //       refsBothDirections, anisotropic}, groundScale, frontSign (see the header of src/core/measure.js)
}
```
Wall plane algorithm:
1. With `rect` (4 corners, `orderQuad`):
   - Known size → `H = homographyFromPoints(quad, [[0,H],[W,H],[W,0],[0,0]])`, mode `rect-known`.
   - Unknown size → aspect `a = rectAspectFromQuad(quad, K)`; map to `[[0,1],[a,1],[a,0],[0,0]]`;
     scale from refs (below). mode `rect-refs`; `!ok` (uncalibrated) if no refs.
2. Without rect → similarity from refs (ft per px, v up), mode `refs-only`; uncalibrated if no refs.
   A single `rect` ref on a plane without `rect` may be used as the plane rectangle (known size).
3. Scale fit from refs (rect refs contribute width and height as two line constraints):
   - rect-known: no fit; every ref is a check → `errorPct`.
   - otherwise isotropic weighted mean `s = Σ wᵢ(Lᵢ/|dᵢ|) / Σ wᵢ`, `wᵢ = |dᵢ|·q(quality)`
     (q: high 1, medium 0.6, low 0.3); every further ref is a cross-check (`checks = used − 1`).
     If ≥ 2 refs with orientation diversity (one with |du| > 2|dv| and one with |dv| > 2|du|) and mode is
     rect-refs, the least-squares (sx², sy²) from `Lᵢ² = sx²duᵢ² + sy²dvᵢ²` is used (`anisotropic:true`) only
     when the refs pin the proportions better than K (σ_refs = 2.5·√2·sqrt(1/Σ_h|d|² + 1/Σ_v|d|²) px-relative
     < σ_K = aspect sensitivity × focal σ: EXIF 3%, preset 12%, manual/default 25%, rectangle 3.5·relStd), or when
     they disagree with K by z > 2; in the latter case K's proportions count as the cross-check
     (`checks = used − 1`) and `disagreementPct` = |sx/sy − 1|·100. Otherwise `checks = used − 2`.
   - `errorPct = 100·(measured − expected)/expected`; `disagreementPct` = the spread between independent size
     constraints, `(max ratio / min ratio − 1)·100` with ratio = measured/expected under the final solution (on
     rect-known the rectangle counts as ratio 1), when `checks ≥ 1`, else null. When separate scales were switched on
     because the refs disagree with K, it is the larger of that K-vs-refs gap |sx/sy − 1|·100 and (with ≥ 3 refs) the spread. (The original "max |errorPct|" under-reports when the fit sits between two refs.)
4. Pose: `poseFromHomography(Hplane2img, K)` when mode is rect-*; `viewAngleDeg` at the rect center.
   - `disagreementZ` = max pairwise |ln(rᵢ/rⱼ)| / hypot(σᵢ, σⱼ) with σ = 2.5·√2 px / ref length on screen
     (rect side: 2.5 px / side length): how much of a disagreement tap noise alone explains.
5. Warnings: disagreement > config.refDisagreementWarnPct → "References on 'Front wall' disagree by 7.2%.
   Check that each one sits on this wall and that its size is right."; non-convex quad; refs-only
   ("No perspective rectangle: assumes the photo was taken straight on.").

Roof plane (`kind:'roof'`): needs parent wall solution with pose. Eave endpoints → wall coords
(u,v,0) via parent `Himg2plane` → `roofFrame` with resolved pitch → `homographyForFrame` →
invert. mode `roof-3d`. Without parent pose → mode `roof-ortho`: use parent H, then lengths
are corrected per segment with `orthoPitchLength`. Pitch resolution: `derived.pitch` →
`settings.roofPitch` → estimated pitch → default 6/12 (`source:'default'`).

Derived planes do NOT inherit the wall's `checks` / `disagreementPct`. Roof refs are checks. Ground refs re-fit the
ground scale about the camera foot (`groundScale`; one ref sets it, further refs are checks). Points of a roof or
ground item at or above that surface's horizon (w ≤ 0 under Hplane2img) make the item `!ok` with a plain reason.
Roof pitch is estimated per roof: rakes on the parent wall whose low end is on the eave line (±1.5 ft, within its
span) first, else all gable rakes (`pitchInfo.onEave:false`); samples spreading > 2/12 → 'pitch-spread' warning.
Ground plane (`kind:'ground'`): same with `groundFrame` → mode `ground-3d`; without pose → `!ok`
("Ground plane needs a perspective rectangle on its wall").

```
estimatePitch(project, planeSolutions) → {rise, run:12, angleDeg, samples} | null
    // in-plane gable rakes: features type 'rake' on WALL planes; per segment ≥ 1 ft, angle in plane
    // coords; rise = 12·tan(angle); median; round to nearest integer; clamp 2..18.
measurePoints(points, closed, planeSol, opts) → {lengthFt, segmentsFt, areaSqFt, widthFt, heightFt, pixelLength}
    // live readout; handles roof-ortho correction
measureFeature(feature, planeSol, ctx) → FeatureMeasurement
FeatureMeasurement = {
  ok, featureId, type, method: 'plane'|'roof-3d'|'roof-ortho'|'ground-3d'|'override'|'uncalibrated',
  measuredFt,          // geometric length (polyline/perimeter; vertical: height) — null if !ok
  wrapFt,              // tree/column spiral length, else null
  lengthFt,            // display length used for planning = overrideFt ?? (wrapFt ?? measuredFt)
  withWasteFt,         // lengthFt * (1 + wastePct/100) for linear types; = lengthFt for bush/tree/column
  areaSqFt, widthFt, heightFt,      // area types and verticals
  lights,              // bush rule-of-thumb light count, else null
  pitchEstimate,       // for in-plane rakes: {rise, run:12, angleDeg}
  overridden: bool,
  confidence: { level: 'high'|'medium'|'low', score: 0..100, reasons: [string] },
  uncertaintyPct       // expected error (2σ, %) from tap precision; null outside measureProject
}
// Spiral: turns = H_in / s ; wrapFt = turns · hypot(π·D_in, s) / 12   (D, s from params or config)
// Tree wrapMode 'canopy': lights = canopyLightsPerFtHeight · heightFt, wrapFt = null, lengthFt = heightFt.
// Bush: lights = lightsPerUnit · (heightFt/heightUnitFt) · (widthFt/widthUnitFt); width/height from the plane-space
//   bbox of the polygon (or params.overrideWidthFt/overrideHeightFt → overridden:true); measuredFt = perimeter;
//   lengthFt = null for bushes (they are planned by lights, not feet).
// totals: byType[t].lengthFt sums lengthFt (bush contributes 0 and its lights); totalFt/totalWithWasteFt exclude bushes.
scoreConfidence(factors) → {level, score, reasons}   // start 100, subtract; override → 100 'Tape-measured'
    // (a tape-measured tree height with an assumed trunk diameter → Medium)
    // plane mode: rect-known 0, rect-refs −5, refs-only −20, roof-3d −10, roof-ortho −20, ground-3d −10, uncalibrated → 0
    // no cross-check reference −5; disagreement 3–6% −10, 6–10% −20, >10% −35
    // only medium/low quality refs −10; courses ref spanning < 8 courses −10
    // view angle 20–35° −5, 35–50° −15, > 50° −25; focal from 'default' on rect-refs/roof/ground −10
    // pitch estimated −10, pitch default −25 (roof planes)
    // off-plane type on a wall plane −15 (tree, bush, ridge)
    // extrapolation: feature bbox reaches > 1.5× rect size outside the rect extent −10
    // tap precision: 2 px / pixelLength > 3% −10
    // disagreement deductions apply only when significant (disagreementZ > 2 or unknown): a correct short
    // reference never lowers a rating; focal from 'rectangle' with relStd > 5% on rect-refs/roof/ground −10
    // level: ≥ highMin high, ≥ mediumMin medium, else low. Every deduction adds a plain-language reason.
    // Then level CAPS (score clamped into the capped band; limiting reasons listed first):
    //   tap precision uncertaintyPct u (2σ of the item's size with every calibration tap and every item point
    //     nudged ±2.5 px; measureProject fills it): u > 3% → ≤ Medium, u > 6% (or Infinity) → Low
    //   refs-only → Low (Medium when horizontal and vertical refs agree within 3%); a broken rectangle → Low
    //   roof-ortho → Low; focal 'default': roof/ground → Low, rect-refs (isotropic) → Medium
    //   focalMismatchPct (lens vs rectangle estimate beyond max(15%, 3·relStd)): roof/ground → Low, rect-refs → Medium
    //   roof/ground when the wall rectangle misfits the lens (poseConsistencyPct > poseTolerancePct) → Low
    //   pitch 'estimated' or 'default' → Low (the gable on the wall may not be this roof's slope)
    //   off-plane on a wall: tree, column, ridge → Low; bush → Medium (reason gives the expected bias)
    //   scale from one unchecked reference (checks 0, scaleFrom 'refs') → Medium; tree with assumed diameter → Low
measureProject(project, config) → {
  cameras, planes, pitch,
  features: { [featureId]: FeatureMeasurement },
  totals: { byType: { [type]: {count, lengthFt, withWasteFt, lights} }, totalFt, totalWithWasteFt },
  warnings: [{level:'warn'|'info', code, message, planeId?, featureId?, imageId?}]
  // codes include 'focal-mismatch' (warn, with suggestedFocalPx), 'exif-ignored' (info), 'pitch-spread' (warn)
}
imageToPlane(planeSol, p) → [u,v] | null ; planeToImage(planeSol, uv) → [x,y] | null
planeGridLines(planeSol, stepFt, extent) → [[p1,p2], ...]   // image-space segments for an overlay grid
formatLength(ft, format='ft-in') → "32′ 4″" or "32.3 ft"   // ft-in rounds to nearest inch
```

### 5.6 design

```
planRuns(project, measured, library) → LightRun[]
LightRun = {
  id: 'run_' + featureId, featureId, featureType, label, planeId, imageId,
  productId, productName, category, tech, unit,
  colorMode, colors: ['#hex', ...],          // resolved (feature.color ?? project settings)
  lengthFt, withWasteFt,
  quantity,                                  // strings / nets / sets / feet
  bulbs, watts, amps,                        // amps = watts / voltage
  clips: { type, count } | null,             // C9/C7/icicle (clipEligible) every clipSpacingIn: ceil(lengthFt*12/spacing)+1;
                                             // mini lights on window/door → adhesive; railing → zipTie (same spacing)
  lightStakes: number,                       // 'stakes' type: ceil(lengthFt*12/stakes.spacingIn)+1
  method: 'linear'|'bush-rule'|'bush-net'|'spiral'|'path-sets'|'per-foot',
  detail: string,                            // human explanation, e.g. "35.2 ft + 10% = 38.7 ft ÷ 25 ft per string → 2 strings"
  warnings: [string],
  // filled later by plan.js from power.runInfo (and, when strings are counted along the chain, quantity,
  // hung, bulbs, watts and amps of the live load, with the chain note appended to detail):
  start: null, end: null, reversed: false, chainId: null, feedIds: [], outletId: null, circuitId: null
}
// Quantity rules:
//  string products: ceil(withWasteFt / stringLengthFt); bush with string product: ceil(lights / bulbsPerUnit)
//  net products on bush: ceil(widthFt*heightFt*netCoverFactor / coverageSqFt); on linear: ceil(withWasteFt*... ) treat as 4ft-wide coverage
//  set products (path): stakes = floor(lengthFt*12/stakeSpacingIn)+1 ; sets = ceil(stakes / stakesPerSet)
//  foot products: ceil(withWasteFt)
//  disabled or missing product → fall back to typeDefaults, then the enabled suitable product closest to the default
//  (LED before incandescent, then same category, then same unit, then library order), with a run warning
suitableProducts(type, library) → product[]   // enabled products whose suitableFor includes type
```

### 5.7 power

```
planPower(project, measured, runs, library) → PowerPlan
PowerPlan = {
  chains: [{id, productId, runIds /*ordered*/, reversed /*{runId: bool}*/, strings /*hung*/, spares, watts /*live*/, feedIds}],
  feeds:  [{id, chainId, runIds, strings, watts, amps, start: {point:[x,y], imageId, planeId, label, toward?},
            outletId|null, circuitId|null,
            cord: {lengthFt /*needed*/, boughtFt, awg, pieces: [lengths], voltageDropPct} | null,
            cordPath: [[x,y],[x,y]],          // image-space polyline outlet → feed start (for overlay)
            crossesWalkway: bool, crossesDoorway: bool, doorway?: label, cordUnknown: bool,
            portions: [{runId, units, total, startsRun, endsRun}]}],   // hung strings per run, for the checklist
  outlets: [{id, label, circuitId, feedIds, watts, needsSplitter, splitters, timer: bool, limitW, overloaded, incandescentW}],
  circuits: [{id, name, breakerAmps, voltage, limitW, loadW, existingLoadW, utilizationPct, outletIds, overloaded}],
  runInfo: { [runId]: {chainId, feedIds, outletId, circuitId, start:[x,y], end:[x,y], reversed,
                       quantity? /*bought*/, hung?, watts? /*live*/, note?} },
  cords: [{awg, lengthFt, count}],            // purchasable pieces aggregated
  counts: { timers, splitters, cordCovers, gfciAdapters },
  totals: { watts, amps },                    // live load: hung strings only
  warnings: [{level:'danger'|'warn'|'info', code, message, featureId?, outletId?, circuitId?}]
}
```
Rules:
- Distances: same calibrated plane → plane coordinates; different planes that both have a camera pose (walls with a
  perspective rectangle and the roof/ground planes built on them) → 3D distance in the camera frame; otherwise the
  image vector scaled by each plane's local Jacobian in that direction (never a direction-blind scale).
- Chains: runs with the same productId whose endpoints are within `config.power.chainGapFt` (feet, as above,
  cross-plane allowed) connect end to end. Closed runs have start = end.
- Strings: for string products laid along a measured length only the strings that cover the true length are hung
  and loaded; the rest (waste rounding) are spares. Consecutive runs of a chain with the same string and colors are
  counted as one continuous line (a string carries on around the corner); runInfo carries each run's share.
- Feeds: split a chain whenever cumulative hung units would exceed product.maxEndToEnd (split between runs;
  if one run alone exceeds it, split it into several feeds along its length). A mid-run feed starts where the
  hung strings end (string length along the run). A chain may instead be fed from its point nearest an outlet
  with two walks working outward, when that needs at least 10% less cord.
- Orientation & outlet choice minimize cord length; respect `feature.params.outletId` and `reverse`.
  Greedy: feeds by watts desc → nearest outlet whose circuit stays ≤ limitW and whose plug-in gear stays ≤ its
  limit; else nearest whose circuit fits; else nearest + overload warning.
- Cord length (ft) = routed distance outlet→feed start (same plane: |Δu|+|Δv|; otherwise straight distance as
  above × 1.3) × routingFactor + cordSlackFt. Pieces: smallest standard length ≥ L; L > 100 → 100s + remainder.
  Gauge: smallest of 16/14/12 AWG whose ampacity (capped at the 15 A plug, `plugAmps`) ≥ I and
  drop% = 2·L·(Ω/1000)·I / V · 100 ≤ maxVoltageDropPct, with L = the length of the pieces bought.
- limitW = breakerAmps · voltage · continuousFactor (15 A → 1440 W; 20 A → 1920 W); continuousFactor is bounded
  to (0, 1] (80 reads as 80%). Each outlet's cords share one receptacle, timer and stakes: ≤ plugAmps · V · factor.
- Timers: one per outlet with feeds. Splitters (chained from the timer socket): outlet with n > 1 feeds →
  ceil((n − 1) / (splitterOutlets − 1)).
- Cord covers: one per feed whose cordPath crosses a walkway feature, or whose same-wall route passes a traced door
  or a walkway meeting that wall. GFCI adapters: one per used outlet with gfci=false.
- Warnings (codes): incandescent, circuit-overload, circuit-high (>90% of limit), outlet-overload, timer-tungsten,
  many-cords (> 6 cords at one outlet), continuous-factor, max-end-to-end (info: "needs N feeds"), fed-from-middle
  (info), cord-walkway, cord-doorway, no-gfci, interior-outlet, voltage-drop, long-cord (>100 ft), cord-ampacity,
  cord-unknown, no-outlets, unassigned, outlet-no-circuit, outlet-missing, and always
  `disclaimer` (info): "This is a planning estimate, not an electrical inspection. ..."

### 5.8 bom

```
buildBom(project, runs, power, library) → { lines: [BomLine], subtotal, byCategory: {lights, clips, cords, power, hardware} }
BomLine = { sku, category, name, qty, unit, unitPrice, defaultPrice, overridden, lineTotal, notes }
  // lights grouped by productId + color mode label; clips → packs (ceil(count·(1+waste)/pack)) of config.clipPackSize
  // when set, else the accessory packSize;
  // light stakes → packs; cords by awg+length; timers; splitters; cord covers; gfci adapters.
  // unitPrice = project.pricing.overrides[sku] ?? defaultPrice. Money rounded to cents.
buildQuote(project, bom, measured, runs, library) → Quote
Quote = { enabled, materialsCost, markupPct, materialsPrice, laborMethod, linearFt, laborHours, laborCost,
          takedownFee, storageFee, taxPct, tax, total, lines: [{description, amount}], validDays, notes }
  // laborHours = linearFt/ftPerHour + setupHours + trees·hoursPerTree + bushes·hoursPerBush (rounded 0.25)
  // laborCost = perFt ? linearFt·ratePerFt + (trees+bushes hours)·ratePerHour : laborHours·ratePerHour
  // tax applies to materialsPrice
buildChecklist(project, runs, power, measured) → [{outletId|null, title, steps: [string]}]
  // grouped by outlet then feed order: plug timer → run cord (length, gauge) → clips → hang strings from the
  // start end → continue to next run in the chain → test. Final group: general safety/test steps.
bomToCsv(bom) → string   // header: SKU,Item,Category,Qty,Unit,Unit Price,Line Total,Notes ; RFC 4180 escaping
```

### 5.9 schema

```
SCHEMA_ID = 'lightplan/project', SCHEMA_VERSION = 1, JSON_SCHEMA (object, same as schema/project.schema.json)
uid(prefix, rng?) → string
createProject(opts?) / createImage(opts) / createPlane(opts) / createRef(opts) / createFeature(type, opts)
createOutlet(opts) / createCircuit(opts)        // fill every field with defaults (§4)
normalizeProject(p) → p'    // fills missing fields, never throws on partial input
migrateProject(p) → p'      // upgrades older versions; unknown future version → throw Error with plain message
validateProject(p) → {ok, errors: [string]}
exportProject(project, derived?, imagesByKey? /* {storageKey: dataUrl} */, exportedAt? /*ISO string*/) →
    { schema:'lightplan/export', version:1, exportedAt, project, images, derived }   // pure: caller passes the time
importProject(obj) → {project, images: {storageKey: dataUrl}}   // accepts an export wrapper or a bare project;
    // migrate + normalize + validate; throws Error with a plain message ("This file is not a LightPlan project.")
createProject(opts) defaults: no images/planes/features/outlets; circuits = [{name:'Circuit 1', breakerAmps:15}].
```

### 5.10 plan

```
computePlan(project) → Plan     // pure; uses catalog.getLibrary(project)
Plan = { library, measured, runs /*with power annotations merged*/, power, bom, quote, checklist,
         warnings /*measured + power + run warnings, deduped, danger first*/,
         summary: { totalFt, totalWithWasteFt, byType, strings, clips, cords, timers, watts, amps,
                    circuits, outletsUsed, cost, quoteTotal } }
```

### 5.11 sample

```
createSample({traced = true} = {}) → { width, height, primitives, project, groundTruth, camera }
  // A 3D house rendered through a pinhole camera (yaw 15–25° off the facade normal, tilt ≥ 8° up,
  // f from 26 mm-equivalent) so the perspective is visible and focal length is estimable.
  // project: one image (source.kind 'sample', storageKey 'sample'), planes: 'Front wall' (rect = facade corners,
  // tape-measured 34 × 10 ft, preset custom-rect, + door-height ref + one horizontal ref as cross-checks), 'Garage
  // wall' (set back, rect = double garage door 16×7 known + one cross-check ref), 'Main roof' (roof, from front
  // eave, pitch entered 6/12; settings.roofPitch stays null so the project pitch is still estimated from the
  // in-plane front gable as a cross-check), 'Front yard' (ground, from front wall base).
  // (Changed after review: the size-unknown front wall rated every wall item Low on the first screen.)
  // features (traced:true): eaves, front-gable rakes (in wall plane), side rake + ridge on roof plane, gutter,
  // 2 windows, door outline, 3 bushes, 1 tree, 2 walkway edges on ground plane; outlets: porch GFCI (15 A
  // circuit), garage exterior GFCI (20 A circuit).
  // traced:false → the same image with one blank 'Front wall' plane (no rect, refs, features or outlets) for practice.
  // groundTruth: { [featureId]: trueLengthFt } computed from the 3D model (eaves/rakes/windows/etc.).
drawPrimitives(ctx, primitives)    // works with any CanvasRenderingContext2D (no DOM access)
toSVG(primitives, width, height) → string
// primitive: {t:'poly', pts, fill?, stroke?, lw?, closed?} | {t:'line', pts, stroke, lw, dash?} |
//            {t:'circle', c:[x,y], r, fill?, stroke?, lw?} | {t:'rect', x,y,w,h, fill} |
//            fill may be '#hex' / 'rgba()' or {linear:[x0,y0,x1,y1], stops:[[0,'#..'],[1,'#..']]}
```

---------------------------------------------------------------------------------------------

## 6. UI contract

### 6.1 Store (`ui.store`)

```
createStore({project, ui}) → store
store.project()                // current project object (treat as immutable)
store.ui()                     // ui state object
store.plan()                   // memoized plan.computePlan(project); recomputed lazily after project changes
store.commit(label, mutator, {gesture=false}={})   // mutator(draft) edits a deep clone; pushes undo (unless inside
                                                   // a gesture); bumps updatedAt; schedules autosave; notifies
store.beginGesture()           // snapshot for undo; commits with {gesture:true} won't push until endGesture
store.endGesture(label)        // push one undo entry if the project changed during the gesture
store.setUI(patch)             // shallow-merge into ui (nested objects replaced); notifies; not undoable
store.undo() / store.redo() / store.canUndo() / store.canRedo()
store.replaceProject(project, {resetHistory=true})
store.subscribe(fn) → unsubscribe        // fn({projectChanged, uiChanged})
store.getImage(imageId) → CanvasImageSource | null   // decoded pixels (HTMLImageElement / canvas)
store.setImage(imageId, element, dataUrl)            // runtime cache + persist
```
UI state:
```
ui = {
  step: 1..6,
  mode: { name: 'select'|'pan'|'rect'|'line'|'trace'|'outlet', opts: {} },
  draft: { points: [[x,y],...] },            // in-progress taps for rect/line/trace modes
  selection: null | { kind: 'feature'|'plane'|'ref'|'outlet', id, planeId? },
  activePlaneId: 'pl_front',
  traceType: 'roofline',
  view: { preview: true, night: true, twinkle: false, overlay: true, grid: true, labels: true, snap: true },
  sheet: 'half',                              // mobile panel height: 'min'|'half'|'full'
  toast: null | { message, kind: 'info'|'ok'|'warn'|'error', id },
  dialog: null | { title, body, confirmLabel, danger, onConfirm }   // in-page confirm
}
```

### 6.2 Actions (`ui.actions`) — the only place that mutates the project

```
createActions(store) → actions
actions.goStep(n)
actions.select(sel | null)
actions.setMode(name, opts)                  // also clears draft
actions.cancelDraft()
actions.addDraftPoint([x,y])                  // viewport calls on tap in rect/line/trace modes; auto-completes when
                                              // rect has 4, line has 2, vertical trace has 2, polygon closed by tapping
                                              // the first point (viewport passes the first point exactly when closing)
actions.removeLastDraftPoint()
actions.completeDraft()                       // finalize per mode.opts.purpose:
    // rect  purpose 'planeRect' {planeId, presetId, widthFt, heightFt} → plane.rect
    //       purpose 'refRect'   {planeId, presetId, widthFt, heightFt} → plane.refs.push(rect ref)
    // line  purpose 'refLine'   {planeId, presetId, lengthFt, courses} → plane.refs.push(line ref)
    //       purpose 'roofEave'  {planeId (parent), pitch} → new roof plane; 'groundBase' {planeId} → new ground plane
    // trace {type, planeId} → new feature (stays in trace mode, same type, empty draft)
    // rect/line completion returns to 'select' mode and selects the created item
actions.addOutlet([x,y])                      // creates outlet on the WALL under the tap (wallForPoint: rect / refs /
                                              // traced-item hull contains it, else the nearest wall; never roof/ground);
                                              // default circuit (creates one if none)
actions.moveVertex(target, index, [x,y], {gesture})
    // target: {kind:'feature', id} | {kind:'planeRect', planeId} | {kind:'planeLine', planeId} |
    //         {kind:'ref', planeId, refId} | {kind:'outlet', id}   (index ignored for outlet)
actions.insertVertex(featureId, afterIndex, [x,y]); actions.deleteVertex(featureId, index)
actions.deleteSelection()
actions.updateFeature(id, patch) / updatePlane(id, patch) / updateRef(planeId, refId, patch) /
        updateOutlet(id, patch) / updateCircuit(id, patch) / addCircuit() / deleteCircuit(id) /
        updateSettings(patch) / updateQuote(patch) / updateCustomer(patch) / setPriceOverride(sku, price|null) /
        setLibraryProducts(products|null) / setLibraryConfig(config|null) / updateImageCamera(imageId, patch)
actions.addPlane(kind='wall') ; actions.deletePlane(id)
actions.loadImageFile(file, {sourceKind:'upload'|'camera'})   // via ui.imagesource; starts a fresh project keeping settings
actions.loadSample({traced, confirm=true})    // asks first when the user has work (in-page dialog); undoable
actions.newProject() ; actions.startOver()    // startOver shows in-page dialog, then clears storage + loads blank
actions.importProjectFile(file) ; actions.toast(message, kind)
actions.confirm({title, body, confirmLabel, danger}) → Promise<bool>   // in-page dialog
```

### 6.3 Viewport (`ui.viewport`)

```
createViewport({host /*HTMLElement*/, store, actions}) → viewport
viewport.fit() ; viewport.zoomBy(factor, screenPt?) ; viewport.redraw()
viewport.screenToImage([sx,sy]) → [x,y] ; viewport.imageToScreen([x,y]) → [sx,sy]
viewport.destroy()
```
- Creates its own `<canvas>` inside `host` (host has `position:relative`), sizes to host with
  devicePixelRatio, `touch-action:none`, ResizeObserver. Subscribes to the store and redraws via rAF
  (continuous rAF only while twinkle is on, preview visible, and the tab is visible).
- Pointer events: one pointer drag on empty space pans (in every mode); two pointers pinch-zoom + pan;
  wheel zooms at cursor; double-click/double-tap zooms in only in select mode (in trace mode a second tap within
  8 CSS px finishes the polyline; in rect/line/outlet modes every tap places a point); a tap is a press+release
  with < 8 px movement and < 500 ms (in the placing tools a stationary press of any length also places a point).
- Modes per §6.2: taps call `actions.addDraftPoint`. In `select` mode taps hit-test (handles first, then
  outlets, features (distance to polyline/inside polygon), refs, plane rects) and call `actions.select`.
  Dragging a handle of the selected item: `store.beginGesture()`, `actions.moveVertex(..., {gesture:true})`
  per move, `store.endGesture('Move point')` on release. Handle hit radius ≥ 22 CSS px on touch.
- Snapping when `ui.view.snap` (the canvas Snap button, `#ctl-snap`, in every step): to an existing
  vertex/corner/ref endpoint/outlet **on the same surface** within 14 CSS px, capped at 1% of the photo's long side
  (image px); a plane's own rect corners / line ends are excluded while it is being redrawn. Else, for traced items
  only, axis snap (segment within 4° of horizontal/vertical **in the active plane's rectified coordinates**, using
  measure.imageToPlane/planeToImage; falls back to image axes when the plane is uncalibrated). Calibration
  geometry (rects, refs, eave/base lines) is never axis-snapped. Draw a small snap indicator.
- Loupe: while a finger places or drags a point (touch only), draw a 2.5× magnifier circle (~110 px)
  offset above the finger with a crosshair at the true point.
- Overlay (when `ui.view.overlay`), by step: (2) plane rect outlines + rectified grid (`measure.planeGridLines`,
  1 ft minor/5 ft major when zoomed enough), roof/ground planes as translucent grids, refs as dashed lines with
  "expected / measured" labels; (3) features colored by `FEATURE_TYPES[type].color`, length labels
  (`measure.formatLength`) with confidence dot; (5) outlets (icon + label, circuit color), cord paths dashed from
  `plan.power.feeds[].cordPath`, run start arrows; (4/6) features faint + labels. Selected item: bright
  outline + vertex handles. Draft: points, rubber band to hover point, live length via `measure.measurePoints`.
- Preview layer: when `ui.view.preview`, draw base image via `preview.drawBase` and bulbs via
  `preview.drawBulbs` (bulbs from `preview.computeBulbs(project, plan, imageId)`).
- Keyboard (desktop, when focus is not in an input): Esc cancel draft/deselect, Enter finish trace,
  Backspace remove last draft point or delete selection, Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo.
  (The viewport may register these; app.js must not double-register.)

### 6.4 Preview (`ui.preview`)

```
computeBulbs(project, plan, imageId) → Bulb[]   // memoized on (plan object, imageId)
  Bulb = {x, y, r /*image px*/, color, phase, kind: 'bulb'|'mini'|'drop'|'stake'}
  // linear runs: sample along the feature at equal TRUE spacing (product.bulbSpacingIn) in plane coords and map
  //   back with Hplane2img (perspective-correct); cap to keep ≥ 2.5 image px between bulbs (draw a soft line
  //   for denser mini lights); icicle: bulbs on the line + drops below (dropLengthsIn); bush: deterministic
  //   seeded scatter inside the polygon (≤ 600 bulbs) or grid for nets; tree/column: zig-zag spiral across the
  //   trunk width (diameterIn via local scale); path/stakes: bulb on a short stake line.
  // colors from run.colors (multicolor cycles along the run).
drawBase(ctx, image, {night}) → void            // ctx already transformed to image space
drawBulbs(ctx, bulbs, {pxPerImagePx, night, timeMs|null, twinkle}) → void
  // glow sprites cached per color/size, 'lighter' compositing, bloom halo at night; twinkle modulates phase.
renderSnapshot({project, plan, image, maxWidth=1600, night=true, labels=true}) → HTMLCanvasElement
  // photo + lights; labels = numbered tag at each run start ("1", "2"... in plan.runs order) for reports.
```

### 6.5 Export (`ui.export`)

```
initDownloads()                               // call once at startup: caches claude.use('downloads') promise
saveFile(filename, data /*string|Blob*/, mime) → Promise<'saved'|'declined'|'failed'|'busy'|'unavailable'|'too_large'>
                                              // busy: a save prompt is already open (one at a time) or rate_limited;
                                              // unavailable: inside the viewer (window.claude present) with no downloads
                                              //   capability (use() null / timed out) or code unavailable|not_granted|capability_*
                                              //   — never the blob fallback there; too_large: the viewer refused the size.
                                              // The <a download> fallback runs only when window.claude is absent.
exportPdfReport(store) → Promise              // preview snapshot + summary + measurements + BOM + power + checklist + disclaimer
exportQuotePdf(store) → Promise               // customer-facing quote (installer mode)
exportCsv(store) → Promise                    // bom.bomToCsv
exportJson(store, {includeImages=true}) → Promise   // schema.exportProject(project, plan, images)
importJsonFile(file) → Promise<{project, images}>   // schema.importProject; images as dataUrls
PdfDoc class: new PdfDoc({size:'letter'}); addPage(); text(str, x, y, {size, bold, color, align, maxWidth});
  line(x1,y1,x2,y2,{width,color}); rect(x,y,w,h,{fill,stroke}); image(jpegBytes|dataUrl, x, y, w, h);
  textWidth(str, size, bold); toBytes() → Uint8Array   // Helvetica/Helvetica-Bold WinAnsi, JPEG via DCTDecode,
  // correct xref byte offsets. Coordinates in points from the TOP-left (writer flips internally).
```

### 6.6 Panels (`ui.panels`) and app (`ui.app`)

`ui.panels.mount({root, store, actions, viewport})` renders the step panel for `ui.step` and re-renders
on store changes **without destroying focused inputs** (patch values or re-render only when structure
changes; commit text inputs on `change`, not on every keystroke). `ui.app.start()` boots: persist.load →
store → actions → viewport → panels → top bar/step bar/canvas controls wiring → `export.initDownloads()`.
First run (nothing saved) opens the traced sample house at step 1 with the night preview on, and a banner
explaining it is a sample. A restored plan reopens at the step saved in the `ui` pref, in day view while nothing
is traced. Persistent notes (`ui.notice`) cover blocked storage, an autosave this version cannot read (kept as a
backup with a Download button) and another tab saving over the plan (autosave pauses).

### 6.7 Visual design direction

Subject: a lighting installer's planning tool, used outdoors on a phone and at night.
- Fonts (Google Fonts with fallbacks): display `Big Shoulders Display` (brand + step titles only, used sparingly),
  body `Atkinson Hyperlegible` (legibility in glare), numbers `JetBrains Mono` with `tabular-nums`.
- Tokens: light theme = cool paper `--bg:#f4f6f3`, ink spruce `--ink:#15302b`, accent bulb amber `--accent:#d98a1c`,
  muted `--muted:#5d6e69`, line `--line:#d5ddd8`, surface `--surface:#ffffff`; dark theme = night sky
  `--bg:#0d1420`, `--ink:#e8eef4`, accent `--accent:#ffbf5a`, surface `#141d2b`. Semantic: ok `#2f8f5b`,
  warn `#c98200`, danger `#c8354a` (adjust per theme for contrast). Confidence pills: High/Medium/Low.
- Layout: one-screen app (`html,body{height:100%}`), top bar (brand, undo/redo, menu), numbered step bar
  (the order is real), canvas fills the remaining area; desktop ≥ 900 px: panel on the right (380 px);
  phone: bottom sheet with min/half/full sizes. Floating canvas controls: zoom in/out, fit, day/night, twinkle,
  overlay. Tool hint bar at the top of the canvas while a tool is active ("Tap the 4 corners of the garage door").
- Tap targets ≥ 44 px, visible focus states, no emoji icons (use inline SVG icons), side gutter
  `max(16px, env(safe-area-inset-*))` on panels.
- Theme tokens: bare `:root` light; `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){...}}`
  and `:root[data-theme="dark"]{...}` dark; `body{background:var(--bg)}`.

---------------------------------------------------------------------------------------------

## 7. Implementation notes (shipped Phase 1 vs. this contract)

The code is the source of truth. Every documented signature above still works; the items below are where the
shipped modules add to or refine the contract. Each file's header comment carries the same list in more detail.
Phase 2 ports (TypeScript `@lightplan/core`) should keep these behaviours, and the unit tests pin most of them.

### 7.1 Core

**camera**
- `resolveCamera(image, planes, opts?)` returns `{ok, f, cx, cy, source, label, relStd, rectEstimate, focalQuad,
  exifIgnored}`. `ok:false` (with `f:null`, label 'Photo size unknown') when the image has no usable width/height.
  'auto' also considers rectangle *references* (e.g. a door drawn as a rect), lowest relStd wins. EXIF focal35 is
  ignored (`exifIgnored` = plain reason) when the EXIF pixel size does not fit the stored photo (crop / resize).
- `estimateFocalFromQuad` also returns `samples`; `poseFromHomography` also returns `consistency
  {normRatio, cosAngle}`; `viewAngleDeg(pose, point, normal?)` takes an optional plane normal.
- Extra exports: `getPreset, DEFAULT_PRESET_ID, FULL_FRAME_DIAGONAL_MM, Kmatrix, KinvMatrix, focalFromQuadQuick`.

**exif** — one entry whose value lies outside the EXIF block is skipped (that field is null) instead of the whole
block returning null. Also reads `width`/`height` from 0xA002/0xA003 (used by the crop check). Extra export `TAG`.

**measure**
- `solvePlanes(...).cameras[imageId]` is the full `resolveCamera` result above (not just K + source/label/relStd).
- `measureProject` also returns `ok` (false only for a non-object input). Its warnings may carry `imageId` and
  `suggestedFocalPx` ('focal-mismatch'); `plan.collectWarnings` keeps only featureId/planeId/outletId/circuitId/
  stage, so the UI reads lens warnings from `plan.measured.warnings`.
- PlaneSolution extras: `reason` (why !ok), `issues [{code, level, message}]`, `calib {scaleFrom: 'rect'|'refs'|
  'parent', onlyMediumLowRefs, minCourses, rectProblem, refsBothDirections, anisotropic}`, `frame` (roof/ground 3D
  frame), `gridExtent` (overlay box on every plane; `extent` stays the rect box or null), `parentPlaneId`,
  `disagreementZ`, `poseConsistencyPct`, `poseTolerancePct`, `focalMismatchPct`, `pitchInfo {onEave, spread,
  samples}`, `groundScale`, `frameHimg2plane`, `frontSign` (horizon test), `promotedRefId` (a rect ref used as the
  plane rect), `uncertaintyPct` (typical item, 2σ %) and `confidence` (plane-level rating shown on its pill).
- `disagreementPct` is a spread, not max |errorPct| (§5.5 step 3). `scale.sx/sy` are fitted factors in ft per base
  unit (1 for rect-known, ft/px for refs-only). Roof/ground `viewAngleDeg` is the parent wall's.
- Derived planes do not inherit the wall's `checks`/`disagreementPct`; ground refs re-fit the ground scale about the
  camera foot; roof/ground points at or above the surface's horizon make the item `ok:false`.
- On a plane without `rect`, the largest valid known-size rect ref becomes the plane rect. An unknown-size rect with
  one known side uses that side as an extra scale reference.
- FeatureMeasurement extras: `reason`, `pixelLength`, `segmentsFt`, `uncertaintyPct` (2σ %, `Infinity` when a ±2.5 px
  nudge breaks the measurement, null outside measureProject). Trees, columns and bushes on a ground plane with a
  pose are measured on a vertical plane through their base (method 'ground-3d').
- `scoreConfidence` takes the extra factors listed in §5.5 and applies level caps after the deductions; the
  practical effect is that High needs a known-size rectangle (or cross-checked refs) whose tap-precision error is
  ≤ 3%, and roof/ground items are Low unless pitch is entered and the lens/rectangle agree.
- Extra exports: `QUALITY_WEIGHT, getRefPreset, refLabel, resolvePitch, spiralWrapFt`.

**design** — clip rule widened (string products on roof-edge mounts get all-in-one clips, rope gets adhesive clips;
mount 'zipTie' → zip ties, 'stake' → none, explicit 'none' → none); light stakes for any stake-mounted string or
per-foot run; tree canopies use method 'bush-rule'; `lengthFt`/`withWasteFt` are always numbers (0 when unmeasured);
LED-first product fallback with a run warning; products with unusable data are skipped with a warning. Extra
exports: `resolveProduct, clipsFor, productDataProblem`.

**power** — 3D cross-plane distances (camera frame) with a direction-aware Jacobian fallback; hung vs bought strings
(spares), strings counted along each chain, mid-run feeds where hung strings end, feeding from the middle when it
saves ≥ 10% cord; outlet limit = plugAmps · V · factor (1,440 W) with 'outlet-overload'; 'timer-tungsten';
'many-cords'; continuous factor bounded to (0, 1]; chained power stakes `ceil((n−1)/(splitterOutlets−1))`; cord gauge
and drop computed on the pieces bought (`cord.boughtFt`); same-wall cords past a traced door or a walkway meeting
the wall get a cover ('cord-doorway'). Feeds also carry `cordUnknown`; feeds consider only outlets on the same photo
unless `params.outletId` forces one. Extra codes: cord-unknown, outlet-no-circuit, outlet-missing, cord-ampacity.
Extra exports: `limitW, continuousFactorOf, voltageDropPct, chooseCordGauge, cordPieces, sizeCord, DISCLAIMER`.

**bom** — results carry `ok` (false + `reason` when the data is unusable); light lines keyed by product + color mode
(custom palettes split lines); clip packs add waste, light stakes do not; quote omits zero fees/tax; checklist
follows `feed.portions`, chains power stakes and adds "No outlet chosen yet" / "Not in the plan yet" groups;
`bomToCsv` uses CRLF, neutralises formula-leading cells and writes the subtotal in a summary row (blank row, then
'Subtotal' in SKU and the amount in Item) so summing Line Total is not doubled. Extra exports: `round2, emptyBom`.

**schema** — factories take `opts.id`, `opts.rng` and (createProject) `opts.now`; without `now`, createdAt/updatedAt
are null (core never reads the clock). `settings.roofPitch` defaults to **null** (unknown → estimated, else 6/12).
`normalizeProject` keeps unknown keys on every nested object, drops a top-level `derived`, nulls dangling ids and
drops refs with the wrong point count. `validateProject` checks custom products like the product editor.
`importProject` also accepts a JSON string and reads a string wrapper version ("2" → refused as newer). Extra
exports: `EXPORT_SCHEMA_ID, EXPORT_VERSION, ENUMS, ID_PREFIX, createDefaultSettings, createDefaultQuote,
quoteFieldProblem`.

**plan** — `computePlan` never throws: a failing stage adds a danger warning `{code:'internal-error', stage}` and an
empty result. Run warnings become `{level:'warn', code:'run', message, featureId}`. `summary.circuits` counts
circuits that power a feed; `summary.quoteTotal` is null when installer mode is off. `mergeRunInfo` also copies
power's per-run quantity/hung/watts/amps/bulbs and a detail note. Extra exports: `mergeRunInfo, collectWarnings,
summarize, emptyMeasured, emptyPower`.

**sample** — groundTruth values are numbers except bushes (`{widthFt, heightFt}`); the tree's value is its trunk
height. `camera.distanceFt` is added; extra exports `SAMPLE_WIDTH, SAMPLE_HEIGHT`. The sample's taps are exact
projections, so its lengths match ground truth within 0.4% (bushes, traced on the wall, come out 6–11% wide and are
flagged), yet most items are rated **Low**: ratings assume a human's ±2.5 px taps on a 1600 × 1100 photo, and the
front wall's rectangle is sized by references, the roof pitch is estimated and the ground is far away.

### 7.2 UI

**store** — UI state also has `calib`, `bannerDismissed`, `busy`, `notice` and `activeVertex`. `createStore` accepts
`opts.persist` (null disables autosave) and `opts.now`. `commit()` returns true when the project changed; a mutator
may return false to cancel. `setImage(id, el, dataUrl, {persist:false})`. undo/redo are no-ops inside a gesture.
Extra methods: `undoLabel(), redoLabel(), getImageData(imageId) → dataUrl | null, inGesture(), clearImages()`.
Extra exports: `defaultUI, sanitizeUI, activeImageOf, MAX_HISTORY`.

**actions** — extra line purpose 'planeLine' (redraw a roof eave / ground base); `completeDraft({close})`;
`addOutlet` uses `wallForPoint`; `startTrace` picks the surface by `KINDS_FOR_TYPE` and, for a walkway/stakes with no
ground plane, starts the ground base line first (`opts.thenTrace`); `loadSample` asks first and is undoable;
`deletePlane` returns `Promise<bool>`; `addCircuit`/`addPlane` return the new id; `updateQuote` returns false (and
toasts) for values a reload would reset. Extra actions: `undo, undoLabel, canUndo` (a draft point first),
`hasUserWork, setActiveVertex, setActivePlane, setView, setCalib, setSheet, startPlaneRect, removePlaneRect,
startReference, startTrace, startOutlet, redrawPlaneLine, changeFeatureType, resetAutoPlan, setProjectName,
dismissBanner, dismissToast, confirmReplace, hydrateImages` (resolves `{missing, damaged}`), `deleteFeature,
deleteRef, deleteOutlet`. Module exports also `parseLength(text)` (6'-8", 6' 8 1/2", 36-1/2", 1,200 …),
`nextFeatureLabel, nextOutletLabel, wallForPoint, KINDS_FOR_TYPE`.

**persist** (not specified in §6) — project JSON in localStorage `lightplan:v1:project`, photos in IndexedDB
`lightplan/images` (localStorage fallback `lightplan:v1:img:<key>`), prefs `lightplan:v1:pref:<name>` (including
`ui` = {step, night, preview}); the sample photo is never stored. Exports `load` (also returns `raw`), `clear,
saveProject` (debounced ~400 ms), `saveProjectNow, flush, isAvailable, backupUnreadable/loadBackup/clearBackup`
(`lightplan:v1:project:unreadable`), `handleStorageEvent, setForeignChangeHandler, isAutosavePaused/pauseAutosave/
resumeAutosave, saveImage, loadImage, deleteImage, pruneImages` (keeps photos of the backup and of another tab's
plan), `savePref, loadPref, setErrorHandler` and the key constants. Every call resolves; nothing rejects.

**imagesource** — `SampleImageSource.acquire` also returns `sample` (the full createSample result). Extra exports:
`decodeArrayBuffer, decodeFile, loadElement, renderSample, isHeic, maxImageSide, undecodableMessage`.

**viewport** — snapping and double-tap rules as in §6.3 (same-surface vertex snap capped at 1% of the photo, no
axis snap on calibration geometry). A selected traced item shows "+" midpoint handles (insertVertex); pressing a
point sets `ui.activeVertex`. Extra members `canvas, getView, setView, zoomIn, zoomOut, isAnimating`; extra keys
+ / − / 0 and Delete; step 5 labels cord paths with their length. Module extras for tests: `selectionHandles,
snapCandidates` (entries carry `planes[]`), `layersFor, targetKey, midpointHandles, isDoubleTap, snapRadiusImg`.

**preview** — Bulb also has `a, run, s, dim`; the returned array carries `strands` and `imageId`; `drawBase` takes
width/height; `drawBulbs` takes `dpr` and `cache` (layer cache + 6 twinkle groups); `renderSnapshot` takes `imageId`.
Extra exports: `clearCaches, twinkleFactor, roundRectPath, BULB_RADIUS_IN, MAX_BUSH_BULBS, MIN_SPACING_PX`.

**export** — `saveFile` result set as in §6.5; only one save at a time; inside the viewer the blob fallback is never
tried. `initDownloads({timeoutMs=12000})` returns the cached promise. PdfDoc is richer than §6.5 (title/author
metadata, lineHeight/maxLines, `wrapText`, `setPage`, dashed lines, rounded rects; `text()` returns
`{lines, width, height}` and treats y as the top of the first line). Export functions reject with a plain Error
when there is nothing to export. Extra exports include `buildReportPdf, buildQuotePdf, parseJpeg` and formatting
helpers; `_resetDownloads` is for tests only.

**panels / app** — `mount()` returns `{render, destroy}`; extra exports `icon, h, morph, pickFile, exportFile,
stepWarnings, warningStep, STEPS, validateProducts, diffConfig, ICONS`. `warningStep` routes 'focal-mismatch' and
'exif-ignored' to step 1, where the Lens section offers "Use N px" (click action 'lens-use'). The safe-share field
reads 1–100 as a percent. `ui.app` loads viewport and export lazily and guarded (they are not `define()`
dependencies), exports `start, hintFor`, and adds the hint-bar surface picker (`#hint-plane`), the persistent
`#notice` and a short-landscape layout (side panel, compact bars).

### 7.3 Tests and verification at hand-off

- `node --test`: 304 unit tests, all passing (incl. `measure-honesty.test.js`, a seeded 250-house simulation: 98%
  of High results within ±3%, 99% of Medium within ±6%).
- `node tests/e2e/smoke.mjs` (after `node build.js`; Playwright Chromium): passes phone 41, desktop 41, dark 41,
  blocked-storage 4, inputs 11, measure 8, review 35, landscape 4 — 185 checks. `LP_SECTIONS=<regex>` with
  `--only=<pass>` runs a subset; screenshots go to `tests/e2e/out/` (gitignored).

---------------------------------------------------------------------------------------------

## 8. Phase 1.1 changes (owner feedback, Nov 2026)

Three changes requested after the first hands-on look. Where this section disagrees with §5.7 or §7, this section wins.

### 8.1 Cords run along the ground, then up (never across a wall face)

**Problem.** Home-run cords were routed "across the wall at outlet height, then up or down", so they were drawn (and
measured) straight across windows and doors.

**Rule.** A cord from an outlet goes **down to the ground, along the ground, then straight up** to where it plugs in.
No cord segment may cross the inside of a traced window or door on its wall.

Definitions (all in wall-plane feet unless noted):
- `groundV(wall)`: the wall's ground level. In order: (1) a ground plane derived from this wall → mean v of its base
  line; (2) the lowest of: the wall rectangle's bottom corners, every feature point on the wall, and each outlet on the
  wall minus `config.power.outletHeightFt` (default 1.5).
- **Openings** of a wall: the plane-space bounding box of every traced `window` and `door` feature on it, grown by
  `config.power.openingMarginFt` (default 0.5). A door's box extends down to `groundV`.
- **Riser**: the vertical segment that takes a cord from the ground up to height `v` at position `u`. If the riser at
  the target's own `u` would pass through an opening, move it sideways to the nearest clear `u` (prefer the side that
  makes the whole route shorter), then **hop** horizontally at the target's height to the target. A target that sits on
  an opening's outline (lights around a window) is reached by a riser beside that opening.

Routes (segments are summed, then `× routingFactor + slack`; slack = `cordSlackFt` for home runs, `jumperSlackFt`
(default 1.5) for jumpers):
- **Home run, target on a wall**: drop (outlet → ground) + ground (along the wall base to the riser; between two
  different walls, the 3D ground distance between the two foot points, or the scaled image distance when no pose) +
  rise + hop. A target within 1 ft of the ground needs no riser.
- **Home run, target on a roof plane**: as above up the parent wall to the eave point nearest the target, then up the
  slope (|Δb|, plus |Δa| along the eave if needed).
- **Home run, target on a ground plane** (walkway, stakes, trees and bushes traced on the ground): drop + straight
  along the ground to the target's base point.
- **Area and vertical items** (bush, tree, column) are fed at their **base** (lowest point), wherever they are traced.
- **Jumper** (run to run, §8.2): the shortest valid of
  (a) *direct*: straight, only when the two points are within `config.power.jumperDirectFt` (default 6) and, on one
      wall, the segment misses every opening (corner hops: eave → rake, eave → garage gutter);
  (b) *along the wall* (same wall): an L-shaped path, vertical-first or horizontal-first, that misses every opening;
  (c) *via the ground*: down (with riser rules), along the ground, up (with riser rules).
- No calibrated plane at either end: the old scaled-image fallback, flagged `cordUnknown` when there is no scale.

Outputs per feed (existing fields keep their meaning):
- `cordPath`: image-space polyline through every corner of the route (outlet → ground → along → up → hop → start), so
  the photo shows the cord on the ground and up beside openings. Straight plane segments need only their end points.
- `cord.kind`: `'home' | 'jumper'`; `cord.route`: `[{kind:'drop'|'ground'|'rise'|'hop'|'roof'|'wall'|'direct', lengthFt}]`;
  `cord.routeText`: plain words, e.g. `"down 1.5 ft, 18 ft along the ground, up 8.5 ft beside Window left"`.
- Crossings are tested on the real route: `crossesDoorway` when the ground segment passes a traced door's span on that
  wall; `crossesWalkway` when it crosses a walkway feature (image-space or near-wall test as before). Each crossing
  adds `config.power.crossingPenaltyFt` (default 12) to a candidate's cost when the planner compares options (never to
  the cord length bought).

### 8.2 Runs are linked with jumper cords (daisy chains), not one cord each

**Problem.** Every chain got its own extension cord back to an outlet (the sample: 12 cords and 6 power stakes on
2 outlets). Installers link nearby runs and bring only a few cords back to the outlets.

**Model.** Each outlet powers one or more **supply trees**. A feed is supplied either by a **home run** from an outlet
or by a **jumper** from an already-powered feed:
- from that feed's **end** (the last string's end plug): the jumper's load then passes *through* that feed's strings;
- from that feed's **start** junction (a 3-way tap where its own cord meets the lights): the load passes through its
  supply cord only.

Planner (deterministic, Prim-style): start with the outlets as sources; repeatedly take the cheapest feasible
`(unpowered feed, orientation, source)` by routed cord length (+ crossing penalties); ties prefer a jumper, then the
shorter cord, then ids. Stop when every feed is powered or nothing feasible remains (then `unassigned`, as before).
A jumper is only considered when `config.power.daisyChain` (default true) is on, the feed's features do not set
`params.ownCord: true`, and its routed length ≤ `config.power.jumperMaxFt` (default 30).

Feasibility of attaching feed `f` to a source:
- **Through-string limit**: for every ancestor whose strings the load passes through,
  `own watts + watts passing through ≤ maxConnectedW(product)`, where `maxConnectedW = product.maxConnectedW ??
  product.maxEndToEnd × product.wattsPerUnit`. Products with `endConnector === false` (default false only for
  `unit:'foot'`) cannot be a source at their end.
- **Cord limit**: every cord on the path back to the outlet carries its whole subtree and must stay within the plug
  limit (`plugAmps × voltage × continuous factor`).
- **Outlet and circuit limits**: as before, counting the whole tree on the root outlet.
- `params.outletId` forces a home run from that outlet; `params.reverse` still forces direction.

After the trees are built, every cord is sized for the watts it carries (its subtree) on the length bought. The
voltage drop of a feed is the **sum** over the cords on its path; above `maxVoltageDropPct` → `voltage-drop` warning.

Taps: a start junction with `k` jumpers needs `ceil(k / (tapOutlets − 1))` 3-way taps; an end with `k` jumpers needs
`k ≤ 1 ? 0 : ceil((k − 1) / (tapOutlets − 1))` (`config.power.tapOutlets`, default 3). Accessory `tap-3way`.
Power stakes at an outlet are counted from its **home-run** cords only.

Output additions (PowerPlan):
```
feeds[]:  source: {kind:'outlet', outletId} | {kind:'feed', feedId, port:'end'|'start'},
          parentFeedId|null, childFeedIds[], depth, supplyW /*carried by its supply cord*/, throughW /*passing through its strings*/,
          pathDropPct /*summed voltage drop*/; outletId/circuitId = the ROOT outlet of its tree (loads unchanged)
outlets[]: feedIds = every feed in its trees; directFeedIds = its home runs
groups[]: {id, outletId, rootFeedId, feedIds /*pre-order*/, watts, homeRunFt, jumperFt}
counts:   + taps, homeRuns, jumpers
warnings: + 'daisy-chain' (info: "11 runs are linked with 8 jumper cords; 4 cords go back to outlets"),
          'pass-through' (warn, only when a forced choice exceeds a string's limit)
runInfo[runId]: + sourceFeedId
```
BOM: jumpers are bought as the smallest standard outdoor cord that fits (same sizing as home runs) and `tap-3way`
lines are added. Checklist: per outlet, depth-first through each tree — home run (with `routeText`), clips, strings,
then "From the end of X, plug in a 6 ft jumper to Y…".

New config keys (`config.power`): `daisyChain: true, jumperMaxFt: 30, jumperDirectFt: 6, jumperSlackFt: 1.5,
outletHeightFt: 1.5, openingMarginFt: 0.5, crossingPenaltyFt: 12, tapOutlets: 3`.
New feature param: `params.ownCord: boolean` (default false) — "give this run its own cord from the outlet".

### 8.3 Suppliers (written after the supplier research; see below when present)
