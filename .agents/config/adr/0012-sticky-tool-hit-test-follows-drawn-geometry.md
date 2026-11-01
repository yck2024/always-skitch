# 0012 Sticky-tool "clicked an annotation" test follows drawn geometry for Rectangles and Arrows

While a drawing tool is sticky, clicking an existing **Annotation** escapes to Select and picks it up instead of stacking a new annotation on top. That test used each object's whole bounding box (`containsPoint`). A Rectangle is hollow (transparent fill), so a click in its empty inside was swallowed: Text could not start typing inside a box, and Arrow or Rectangle drags could not begin there. A diagonal Arrow had the mirror problem — its bounding box is much larger than the drawn line, so clicks near it but off the line were grabbed too.

The escape now matches the drawn geometry for those two kinds, in both Skitch and Freeform:

- **Rectangle**: a hit only inside the border band — half the stroke width plus a small tolerance (6 screen px) on each side of the edge. A click in the empty inside falls through to the active tool.
- **Arrow**: a hit only inside the tapered polygon silhouette (shaft or head) or within the same tolerance of its outline. Clicks beside the line fall through.
- **Every other kind** (text, **Step**, blur) keeps the bounding-box test. They look solid, so clicking anywhere on them still picks them up. Freeform **Images** are still excluded from the escape, as before.
- **Select tool**: unchanged. Fabric's own targeting handles it, so clicking inside a Rectangle still selects it and moving boxes works as before.

## Considered options

- **Fabric's `perPixelTargetFind`**: rejected. It only applies to objects Fabric hit-tests, and annotations are `evented = false` while a drawing tool is active (so a finished shape is not grabbed by the next drag). It would also change Select-tool targeting, which must stay whole-box for Rectangles, and it reads canvas pixels, so the tolerance around a thin border would be a separate hack anyway.
- **A filled-but-invisible hit area on the Rectangle**: rejected for the opposite reason — it is what we want to avoid. Making the inside hittable only for Select means a second hidden fill that has to be kept in sync through resize, recolor, re-weight, undo serialization and PNG export.
- **Keep the whole bounding box (status quo)**: rejected. It is the bug: the owner could not type inside a Rectangle without clicking elsewhere and dragging the text in.
- **Make Rectangles never escape to Select**: rejected. Clicking a drawn border to grab it is useful and was already working; losing it would trade one workaround for another.

## Consequences

- The geometry lives in one pure helper, `src/utils/hitTest.ts`, used by both editors. Each editor still owns its own event wiring (ADR-0002, ADR-0008): only the question "does this pointer count as on this annotation" is shared, so the two routes cannot drift on it.
- The test works in the object's own transform (position, scale, rotation) and takes its tolerance from the editor's `annotationScale()`, so it holds at any zoom. The border band uses the Rectangle's actual stroke width, so the grabbable area follows the **Line weight** — a Thick border is easier to grab than a Thin one.
- Fabric's Select-tool targeting and the ADR-0008 text dismissal guard (which uses `containsPoint` on the text being edited) are deliberately untouched.
- A Rectangle drawn around other annotations no longer captures clicks meant for them, but a click in the thin band where its border overlaps a Step or text still picks up whichever annotation is first in z-order, as before.
- A very small Rectangle (inside narrower than twice the band) is all border, so every click on it picks it up. This matches how it looks.
