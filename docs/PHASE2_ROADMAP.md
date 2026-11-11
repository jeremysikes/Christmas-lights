# LightPlan Phase 2 — Technical Roadmap

Phase 1 is a single HTML file. Phase 2 turns it into a commercial web and mobile product. This is a plan, not a build.

Revised November 2026 after a fact-check against primary sources and a hands-on usability review. Section 11 lists what was checked and what could not be.

## 1. What changed in this revision

| Topic | Before | Now |
|---|---|---|
| Google Solar API | "Could prefill roof pitch and roof geometry" | **Not usable.** Google's terms allow it only for energy-system work, and it returns roof-plane pitch and area, not edge lengths. |
| Street View | "Terms restrict this" | **Prohibited**, stated exactly: no storing, no tracing, no ML training on Google content. Phase 1's "Street View screenshot" preset was renamed. |
| AR capture | Default measurement path | An optional close-range scale check, promoted only if a field trial shows it beats door and garage references. |
| Pricing sources | Amazon and big-box first | The installer's own suppliers first (Christmas Lights Etc and 1000Bulbs). Amazon's Product Advertising API was retired in 2026; its successor is the Creators API. |
| Product model | Pre-lamped strings only | Adds bulk C7/C9: socket wire by the spool, bulbs by the box, slide-on plugs (shipped in Phase 1.1). |
| Payments | Stripe Billing + Checkout, deposits | Deposits on installer quotes need Stripe Connect; scheduled after the first paid season. |
| Business model | Three options, none chosen | Installer-first. |
| Missing | — | Build order with exit tests, measurement validation plan with targets, supplier track, competitor scan. |

## 2. Build order and gates

Each step has an exit test. Nothing later is funded until the test passes.

1. **Now to December 2026 — Phase 1.1 (no backend).** Ground-first cords and linked runs, supplier catalogs with order sheets, bulk C7/C9, tap-precision confidence, and field data from this season's installs. *Exit:* the materials list matches a real supplier order on three jobs.
2. **January to April 2027 — hosted installer web app.** Accounts and companies, cloud projects and photos, a quote link the customer can accept, branded PDF, a company product library with the installer's account prices, Stripe Billing for LightPlan's own subscription. Web before native: it removes the artifact viewer's limits (live camera, links, printing) and reuses the Phase 1 interface. *Exit:* five installers send real quotes.
3. **May to August 2027 — supplier integration stages 1–2 and assisted tracing** (automatic rectification, reference detection, confirm instead of draw), ready for the selling season. *Exit:* price dates refresh without manual edits; tracing time halves.
4. **After the 2027 season.** Deposits through Stripe Connect, scheduling, takedown, storage and renewals. Decide on a native AR app and a roof-report add-on from the validation data. Homeowner plan and retail links last. *Exit:* validation targets (section 7) met before any native app spend.

This install season and the January takedown are the only chance until late 2027 to record real installed quantities. Start collecting now (section 7).

## 3. Go-to-market: installer first

- **Core job.** Quote in minutes from a photo the customer sends, pull an accurate materials list with the supplier's part numbers, hand the crew an install sheet.
- **Quote model.** Per-foot installed pricing with minimums, good/better/best options, leased or customer-owned product.
- **Seasonal rhythm.** Sell late summer to November, install October to early December, take down in January, renew in summer.
- **Pricing hypothesis.** An annual per-company plan billed before the season, with seat add-ons. One competitor is reported at about $497 a year, or free with a 2% fee on payments (vendor-reported; confirm).
- **First customers.** Ten design partners from the owner's network; channels through supplier contractor programs and installer training groups.
- **Homeowners.** A free version as a lead source that hands the plan to a local installer or a supplier order sheet.
- **Success measures.** Quotes sent, close rate, materials list versus actual, minutes per quote.

These are planning assumptions. Interview five installers before fixing the price.

## 4. Supplier integration

No supplier checked (Christmas Lights Etc, 1000Bulbs, Christmas Designers, Novelty Lights and others) shows a public API, product feed, CSV quick order or cart link. Integration therefore starts as a supplier map inside the app and grows as suppliers agree to share data.

