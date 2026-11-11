# Live check of the LightPlan supplier catalog - 2026-11-11

Everything below was read from the suppliers' own pages in this session (each page was fetched once and parsed from the saved copy). Prices are a snapshot of 2026-11-11.

## Result in one paragraph

All 84 product URLs were checked: 42 verified unchanged, 38 corrected, 4 no longer orderable, 0 left unverified. All 48 category URLs load (HTTP 200); one is mapped to the wrong thing (CLE "plugs"). The CLE search URL works. Three things were blocked and are NOT verified: the 1000Bulbs search URL (403 challenge, after which I stopped fetching 1000bulbs.com), 1000Bulbs' account/shipping pages, and all Lights for Christmas prices (429 on the third request).

## Counts by status

| Supplier | verified | corrected | gone | mismatch | unverified |
|---|---|---|---|---|---|
| Christmas Lights Etc (42) | 19 | 20 | 3 | 0 | 0 |
| 1000Bulbs (42) | 23 | 18 | 1 | 0 | 0 |

Added for step 5: 14 CLE items (all from product pages) and 14 1000Bulbs items (category-listing evidence only, status `listing`).

## The 11 doubts

1. **Resolved.** CLE C7 item numbers. Page 13593 (C7 warm white) shows Item Number 72609; page 13594 (C7 cool white) shows 72606. Catalog 87773 for warm white was wrong; 72606 for cool white was right. (The "+3" guess had the two swapped.)
2. **Resolved.** CLE C9 contractor pack. One box of 500 is $511.00 ($1.022 per bulb): that is the buy-box price and the structured-data price. The tier table rows are "0 - 1 boxes $547.50", "1 - 2 boxes $511.00", "2+ boxes $474.50"; each range stops just short of its upper number (as with "20 - 40" then "40+" on other pages), so one box is the $511.00 row and the $547.50 row never applies to a whole box. Two or more boxes: $474.50 each. Not tested in a cart.
3. **Resolved.** CLE zip plugs. Packs are 5, not 1: page names say 5-Pack, spec table says "Qty per Pack: 5", buy box quantity-per-box is 5, $6.20 per pack. The "1-Pack" in the URL slug is stale. Separately, the green SPT1 5-packs (67083, 67081) are no longer purchasable; green SPT1 plugs are now 10-packs (88283 male, 88287 female) at $12.40.
4. **Resolved.** CLE SKUs equal to the URL page id. All nine are the real Item Numbers: 15085, 15083, 18630, 15054, 15052, 15098, 15100 are shown as "Item Number" on their pages; 17441 and 17443 are the Item Numbers in the option table of the current wire page. (On newer products the item number differs from the page id, e.g. 500 ft C9 SPT1W spool page 61557 = item 81832.)
5. **Resolved.** CLE 5mm contractor pack is now $431.76 per case of 24 = $17.99 per set, below the single retail set at $19.99. 8+ cases: $343.07 per case ($14.29 per set).
6. **Resolved.** 1000Bulbs CMS-10108 (SPT-2 spool) is $451.44 on its product page and in the category listing; $340.43 was wrong. SPT-1 twin CMS-10105 is $391.13.
7. **Resolved.** 1000Bulbs price variance. Every catalog product page was fetched; today's page prices are in the file (e.g. CMS-10095 $481.47, CMS-50WW6B $354.27 per case of 24). Product pages and category listings agreed wherever both were seen. Prices are a snapshot of 2026-11-11; pages carry a cache timestamp and no quantity tiers.
8. **Resolved.** 1000Bulbs CMS-10284. Product page is /product/225399/CMS-10284.html: $19.72 per pack of 25, Wattage 0.54 Watt (the page really says 0.54; siblings say 0.48). It is marked "temporarily unavailable - please call".
9. **Resolved.** 1000Bulbs net CMS-100L5MMNETWWG: the page states 9.6 W and Max. Connections 25 sets (240 W). The supplier publishes that figure; capping at 22 sets (216 W) stays a modelling decision. Stringers CMS-10126 and CMS-10119: the pages state Maximum Wattage 1800 Watt on 20 AWG wire. Confirmed as published, and confirmed unsuitable as a load limit.
10. **Resolved.** 1000Bulbs doubtful entries. SHL-LED70ICEWW: live, in stock, $21.72. TRUNK8CLRG: the order SKU is HLS-TRUNK8CLRG (TRUNK8CLRG is the MPN), $16.10, incandescent 60 W, max 3 sets. CMS-WIRE1000GR2: "Not for Sale. Reference Only." - drop it. PLUG-10002: in stock, $6.73 per 10.
11. **Partly resolved.** Missing watts. CLE trunk wrap 72526: 6.86 W, 0.06 A, max 31 sets (now on the page). 1000Bulbs CMS-10286 and CMS-10279: 0.48 W per bulb. CLE photocell 85135: still no amp or watt rating on the page - unresolved.

