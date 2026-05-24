# 0009 Step numbers are stable IDs, derived as max + 1

Both contexts (Skitch and Freeform) expose a **Step** annotation — a numbered circular badge placed sequentially (1, 2, 3, …) to walk a viewer through a screenshot. Each Step's number is a **stable ID** assigned at creation; once a Step is created as "Step 3" it stays Step 3 for the rest of its life. The "next number" to assign when the user places a new Step is computed by reading the current canvas: `max(existing Step numbers) + 1`, or `1` if no Steps exist. No counter is stored separately from canvas content.

## Considered options

- **Stored monotonic counter (the original implementation)**: rejected. A `useRef(1)` that increments on each placement is intuitive but accumulates surprises:
  - **Freeform**: `Clear Canvas` left the counter ticking — the next Step showed N+1, not 1.
  - **Skitch**: `Undo` did not rewind the counter — placing → undoing → placing again gave N+1 instead of N. `Clear annotations` (`C`) had the same problem.
  - Each surprise was a candidate for a one-off patch (reset inside `clearCanvas`, snapshot the counter into history, etc.), but every patch left the next event uncovered. The mental model — "the counter is a separate thing you have to remember to keep in sync with content" — leaks.

- **Derived as `max(existing) + 1`** (chosen): the canvas already round-trips Step numbers through serialize/deserialize (the number is the `Text` child of the callout `Group`, included by Fabric's default `toObject`), so reading max off the canvas is free. Every "reset" scenario falls out without per-scenario code:
  - Empty canvas → next = 1 (covers Freeform **Clear Canvas**, Skitch **Clear annotations**, fresh paste in Skitch).
  - Skitch undo back to [1, 2] → next = 3.
  - Redo back to [1, 2, 3] → next = 4.
  - Freeform paste preserves max → no implicit reset, matching the deliberate **Canvas**-wide (not per-**Image**) numbering choice.
  No history machinery changes, no UI button for "reset counter", no per-context divergence in the rule itself.

- **Sequential renumbering (gaps auto-collapse)**: rejected. Deleting Step #2 from [1, 2, 3] would shift the surviving #3 down to #2. But a Step's number is part of the user's mental model — they may already have written "see Step 3" in surrounding documentation, or be explaining the screenshot live referencing the numbers. Silently renumbering invalidates those references. Stable IDs are worth the visible gap.

- **Smallest-unused-integer (fill the gap with reuse)**: rejected. After deleting #2 in [1, 2, 3], the next Step would become a new #2 — same number, different identity. Anything that referenced the old #2 elsewhere is now ambiguous between the deleted Step and the new one. Stable IDs forbid number reuse for the same reason renumbering is forbidden: identity drift.

- **User-facing "Reset counter" button**: rejected. Would only be needed if the counter were stored. Under derived-max, the natural reset path is "remove the existing Steps" — which the user already has to do to start over visually. **Clear Canvas** (Freeform) and **Clear annotations** (Skitch) cover the gesture; no new UI required.

## Consequences

- `calloutNumberRef` is removed from both `src/components/CanvasEditor.tsx` and `src/freeform/CanvasEditor.tsx`. The explicit `calloutNumberRef.current = 1` on Skitch image load is also removed — it's redundant under the derived rule.

- A helper computes the next Step number by walking objects tagged `data.kind === 'callout'`, reading each group's child `Text` content (parsed as int), and returning `max + 1` (or `1` if no Steps). Per-context duplication is fine for now — the helper is small, and the two contexts have different object-tagging utilities. Consolidate into a shared util if a third context ever needs it.

- **Stable IDs imply visible gaps after manual deletes.** Deleting Step #2 from [1, 2, 3] leaves [1, 3] on the canvas, and the next Step becomes #4. This is intentional and called out explicitly in the **Step** glossary entries.

- Performance: scanning every annotation per Step placement is O(n). Acceptable — n is bounded by user patience (Freeform expects 2–4 Images and a handful of Steps per Image, see ADR-0004), and placement is a click event, not a draw loop.

- The user-facing name is **Step** (per toolbar label and now glossary). The internal code identifier stays `callout` (`Tool = 'callout'`, `makeCallout`, `data.kind === 'callout'`). This UI/code asymmetry is documented in the glossary's `_Avoid_` line so a future maintainer searching for "callout" finds the connection.
