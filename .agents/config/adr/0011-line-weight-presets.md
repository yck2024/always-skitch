# 0011 Line weight as three fixed presets over a slider

User feedback asked for control over how thin/thick rectangles draw. We expose **Line weight** as three fixed presets — Thin (4), Medium (8), Thick (14) — in a toolbar popover, not a continuous slider. This is the same trade ADR-0001 made for color: a constrained set of curated choices over a free control, keeping the quick-markup UI one-click simple and every exported screenshot recognizably Skitch-styled. Medium is pinned at 8, the historical hardcoded `STROKE_WIDTH`, so the default look of every annotation is pixel-identical to before the feature existed.

The setting mirrors **Active color**'s machinery in both contexts: it applies to new annotations AND re-weights the current selection; it resets on paste in Skitch and persists in Freeform, each following its context's existing rule. Scope is everything drawn as a line — rectangles and arrows (arrows scale their body/head polygon geometry by `weight / 8` to preserve the iconic shape ratio). Text, Steps, blur, and Halos have no line weight.

## Considered options

- **Continuous slider (1–24px)**: rejected — the free-control complexity ADR-0001 already rejected for color; fiddly on a tool whose whole point is fast markup, and produces off-brand hairline/blob extremes.
- **Cycling toolbar button**: rejected — smallest UI, but the options aren't visible up front and mis-clicks overshoot; the popover keeps all three choices scannable, matching the color picker.
- **Rectangle-only scope**: rejected — a global control sitting next to the color swatch that silently ignores arrows reads as a bug ("I set Thick, drew an arrow, nothing changed").
- **Keyboard shortcut**: deferred — keys are scarce (`C`, `Esc`, `]`, `[` taken); this repo adds shortcuts when demand shows up in feedback, not speculatively.

## Consequences

- Users cannot pick an arbitrary width (e.g. 11px). Adding a fourth preset later is cheap; switching to a slider later would orphan this ADR and the preset vocabulary in both CONTEXT.md files.
- Changing Thin/Thick values later churns users' exported-image expectations; changing Medium breaks the "default look never changed" invariant and should not happen.
- Both contexts wire the control separately (they share no editor code — ADR-0002), but the preset values and the picker component are shared modules (`src/weights.ts`, `src/components/WeightPicker.tsx`) alongside the shared palette, so the values cannot drift between contexts.