## Every correction (old -> new)

### Christmas Lights Etc

| Part number | Product | Change |
|---|---|---|
| 72636 | C9 Warm White OptiCore LED Christmas Light Bulbs, Box of 25 | price $32.99 -> $29.99 |
| 72639 | C9 Cool White OptiCore LED Christmas Light Bulbs, Box of 25 | price $32.99 -> $29.99 |
| 72642 | C9 Multicolor OptiCore LED Christmas Light Bulbs, Box of 25 | price $32.99 -> $29.99 |
| 72645 | C9 Red OptiCore LED Christmas Light Bulbs | price $32.99 -> $29.99 |
| 72654 | C9 Green OptiCore LED Christmas Light Bulbs | price $32.99 -> $29.99 |
| 72609 | C7 Warm White OptiCore LED Christmas Light Bulbs, Box of 25 | sku 87773 -> 72609 |
| 15098 | 100' C9 Commercial Light Stringer, SPT1 Green Wire, 12" Spacing | price $54.99 -> $49.99 |
| 15100 | 25' C9 Commercial Light Stringer, SPT1 Green Wire, 12" Spacing | price $14.99 -> $15.99 |
| 71673 | Green Christmas Light Plug, Polarized Female Zip Plug, SPT2, 5-Pack | price $5.95 -> $6.20; packQty (none) -> 5 |
| 17441 | 500' Green SPT1W Christmas Light Wire | URL -> https://www.christmaslightsetc.com/p/Green-Christmas-Light-Wire-5762.htm |
| 17443 | 500' Green SPT2W Christmas Light Wire | URL -> https://www.christmaslightsetc.com/p/Green-Christmas-Light-Wire-5762.htm |
| 83965 | Wintergreen Lighting Christmas Light Shingle Tab, 100 Pack | price $25.00 -> $24.99 |
| 77667 | C9 Warm White OptiCore Commercial LED Christmas String Lights, 25 Ligh | price $47.99 -> $49.99 |
| 77653 | C7 Warm White OptiCore Commercial LED Christmas String Lights, 25 Ligh | price $34.99 -> $39.99 |
| 84095 | 25 C9 Warm White LED Christmas Lights, 8" Spacing | sku 20349 -> 84095; price $13.99 -> $14.99 |
| 83768 | 70 5mm Warm White LED Christmas Lights, 4" Spacing | sku (none) -> 83768 |
| 84222 | 70 5mm Warm White LED Christmas Lights, 4" Spacing, Contractor Pack | price $499.99 -> $431.76 |
| 85472 | 5MM 4'x6' Warm White LED Net Lights, Green Wire | price $39.99 -> $34.99 |
| 80349 | 150' Warm White LED Rope Light, 2 Wire 1/2", 120 Volt | URL -> https://www.christmaslightsetc.com/p/2-Wire-Warm-White-LED-Rope-Light-120-Volt-13917.htm; price $179.99 -> $184.99 |
| 80056 | Wintergreen Lighting 15 Amp Heavy Duty Grounded Timer - Outdoor | price $29.99 -> $34.99 |