| Stage | What | Needs |
|---|---|---|
| 0 (Phase 1.1, shipped) | Hand-checked catalog per supplier: part number, link, pack size, price with an "as of" date. "Buy from" picker, order sheet per supplier, the installer's own price per line. | Nothing. |
| 1 | Tables for suppliers, supplier products, dated price observations and each company's account tier. Sources in order of preference: a feed or price file the supplier shares, the installer's account price-list upload, manual entry. | Hosted app; supplier agreement. No scraping or logged-in automation without written permission. |
| 2 | Cart hand-off: product link always; multi-item cart link or quick-order upload only where the supplier's site supports it; emailed purchase order as the fallback. | Per-supplier test. Stores on Shopify-style URLs (Lights for Christmas, Christmas Light Source) may accept cart links; untested. |
| 3 | "Your price" versus list, and margin in the quote. Supplier logins are never stored. | Account price list. |
| 4 | Order export and reconciliation: PO number, ordered versus received, substitutions, reorder from last year's project. | Stage 1. |

**Questions to put to each supplier:** product feed or price file for wholesale accounts; CSV or quick-order upload; cart link format; affiliate or referral program and network; permission to show their prices and images in a third-party app; minimum-advertised-price rules; drop-ship to a job site.

**Wholesale sourcing.** Christmas Lights Etc is the retail site of Wintergreen Corporation, which runs an application-based wholesale program with pricing tiers and in May 2025 acquired Lights for Christmas. The cheapest change for an installer already buying there is a Wintergreen wholesale account, compared against Christmas Designers' published quantity tiers and Novelty Lights' partner discount. Wholesale price lists are gated everywhere, so "your price" entry (stage 3) matters more than list prices.

**Bulk materials model.** Wholesale C7/C9 is bought as socket wire, bulbs and plugs and cut to length. Phase 1.1 models this (`kind: 'bulk'`): wire rounded to spools with leftover reported, bulbs per colour in boxes of 25, two plugs per cut length, and a limit of 250 ft or 250 bulbs per feed. Phase 2 adds price breaks, a cut list per run, jumpers made from blank zip cord, and leftover stock carried between jobs.

## 5. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Shared logic | `src/core/*` becomes `@lightplan/core` (TypeScript ES modules, same signatures) | Every calculation is already a pure function with no DOM access. The same package runs in the browser, React Native and on the server. |
| Web app | Next.js (React, TypeScript) | Server rendering for quote pages customers open from a link; route handlers for the API. |
| Mobile app | React Native with Expo, after the web app | Shares the core package. AR needs native development builds (it does not run in Expo Go). |
| API | Next.js route handlers or a Fastify service | Recomputes plans server-side with the same core package, so the server never trusts client math. |
| Database | Postgres (Neon or Supabase) | Tables per `docs/DATA_MODEL.md` section 7, plus `organizations`, `customers`, `quotes`, `suppliers`, `supplier_products`, `price_observations`. Full project JSON also kept in a versioned `jsonb` column. |
| Photo storage | S3 or Cloudflare R2, signed URLs | Original photo plus the working copy; lifecycle rules for retention. Record the image source on every photo. |
| Auth | Clerk, Auth0 or Supabase Auth | Installer companies with crew roles; consumer accounts later. |
| Payments | Stripe Billing and Checkout for LightPlan's own subscriptions and seats | Deposits on installer quotes are the installer's money: that is Stripe Connect (onboarding, payouts, disputes), scheduled later. Until then the quote links to the installer's own payment link. |
| Jobs | A queue (Inngest, Cloud Tasks) | Vision inference, PDF rendering, re-install reminders. |
| PDF | Keep the in-browser writer for offline use; render branded PDFs server-side from HTML. | |

The project JSON (`schema/project.schema.json`) is the API payload. The `ImageSource` interface is the plug-in point for new imagery. The sample house and its ground truth become golden tests.

## 6. Address lookup and imagery: licensing comes first

"Type an address and measure from Street View" is the obvious idea and the one to avoid.

