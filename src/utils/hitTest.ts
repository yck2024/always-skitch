import { util, type FabricObject, type Point, type Polygon, type Rect } from 'fabric';

// Screen-pixel slop added around a Rectangle's border or an Arrow's drawn
// shape when deciding whether a sticky-tool click landed "on" it (ADR-0012).
// Callers convert to scene units using the actual canvas display scale.
export const HIT_TOLERANCE_PX = 6;

type Pt = { x: number; y: number };

function kindOf(object: FabricObject): string | undefined {
  return (object as FabricObject & { data?: { kind?: string } }).data?.kind;
}

// A Rectangle annotation is hollow, so only its border band (stroke plus
// tolerance) counts. Works in the rect's local space so moved, resized and
// rotated rects behave the same as a fresh one; the tolerance is divided by
// the object's scale so it stays constant on screen.
function hitsRectangleBorder(rect: Rect, pointer: Pt, tolerance: number): boolean {
  const local = util.transformPoint(pointer, util.invertTransform(rect.calcTransformMatrix()));
  const scaling = rect.getObjectScaling();
  const scaleX = Math.max(Math.abs(scaling.x), 1e-6);
  const scaleY = Math.max(Math.abs(scaling.y), 1e-6);
  const stroke = rect.strokeWidth ?? 0;
  // With strokeUniform the stroke keeps its width under scaling, so its local
  // thickness shrinks as the rect grows; otherwise it scales with the rect.
  const strokeX = rect.strokeUniform ? stroke / scaleX : stroke;
  const strokeY = rect.strokeUniform ? stroke / scaleY : stroke;
  const bandX = strokeX / 2 + tolerance / scaleX;
  const bandY = strokeY / 2 + tolerance / scaleY;
  const halfW = (rect.width ?? 0) / 2;
  const halfH = (rect.height ?? 0) / 2;
  const ax = Math.abs(local.x);
  const ay = Math.abs(local.y);
  const insideOuter = ax <= halfW + bandX && ay <= halfH + bandY;
  const insideInner = ax < halfW - bandX && ay < halfH - bandY;
  return insideOuter && !insideInner;
}

function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

function pointInPolygon(p: Pt, points: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// An Arrow is a tapered polygon, so "the drawn line" is the polygon itself:
// a hit is inside the silhouette or within tolerance of its outline. Points
// are stored polygon-local (offset by pathOffset), so map them through the
// object's transform to scene space first — see reweightArrow.
function hitsArrowShape(arrow: Polygon, pointer: Pt, tolerance: number): boolean {
  const matrix = arrow.calcTransformMatrix();
  const points = arrow.points.map((pt) =>
    util.transformPoint({ x: pt.x - arrow.pathOffset.x, y: pt.y - arrow.pathOffset.y }, matrix),
  );
  if (pointInPolygon(pointer, points)) return true;
  return points.some((pt, i) => distanceToSegment(pointer, pt, points[(i + 1) % points.length]) <= tolerance);
}

// Slack, in scene units, so a click exactly on an edge still counts as inside.
// Far smaller than a pixel and far larger than float noise (~1e-13 at the
// coordinates this app uses).
const BOX_EPSILON = 1e-6;

// Whole-box test: is the pointer inside the object's oriented bounding box
// (the quad Fabric draws its selection frame on)? Used instead of
// `object.containsPoint`, whose ray-cast aims at exactly the box's minX and
// so reports a point a hair above the top-left corner as inside, however far
// to the right it is (issue #45). Here the point is moved into the object's
// local space and compared with the box's half-size, which holds for any
// position, scale, rotation or skew. Edges are inclusive within BOX_EPSILON.
function hitsBoundingBox(object: FabricObject, pointer: Pt): boolean {
  const local = util.transformPoint(pointer, util.invertTransform(object.calcTransformMatrix()));
  // Fabric's local box is the object's own width/height plus the stroke. With
  // strokeUniform the stroke is not scaled, so convert its screen thickness
  // back to local units.
  const stroke = object.strokeWidth ?? 0;
  const scaling = object.getObjectScaling();
  const scaleX = Math.max(Math.abs(scaling.x), 1e-6);
  const scaleY = Math.max(Math.abs(scaling.y), 1e-6);
  const strokeX = object.strokeUniform ? stroke / scaleX : stroke;
  const strokeY = object.strokeUniform ? stroke / scaleY : stroke;
  const halfW = ((object.width ?? 0) + strokeX) / 2;
  const halfH = ((object.height ?? 0) + strokeY) / 2;
  return (
    Math.abs(local.x) <= halfW + BOX_EPSILON / scaleX && Math.abs(local.y) <= halfH + BOX_EPSILON / scaleY
  );
}

// Sticky-tool "did this click land on an existing annotation" test (ADR-0012).
// Hollow Rectangles and diagonal Arrows are matched on their drawn geometry
// only; every other kind keeps the bounding-box test because it looks solid.
// `tolerance` is in scene units (HIT_TOLERANCE_PX / displayScale).
export function annotationContainsPoint(object: FabricObject, pointer: Point, tolerance: number): boolean {
  switch (kindOf(object)) {
    case 'rectangle':
      return hitsRectangleBorder(object as Rect, pointer, tolerance);
    case 'arrow':
      return hitsArrowShape(object as Polygon, pointer, tolerance);
    default:
      return hitsBoundingBox(object, pointer);
  }
}
