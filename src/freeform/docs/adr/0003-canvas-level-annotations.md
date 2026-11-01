# 0003 Freeform Annotations are canvas-level, except Blur

In the Freeform context, non-Blur **Annotations** (arrows, rectangles, text, callouts) live in **Canvas** coordinates and are never bound to a specific **Image**. Moving an **Image** does not move them. They can freely cross **Image** boundaries — an arrow that starts inside Image A and ends inside Image B is a single canvas-level arrow, owned by neither. Blur was originally included in this rule; [ADR-0014](./0014-blur-follows-its-image.md) amends it for privacy.

## Considered options

- **Image-attached annotations**: rejected. Requires binding logic on every draw, parent-child serialization, and special cases for cross-image annotations. Magical move-with-the-image behavior surprises users who drag an Image and find their arrows gone with it.
- **Hybrid (attach if fully inside an Image, else canvas-level)**: rejected. Inconsistent rule — same gesture sometimes attaches, sometimes doesn't.

## Consequences

- Group-select-and-drag is the way to move an **Image** with its non-Blur **Annotations** together; users must learn this gesture. Blur attachment behavior is defined by [ADR-0014](./0014-blur-follows-its-image.md).
- Cross-image arrows ("this state → that state") are a natural first-class operation, supporting flow/sequence use cases without special code.
- Annotation serialization stays a flat list of canvas-coordinate objects, identical in shape to Skitch's existing history model.
- Blur's creation and image-bound clipping rules are in [ADR-0005](./0005-blur-per-image-only.md); its attachment behavior is defined by [ADR-0014](./0014-blur-follows-its-image.md).
