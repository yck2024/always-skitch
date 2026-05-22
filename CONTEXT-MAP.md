# Context Map

This repo hosts two distinct annotation experiences. They share infrastructure (Fabric.js canvas, color palette, PNG export) but their domain models do not overlap.

## Contexts

- [Skitch](./CONTEXT.md) — single-screenshot quick markup at `/`. One **Background** hosts **Annotations**; pasting replaces.
- [Freeform](./src/freeform/CONTEXT.md) — multi-image annotation board at `/freeform`. A **Canvas** hosts **Images** and **Annotations**; pasting adds.

## Relationships

The two contexts share no runtime state — a user picks one route or the other. Code shared between them:

- Color **Palette** (the six approved Skitch colors)
- Fabric.js canvas plumbing
- PNG export & clipboard utilities

## Why two contexts and not one

The same word means different things in each context:

- **Canvas** and **Image** are central terms in Freeform but explicitly forbidden in Skitch (where "image" is ambiguous with **Background**).
- **Active color** resets on every paste in Skitch but persists across pastes in Freeform.
- **Annotations** sit on a singular **Background** in Skitch but live on a flat **Canvas** alongside **Images** in Freeform.

Merging these into one glossary would force every term to be qualified. Separate contexts keep each language clean.
