# 0007 Clear Canvas wipes all Images and Annotations, not just Annotations

Freeform exposes a **Clear Canvas** command via a toolbar button. It removes every **Image** and **Annotation** from the **Canvas** in a single undoable step. Settings — **Active color**, **Canvas color**, and the active tool — are preserved. The button sits in the destructive-actions cluster (immediately after Delete), is disabled when the **Canvas** has no content, and prompts a `window.confirm` before executing. There is no keyboard shortcut.

## Considered options

- **Annotations-only Clear (mirroring Skitch's `C`)**: rejected. Skitch's `Clear annotations` keeps the Background because the Background is the reference content the user is annotating — the asymmetry of "keep what I'm marking up, drop my marks" makes sense there. Freeform has no Background concept (ADR-0003): **Annotations** are siblings of **Images** on the **Canvas**, not a layer above some primary content. "Clear annotations, keep images" would be a Skitch-shaped operation forced onto a Freeform-shaped domain, with no clear user need behind it — a user who wants to drop just the arrows on an **Image** can group-select + Delete.

- **Hard reset (no undo)**: rejected. Freeform already snapshots every mutation into history; **Clear Canvas** piggybacks on that mechanism essentially for free. Hard reset would diverge from Skitch's `clearAnnotations` precedent (which is undoable) and force users into a "confirm-or-lose-it-forever" stance heavier than the gesture warrants.

- **Reuse Skitch's `c` keyboard shortcut**: rejected. The two routes deliberately don't share semantics (CONTEXT-MAP.md). Binding `c` to a wipe-everything action in one route and a wipe-annotations action in the other is a punji stick for dual-route users — they hit `c` in Freeform expecting Skitch-flavored "drop my arrows" and lose their **Images** instead. The cost of binding `c` outweighs the convenience for a low-frequency gesture.

- **Add a different shortcut (`Shift+C`, `Cmd+Backspace`, etc.)**: deferred. **Clear Canvas** is a once-per-session gesture; keyboard convenience matters less than for tools the user invokes constantly. Easier to add a shortcut later if demand emerges than to take one back once users have learned it.

- **"Paste as New" — a second paste button that does Clear+Paste atomically**: deferred. Matches Skitch's "paste replaces Background" muscle memory exactly. But it's a second way to do something users can already do by chaining (`Clear Canvas` then paste), and shipping two paste buttons up front adds a learning step that may not pay off. Reconsider if users naturally request it.

- **Reset settings as part of "clear"**: rejected. CONTEXT.md already separates **content** (Images, Annotations) from **settings** (**Active color**, **Canvas color**, active tool); the latter explicitly persist across content changes — Active color persists across pastes, Canvas color is documented as "a setting, not an edit." A user who has switched **Canvas color** to Black for a dark-UI screenshot doesn't want it reset when they start the next one. **Clear Canvas** is a content gesture, not a workspace gesture.

## Consequences

- A new entry point on the editor handle — `clearCanvas()` on `FreeformCanvasEditorHandle` — removes every Freeform-tagged object (**Images** and **Annotations** alike) and pushes a single snapshot to history. Cmd+Z restores; the snapshot mechanism is the same one driving every other Freeform mutation.

- The toolbar gains a `Clear Canvas` button immediately after `Delete`. Disabled when `hasContent` is false (no **Images** and no **Annotations**) — the same flag already driving Copy PNG / Download. On click, `window.confirm` prompts: "Clear the Canvas? All Images and Annotations will be removed. Use Undo to restore." On confirm, the editor handle's `clearCanvas()` runs.

- Selection state is implicitly cleared (no objects left to select). The active tool stays where it was; the user can immediately start drawing or paste a new **Image** without re-picking a tool.

- This is the first user-visible Freeform operation whose verb name overlaps with a Skitch operation but whose semantics deliberately diverge. CONTEXT.md captures the distinction in the **Clear Canvas** glossary entry. Future Freeform commands that map to Skitch concepts should follow the same pattern: pick names that make the asymmetry explicit (so not just `Clear`) and document the divergence in CONTEXT.md.

- No keyboard shortcut is published in the Shortcuts modal. If a shortcut is added later, both the modal and the CONTEXT.md entry will need updating in lockstep.

## Update — partial supersession by ADR-0010

The "Annotations-only Clear" alternative rejected above is partially superseded by [ADR-0010](../../../../.agents/config/adr/0010-freeform-clear-annotations.md). Freeform now exposes both **Clear Annotations** and **Clear Canvas** as siblings; the "group-select + Delete is enough" reasoning didn't anticipate the workflow of redoing all marks across multiple **Images** while keeping the **Images**. ADR-0007's Clear Canvas decision itself is unchanged.
