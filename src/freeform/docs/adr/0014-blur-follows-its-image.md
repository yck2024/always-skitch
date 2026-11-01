# 0014 A Freeform Blur follows the Image it was drawn on

In Freeform, a Blur belongs to the **Image** it was drawn on. Moving that **Image** moves the Blur with it. Resizing or rotating the **Image** keeps the Blur over the same part of the **Image**. A Blur cannot be moved, resized, or rotated on its own. This amends [0003](./0003-canvas-level-annotations.md) and [0005](./0005-blur-per-image-only.md) for Blur only; every other **Annotation** still lives in **Canvas** coordinates and stays put when an **Image** moves.

ADR-0003 treated a Blur like any other **Annotation**: a pixel snapshot in **Canvas** coordinates. Moving or resizing the screenshot after blurring left the Blur behind and showed the hidden content again, both on screen and in exports. A Blur that drifts off what it hides is a privacy leak, not a layout choice. The owner approved this change after the 2026-11-01 review of every annotation type (issue #47).

## Rules

- **Link**: each **Image** has a stable id, and each Blur records the id of the **Image** it was drawn on, plus the crop it pixelated, in that **Image**'s natural pixels. Both are stored on the objects, so they survive undo and redo.
- **Move, resize, rotate**: the Blur's position comes from the **Image**'s transform and the crop. It follows live during the gesture, not only when the gesture ends. The pixelated bitmap is not re-sampled: it was sampled from the **Image**'s natural pixels, so scaling it with the **Image** keeps every block over the pixels it came from.
- **Blur on its own**: a Blur is locked: no handles, and it cannot be dragged on its own. It can still be selected and deleted. If it is dragged as part of a multi-selection without its **Image**, it snaps back onto its **Image**.
- **Image deleted**: deleting an **Image** deletes its Blurs in the same undo step. A Blur left behind would hide nothing and could later sit over a different **Image**. Undo restores both.
- **Two Images**: a Blur cannot span two **Images**. ADR-0005 already clips each Blur to the one **Image** the drag started on, so the Blur belongs to that **Image** alone. Redacting across two **Images** still takes two strokes, and each Blur follows its own **Image**.
- **Undo and redo**: a history step records the **Image** and its Blurs in their positions at that moment. On restore, every Blur is placed on its **Image** again, so no history state can show a Blur off its **Image**.
- **Drawing on a rotated Image**: the drag box is mapped into the **Image**'s natural pixels through the inverse of its transform and widened to whole pixels. On a rotated **Image** the Blur can therefore cover more than the drawn box, never less.

## Considered options

- **Keep ADR-0003 for Blur (status quo)**: rejected. This is the bug: the hidden content shows again after a routine move or resize.
- **Bind every Annotation to the Image under it**: rejected, for the reasons in ADR-0003. Arrows and text often cross **Images** on purpose. Only Blur has a privacy reason to stay on its pixels.
- **Re-pixelate from the source on every change**: not needed. Scaling the existing bitmap with the **Image** already keeps it over the right pixels, and the bitmap never contains unblurred pixels. Re-sampling would add an async decode to every gesture frame.
- **Keep an orphan Blur when its Image is deleted**: rejected. It hides nothing, and it would be the only Blur not tied to an **Image**.

## Consequences

- Group-select is no longer needed to move a screenshot with its Blurs. It is still needed for every other **Annotation**.
- Blurs still render above every **Image** (ADR-0006 layer order is unchanged). If a blurred **Image** is moved under another **Image**, its Blur stays on top and covers part of the **Image** above it. The result looks odd but hides nothing that should be visible.
- The Blur tool's start-on-an-**Image** and clip-to-that-**Image** rules from ADR-0005 are unchanged.
- The Skitch context is unaffected: it has a single Background, which never moves.
