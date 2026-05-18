# Always Skitch

A static, browser-only image annotation app for marking up screenshots with bold, opinionated Skitch-style red annotations.

## Language

**Annotation**:
A shape drawn by the user on top of the background image (arrow, rectangle, text, callout, blur).
_Avoid_: shape, object, marker

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
The white stroke around text letters and around callout circles, plus the white label inside callout circles.
_Avoid_: outline, border, stroke

**Recolor**:
The act of changing color on the currently selected annotation(s).

## Relationships

- A **Background** hosts zero or more **Annotations**.
- Each **Annotation** stores its own color; the **Active color** is the pen used when creating new ones.
- Picking from the **Palette** sets the **Active color** AND **recolors** the current selection (if any).
- **Active color** resets to red when a new image is pasted, and is not part of undo history.
- A **Halo** always stays white regardless of **Active color** — the **Palette** is constrained to colors against which white halos remain readable.

## Example dialogue

> **Dev:** "If the user picks green, do all the existing red arrows turn green?"
> **PM:** "No — only the selected one (if any) and any new ones the user draws. Each **Annotation** keeps its own color."
> **Dev:** "And if they paste a new screenshot?"
> **PM:** "The **Active color** resets back to red. Each screenshot starts fresh."
