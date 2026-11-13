# LightPlan

Measure a house from one photo, design a Christmas-light layout, and get a bill of materials, a power and circuit plan, a quote and an install checklist.

**Phase 1** (with the Phase 1.1 changes: ground-first cords, linked runs, suppliers, honest finger-tap confidence) is a single self-contained HTML file: [`dist/lightplan.html`](dist/lightplan.html). Open it in any modern browser (desktop or phone). It works offline; fonts load from Google Fonts when online and fall back to system fonts otherwise.

## How it works

1. **Upload** a photo of the house front (file, drag-and-drop, or the phone camera), or start from the built-in sample house. Step 2 opens by itself once the photo is in. One button pinned under the panel always says what to do next.
2. **Calibrate.** Tap the four corners of a rectangle on the wall (the wall itself, a garage door or the front door). LightPlan computes a perspective transform (homography) so measurements come out as if you stood straight in front of the wall. Add references of known size (door height, garage door width, siding or brick courses, any tape-measured length); when two references disagree, you get an accuracy warning. Add more surfaces for walls that are set back, a roof slope (for receding rakes, ridges and hips, corrected for pitch), and the ground (for walkways).
   - **The best rectangle sets the scale.** When a wall has more than one rectangle of known size (say a window and a garage door), LightPlan takes the scale from the one that gives the steadiest lengths and uses the others as checks. Nothing is re-tapped, and the wall's card says which one was used. A larger rectangle that does not agree with the wall's own (a garage on a set-back wing, a mistyped size) is left as a check, with the reason.
   - **Mansard roofs.** "Steep roof face (mansard)" adds the steep lower face: mark the line where it starts, then pick its angle (70° to start with) or type two tape numbers (how far it goes up, how far it goes back, or its sloped height). "Add the upper roof" marks the trim line where the steep face ends, so the top edge can be measured too. A picked angle is a guess, so lengths on that face are rated Low until it is measured.
3. **Trace** rooflines, rakes, gutters, ridges, windows, doors, columns, railings, walkways, bushes, trees and ground stakes. While a tool is in use the photo sits under the hint bar, and after each trace the bar offers what to trace next. Each measurement shows a High / Medium / Low confidence with the reasons, and any length can be replaced by a tape-measured value. On a mansard the surface follows where you trace: between the bottom line and the trim line is the steep face, above the trim line is the upper roof. An item on the wrong surface is flagged at once with the fix: a ridge drawn on a wall ("Put it on the roof" or "Type its length"), or an item drawn below the line where its roof starts.
4. **Design.** Say who you buy from: **Any store** (typical retail products, no part numbers), **Christmas Lights Etc** or **1000Bulbs**. An auto-plan picks a product for every run from that supplier's catalog, with its part number, a price "as of" the day it was checked and a link to its page. C7 and C9 can be bought the way installers buy them, as **cut-to-length socket wire, bulbs by the box and slide-on plugs**, or as ready-made strings. A run in a colour the supplier's ready-made item is not sold in keeps the any-store product, so no part number of another colour is ever ordered. The lights are drawn on the photo with a day/night toggle and twinkle.
5. **Power.** Place outlets and assign circuits. The step opens with a plain verdict ("Good to go: 146 W, 10% of one outlet's safe limit", or what to fix first).
   - **Cords run along the ground.** A cord goes from the outlet down to the ground, along the ground and straight up to where it plugs in, never across a wall face and never through a traced window or door (it goes up beside the opening, or between or over windows that nearly touch).
   - **Runs are linked.** Nearby runs are joined with short jumper cords and 3-way taps, so only a few cords go back to the outlets (the sample: 2 cords to outlets, 10 jumpers, 4 taps). Every string run, cord, outlet and circuit stays within its limit, and voltage drop is added up along each path. One switch turns linking off; each run has a "Give this run its own cord" switch.
   - Loads are kept at or below 80% of the breaker rating, and an outlet carries at most 1,440 W through its one timer and power stakes. Cords are sized by load on the length actually bought (15 A plug limit, 3% voltage drop). Warnings cover incandescent loads, overloaded circuits and outlets, a load above the supplier timer's rating, cords in front of doors or across walkways, long cords and missing GFCI protection.
6. **Review & export.** Rough measurements come first, each with a tape-measure field. Then the summary, the shopping list (supplier, part number, how fresh the price is, an editable unit price, a link), an **order sheet per supplier** to copy as text or save as CSV, the installer quote (labor, markup, takedown and storage fees; "charge only what is used" for installers who keep leftovers), the install checklist, and exports: PDF report, customer quote PDF, CSV shopping list, and a reloadable JSON project file.

### Phase 1.1 at a glance

- **Confidence that is honest about finger taps.** Every tapped point records how precisely it could be placed at the zoom it was tapped with. A point tapped zoomed out on a phone can be off by 15 photo pixels or more, so the rating drops and says "Tapped zoomed out: zoom in and re-tap".
- **Supplier prices are dated, not live.** Prices and part numbers were read from each supplier's own pages on the date shown. Nothing is fetched; the app never contacts a supplier. "Checked" means read on the item's own page; "check the price" means seen on a category list only, or a colour nobody read a price for. Type your account price over any line.
- **Cut-to-length C7/C9.** At most 250 ft of wire or 250 bulbs on one cord. The feet with waste are bought; the true length is cut, hung and lit. Wire is bought as the cheapest sensible mix of spools and ready-made lengths, and slide-on plugs are counted only for the ends that have none.

