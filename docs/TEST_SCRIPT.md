# Field test: LightPlan vs. a tape measure

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

1. **Upload.** Step 1, Choose photo. Check that the lens line says the focal length came from the photo (EXIF). If it says "assumed", keep going and note it.
2. **Garage wall.** Step 2. Add a wall plane named "Garage". Choose the rectangle preset that matches your garage door (single 9 × 7 ft or double 16 × 7 ft) and tap its four corners. Zoom in so each tap lands on the corner; use the magnifier on a phone.
3. **Front wall.** Select "Front wall". Rectangle: "Size unknown" and tap the four corners of the wall (foundation corners and the two top corners under the eave). Add two references: "Entry door height (80 in)" along the door's edge, and a long horizontal one: Custom length with the tape value of D (the wall along the foundation) or of the garage door width (B). A short reference such as the 36 in door width adds more tap error than it removes. If your door is not standard, use Custom length with the tape value from A. For the best rating, use the tape value of D as the rectangle's width instead ("Custom rectangle"): a large rectangle of known size is what earns "High".
4. **Read the reference check.** Each reference shows expected vs. measured. A disagreement warning above 5% means a tap is off or a reference size is wrong; fix it before going on. On a short reference part of the gap can be tap error: zoom in and re-tap its ends.
5. **Trace.** Step 3. Zoom in for every tap (on a phone, use the magnifier). On the matching plane, trace: the window (C), the front eave and the wall-length line along the foundation (D), the garage eave (E). For the walkway (F) and the tree (G), add a ground plane from the front wall (tap two points along the wall's base) and trace them on it; enter the tree's diameter. Ground lengths are worked out from the wall rectangle's view of the camera, so add one tape-measured length on the ground (for example the driveway width) as a reference on the ground plane: it re-fits the ground's scale.
6. **Record** each LightPlan length and its confidence level in the table.

## 4. Repeat checks

1. **Swap references.** Delete the horizontal reference and re-read D. Then put it back and delete the door-height reference. Lengths should move by less than the expected error listed under their confidence pill. A bigger change means one reference is misplaced.
2. **Angled photo.** Repeat section 3 with the angled photo. In-plane lengths (A–E) should agree with the straight-on results within 3%.
3. **Override.** Type the tape value for D into the override box. The confidence changes to "Tape-measured", and the string counts, BOM and power plan update.
4. **Pitch.** If you measured H, compare it with the estimated pitch in step 2 (shown as "estimated" on the roof plane).

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

- Each pill lists the expected error from tap precision ("Expected error about ±x%"). LightPlan assumes every tap can be off by about 2.5 px of the stored photo and works out what that does to each length, so a level is only shown when the length can be trusted to that band. In simulation (random houses, 1.5–3 px tap error) 98% of High results land within ±3% and 99% of Medium within ±6%.
- "High" needs a large rectangle of known size (the tape-measured wall, or a garage door that fills a good part of the photo), zoomed taps and a cross-check reference. A small rectangle such as the front door, a single unchecked reference, or no rectangle at all caps the rating at Medium or Low.
- Ground (F) and roof items are worked out in 3D from the wall rectangle, and a one-pixel tilt of that rectangle moves them by several percent, so they are usually Low. A tape-measured reference on the ground plane re-fits it; taking the photo closer or from higher up (a second-floor window) helps too.
- Roof items are Low unless you enter the roof pitch: the pitch estimated from a gable on the wall may belong to a different roof.
- Trees, posts and bushes traced on a wall plane are flagged (they stand in front of it, so they measure too large); trace them on a ground plane to measure them in 3D. A tree with no diameter entered is flagged too.
- The plan adds 10% to every run, so a High-confidence measurement within ±3% still leaves margin for corners and drops.

If an item misses its band, note the photo angle, which references were used, and the reasons listed under its confidence pill. Those reasons point at the cause: a far-off-rectangle feature, a short reference, a steep viewing angle, or a lens setting that does not match the photo (step 1 offers the measured focal length).
