# LightPlan

Measure a house from one photo, design a Christmas-light layout, and get a bill of materials, a power and circuit plan, a quote and an install checklist.

**Phase 1** is a single self-contained HTML file: [`dist/lightplan.html`](dist/lightplan.html). Open it in any modern browser (desktop or phone). It works offline; fonts load from Google Fonts when online and fall back to system fonts otherwise.

## How it works

1. **Upload** a photo of the house front (file, drag-and-drop, or the phone camera), or start from the built-in sample house.
2. **Calibrate.** Tap the four corners of a rectangle on the wall (a garage door, the front door, or the wall itself). LightPlan computes a perspective transform (homography) so measurements come out as if you stood straight in front of the wall. Add references of known size (door height, garage door, siding or brick courses, any tape-measured length); when two references disagree, you get an accuracy warning, and every measurement's confidence reflects how far tap error could move it. Add more planes for walls that are set back, a roof slope (for receding rakes, ridges and hips, corrected for pitch), and the ground (for walkways).
3. **Trace** rooflines, rakes, gutters, ridges, windows, doors, columns, railings, walkways, bushes, trees and ground stakes. Each measurement shows a High / Medium / Low confidence with the reasons, and any length can be overridden with a tape-measured value.
4. **Design.** An auto-plan picks a product for every run, counts strings, clips and stakes, and renders glowing bulbs on the photo with a day/night toggle and twinkle.
5. **Power.** Place outlets and assign circuits. Runs are chained end to end within each product's limit, fed from the nearest outlet with capacity, and kept at or below 80% of the breaker rating. Cords are sized by load and length. Warnings cover incandescent loads, overloaded circuits, cords across walkways and missing GFCI protection.
6. **Review & export.** Summary, editable BOM, installer quote (labor, markup, takedown and storage fees), install checklist, and exports: PDF report, customer quote PDF, CSV BOM, and a reloadable JSON project file.

## Repository layout

```
dist/lightplan.html            the Phase 1 deliverable (standalone document)
dist/lightplan.artifact.html   same app as an Artifact fragment
src/core/                      pure calculation modules (no DOM): geometry, camera, exif, measure,
                               catalog, design, power, bom, schema, plan, sample
src/ui/                        browser modules: persist, store, imagesource, actions, preview,
                               viewport, export, panels, app
src/template.html, styles.css  markup and styles
schema/project.schema.json     JSON Schema for the portable project file
docs/                          spec, data model, assumptions, field test script, Phase 2 roadmap
tests/                         node:test unit tests and a Playwright smoke test
```

## Build and test

Requires Node 18+ (no npm dependencies).

```sh
npm run build   # node build.js → dist/lightplan.html and dist/lightplan.artifact.html
npm test        # node --test → unit tests for every core module, incl. sample-house accuracy
npm run e2e     # build + Playwright smoke test in Chromium (mobile and desktop)
```

## Documents

- [Assumptions](docs/ASSUMPTIONS.md)
- [Data model](docs/DATA_MODEL.md) and [JSON Schema](schema/project.schema.json)
- [Field test against a tape measure](docs/TEST_SCRIPT.md)
- [Phase 2 roadmap](docs/PHASE2_ROADMAP.md)
- [Internal build contract](docs/SPEC.md)

## Accuracy notes

- Lengths on a wall with a perspective rectangle are exact up to tap precision; on the sample house they match the 3D ground truth within 1%.
- Confidence is honest about tap precision: every calibration tap and every traced point is assumed to be off by about 2.5 px, and the resulting expected error decides the level (High within ±3%, Medium within ±6%; checked by a seeded simulation of random houses in `tests/measure-honesty.test.js`). High needs a large known-size rectangle, zoomed taps and a cross-check.
- Roof-slope and ground-plane lengths use the camera pose recovered from the wall rectangle and the focal length (from EXIF, the rectangle, or a phone-camera preset). They are very sensitive to tap error and are usually rated Low; a tape-measured reference on the ground plane re-fits it, and roof items need the pitch entered. A lens setting that disagrees with the photo's rectangles is flagged.
- Trees, posts and bushes traced on a wall stand in front of it, so their sizes come out too large and are flagged; on a ground plane they are measured in 3D.
- The power plan is a planning estimate, not an electrical inspection.
