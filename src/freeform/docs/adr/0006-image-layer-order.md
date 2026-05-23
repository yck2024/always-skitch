# 0006 Image layer order in Freeform is explicit and user-controlled, not auto-promote-on-select

In Freeform, the user reorders the front-to-back stacking of **Images** explicitly via **Bring to Front** (`]`) and **Send to Back** (`[`) — keyboard shortcuts or a right-click context menu. Selecting an **Image**, including by drag, does NOT change its layer order. A newly pasted **Image** lands at the top of the **Image** stack (still below all **Annotations**, per ADR-0003).

## Considered options

- **Auto-promote on select** (the macOS window-manager / Stage Manager pattern): rejected. Every design and whiteboard app a user is likely to have learned (Figma, Sketch, Keynote, PowerPoint, Apple Freeform, Miro) treats selection as inert with respect to z-order. Auto-promote on select would make routine actions like recoloring or inspecting a screenshot silently restack the board.
- **Auto-promote on drag start**: rejected. Same family of surprises as auto-promote-on-select; no popular precedent in design tools.
- **Per-step reorder (separate Bring Forward / Send Backward commands)**: deferred. Freeform's expected use is 2–4 **Images** per Canvas (ADR-0004); on stacks that small "one step" and "all the way" diverge by at most one position. Adding `Shift+]` / `Shift+[` later if users ask is cheap.
- **Reordering Annotations too**: rejected. ADR-0003's Annotation-above-Image invariant is the stronger guarantee; exposing per-Annotation z-order would tempt users to break it. Among Annotations, draw order remains the rule.

## Consequences

- The right-click context menu is introduced for the first time in this app. MVP contents: **Bring to Front**, **Send to Back**, **Delete**. In any drawing tool the menu falls through to the browser default — drawing tools freeze **Image** interactivity, so reorder is Select-tool-only by construction.
- Right-clicking an unselected **Image** in Select tool selects it (replacing any prior selection) AND shows the menu in one gesture, matching Apple Freeform / Figma / Keynote.
- Each `]` / `[` press is its own undo step; layer order is implicit in the Fabric object array, which is already part of the history snapshot.
- The earlier `sendObjectToBack(image)` on every paste is replaced. New pastes insert at the top of the **Image** stack only; **Annotations** stay above. This reverses an in-tree behavior (older pastes used to cover newer ones), so it shows up as a visible UX change in addition to the new feature.
- Multi-select reorder preserves internal relative order: a selected group moves together to the top or bottom of the **Image** stack with its internal stacking intact. Mixed selections apply the command only to the **Images** within them; empty or Annotation-only selections are no-ops.
