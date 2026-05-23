# 0008 Canvas color: Match mode

The **Canvas color** picker gains a fourth option, **Match**, that derives Canvas color from the dominant color of the most-recently-pasted **Image**. Match auto-engages once on the first paste into an empty canvas and recomputes on subsequent pastes while active; once the user explicitly picks White/Black/Transparent, Match disengages and stays off until the user clicks the Match swatch again. This is the only setting in Freeform that can change implicitly on paste — a deliberate carve-out from the "settings persist across pastes" invariant established for Active color and the active tool.

The derived color is "designed", not literal: pixels are saturation-weighted (to avoid the failure mode where typical screenshots — 70%+ white UI chrome — yield a near-white result that looks like a no-op) and lightness-clamped to a readable range (so palette-colored annotations on top remain visible). Extraction is rolled in-house (~50 LOC) rather than via Vibrant.js or color-thief; the algorithm we want is simple enough that a dep is not worth the bundle cost on a project this small.

## Considered options

- **Blurred image as background** (à la Instagram Stories): rejected — Freeform's Canvas is auto-growing (ADR-0004) with no fixed aspect ratio, forcing an unattractive stretch/tile/center policy. Blurred UI screenshots also look foggy (sharp text and icons smear), so the visual rarely pays off.
- **Gradient between top-N extracted colors**: deferred — solid color v1 first. Easy to layer on later if the simpler mode isn't expressive enough.
- **Literal most-frequent pixel extraction**: rejected — screenshots dominated by white chrome produce near-white results, so the feature would look broken half the time. The softening step is the feature.
- **Auto-engage Match on every paste**: rejected — would fight the user when they had deliberately picked White/Black/Transparent. Match auto-engages exactly once, on the first paste into an empty canvas; after that, paste only updates the color if Match is still active.
- **No 4th swatch, hidden mode**: rejected — left the user no path back to Match after picking W/B/T short of clearing the canvas. The 4th swatch (static icon, no live preview) costs little and restores reversibility.
- **Vibrant.js / color-thief**: rejected — both bring categorization features we don't use; the saturation-weighting + lightness-clamping we want is shorter than the integration code would be.

## Consequences

- The "settings don't change on paste" invariant in `CONTEXT.md` now has an explicit, local exception: Canvas color in Match mode recomputes on paste. Active color and the active tool still persist unconditionally.
- ADR-0001's readability constraint (Palette colors are curated so white halos stay readable against the annotation's own fill) is unchanged. Annotation legibility *on top of* a Match-derived background is best-effort: lightness clamping keeps it acceptable in the common case, but a user pasting an image whose dominant hue is close to their pen color can still produce a clash. The mitigation is in the user's hands — switch to a different palette color or back to W/B/T.
- Extraction failure (all-white, all-grayscale, or mostly-transparent images) silently falls back: White on the first paste, the previous derived color on subsequent pastes. No toast — keeps the feature feeling magical rather than apologetic.
- Match mode survives Clear Canvas (ADR-0007) — Canvas color is preserved as a setting, including the "Match" mode marker. The cached derived color stays until the next paste recomputes it.
