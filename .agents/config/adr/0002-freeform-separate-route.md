# 0002 Freeform lives at a separate route, not as a mode toggle

The multi-image annotation experience ("Freeform") lives at `/freeform` as its own top-level route, with its own bounded context (see `src/freeform/CONTEXT.md`). The existing single-image Skitch experience stays at `/`. The two share infrastructure (Fabric.js canvas plumbing, color **Palette**, PNG export utilities) but no runtime state; users navigate between them via top-bar tabs.

## Considered options

- **Single route with a mode toggle**: rejected. The two contexts have diverging domain models — `Active color` resets per paste in Skitch but persists in Freeform; `Canvas` and `Image` are central in Freeform but explicitly forbidden terms in Skitch. A mode toggle would bleed `if (mode === ...)` branches through every component and destroy each glossary's coherence.
- **Two separately deployed apps**: rejected as overkill. They share enough infrastructure that splitting deployments would duplicate code without benefit.

## Consequences

- Routing is required. The app gains `react-router-dom` with `BrowserRouter`, plus a `404.html` shim for GitHub Pages so deep links to `/freeform` survive refresh.
- The repo documents two contexts via `CONTEXT-MAP.md`, each with its own `CONTEXT.md`.
- Future shared work (e.g., a new annotation kind) must land in both contexts explicitly; there is no "shared toolbar" component yet, by design.
