# Always Skitch — single-image context

This context covers the single-screenshot annotation flow at `/`. The multi-image experience at `/freeform` has its own context — see [CONTEXT-MAP.md](./CONTEXT-MAP.md).

A static, browser-only image annotation app for marking up screenshots with bold, opinionated Skitch-style red annotations.

## Language

**Annotation**:
A shape drawn by the user on top of the background image (arrow, rectangle, text, Step, blur).
_Avoid_: shape, object, marker

**Step**:
A numbered circular **Annotation** used to walk a viewer through the screenshot (1, 2, 3, …). Each **Step**'s number is a stable ID assigned at creation — deleting or undoing intermediate **Steps** never renumbers the others. The next **Step**'s number is `max(existing numbers) + 1`, falling back to 1 when no **Steps** exist — so clearing annotations, undoing back to empty, or pasting a new **Background** all restart at 1.
_Avoid_: callout (code/internal name only), marker, label, badge

**Background**:
The pasted screenshot the user is annotating.
_Avoid_: image, canvas

**Active color** (a.k.a. pen color):
The color new annotations are drawn in, shown as a swatch in the toolbar.
_Avoid_: pen, ink, fill color, brush color

**Palette**:
The fixed six-color set offered in the color picker popover.
_Avoid_: swatches, color list, presets

**Halo**:
The white stroke around text letters and around **Step** circles, plus the white number label inside each **Step**.
_Avoid_: outline, border, stroke

**Recolor**:
The act of changing color on the currently selected annotation(s).

**Line weight**:
The thickness that line-drawn **Annotations** (rectangles and arrows) are drawn at, chosen from three fixed presets (Thin / Medium / Thick) in a toolbar popover. Behaves like **Active color**: it applies to new annotations AND re-weights the currently selected annotation(s). Text, **Steps**, blur, and the **Halo** have no line weight.
_Avoid_: stroke width ("stroke" belongs to **Halo**), width (ambiguous with rectangle geometry), thickness (preset labels only, not the property name), pen size

## Relationships

- A **Background** hosts zero or more **Annotations**.
- Each **Annotation** stores its own color; the **Active color** is the pen used when creating new ones.
- Picking from the **Palette** sets the **Active color** AND **recolors** the current selection (if any).
- Each rectangle and arrow stores its own **Line weight**; picking a preset sets the active weight AND re-weights the current selection (if any) — the same dual behavior as the **Palette**.
- **Active color** resets to red and **Line weight** resets to Medium when a new image is pasted; neither is part of undo history.
- A **Halo** always stays white regardless of **Active color** — the **Palette** is constrained to colors against which white halos remain readable.

## Example dialogue

> **Dev:** "If the user picks green, do all the existing red arrows turn green?"
> **PM:** "No — only the selected one (if any) and any new ones the user draws. Each **Annotation** keeps its own color."
> **Dev:** "And if they paste a new screenshot?"
> **PM:** "The **Active color** resets back to red. Each screenshot starts fresh."