Not orderable today (`gone`):

- 67083 - Green Christmas Light Plug, Polarized Male Zip Plug, SPT1, 5 pk: not available for purchase.
- 67081 - Green Christmas Light Plug, Polarized Female Zip Plug, SPT1, 5-Pack: not available for purchase.
- 86287 - Canny Ridge Clip Pro, 25 Pack: not available for purchase.

### 1000Bulbs

| Part number | Product | Change |
|---|---|---|
| CMS-10294 | (NEW Technology) C9 - Warm White - Faceted LED - VividCore Premium - 5 | price $25.53 -> $25.42 |
| CMS-10284 | (NEW Technology) C7 - Warm White - Faceted LED - VividCore Premium - 5 | URL -> https://www.1000bulbs.com/product/225399/CMS-10284.html (temporarily unavailable) |
| CMS-10279 | (NEW Technology) C7 - Green - Faceted LED - VividCore Premium - 50% Br | price $18.78 -> $19.72 |
| CMS-10106 | 1000 ft. - 15 in. Socket Spacing - 18 Gauge Copper - C9 Christmas Ligh | price $342.79 -> $394.92 |
| CMS-10108 | 1000 ft. - 12 in. Socket Spacing - 18 Gauge Copper - C9 Christmas Ligh | price $340.43 -> $451.44 |
| CMS-10095 | 1000 ft. - 12 in. Socket Spacing - 18 Gauge Copper - C7 Christmas Ligh | price $322.45 -> $481.47 |
| CMS-10126 | 25 ft. - C9 Christmas String Lights - 25 Sockets - 12 in. Spacing - Gr | price $9.20 -> $10.86 |
| CMS-10119 | 25 ft. - C7 Christmas String Lights - 25 Sockets - 12 in. Spacing - Gr | price $8.78 -> $12.02 |
| CLIP-10005 | Tab Light Clips - For Shingles - Holds C7 and C9 String Lights - Pack  | price $13.52 -> $15.49 |
| CLIP-10009 | Magnetic Light Clips - Holds C7 or C9 Lights - Pack of 50 - For Flat M | price $42.22 -> $41.60 |
| CMS-25C9-8GWW | 17 ft. - Warm White - LED C9 Christmas String Lights - 25 Bulbs - Gree | price $13.93 -> $13.97 |
| CMS-50WW6B | 26 ft. LED Mini Lights - (50) Warm White 5mm Bulbs - 6 in. Bulb Spacin | price $255.10 -> $354.27 |
| SHL-LED70ICEWW | Warm White Icicle Lights - 8 ft. - 70 LED Mini Lights - White Wire - 1 | price $19.26 -> $21.72 |
| CMS-100L5MMNETWWG | LED Warm White Net Lights - 100 Bulbs - Green Wire - 4 ft. x 6 ft. - 5 | price $32.97 -> $33.08 |
| FT2-L120HA12150 | 1/2 in. - LED - Warm White - Rope Light - 2 Wire - 120 Volt - 150 ft.  | price $239.06 -> $198.08 |
| STAKE-10001 | Christmas Lawn Stakes - 5 in. Tall - Holds C7 and C9 String Lights - F | price $6.29 -> $7.31 |
| PLTS-12336 | Mechanical Heavy Duty Outdoor Timer - Photocell Controlled - 2 Outlets | price $11.44 -> $15.73 |
| HLS-TRUNK8CLRG | HLS TRUNK8CLRG - Tree Wrap Lights - (150) Bulbs - Clear - 8 ft. x 2 ft | URL -> https://www.1000bulbs.com/product/8002/HLS-TRUNK8CLRG.html; sku TRUNK8CLRG -> HLS-TRUNK8CLRG |

Not orderable today (`gone`):

