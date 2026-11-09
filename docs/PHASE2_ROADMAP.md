# LightPlan Phase 2 — Technical Roadmap

Phase 1 is a single HTML file. Phase 2 turns it into a commercial web and mobile product. This section is a plan, not a build.

## 1. What carries over unchanged

- **`src/core/*` becomes `@lightplan/core`.** Every calculation (homography, camera pose, measurement, confidence, auto-plan, power plan, BOM, quote, checklist) is already a pure function with no DOM access. Convert the `LP.define` wrappers to TypeScript ES modules with the same signatures; type them from the shipped behaviour, which `docs/SPEC.md` §7 (Implementation notes) lists where it differs from the original contract. The same package runs in the browser, in React Native (Hermes), and on the server.
- **The project JSON** (`schema/project.schema.json`, `docs/DATA_MODEL.md`) is the API payload and the database shape. Derived results are always recomputed from the persisted inputs, so the server never trusts client math.
- **The `ImageSource` interface** (`src/ui/imagesource.js`) is the plug-in point for new imagery: phone camera with AR scale, licensed aerial reports, or address lookup.
- **The sample house** and its ground truth become golden tests, joined by a field dataset of tape-measured houses (see `TEST_SCRIPT.md`).

## 2. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Web app | Next.js (React, TypeScript) | Server rendering for quote pages customers open from a link; route handlers for the API. |
| Mobile app | React Native with Expo | Shares `@lightplan/core` and most UI logic; native modules for ARKit/ARCore capture. |
| API | Next.js route handlers or a separate Fastify service | Recomputes plans server-side with the same core package; issues signed quote links. |
| Database | Postgres (Neon or Supabase) | Tables mirror the schema: `projects`, `images`, `planes`, `features`, `outlets`, `circuits`, `quotes`, plus `organizations` and `customers` for installers. Store the full project JSON in a `jsonb` column too, versioned. |
| Photo storage | S3 or Cloudflare R2, signed URLs | Original photo plus the downscaled working copy; lifecycle rules for retention. |
| Auth | Clerk, Auth0 or Supabase Auth | Consumer accounts plus installer organizations with crew roles. |
| Payments | Stripe Billing + Checkout | Subscriptions, per-project unlocks, installer seats; deposits on accepted quotes. |
| Jobs | A queue (e.g. Inngest, Cloud Tasks) | Vision inference, PDF rendering, re-install reminders. |
| PDF | Keep the in-browser writer for offline use; render branded installer PDFs server-side from HTML. | |

## 3. Address lookup and imagery — licensing comes first

The obvious idea, "type an address and measure from Street View", is the riskiest one.

- **Google Maps Platform terms restrict this use.** They limit caching and storing Street View imagery and prohibit creating content derived from Google Maps content, which is what tracing and measuring rooflines would do. Saving traced lines and lengths from a Street View frame likely counts as derived data.
- **Options to evaluate instead:**
  - **Google Solar API.** Returns roof segments per building with pitch, azimuth and area, and digital surface model layers. This could prefill roof pitch and roof segment geometry. Check its own terms on permitted use and caching.
  - **Google Aerial View API.** 3D flyover videos of an address. Useful for a customer-facing preview, not for measurement.
  - **Licensed aerial measurement providers** (EagleView, Nearmap, Vexcel, Hover, GAF QuickMeasure and similar). Roof reports already list eave, rake, ridge, hip and valley lengths, which map directly to LightPlan feature types. Per-report fees suit the installer plan.
  - **Phone photos with AR measurement as the primary source.** ARKit (with LiDAR on Pro iPhones) and ARCore depth and plane detection give metric scale without a reference object. The user owns the photo, so there is no imagery license to clear. Multi-photo capture can feed photogrammetry for a full facade model.
- **Recommendation.** Make phone capture with AR scale the default measurement path, offer licensed roof reports as a paid add-on for installers, and use a geocoder only to look up the address, never to supply measurement imagery.
- **A lawyer should review the Google Maps Platform, Solar API and any provider terms before launch.**

## 4. Automatic roofline and edge detection

Goal: users confirm lines instead of drawing them.

1. **Rectify automatically.** Detect line segments (LSD or a learned detector such as DeepLSD) and estimate vanishing points with RANSAC. This proposes the wall plane and its perspective rectangle without taps.
2. **Detect references.** An object detector (YOLO-class model) for entry doors, garage doors and windows proposes calibration references with their standard sizes. Two or more detected references give the cross-check the confidence score already uses.
3. **Propose features.** A wireframe-parsing model (HAWP, LETR-style) plus facade segmentation (SAM 2 fine-tuned on house photos) proposes eaves, rakes, gutters, ridges and window outlines, each tagged with a type and a model confidence.
4. **Confirm, do not draw.** The trace step shows proposals as dashed lines; one tap accepts, a drag adjusts. Accepted and corrected lines, with user consent, become training data.
5. **Where it runs.** Start server-side on GPU; move the detector to the device (Core ML, TensorFlow Lite) for offline use and privacy.

## 5. Live product pricing and affiliate links

- Retailer and affiliate feeds: Amazon Product Advertising API, Home Depot and Lowe's through their affiliate networks, and wholesale catalogs for installers (for example Wintergreen, Christmas Designers, Minleon).
- Normalize product data into the existing product schema (bulb spacing, string length, watts, max end to end). Watts and max end-to-end come from spec sheets and must be verified, not guessed.
- Cache prices with timestamps and show "price as of" on the BOM. Disclose affiliate relationships (FTC rules).

## 6. Business models

- **Consumer subscription.** A seasonal pass that unlocks saved projects, PDF export and re-planning year to year.
- **Per-project fee.** Pay once to unlock the BOM, power plan and PDF for one house.
- **Installer (B2B) plan.** Per-seat pricing with branded quotes, signed quote links with e-acceptance and deposits, crew install sheets (the checklist, per crew), a customer list, takedown and storage tracking, and yearly re-install reminders that reopen last year's project with the same measurements.

## 7. Top risks and how to reduce them

| Risk | What could go wrong | Mitigation |
|---|---|---|
| **Measurement accuracy** | A wrong reference size or an off-plane feature produces a confident-looking wrong number; a short order costs a second store trip, an installer underquotes. | Keep per-measurement confidence and reasons (Phase 1 already caps the level by the expected error from tap precision and by bias it cannot see: a single unchecked reference, an assumed lens or roof pitch, items standing in front of a wall); show reference disagreement; keep the 10% waste default; add AR scale and automatic reference detection; build a field dataset with tape-measured ground truth and track error by feature type; installer quotes say "final measurements verified on site". |
| **Imagery licensing** | Deriving measurements from Street View or other licensed imagery breaches terms; takedown or account loss after launch. | Default to user-captured photos; use licensed measurement providers under contract; never store third-party imagery beyond what the license allows; legal review before launch; user upload terms grant LightPlan a license to process the photo. |
| **Liability for electrical advice** | A user overloads a circuit or uses a non-GFCI outlet because the plan said it was fine. | Conservative rules (80% continuous load, GFCI warnings, voltage-drop limits); plug-in products only, no wiring guidance; the "planning estimate, not an electrical inspection" notice on screen and in every PDF; terms of service with limitation of liability; professional liability insurance; recommend a licensed electrician for any new circuit or outlet. |
| Product data | Real strings draw different watts or allow fewer strings end to end than the defaults. | Editable library; prompt users to check the box label; prefer retailer spec-sheet data in Phase 2. |
| Privacy | Photos of homes plus addresses are sensitive. | Encrypt at rest, signed URLs, a retention policy, delete-my-data, no public project pages unless shared by link. |
