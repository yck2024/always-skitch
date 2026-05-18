# 0001 Constrained color palette over free picker

The color picker exposes a fixed six-color **Palette** (red, black, blue, green, cyan, magenta) instead of a native `<input type="color">`. Every text and callout annotation depends on a white **Halo** staying readable on top of its fill — colors like yellow, pale cyan, or white itself break that and quietly destroy legibility, which is the iconic Skitch property we are unwilling to lose. The palette is curated so every choice keeps white halos readable; adding new palette entries requires the same contrast check.

## Considered options

- **Native `<input type="color">`**: rejected — no contrast guardrails, breaks white halos for pale colors.
- **Palette + "more colors" escape hatch**: deferred — reintroduces the failure mode for whichever color the user types in. Easy to add later if a real need emerges; ripping it back out would be harder.

## Consequences

- Users who need a specific brand or external color cannot have it. The product is positioned as a contrast-rescue tool, not a personalization tool (see `CONTEXT.md` → Active color).
- Future palette changes must validate white-halo contrast before shipping.
