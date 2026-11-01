import type { FabricObject } from 'fabric';

// A Text annotation is a Fabric Textbox. It wraps words at its `width`, and
// when a single word is longer than that, Textbox.initDimensions widens the
// box to fit the word. It never narrows the box again, so after Enter splits a
// long line the Text (its selection outline, and Freeform's fitted canvas)
// keeps the old, wider width.
//
// The width the box should return to is its wrap width: the width it was
// created with, or the one the user last set with a side handle. It is kept in
// `data.wrapWidth`, which history snapshots serialize along with `kind`, so
// undo and redo keep it too.

type TextData = { kind?: string; wrapWidth?: number };
type TaggedObject = FabricObject & { data?: TextData };

function textData(object: FabricObject | undefined): TextData | undefined {
  const data = (object as TaggedObject | undefined)?.data;
  return data?.kind === 'text' ? data : undefined;
}

// object:modified handler: after the user drags a Text's side handle, that
// width becomes the one it wraps at.
export function rememberResizedTextWrapWidth(event: { target?: FabricObject; action?: string }) {
  const target = event.target;
  const data = textData(target);
  if (!target || !data || event.action !== 'resizing') return;
  (target as TaggedObject).data = { ...data, wrapWidth: target.width };
}

// Narrow a Text back to its wrap width, or to its longest word if that is
// wider (Fabric re-widens it as far as that word needs). Call on every text
// change, before anything measures the Text. Returns true if the width
// changed. A Text with no recorded wrap width is left alone.
export function fitTextWidthToContent(object: FabricObject): boolean {
  const wrapWidth = textData(object)?.wrapWidth;
  if (typeof wrapWidth !== 'number' || object.width <= wrapWidth) return false;
  const before = object.width;
  // Width is a Textbox layout property: set() re-runs initDimensions, which
  // re-wraps the text and widens the box again only if a word needs it.
  object.set('width', wrapWidth);
  object.setCoords();
  return object.width !== before;
}
