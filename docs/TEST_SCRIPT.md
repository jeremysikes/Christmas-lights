# Field test: LightPlan vs. a tape measure

Before going out, check the build: `npm run build`, `npm test` (459 unit tests, all passing) and `npm run e2e` (696 smoke checks in Chromium, all passing). Then open `dist/lightplan.html` on the phone you will use.

About 45 minutes on a real house. You need a 25 ft (or longer) tape measure, a phone, and a helper for the long measurements. Do everything from the ground; no ladder is needed.

## 1. Tape-measure the house first

Measure these and write them in the results table (section 5). Each one is something you can also trace in LightPlan.

| # | What to measure | How |
|---|---|---|
| A | Front door: width and height | Inside the trim, slab only. |
| B | Garage door: width and height | The door panel itself, not the trim. |
| C | One front window: width and height | Outside edge of the trim. |
| D | Front wall length | Along the foundation, corner to corner. The eave above is this length plus the overhang at each end; measure the overhang by holding the tape up from the ground at a corner, or estimate it. |
| E | Garage wall length | Same method, if the garage is set back from the main wall. |
| F | Walkway edge | One straight edge, from the house to where it meets the sidewalk or driveway. |
| G | Tree trunk | Height from the ground to the first branches (eye estimate against the tape), and circumference at chest height. Diameter = circumference ÷ 3.14. |
| H | Roof pitch (optional) | A phone level app laid on a gable rake board, or a speed square. Pitch = 12 × tan(angle). |

## 2. Take two photos

1. **Straight-on photo.** Stand across the street, centered on the house. Phone at chest height, held level (vertical edges of the house should look parallel), main 1× lens, whole house in frame, daylight.
2. **Angled photo.** Step about 30° to one side and take a second photo the same way.

Do not crop or edit the photos. Upload the originals so LightPlan can read the lens information.

## 3. Measure in LightPlan (straight-on photo)