- CMS-WIRE1000GR2 - 1000 ft. - Green - 18 AWG - SPT-2 Rated - Commercial Christmas Wire: not for sale (reference only).

The three CLE pages still load but say "not currently available for purchase" and show no price or Item Number (they may return; today they cannot be ordered). Replacements seen: CLE SPT1 green plugs are now 10-packs (male 88283, female 88287, $12.40 each pack); CLE ridge clip is now Canny Ridge Clip Pro X2 (88780, $26.25 per 25); 1000Bulbs has no 1000 ft SPT-2 green wire listed (longest is 500 ft CMS-10130, $170.84, listing evidence).

Conflicts printed on the supplier pages themselves (flagged in the JSON, not corrections):

- 1000Bulbs CLIP-10003 ridge clip: title, price block and listing say 25 Pack ($17.59, $0.70 each); the attribute table says Package Quantity 50. Treated as 25.
- 1000Bulbs CMS-50WA-6GWW mini string: attribute table says max 45 sets, description says 90. Use 45.
- CLE spools and stringers: spec table amp capacity (7 for SPT1W, 10 for SPT2W, 5 to 8 on stringers) versus "8 amp capacity" in the description on every page. Use the lower figure.
- CLE structured data "sku" is an internal id, not the Item Number, on newer products (e.g. item 72636 has structured sku 61361). Order by Item Number.

## Category URLs (48)