- **Google Street View and Maps imagery: prohibited for this use.** The Maps Platform terms (section 3.2.3) bar storing or caching Street View images (only the panorama ID may be kept), bar creating content from Google Maps content (the EEA terms name tracing building outlines from Street View), and bar using Google content to train, test or validate ML models. Phase 1.1 removed the "Street View screenshot" wording. A user's own screenshot falls under Google's consumer terms, which is a question for counsel. At least one competitor advertises mockups on Street View images; that is their risk, not a precedent.
- **Google Solar API: not available.** Service terms 20.1 limit it to assessing, designing or installing energy systems. It returns pitch, azimuth and area per roof plane, not eave or rake lengths, and cached data must be deleted after 30 days.
- **Google Aerial View API: not planned.** Pre-rendered flyover video of a US address; asynchronous, billable, and it cannot show the lighting design. The Phase 1 preview on the customer's own photo already does this job.
- **Geocoding.** Store the address the user typed as LightPlan's own data. If Google geocoding is used, keep only the place ID long term, respect the 30-day limit on coordinates, and never pair results with a non-Google map. Otherwise pick a geocoder whose licence allows permanent storage.
- **Roof-measurement reports (later add-on).** EagleView's sample reports list total ridge, hip, valley, rake and eave lengths, which map to LightPlan's feature types. Reports cover roof edges only: windows, doors, columns, bushes, walkways and outlets still come from the photo. Before planning, ask each provider (EagleView, GAF QuickMeasure, Roofr) for a sample file, per-report price, API access, turnaround, and whether measurements may be stored and reused in a third-party app. Hover is not aerial: it builds a 3D model from phone photos and is a candidate for multi-photo capture. Nearmap supplies imagery and building attributes, not edge lengths.
- **Recommendation.** User-captured photos stay the default. Roof reports are a paid installer add-on once terms are confirmed. A lawyer reviews Google's and any provider's terms before launch.

## 7. Measurement: validate first, then automate

**The Phase 1 risk found in review.** On a phone at fit zoom, finger taps on a small rectangle produced lengths 10–30% off, sometimes rated Medium. Phase 1.1 records how precisely each point was tapped and lowers the rating accordingly. Still to do before homeowners use it unassisted: a two-tap scale for straight-on photos, a drag-to-place loupe with automatic zoom, and a box tool for windows.

**Validation plan.**
- *Targets (proposed; owner to set):* in-plane eave and gutter runs within 2% median and 5% at the 90th percentile; roof-slope and ground items within 10% at the 90th percentile; footage per run off by at most one string or one 25-bulb box in 90% of runs.
- *Dataset:* at least 30 houses, two photos each, three or more phone models including one Android; one and two storeys; straight and angled shots; the zoom used for taps recorded.
- *Ground truth:* laser meter or tape for reachable items; for rooflines, the footage actually installed. Capture takedown counts in January.
- *Confidence calibration:* the share of High items that land inside the stated band.
- *Replay harness:* saved taps re-run through the core package in CI, failing on regression.
- *Method comparison on the same houses:* single photo, two photos, AR walk-up reference, roof report.
- *Consent* to keep the photos. No Google-sourced images in any training or test set.

"Quote without a site visit" becomes a product claim only after the 90th-percentile target is met.

**AR as an optional scale check, not the default.** ARKit depth and meshing need a LiDAR device, plane detection needs visual texture, and both are weakest on a wall across the street. Test AR as a close-range measurement of one reference (garage door width, a wall segment) that feeds the existing reference slot. Run a ten-house trial before funding a native app. A server-side monocular depth model can be tested as a cross-check in the same trial.

**Assisted tracing ("confirm, do not draw").**
1. *Rectify automatically.* Line segments (LSD, or a learned detector such as DeepLSD, MIT) and vanishing points with RANSAC propose the wall plane without taps.
2. *Detect references.* A permissively licensed detector (for example RF-DETR, Apache 2.0) or a text-prompted segmenter (SAM 3) proposes doors, garage doors and windows with their standard sizes. Check every model's licence: Ultralytics YOLO is AGPL or paid.
3. *Propose features.* Wireframe parsing (HAWP, LETR) plus segmentation proposes eaves, rakes, gutters and window outlines. Segmentation gives masks, not typed lines; turning mask edges into eaves and rakes is geometry work to budget.
4. *Confirm.* Proposals appear as dashed lines; one tap accepts, a drag adjusts. Accepted lines become training data only for user-captured photos, with consent.
5. *Where it runs.* Server-side on GPU first; on device later (Core ML, LiteRT, formerly TensorFlow Lite).

## 8. Product data and pricing sources

