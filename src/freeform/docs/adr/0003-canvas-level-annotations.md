# 0003 Annotations in Freeform are canvas-level, never image-attached

In the Freeform context, **Annotations** (arrows, rectangles, text, callouts, blurs) live in **Canvas** coordinates and are never bound to a specific **Image**. Moving an **Image** does not move the annotations drawn on top of it. Annotations can freely cross **Image** boundaries — an arrow that starts inside Image A and ends inside Image B is a single canvas-level arrow, owned by neither.

## Considered options

- **Image-attached annotations**: rejected. Requires binding logic on every draw, parent-child serialization, and special cases for cross-image annotations. Magical move-with-the-image behavior surprises users who drag an Image and find their arrows gone with it.
- **Hybrid (attach if fully inside an Image, else canvas-level)**: rejected. Inconsistent rule — same gesture sometimes attaches, sometimes doesn't.

## Consequences

- Group-select-and-drag is the only way to move an **Image** with its **Annotations** together; users must learn this gesture.
- Cross-image arrows ("this state → that state") are a natural first-class operation, supporting flow/sequence use cases without special code.
- Annotation serialization stays a flat list of canvas-coordinate objects, identical in shape to Skitch's existing history model.
- Blur is an exception in *creation* only (must be drawn on an **Image** — see [0005](./0005-blur-per-image-only.md)); the resulting Blur annotation still lives in canvas coordinates like everything else.
