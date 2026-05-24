# 0003 Text tool is one-shot — auto-switches to Select after editing exits

In both Skitch and Freeform, after the user exits edit mode on a freshly created text box, the active tool automatically switches to Select. The user must re-pick Text to create another text box. Every other drawing tool — Arrow, Rectangle, Callout, Blur — remains sticky and can be used to create multiple objects in succession.

## Considered options

- **Keep Text sticky (status quo, matches Figma)**: rejected. Text is the only drawing tool that combines *click-finalize* (no drag needed — a single click creates the object) with *immediate edit mode* (the new text box opens into a text input). After the user finishes typing, clicking elsewhere on the canvas is the natural "I'm done" gesture — but each such click silently creates another text box. The result is canvas debris that the user did not intend and has to clean up. Other click-finalize tools (Callout) don't have this problem because they have no edit mode — the user doesn't expect to do anything after the click, so click-elsewhere is unambiguously "place another."

- **Make all drawing tools one-shot for consistency**: rejected. Arrow, Rectangle, and Blur all require drag motion, so a stray click can't accidentally create one — the sticky pattern is genuinely useful (draw multiple shapes in a row without re-picking the tool). Callout is click-finalize but produces numbered step markers in sequence — placing several in a row is exactly the feature. Stripping stickiness everywhere would punish the legitimate multi-shape workflow to fix a problem only Text has.

- **Add an Esc-to-finish hint or modal toast**: rejected. Adds UI clutter (a toast every time the user enters text edit mode) and doesn't fix the click-elsewhere case — users still click before reading the hint. The fix needs to be behavioral, not informational.

- **Switch to Select on first text creation, but keep Text sticky on subsequent creations within the same session**: rejected as too clever. Mode-switching that depends on history-of-actions is hard to predict and harder to document.

## Consequences

- Implementation hooks into Fabric's `editing:exited` event on the text object. When it fires, the editor calls the parent's `onToolChange('select')` callback to flip the active tool. The handler is wired on each text box at creation time (in the same `enterEditing()` site that already runs).

- The click that exits editing is itself processed *after* the tool switch, so it follows Select-tool semantics: a click on an Image selects the Image, a click on empty Canvas (Freeform) or empty Background (Skitch) deselects. This is the desired outcome — the user's "I'm done with text" gesture lands in a sensible state regardless of where they clicked.

- The change applies to both routes, but each route owns its own implementation in its CanvasEditor file. No shared utility is introduced; the two text creation paths remain parallel-but-separate, matching the existing pattern (cf. ADR-0002 — the two contexts share no runtime state).

- Discoverability cost: a user coming from Figma will notice that Text behaves differently from Arrow/Rectangle here. We accept this — the alternative (debris-producing sticky Text) is a more visible and more annoying surprise than the one-shot snap-out.

- The Shortcuts modal in each route already lists `T` as the Text tool. No documentation change there — the user invokes Text the same way; only the *post-typing* behavior changes.

- A user who *does* want to create multiple text boxes in a row re-presses `T` (or clicks the Text toolbar button) between each. We judged this to be both rare in practice and an acceptable cost for eliminating the accidental-creation trap.
