# Freeform

A multi-image annotation board at `/freeform`. Users paste several screenshots into one canvas and annotate freely across them. See [CONTEXT-MAP.md](../../CONTEXT-MAP.md) for how this relates to the [Skitch](../../CONTEXT.md) context.

## Language

**Canvas**:
The auto-growing bounding box that hosts everything in Freeform. No fixed size — grows as content is added or moved.
_Avoid_: page, board, document, workspace

**Image**:
A pasted screenshot on the **Canvas**. Draggable, resizable, deletable. A **Canvas** can hold many.
_Avoid_: photo, picture, tile, card, panel, background

**Annotation**:
A shape (arrow, rectangle, text, callout, blur) on the **Canvas**. Lives in canvas coordinates, never bound to an **Image**.
_Avoid_: shape, marker

**Active color**:
The pen color new **Annotations** are drawn in. Unlike Skitch, the **Active color** persists across pastes — pasting an **Image** never resets it.

**Canvas color**:
The color of the **Canvas** itself — shows in empty space between **Images** and forms the background of the exported PNG. User picks one of four modes from the toolbar: **White** (default), **Black**, **Transparent**, or **Match**. Independent of the **Active color**; changing one does not affect the other.
_Avoid_: backdrop, paper, fill

**Match** (Canvas color mode):
A derivation: **Canvas color** = saturation-weighted, lightness-clamped dominant color of the most-recently-pasted **Image**. Auto-engages once when the user pastes into a fresh canvas (the only setting in Freeform that can change implicitly on paste). After the user explicitly picks **White**, **Black**, or **Transparent**, **Match** disengages until the user clicks the **Match** swatch again. The derived color is "designed" (softened), not literal — pure most-frequent extraction would return near-white on typical screenshots and clash with palette annotations otherwise.
_Avoid_: Auto, Adaptive, Derived, From image

**Layer order**:
The front-to-back stacking of objects on the **Canvas**. **Annotations** always render above **Images** — an unbreakable rule. Among **Images**, **Layer order** is user-controlled via **Bring to Front** and **Send to Back**. Among **Annotations**, draw order determines the stack (newer in front).
_Avoid_: z-order, stacking, depth, level

**Bring to Front / Send to Back**:
The two commands the user invokes (keyboard `]` / `[`, or right-click menu) to move selected **Images** to the top or bottom of the **Image** layer stack. Applies only to **Images** in the selection; Annotations and empty selections are no-ops.
_Avoid_: raise, lower, promote, demote

## Relationships

- A **Canvas** hosts zero or more **Images** and zero or more **Annotations**.
- **Images** and **Annotations** are siblings on the **Canvas** — no parent-child relationship between them.
- An **Annotation** does NOT move when an **Image** moves. To move them together, the user group-selects first.
- **Annotations** always render on top of all **Images**. The user has no operation that puts an **Image** above an **Annotation**.
- Among **Annotations**, **Layer order** follows draw order — newer in front of older. There are no per-Annotation reorder controls in MVP.
- Among **Images**, **Layer order** is user-controlled via **Bring to Front** / **Send to Back**. A freshly pasted **Image** lands at the top of the Image stack by default (still below all Annotations).
- **Canvas color** is preserved across pastes, with one carve-out: when **Match** mode is active, each paste re-derives the color. Explicit **White** / **Black** / **Transparent** picks are never disturbed by paste.

## Example dialogue

> **Dev:** "If I drag an Image, do the arrows I drew on top of it follow?"
> **PM:** "No. Annotations live in Canvas coordinates. If the user wants them to move together, they group-select first."
> **Dev:** "What if I paste a new Image — does it land on top of my existing Annotations?"
> **PM:** "No. Annotations always render on top of all Images. Pasting another Image can never cover your annotations."
> **Dev:** "What about another Image — can a new paste cover an older Image?"
> **PM:** "Yes. New pastes land on top of the existing Image stack by default. If the user wants a different order, they select an Image and press `]` (Bring to Front) or `[` (Send to Back)."
> **Dev:** "If I select both an Image and an Annotation and press `]`?"
> **PM:** "Only the Image moves. Annotations are ignored by the layer commands — they're already above all Images by rule."
> **Dev:** "Does pasting an Image ever change Canvas color?"
> **PM:** "Only when **Canvas color** is in **Match** mode. Then each paste re-derives a softened dominant color from the pasted Image. If the user has clicked White/Black/Transparent, paste leaves Canvas color alone. **Match** also auto-engages once, the first time a user pastes into a fresh canvas — that's the only implicit setting change in Freeform."