## Repository layout

```
dist/lightplan.html            the Phase 1 deliverable (standalone document)
dist/lightplan.artifact.html   same app as an Artifact fragment
src/core/                      pure calculation modules (no DOM): geometry, camera, exif, suppliers,
                               catalog, measure, design, power, bom, schema, plan, sample
                               (suppliers.js: the hand-checked supplier catalog, part numbers and links)
src/ui/                        browser modules: persist, store, imagesource, actions, preview,
                               viewport, export, panels, app
src/template.html, styles.css  markup and styles
schema/project.schema.json     JSON Schema for the portable project file
docs/                          spec, data model, assumptions, field test script, the supplier check
                               (what was read on the suppliers' pages and when), Phase 2 roadmap
tests/                         node:test unit tests and a Playwright smoke test (tests/e2e/)
```

## Build and test

Requires Node 18+ (no npm dependencies).

```sh
npm run build   # node build.js → dist/lightplan.html and dist/lightplan.artifact.html
npm test        # node --test → 517 unit tests (core modules, UI logic, suppliers, sample-house accuracy, confidence simulation)
npm run e2e     # build + node tests/e2e/smoke.mjs: Playwright/Chromium smoke test, 911 checks
```

The smoke test drives the built file through fourteen passes: phone (390 px), desktop, dark scheme, blocked storage, input validation, measurement callouts, the UI review findings, a landscape phone, the Phase 1.1 power and flow UI on a phone and on a desktop, the supplier UI on both, the Phase 1.1 review fixes (390, 360 and 1280 px), and a real project with a mansard roof (390 and 1280 px, with spot checks at 360 px). `node tests/e2e/smoke.mjs --only=phone` runs one pass; screenshots land in `tests/e2e/out/` (gitignored). `node tests/e2e/final-shots.mjs` writes screenshots of steps 4 to 6 of the sample for a last look. Playwright is not an npm dependency: install it yourself (`npm i -D playwright` and `npx playwright install chromium`) where it is not preinstalled.

## Documents

- [Assumptions](docs/ASSUMPTIONS.md)
- [Data model](docs/DATA_MODEL.md) and [JSON Schema](schema/project.schema.json)
- [Supplier check](docs/SUPPLIER_CHECK.md): what was read on the suppliers' pages, and when
- [Field test against a tape measure](docs/TEST_SCRIPT.md)
- [Phase 2 roadmap](docs/PHASE2_ROADMAP.md)
- [Internal build contract](docs/SPEC.md)

## Accuracy notes

- Lengths on a wall with a perspective rectangle are exact up to tap precision. On the sample house, whose taps are exact projections of a 3D model, lines match the ground truth within 0.4% (bushes traced on the wall come out 6–11% wide, and are flagged). The sample's front wall is calibrated the way an installer would do it (wall length and height taped at the foundation, door and window references as cross-checks, roof pitch entered), so its wall items rate High or Medium while roof, ground, tree and bush items rate Low: ratings assume a person's taps, not exact ones (see below).
- Confidence is honest about tap precision: every calibration tap and every traced point is taken to be off by at least 2.5 px, and by more when it was tapped zoomed out (the app records the precision of each tap from the zoom at that moment). The resulting expected error decides the level (High within ±3%, Medium within ±6%; checked by a seeded simulation of random houses, including finger taps at fit zoom, in `tests/measure-honesty.test.js`). High needs a large known-size rectangle, zoomed taps and a cross-check.
- Roof-slope and ground-plane lengths use the camera pose recovered from the wall rectangle and the focal length (from EXIF, the rectangle, or a phone-camera preset). They are very sensitive to tap error and are usually rated Low; a tape-measured reference on the ground plane re-fits it, and roof items need the pitch entered. A lens setting that disagrees with the photo's rectangles is flagged.
- Trees, posts and bushes traced on a wall stand in front of it, so their sizes come out too large and are flagged; on a ground plane they are measured in 3D.
- A ridge traced on a wall comes out too short (it sits behind the wall) and is rated Low with the fix offered. Moving it to a roof is checked: a result much longer than on the wall, or on a roof seen almost edge-on, is reported as wrong or rough, never as done.
- Steep roof faces (mansard) are measured in their own plane. With the slope tape-measured and a large rectangle on the wall, simulated houses give High within ±3% and Medium within ±6% on the steep face (`tests/measure-mansard.test.js`). With a guessed angle everything on the face is Low. The upper roof is seen almost edge-on from the street, so its lengths are rough: tape-measure the ones that matter.
- When a second, larger rectangle sets a wall's scale, the wall's own rectangle checks it. If the two are 3% or more apart the wall is Medium at best, and Low at 6% or more.
- The power plan is a planning estimate, not an electrical inspection.
