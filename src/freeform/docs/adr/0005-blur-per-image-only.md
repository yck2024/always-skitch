# 0005 Freeform's Blur tool samples per-Image only and clips to Image bounds

In Freeform, the Blur tool can only be used on top of an **Image**. Hovering empty **Canvas** with the Blur tool active shows a disabled cursor; a blur drag that starts on an Image and extends past its edge is clipped to that Image's bounds. The pixelated crop is sampled from the original full-resolution pixels of that one Image, scaled into its current resized display.

## Considered options

- **Sample from whatever is beneath (Image or Canvas color)**: rejected. Pixelating a flat **Canvas color** is a no-op that produces a confusing solid rectangle.
- **Rasterize the whole Canvas and sample from that**: rejected for MVP. Most general, but adds a per-blur canvas-rasterization step and complicates the rendering pipeline for a rare cross-image use case.
- **Per-Image with no clipping (extend the rect past the edge, sample only the overlap)**: deferred. Reasonable, but visually less predictable than hard-clip for v1.

## Consequences

- Blur's purpose — redacting information that exists in a screenshot — stays semantically obvious. Empty **Canvas** has nothing to redact.
- Cross-image redaction requires two blur strokes. Acceptable given the rarity.
- Implementation reuses Skitch's existing `createPixelatedCrop` almost verbatim — just plumbed to "the **Image** under the cursor" instead of "the singular **Background**."