- **Primary:** the suppliers the installer buys from, through section 4.
- **Secondary, homeowner plan only:** Amazon's Creators API (the Product Advertising API 5.0 was deprecated in spring 2026; credentials and auth changed) and big-box affiliate programs (terms to be confirmed).
- Watts, amp ratings and maximum connected lengths come from the supplier's listing and are marked verified with a date. A product with no listed watts is not offered.
- Every price shows "as of" and whether it was confirmed on the supplier's page.
- Affiliate or referral commissions are disclosed beside every buy link and on the materials list and PDF. Counsel confirms the wording against current FTC guidance.

## 9. Competitors (first scan; vendor-reported, to be verified)

| Product | What it is reported to do | Gap LightPlan fills |
|---|---|---|
| LightQuoter | Quoting, mockups and invoicing for holiday and permanent lighting; mockups on Street View images; per-foot pricing; scheduling; online payment. | No measured footage from a photo, no supplier part numbers, no power plan. Street View mockups carry licensing risk. |
| QuoteIQ | Field-service CRM with a satellite roofline measuring tool and same-day estimates. | Roof edges only, from above; no windows, landscape, materials list or power plan. |
| Strandr, Jolly Lights Professional, Bright Home Designer, Holiday Lights Pro | Photo mockups for selling; some add quotes and client management. | They sell the look; footage is typed or scaled by eye. |
| CLIPA estimating app | Prices an installation in sections. | Estimating from typed footage. |
| Supplier calculators | Per-product counts. | Not tied to a measured plan. |

Hypothesis to test with installers: none of these goes from one photo to measured footage, a materials list with supplier part numbers, and a power plan. Decide per competitor whether LightPlan integrates (export a quote into a CRM) or competes. Record price, platform and feature evidence for each from its own site before relying on this table.

## 10. Business model

- **Installer plan (first).** Annual per-company subscription with seats: branded quotes, quote links with acceptance, crew install sheets, customer list, takedown and storage tracking, yearly re-install reminders that reopen last year's project.
- **Homeowner (later).** Free planning with a per-project unlock for the PDF and order sheet, or a seasonal pass.
- **Supplier referrals.** Only with disclosure, and only where the supplier has a program.

## 11. Top risks

| Risk | What could go wrong | Mitigation |
|---|---|---|
| **Measurement accuracy** | A wrong reference size, an off-plane feature or a zoomed-out finger tap gives a confident-looking wrong number; a short order costs a second trip, an installer underquotes. | Per-measurement confidence with reasons, now including tap precision; low-confidence items listed on Review; 10% waste; the validation plan in section 7; quotes say "final measurements verified on site". |
| **Imagery licensing** | Deriving measurements from Street View or other licensed imagery breaches terms; takedown or account loss after launch. | User-captured photos only by default; image source recorded; licensed providers under contract; legal review; upload terms grant LightPlan a licence to process the photo. |
| **Electrical advice** | A user overloads a circuit or a wire because the plan said it was fine. | Conservative rules (80% continuous load, per-product connected-load limits, 250 ft / 250 bulbs per bulk feed, GFCI warnings, voltage-drop limits); plug-in products only; the planning-estimate notice on screen and in every PDF; terms of service; insurance; a licensed electrician for any new circuit. |
| Supplier data | A stale price, a changed part number or a wrong pack size puts a wrong line on an order sheet. | Dated prices with status; links to the supplier page on every line; installer's own price per line; supplier-shared feeds in stage 1. |
| Product data | Real strings draw different watts or allow fewer connections than the catalog says. | Editable library; specs taken from supplier listings with a date; prompt to check the box label. |
| Privacy | Photos of homes plus addresses are sensitive. | Encrypt at rest, signed URLs, retention policy, delete-my-data, no public project pages unless shared by link. |

## 12. What was checked, and what was not

**Checked against primary sources (November 2026):** Google Maps Platform terms and service-specific terms (Street View, Solar, Aerial View, Geocoding); Apple's ARKit documentation; licences of DeepLSD, HAWP, LETR, RF-DETR, Ultralytics, SAM 2 and SAM 3; Stripe's API specification; Amazon's notice that the Product Advertising API is deprecated in favour of the Creators API; EagleView sample reports; Wintergreen's and Lights for Christmas's own announcements.

**Not verified:** Google Solar and Aerial View pricing; ARCore accuracy guidance; GAF QuickMeasure, Roofr, Vexcel and Hover terms and prices; Home Depot and Lowe's affiliate programs; FTC wording; Stripe Connect fees; every competitor's own site (the table in section 9 rests on directory listings and one vendor's comparison article); wholesale price lists, which are gated.