- All 21 distinct CLE URLs and all 27 1000Bulbs URLs return 200 with no redirect, and every page title matches its key except one.
- CLE `plugs` is wrong: it points at "Zip Cord Christmas Light Wire". CLE has no plugs category page; plugs are a filter on Christmas Light Electrical Accessories (https://www.christmaslightsetc.com/christmas-light-adapters-and-electrical-accessories--106.htm), reached from Christmas Lights > Accessories. A direct list is the search link https://www.christmaslightsetc.com/browse/?q=zip%20plug.
- CLE keys added: `retailStrings` (https://www.christmaslightsetc.com/premium-c9-LED-Christmas-Lights--739.htm), `accessories`, `clipsParent`, and `trunkWrap` (a filter on the LED Net Lights page; no page of its own).
- 1000Bulbs `plugsSpt2` and `magneticClips` load but their canonical form is /category/... (corrected URLs in the JSON). `installerPacks` is right despite its slug ("Professional Installer Packs").

## Search URL patterns

- CLE: `https://www.christmaslightsetc.com/browse/?q={query}` - works. Tested with "C9 warm white": 200, 122 product tiles.
- 1000Bulbs: `https://www.1000bulbs.com/fil/search?q={query}` - pattern taken from the site's own search form (action /fil/search, field q), but the test returned 403 with a Cloudflare challenge. Not verified; `searchUrlWorks` is null.

## Supplier facts

- **CLE wholesale** (https://www.christmaslightsetc.com/wholesale-Christmas-lights-and-trees.htm): "Christmas Lights, Etc is part of the Wintergreen Corporation family." The sign-up form is on wintergreencorp.com (not opened). Wholesale line 1-855-WGC-7100, fax 1-678-935-0717, sales@wintergreencorp.com; retail service 1-866-962-7382. The page promises wholesale pricing, large-order discounts, same-day and blind shipping, but publishes no discount levels, minimums, free-shipping threshold or net terms.
- **CLE public quantity tiers** (no account needed, percent off list): OptiCore C9 bulbs 30% at 20 boxes, 35% at 40; OptiCore C7 25/30/35% at 10/20/40 boxes; 5mm sets 30% at 100, 45% at 192; All-in-One Plus and magnetic clips 15% at 20 packs, 20% at 40 (plain All-in-One clip and shingle tab: none). Spools, stringers, plugs and wire show none. Each product's tiers are in the JSON.
- **1000Bulbs**: phone 1-800-624-4488. Product pages say items ship free "with orders of $600 or more". A credit application PDF is linked in the footer (not opened). No wholesale or contractor account page and no quantity tiers were seen on the pages saved; the account and shipping pages were not fetched because of the block.
- **Quick order / CSV upload / add-to-cart by URL**: none visible on either site. Both carts are POST forms (CLE `/Basket/?action=AddItem`, 1000Bulbs `/fil/cart/products.json` with a per-page token). Not tested.

## Step 5 gaps

SPT-1, 12 in spacing, green socket wire (plugs: spools none, stringers included unless noted):

| Length | CLE C9 | CLE C7 | 1000Bulbs C9 | 1000Bulbs C7 |
|---|---|---|---|---|
| 1000 ft | 15085 $409.99 | 15054 $369.99 | CMS-10105 $391.13 | CMS-10095 $481.47 |
| 500 ft | 81832 $219.99 | 72912 $199.99 | CMS-10110 $224.40 | CMS-10093 $229.77 (listing) |
| 250 ft | not found | not found | not found | not found |
| 100 ft | 15098 $49.99 | 15067 $44.99 | CMS-10124 $39.43 male plug only; CMS-10324 $59.97 male+female (listing) | CMS-10323 $57.64 (listing) |
| 25 ft | 15100 $15.99 | 15071 $11.99 | CMS-10126 $10.86 | CMS-10119 $12.02 |

250 ft socket spools were not found at either supplier (not proven absent; see the JSON notes). 50 ft stringers are in the JSON too.

LED retrofit 25-packs:

| Colour | CLE OptiCore C9 (0.8 W) | CLE OptiCore C7 (0.8 W) | 1000Bulbs VividCore C9 (0.74 W) | 1000Bulbs VividCore C7 (0.48 W) |
|---|---|---|---|---|
| Warm white | 72636 $29.99 | 72609 $24.99 | CMS-10294 $25.42 | CMS-10284 $19.72 (0.54 W, temporarily unavailable) |
| Cool white | 72639 $29.99 | 72606 $24.99 | CMS-10293 $26.15 | CMS-10281 $19.31 |
| Multicolor | 72642 $29.99 | 72612 $24.99 | CMS-10298 $25.52 | CMS-10286 $19.03 |
| Red | 72645 $29.99 | 72615 $24.99 | CMS-10288 $25.03 | CMS-10276 $19.69 |
| Green | 72654 $29.99 | 72624 $24.99 | CMS-10291 $26.07 | CMS-10279 $19.72 |
| Blue | 72648 $29.99 | 72618 $24.99 | CMS-C9BLU $22.33 (standard SMD 0.5 W, listing) | CMS-C7BLU $17.29 (standard SMD 0.54 W, listing) |

- SPT-1 slide-on plugs: CLE male 88283 $12.40 and female 88287 $12.40 per 10; 1000Bulbs male PLUG-10001 $6.73 and female PLUG-10002 $6.73 per 10.
- Clips: CLE all-in-one 82761 $13.99/100, shingle tab 83965 $24.99/100, ridge 88780 $26.25/25. 1000Bulbs all-in-one CLIP-10007 $6.83/50, shingle tab CLIP-10005 $15.49/50, ridge CLIP-10003 $17.59/25.
- Timer and stakes: CLE 80056 $34.99 (15 A outdoor timer) and 84144 $9.99/25; 1000Bulbs PLTS-12336 $15.73 (15 A, 1000 W photocell timer) and STAKE-10001 $7.31/25.
- CLE strings: 5mm mini 83768 $19.99 (4.8 W, max 45 sets); icicle 85686 $21.99 (4.8 W, max 45 sets); net 85472 $34.99 (12 W, max 18 sets); trunk wrap 72526 $39.99 (6.86 W, max 31 sets).
- 1000Bulbs strings: 5mm mini CMS-50WA-6GWW $14.31 (4.8 W, max 45 sets); icicle SHL-LED70ICEWW $21.72 (4.8 W, max 45 sets); net CMS-100L5MMNETWWG $33.08 (9.6 W, max 25 sets); tree wrap HLS-TRUNK8CLRG $16.10 (incandescent, 60 W, max 3 sets; no LED trunk wrap seen).

## Step 6 comparison

| Item | Christmas Lights Etc | 1000Bulbs | Christmas Designers (retail, public tiers) |
|---|---|---|---|
| 1000 ft C9 12 in SPT-1 spool (green) | 15085 $409.99 | CMS-10105 $391.13 | LL-C911-12-G $343.20 (1-5: $343.20; 6-9: $321.80; 10+: $300.30) |
| Box of 25 warm white faceted C9 LED bulbs | 72636 $29.99 per 25 | CMS-10294 $25.42 per 25 | L-PC-C9-26WW-25 $25.87 per 25 |
| 100 all-in-one clips | 82761 $13.99 per 100 | CLIP-10007 $6.83 per 50 | S-AIOC-2000-100 $19.95 per 100 (1-2: $19.95; 3-8: $17.50; 9-19: $16.50; 20-49: $15.50; 50+: $14.50) |
| SPT-1 male plug (green) | 88283 $12.40 per 10 | PLUG-10001 $6.73 per 10 | S-M-182-1-GR (pack of 5: S-M-182-1-G-5) $6.80 per 5 (Pack of 5: $6.80; Pack of 50: $36.75; Case of 1000: $567.00) |

- **Christmas Designers wholesale** (https://www.christmasdesigners.com/wholesale): two application forms, "Pro Installer Account" and "B2B Account"; a sales rep finishes setup, up to 48 hours. States wholesale ("factory-direct") pricing, Early Buy specials, a dedicated rep, blind shipping, same-day shipping before 1pm CST. "Wholesale accounts are not eligible for coupons, Loyalty Program or Free Shipping." Retail orders ship free over $150. No discount levels published; public quantity tiers are on product pages. Phone (800) 391-5280.
- **Lights for Christmas** (https://lightsforchristmas.com/pages/wholesale-create-account): free wholesale account by form; "Multiple pricing levels so that your inventory grows with you", same-day shipping for orders before noon, La Vista NE, info@lightsforchristmas.com. No phone and no prices seen: the site returned 429 on the third request, so none of the four comparison prices were obtained.

## Blocked, and what I could not verify

- **www.1000bulbs.com**: GET /fil/search?q=C9%20warm%20white returned HTTP 403 with a Cloudflare "Just a moment..." JavaScript challenge. All 1000bulbs.com fetching stopped at that point. Already saved before the block: 41 product pages, 2 follow-up product pages, 27 category pages, home page.
- **lightsforchristmas.com**: Third request (GET /collections/cords-sockets) returned HTTP 429 "Verifying your connection...". All fetching of that site stopped. Saved before the block: home page and wholesale page. No product prices were obtained.
- **wintergreencorp.com**: Not reachable by instruction; not attempted. The CLE wholesale sign-up form lives there.
- **cdn.christmaslightsetc.com**: Not an allowed host; the script that loads CLE filtered category grids was not read, so #fragment filters could not be resolved to plain URLs.

Not verified, stated plainly:

- The 1000Bulbs search URL (pattern known, test blocked).
- Any 1000Bulbs wholesale, contractor or net-terms information beyond the $600 free-shipping line and the phone number.
- The 14 added 1000Bulbs items: part number, price and pack size come from the supplier's category listings; their product pages, specs and stock were not opened.
- Whether 250 ft C9/C7 socket spools exist at either supplier, and whether 1000Bulbs sells a VividCore Premium blue bulb.
- Lights for Christmas prices (all four items).
- The Wintergreen wholesale application and any account-only prices at any supplier.
- Cart behaviour: no add-to-cart was performed, so the CLE one-box contractor price ($511.00) rests on the displayed price and structured data.
- CLE photocell 85135 has no amp or watt rating on its page.