1. **Upload.** Step 1, Choose photo. In the Lens section, check that the badge says "From the photo" (EXIF). If it says "Assumed", keep going and note it: once a rectangle is marked it may change to "Measured". If a lens warning appears later with a "Use N px" button, the lens setting disagrees with the rectangles in the photo; note it, then tap the button.
2. **Garage wall.** Step 2. Add a wall plane named "Garage". Choose the rectangle preset that matches your garage door (single 9 × 7 ft or double 16 × 7 ft) and tap its four corners. **Zoom in before every tap** (pinch, or the + button) so each tap lands on the corner; use the magnifier on a phone. LightPlan records how precisely each point could be tapped at the zoom you used: a point tapped with the whole photo in view can be off by 15 photo pixels or more on a phone, and the rating says so ("Tapped zoomed out (about ±16 px on the photo): zoom in and re-tap ...").
3. **Front wall.** Select "Front wall". Rectangle: "Size unknown" and tap the four corners of the wall (foundation corners and the two top corners under the eave). Add two references: "Entry door height (80 in)" along the door's edge, and a long horizontal one: Custom length with the tape value of D (the wall along the foundation) or of the garage door width (B). A short reference such as the 36 in door width adds more tap error than it removes. If your door is not standard, use Custom length with the tape value from A. For the best rating, use the tape value of D as the rectangle's width instead ("Custom rectangle"): a large rectangle of known size is what earns "High".
4. **Read the reference check.** Each reference shows expected vs. measured. A disagreement warning above 5% means a tap is off or a reference size is wrong; fix it before going on. On a short reference part of the gap can be tap error: zoom in and re-tap its ends.
5. **Trace.** Step 3. Zoom in for every tap (on a phone, use the magnifier). On the matching plane, trace: the window (C), the front eave and the wall-length line along the foundation (D), the garage eave (E). For the walkway (F) and the tree (G), add a ground plane from the front wall (tap two points along the wall's base) and trace them on it; enter the tree's diameter. Ground lengths are worked out from the wall rectangle's view of the camera, so add one tape-measured length on the ground (for example the driveway width) as a reference on the ground plane: it re-fits the ground's scale.
6. **Record** each LightPlan length and its confidence level in the table.

## 4. Repeat checks

1. **Swap references.** Delete the horizontal reference and re-read D. Then put it back and delete the door-height reference. Lengths should move by less than the expected error listed under their confidence pill. A bigger change means one reference is misplaced.
2. **Angled photo.** Repeat section 3 with the angled photo. In-plane lengths (A–E) should agree with the straight-on results within 3%.
3. **Override.** Type the tape value for D into the "Tape-measured length" box. The pill changes to "High · tape" (reason "Tape-measured"), and the string counts, BOM and power plan update.
4. **Pitch.** If you measured H, compare it with the estimated pitch in step 2 (shown as "estimated" on the roof plane).
5. **Zoom test.** Trace the front eave twice: once with the whole photo in view, once zoomed in on each end. The zoomed-out trace should be rated lower, with the reason "Tapped zoomed out", and the zoomed-in one should be the closer of the two to the tape.

## 4a. Power and shopping list (10 minutes, on site)

1. **Outlets.** Step 5. Place each outdoor outlet where it is on the photo. Read the cords on the photo: each cord from an outlet should go down, along the ground and up beside (never across) a window or door. Check two of the cord lengths with the tape along the same route; the cord LightPlan buys should be at least that long.
2. **Linked runs.** The list under "How the power runs" shows which runs hang off which with jumper cords. Walk one tree and check that each jumper is a route you would really use.
3. **Supplier.** Step 4, "Buy from": pick the supplier you order from. In step 6, open one "Open" link per kind of item and compare the part number and price on the supplier's page with the shopping list. Note any price that has changed since the "as of" date, and type your account price over the line.

## 4b. Mansard roof (15 minutes, only for a house that has one)

A mansard has a steep lower roof face with a shallow roof on top. You need the same photos as before.

Tape-measure (from a ladder at one corner, or from a dormer window):

| # | What | Why |
|---|---|---|
| M1 | **Up**: how far the steep face goes straight up, from the gutter line to the trim line at its top. Hold the tape plumb. | one of the two slope numbers |
| M2 | **Back**: how far the top of the steep face sits behind the gutter line, measured level. A plumb line dropped from the trim line makes this easy. If you cannot reach, measure the **sloped height** along the shingles instead. | the other slope number |
| M3 | Length of the trim line along the front (or count shingle courses of known width) | check |
| M4 | Length of one leaning corner edge, from the gutter corner up to the trim line | check |
| M5 | Width and height of one dormer face | check |
| M6 | Length of the top edge of the house, if you can reach it safely. Otherwise skip it. | check |

Then in LightPlan:

1. **Scale.** Step 2. If the wall has more than one measured rectangle, read the line on the wall's card: "Scale taken from …". It should name the largest one, and the other should check within a few percent. If a note says a rectangle "does not agree", check its size and that it sits flat on this wall.
2. **Steep face.** Press "Steep roof face (mansard)" and tap both ends of the line where the steep face starts (the gutter line). Under "I measured it" type M1 in Up and M2 in Back (or the sloped height), then "Use these numbers". The panel shows the angle. Most mansards come out between 60° and 75°. If it asks whether the two numbers are swapped, they probably are.
3. **Upper roof.** Press "Add the upper roof" and tap both ends of the trim line. Pick the pitch of the upper roof if you know it.
4. **Trace.** Step 3. Trace the trim line (Eave), one corner edge (Rake), one dormer (Window) and the top edge (Ridge). Watch "On" above the photo: it should say the steep roof face for the first three and the upper roof for the top edge.
5. **Record** each length and its rating in the table below, next to M3 to M6.

| # | Item | Tape | LightPlan | Error % | Confidence |
|---|---|---|---|---|---|
| M3 | Trim line | | | | |
| M4 | Corner edge | | | | |
| M5 | Dormer outline (2 × width + 2 × height) | | | | |
| M6 | Top edge | | | | |

What to expect:

- With M1 and M2 typed in, items on the steep face are rated from how well the wall is measured. A wall rated Medium usually gives Medium or Low on the steep face. A small rectangle on the wall gives Low: mark the wall's own corners with its tape-measured size to lift it.
- With a picked angle and no tape numbers, everything on the steep face is Low. Expect corner edges and dormers to be 5 to 10% off if the real angle is 10° away from the picked one; the trim line moves less (about 3%).
- The top edge (M6) is usually Low and can be far off, because the upper roof is seen almost edge-on. Use the tape number for it.
- A ridge traced on the wall instead of the roof reads too short. LightPlan says so and offers "Put it on the roof". If the result looks wrong (much longer than on the wall), it says that too.

## 5. Results table

| # | Item | Tape | LightPlan (straight) | Error % | Confidence | LightPlan (angled) | Error % |
|---|---|---|---|---|---|---|---|
| A | Door width / height | | | | | | |
| B | Garage door width / height | | | | | | |
| C | Window width / height | | | | | | |
| D | Front wall length | | | | | | |
| E | Garage wall length | | | | | | |
| F | Walkway edge | | | | | | |
| G | Tree height / diameter | | | | | | |
| H | Roof pitch | | | | | | |

Error % = (LightPlan − tape) ÷ tape × 100.

## 6. What "good" looks like

| Confidence shown | Expected error on any item |
|---|---|
| High | within ±3% |
| Medium | within ±6% |
| Low | can be 10% or more; fix the references or use an override |

- Each pill lists the expected error from how exactly the points could be tapped ("Expected error about ±x%"). LightPlan takes every tap to be off by at least 2.5 px of the stored photo, and by more when it was tapped zoomed out, and works out what that does to each length, so a level is only shown when the length can be trusted to that band. In simulation (random houses, 1.5–3 px tap error) 98% of High results land within ±3% and 99% of Medium within ±6%; with finger taps at fit zoom (10–20 px off) nearly every result is rated Low, as it should be.
- **Zoomed-out taps are rated lower.** If a pill is Low or Medium with the reason "Tapped zoomed out", zoom in and tap those points again: that is usually all it takes. If the reason says to "use a larger rectangle" and nothing about zooming, the taps were already precise and only a bigger known-size rectangle will raise the rating.
- "High" needs a large rectangle of known size (the tape-measured wall, or a garage door that fills a good part of the photo), zoomed taps and a cross-check reference. A small rectangle such as the front door, a single unchecked reference, or no rectangle at all caps the rating at Medium or Low.
- Ground (F) and roof items are worked out in 3D from the wall rectangle, and a one-pixel tilt of that rectangle moves them by several percent, so they are usually Low. A tape-measured reference on the ground plane re-fits it; taking the photo closer or from higher up (a second-floor window) helps too.
- Roof items are Low unless you enter the roof pitch: the pitch estimated from a gable on the wall may belong to a different roof.
- Trees, posts and bushes traced on a wall plane are flagged (they stand in front of it, so they measure too large); trace them on a ground plane to measure them in 3D. A tree with no diameter entered is flagged too.
- The plan adds 10% to every run, so a High-confidence measurement within ±3% still leaves margin for corners and drops.

If an item misses its band, note the photo angle, which references were used, and the reasons listed under its confidence pill. Those reasons point at the cause: a far-off-rectangle feature, a short reference, a steep viewing angle, or a lens setting that does not match the photo (step 1 offers the measured focal length).
