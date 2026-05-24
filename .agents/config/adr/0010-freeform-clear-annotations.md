# 0010 Freeform exposes Clear Annotations as a sibling to Clear Canvas

Freeform adds a **Clear Annotations** command — a toolbar button (no confirm) and a `C` keyboard shortcut (prompts `window.confirm` first) — that wipes every **Annotation** from the **Canvas** while leaving **Images** untouched. This partially supersedes ADR-0007, which rejected an "annotations-only Clear" for Freeform on the reasoning that Freeform has no Background and that group-select + Delete covered the use case.

## What changed since ADR-0007

The "group-select + Delete" alternative breaks down at scale. A user who has heavily annotated 3–4 **Images** and wants to redo their marks without re-pasting the **Images** faces either a one-by-one delete (tedious) or a marquee that also grabs the **Images** and has to be manually unselected. Neither is reasonable when annotation count is high.

Per CONTEXT.md, "**Annotations** always render above all **Images** — an unbreakable rule." That rule makes the annotation layer a real, identifiable thing in the domain — not a Skitch-shaped projection forced onto Freeform, as ADR-0007 feared. "Clear the layer" is a clean operation against a layer that the system already enforces.

## On the keyboard shortcut

ADR-0007 rejected reusing Skitch's `C` shortcut because, under that ADR, `C` would have meant "wipe everything" in Freeform vs "wipe annotations" in Skitch — a punji stick for dual-route users. With **Clear Annotations** now matching Skitch's semantics, the concern flips: `C` means the *same thing* in both routes, so binding it in Freeform is a consistency win, not a hazard. Following Skitch's own pattern, the keyboard form prompts a `window.confirm` while the toolbar button does not — the keystroke is easy to misfire, the button click is deliberate.

## Considered options

- **Skip the feature** (status quo): rejected. ADR-0007's group-select-plus-Delete alternative is not viable at scale; the workflow gap is real.
- **Add the button without the `C` shortcut**: rejected. The shortcut is the consistency win — a dual-route user shouldn't need to learn that `C` only works in one app. Same semantic, same key.
- **Confirm dialog on the button too**: rejected. Skitch's pattern is button = no-confirm, keyboard = confirm. Matching that across both routes means muscle memory transfers; the friction profile of each surface is identical wherever you use it.
- **Reset settings (Active color, Canvas color, active tool) on Clear Annotations**: rejected. CONTEXT.md is explicit that settings persist across content changes; that holds here. Clearing the annotation layer is a content operation, not a workspace operation.

## Consequences

- A new `clearAnnotations()` method appears on `FreeformCanvasEditorHandle`, mirroring the shape of the existing `clearCanvas()` but scoped to objects tagged as annotations (`annotationObjects(canvas)` is already exported in `src/freeform/CanvasEditor.tsx`). Single history snapshot, same restore semantics as every other Freeform mutation.

- The toolbar's destructive cluster becomes `[Delete, Clear annotations, Clear Canvas]` — left-to-right escalation from "selected objects" to "all marks" to "everything."

- A new `hasAnnotations` boolean flag is plumbed from the editor to the parent App and into the toolbar, parallel to the existing `hasContent`. `hasContent` is not sufficient for the button's disabled state because an **Image** with zero **Annotations** still makes `hasContent` true — the Clear Annotations button should be disabled in that case.

- The `C` keyboard shortcut binds in Freeform's App-level keyboard handler with a `window.confirm` gate identical to Skitch's (same message text, "Clear all annotations? This cannot be reversed except via Undo.") and falls through silently when no annotations exist.

- ADR-0007 remains accepted in spirit — the Clear Canvas decision still stands. Only the specific rejection of "annotations-only Clear" is superseded by this ADR. A cross-reference note is appended to ADR-0007 pointing here.

- Freeform's CONTEXT.md gains a **Clear Annotations** glossary entry. The existing **Clear Canvas** entry's "Distinct from Skitch's `Clear`..." sentence is rewritten to compare against the new sibling **Clear Annotations** instead.
