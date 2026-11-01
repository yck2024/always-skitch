import { ActiveSelection, util, type FabricObject } from 'fabric';

// The own-transform props Fabric rewrites while an object sits inside an
// ActiveSelection. Same list Fabric's SelectableCanvas uses when it realizes a
// selection member's transform for canvas.toJSON().
const TRANSFORM_PROPS = ['angle', 'flipX', 'flipY', 'left', 'top', 'scaleX', 'scaleY', 'skewX', 'skewY'] as const;

// Serialize one object with its transform in absolute (canvas scene)
// coordinates. While an ActiveSelection is live, each member's own
// left/top/angle/scale are relative to the selection's center, so a plain
// object.toObject() would bake group-relative positions into history, and
// restoring that snapshot would teleport the object. This folds the
// selection's transform into the object just long enough to serialize it,
// then puts the original values back, so the user's live selection is never
// disturbed. Objects that aren't in a selection serialize unchanged.
export function toAbsoluteObject(object: FabricObject, propertiesToInclude: string[]): Record<string, unknown> {
  const group = object.group;
  if (!(group instanceof ActiveSelection)) {
    return object.toObject(propertiesToInclude);
  }
  const original: Record<string, unknown> = {};
  for (const prop of TRANSFORM_PROPS) original[prop] = object[prop];
  util.addTransformToObject(object, group.calcOwnMatrix());
  try {
    return object.toObject(propertiesToInclude);
  } finally {
    object.set(original);
  }
}

// Axis-aligned bounding box of an object in absolute scene coordinates. Uses
// Fabric's getBoundingRect(), which accounts for rotation, scale, stroke and
// any enclosing ActiveSelection (unlike left/top + getScaledWidth/Height,
// which is the unrotated box from the origin corner and turns group-relative
// inside a selection). setCoords() first so the corner cache matches the
// object's current transform even when code moved it with a plain set().
export function absoluteBoundingRect(object: FabricObject): { left: number; top: number; width: number; height: number } {
  object.setCoords();
  return object.getBoundingRect();
}
