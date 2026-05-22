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
The color of the **Canvas** itself — shows in empty space between **Images** and forms the background of the exported PNG. User picks from White (default), Black, or Transparent. Independent of the **Active color**; changing one does not affect the other.
_Avoid_: backdrop, paper, fill

## Relationships

- A **Canvas** hosts zero or more **Images** and zero or more **Annotations**.
- **Images** and **Annotations** are siblings on the **Canvas** — no parent-child relationship between them.
- An **Annotation** does NOT move when an **Image** moves. To move them together, the user group-selects first.
- **Annotations** always render on top of all **Images**, regardless of paste/draw order. Within each kind, newer is in front of older. There are no "bring to front / send to back" controls in MVP.

## Example dialogue

> **Dev:** "If I drag an Image, do the arrows I drew on top of it follow?"
> **PM:** "No. Annotations live in Canvas coordinates. If the user wants them to move together, they group-select first."
> **Dev:** "What if I paste a new Image — does it land on top of my existing Annotations?"
> **PM:** "No. Annotations always render on top of all Images. Pasting another Image can never cover your annotations."
