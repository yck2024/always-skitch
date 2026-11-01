import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  ActiveSelection,
  Canvas,
  Circle,
  FabricImage,
  FabricObject,
  Group,
  Line,
  Point,
  Polygon,
  Rect,
  Text,
  Shadow,
  Textbox,
  Triangle,
  util,
} from 'fabric';
import type { TOriginX, TOriginY } from 'fabric';
import type { Tool } from '../types';
import { hexToLowAlpha, recolorAnnotation } from '../utils/colors';
import { copyPngDataUrlToClipboard, downloadDataUrl } from '../utils/export';
import { HIT_TOLERANCE_PX, annotationContainsPoint } from '../utils/hitTest';
import { toAbsoluteObject } from '../utils/absoluteTransform';
import { fitTextWidthToContent, rememberResizedTextWrapWidth } from '../utils/textWidth';

// Fabric v7 changed the default origin to 'center'; this app's positioning math
// (background image at 0,0, drag-rect from start corner, callout offsets, etc.)
// assumes 'left'/'top'. Restore the v6 default globally.
FabricObject.ownDefaults.originX = 'left';
FabricObject.ownDefaults.originY = 'top';
// Fabric lets a handle dragged past the opposite edge flip the object (mirrored
// Step digit, backwards text). Lock that globally: the drag just stops at the
// opposite edge instead.
FabricObject.ownDefaults.lockScalingFlip = true;

const FONT_FAMILY = '"Arial Rounded MT Bold", Arial, Helvetica, system-ui, sans-serif';
const FONT_SIZE = 32;
const CALLOUT_SIZE = 42;
const PIXEL_SIZE = 12;
// Screen-pixel gutter around the Background (ADR-0013). Fabric can only draw
// and hit-test controls inside its own <canvas> element, so without a gutter
// the handles of an annotation at the image edge are cut off. 48 = the rotate
// knob's 40px offset above the box + its ~7px radius, so even the knob of an
// annotation flush with the top edge stays fully visible. Export crops it away.
const CANVAS_MARGIN_PX = 48;
// Screen pixels of an annotation that must stay over the Background when it is
// moved or resized, so there is always something left to grab (ADR-0013).
const MIN_VISIBLE_PX = 20;

type HistoryState = string;

type DrawingState =
  | { kind: 'rectangle'; startX: number; startY: number; object: Rect }
  | { kind: 'arrow'; startX: number; startY: number; line: Line; head: Triangle }
  | { kind: 'blur'; startX: number; startY: number; object: Rect };

interface CanvasEditorProps {
  imageDataUrl: string | null;
  activeTool: Tool;
  activeColor: string;
  activeWeight: number;
  onToolChange: (tool: Tool) => void;
  onToast: (text: string, tone?: 'success' | 'warning' | 'info') => void;
  onImageLoaded: (hasImage: boolean) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
}

export interface CanvasEditorHandle {
  undo: () => void;
  redo: () => void;
  deleteSelected: () => void;
  clearAnnotations: () => void;
  copyPng: () => Promise<void>;
  downloadPng: () => void;
  recolorSelected: (color: string) => void;
  reweightSelected: (weight: number) => void;
}

type KindedObject = FabricObject & { data?: { kind?: string } };
const kindOf = (object: FabricObject | undefined) => (object as KindedObject | undefined)?.data?.kind;

// A Rectangle's stroke must stay at its Line weight when the Rectangle is
// resized. Fabric resizes by scaling, which stretches the stroke unevenly and
// smears the rounded corners, so fold the scale into width/height and reset it
// to 1. The outer box (which includes the stroke) is kept exactly as dragged:
// (width + stroke) * scale = (width' + stroke). strokeWidth and rx/ry are left
// alone, so the weight and the corner radius stay what they were.
function bakeRectangleScale(rect: FabricObject) {
  const scaleX = rect.scaleX ?? 1;
  const scaleY = rect.scaleY ?? 1;
  if (scaleX === 1 && scaleY === 1) return;
  const stroke = rect.strokeWidth ?? 0;
  rect.set({
    width: Math.max(0, ((rect.width ?? 0) + stroke) * scaleX - stroke),
    height: Math.max(0, ((rect.height ?? 0) + stroke) * scaleY - stroke),
    scaleX: 1,
    scaleY: 1,
  });
  rect.setCoords();
}

// A Step is a circle, so it may only scale uniformly. Corner drags are
// proportional already, but Shift toggles that off, so average the two scales
// and put the anchored corner back where Fabric held it.
function keepStepCircular(step: FabricObject, transform?: { originX: TOriginX; originY: TOriginY }) {
  const scaleX = step.scaleX ?? 1;
  const scaleY = step.scaleY ?? 1;
  if (Math.abs(scaleX - scaleY) < 1e-6) return;
  const anchor = transform
    ? step.translateToOriginPoint(step.getRelativeCenterPoint(), transform.originX, transform.originY)
    : undefined;
  const scale = (scaleX + scaleY) / 2;
  step.set({ scaleX: scale, scaleY: scale });
  if (anchor && transform) step.setPositionByOrigin(anchor, transform.originX, transform.originY);
  step.setCoords();
}

// Steps hide the side handles (they would stretch the circle into an oval).
// `_controlsVisibility` is not serialized, so a Step restored by undo/redo
// comes back with all handles; re-apply on every selection instead.
function hideStepSideHandles(canvas: Canvas) {
  const active = canvas.getActiveObject();
  if (!active) return;
  const members = active instanceof ActiveSelection ? active.getObjects() : [active];
  if (!members.some((object) => kindOf(object) === 'callout')) return;
  active.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
}

function annotationObjects(canvas: Canvas) {
  return canvas.getObjects().filter((object) => (object as FabricObject & { data?: { kind?: string } }).data?.kind !== 'background');
}

// Snapshots are always taken in absolute coordinates, even while an
// ActiveSelection is live (group move/resize/rotate via object:modified, or a
// recolor of a multi-selection) — see toAbsoluteObject.

// The Text annotation currently in edit mode, if any. Fabric's
// textEditingManager keeps at most one IText editing per canvas. Iterate the
// objects rather than read getActiveObject(): a text created under the sticky
// Text tool is not the active object while it is edited (ADR-0008).
function findEditingText(canvas: Canvas): Textbox | undefined {
  return canvas.getObjects().find(
    (object) => (object as FabricObject & { data?: { kind?: string } }).data?.kind === 'text' && (object as Textbox).isEditing,
  ) as Textbox | undefined;
}
function serializeAnnotations(canvas: Canvas): HistoryState {
  return JSON.stringify(annotationObjects(canvas).map((object) => toAbsoluteObject(object, ['data'])));
}

function makeBackground(image: FabricImage) {
  image.set({
    left: 0,
    top: 0,
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
    lockMovementX: true,
    lockMovementY: true,
    data: { kind: 'background' },
  });
  return image;
}

function makeArrow(color: string, scale: number, weight: number, startX: number, startY: number, endX: number, endY: number) {
  // Skitch-style tapered arrow: a single polygon with a pointy tail, narrow
  // body, and a wide triangular head. Points are pre-rotated so we don't have
  // to fight Fabric's bbox-rotation pivot.
  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.hypot(dx, dy);
  const radians = Math.atan2(dy, dx);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotate = (x: number, y: number) => ({
    x: startX + x * cos - y * sin,
    y: startY + x * sin + y * cos,
  });
  // Head occupies ~22% of the length, with absolute min/max bounds for very
  // short/long arrows AND a hard cap at 40% so the head never dominates a
  // short arrow visually. Head is slightly narrower than long for a pointy
  // Skitch silhouette, and the body is thick enough to be clearly visible.
  const rawHeadLen = Math.min(Math.max(length * 0.22, 24 * scale), 80 * scale);
  const headLen = Math.min(rawHeadLen, length * 0.4);
  // Line weight (ADR-0011) scales only the cross-axis widths. headLen stays
  // length-proportional so a Thick short arrow doesn't turn into all head.
  // w = weight / 8 pins Medium to the pre-feature geometry: at weight 8,
  // headHalf is unchanged and the body floor (weight / 2) * scale is the
  // historical 4 * scale — pixel-identical to the old constants.
  const w = weight / 8;
  const headHalf = headLen * 0.42 * w;
  const bodyHalf = Math.max(headHalf * 0.32, (weight / 2) * scale);
  const bodyEnd = Math.max(0, length - headLen);
  const points = [
    rotate(0, 0),                       // tail tip
    rotate(bodyEnd, bodyHalf),          // body upper end
    rotate(bodyEnd, headHalf),          // head upper base
    rotate(length, 0),                  // arrow tip
    rotate(bodyEnd, -headHalf),         // head lower base
    rotate(bodyEnd, -bodyHalf),         // body lower end
  ];
  const polygon = new Polygon(points, {
    fill: color,
    strokeLineJoin: 'round',
  });
  polygon.set('data', { kind: 'arrow' });
  return polygon;
}

function reweightArrow(canvas: Canvas, poly: Polygon, weight: number, scale: number): Polygon {
  // A weight change can't be an in-place set() on an arrow: the taper is
  // baked into the polygon's point geometry, not carried by a strokeWidth.
  // Recover the arrow's absolute tail and tip and rebuild the polygon
  // between them at the new weight. In makeArrow's point order, points[0]
  // is the tail tip and points[3] the arrow tip (polygon-local space);
  // Fabric stores local points offset by pathOffset, so subtract it before
  // mapping through the object's transform matrix.
  const matrix = poly.calcTransformMatrix();
  const toAbsolute = (pt: { x: number; y: number }) =>
    util.transformPoint(new Point(pt.x - poly.pathOffset.x, pt.y - poly.pathOffset.y), matrix);
  const tail = toAbsolute(poly.points[0]);
  const tip = toAbsolute(poly.points[3]);
  const replacement = makeArrow(poly.fill as string, scale, weight, tail.x, tail.y, tip.x, tip.y);
  // Preserve interactivity flags and the stacking position so the swap is
  // invisible apart from the new thickness: capture the old index, remove
  // (indices after it shift down by one), add (appends on top), then move
  // the replacement back into the vacated slot.
  replacement.selectable = poly.selectable;
  replacement.evented = poly.evented;
  const index = canvas.getObjects().indexOf(poly);
  canvas.remove(poly);
  canvas.add(replacement);
  canvas.moveObjectTo(replacement, index);
  return replacement;
}

function updateArrowPreview(line: Line, head: Triangle, startX: number, startY: number, endX: number, endY: number) {
  const dx = endX - startX;
  const dy = endY - startY;
  line.set({ x2: endX, y2: endY });
  head.set({ left: endX, top: endY, angle: (Math.atan2(dy, dx) * 180) / Math.PI + 90 });
}

function makeText(color: string, scale: number, left: number, top: number) {
  const width = 260 * scale;
  return new Textbox('Text', {
    left,
    top,
    width,
    fill: color,
    stroke: '#ffffff',
    strokeWidth: 2.5 * scale,
    paintFirst: 'stroke',
    shadow: new Shadow({ color: 'rgba(0,0,0,0.35)', offsetX: 2 * scale, offsetY: 2 * scale, blur: 3 * scale }),
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE * scale,
    fontWeight: 900,
    editable: true,
    // wrapWidth: the width the box narrows back to once a long word is split
    // (utils/textWidth).
    data: { kind: 'text', wrapWidth: width },
  });
}

function makeCallout(color: string, scale: number, left: number, top: number, number: number) {
  const size = CALLOUT_SIZE * scale;
  const circle = new Circle({
    radius: size / 2,
    fill: color,
    stroke: '#ffffff',
    strokeWidth: 3 * scale,
    originX: 'center',
    originY: 'center',
  });
  const label = new Text(String(number), {
    fill: '#ffffff',
    fontFamily: FONT_FAMILY,
    fontSize: 24 * scale,
    fontWeight: 900,
    originX: 'center',
    originY: 'center',
  });
  const group = new Group([circle, label], {
    left: left - size / 2,
    top: top - size / 2,
  });
  group.set('data', { kind: 'callout' });
  return group;
}

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Shift `target` (one annotation or a multi-selection) by the smallest amount
// that leaves at least `minVisible` scene units of EVERY annotation inside the
// Background rect, never more than the annotation's own size. Clamps rather
// than deletes. If the members cannot all satisfy the rule at once (a
// selection spread wider than the image) it keeps at least one member visible.
function keepOnImage(target: FabricObject, image: { width: number; height: number }, minVisible: number) {
  const members = target instanceof ActiveSelection ? target.getObjects() : [target];
  const bounds = members.map((member) => {
    member.setCoords();
    const box: Bounds = member.getBoundingRect();
    return {
      box,
      visibleX: Math.min(minVisible, box.width, image.width),
      visibleY: Math.min(minVisible, box.height, image.height),
    };
  });
  let minDx = -Infinity;
  let maxDx = Infinity;
  let minDy = -Infinity;
  let maxDy = Infinity;
  bounds.forEach(({ box, visibleX, visibleY }) => {
    minDx = Math.max(minDx, visibleX - (box.left + box.width));
    maxDx = Math.min(maxDx, image.width - visibleX - box.left);
    minDy = Math.max(minDy, visibleY - (box.top + box.height));
    maxDy = Math.min(maxDy, image.height - visibleY - box.top);
  });
  let dx: number;
  let dy: number;
  if (minDx <= maxDx && minDy <= maxDy) {
    dx = Math.min(Math.max(0, minDx), maxDx);
    dy = Math.min(Math.max(0, minDy), maxDy);
  } else {
    let nearestDistance = Infinity;
    dx = 0;
    dy = 0;
    bounds.forEach(({ box, visibleX, visibleY }) => {
      const memberMinDx = visibleX - (box.left + box.width);
      const memberMaxDx = image.width - visibleX - box.left;
      const memberMinDy = visibleY - (box.top + box.height);
      const memberMaxDy = image.height - visibleY - box.top;
      const memberDx = Math.min(Math.max(0, memberMinDx), memberMaxDx);
      const memberDy = Math.min(Math.max(0, memberMinDy), memberMaxDy);
      const distance = memberDx ** 2 + memberDy ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        dx = memberDx;
        dy = memberDy;
      }
    });
  }
  if (dx === 0 && dy === 0) return false;
  target.set({ left: (target.left ?? 0) + dx, top: (target.top ?? 0) + dy });
  target.setCoords();
  return true;
}

function nextStepNumber(canvas: Canvas) {
  let max = 0;
  for (const object of canvas.getObjects()) {
    if ((object as FabricObject & { data?: { kind?: string } }).data?.kind !== 'callout') continue;
    const children = (object as Group).getObjects();
    const text = children.find((child): child is Text => child instanceof Text);
    const parsed = text ? parseInt(text.text ?? '', 10) : NaN;
    if (Number.isFinite(parsed) && parsed > max) max = parsed;
  }
  return max + 1;
}

function createPixelatedCrop(image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.ceil(safeWidth / PIXEL_SIZE));
  small.height = Math.max(1, Math.ceil(safeHeight / PIXEL_SIZE));
  const smallContext = small.getContext('2d')!;
  smallContext.imageSmoothingEnabled = false;
  smallContext.drawImage(image, x, y, safeWidth, safeHeight, 0, 0, small.width, small.height);

  const output = document.createElement('canvas');
  output.width = safeWidth;
  output.height = safeHeight;
  const outputContext = output.getContext('2d')!;
  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(small, 0, 0, small.width, small.height, 0, 0, safeWidth, safeHeight);
  return output.toDataURL('image/png');
}

export const CanvasEditor = forwardRef<CanvasEditorHandle, CanvasEditorProps>(function CanvasEditor(
  { imageDataUrl, activeTool, activeColor, activeWeight, onToolChange, onToast, onImageLoaded, onHistoryChange },
  ref,
) {
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const canvasShellRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const backgroundElementRef = useRef<HTMLImageElement | null>(null);
  const drawingRef = useRef<DrawingState | null>(null);
  const activeToolRef = useRef(activeTool);
  const activeColorRef = useRef(activeColor);
  const activeWeightRef = useRef(activeWeight);
  const historyRef = useRef<HistoryState[]>(['[]']);
  const historyIndexRef = useRef(0);
  // `restoringRef` suppresses saveHistory while a restore is mutating the
  // canvas.
  const restoringRef = useRef(false);
  // Queue rapid Undo/Redo so restores run one at a time and in press order.
  const restoreQueueRef = useRef<Promise<void>>(Promise.resolve());
  const displayScaleRef = useRef(1);
  // Per-gesture state, set on mouse:down:before and read on mouse:up. The
  // tool at press time keeps a click-place tool picked mid-drag (S / T) from
  // also placing a Step or Text on release (#43); the dismissal flag marks a
  // press that only ended text editing (ADR-0008), so the release is ignored.
  const pressToolRef = useRef<Tool | null>(null);
  const dismissGestureRef = useRef(false);

  const fitCanvasToViewport = () => {
    const canvas = canvasRef.current;
    const element = backgroundElementRef.current;
    if (!canvas || !element) return;
    const naturalWidth = element.naturalWidth;
    const naturalHeight = element.naturalHeight;
    if (!naturalWidth || !naturalHeight) return;
    // Derive the available size from the flex container (.canvas-shell) so the
    // canvas adapts to whatever chrome sits above it. Previously this used
    // `window.innerHeight - 150` — a hardcoded budget for a single toolbar that
    // silently broke when TopNav was added. The wrapper's getBoundingClientRect
    // already reflects flexbox-derived height, so no magic numbers needed.
    const shell = canvasShellRef.current;
    const rect = shell?.getBoundingClientRect();
    const fallbackWidth = Math.max(1, window.innerWidth - 64);
    const fallbackHeight = Math.max(1, window.innerHeight - 150);
    const maxWidth = rect && rect.width > 0 ? rect.width : fallbackWidth;
    const maxHeight = rect && rect.height > 0 ? rect.height : fallbackHeight;
    // The element is the Background plus a CANVAS_MARGIN_PX gutter on every
    // side (ADR-0013), so fit the Background into what is left after the gutter.
    const gutter = CANVAS_MARGIN_PX * 2;
    const scale = Math.min(Math.max(1, maxWidth - gutter) / naturalWidth, Math.max(1, maxHeight - gutter) / naturalHeight, 1);
    displayScaleRef.current = scale;
    canvas.setDimensions({ width: naturalWidth * scale + gutter, height: naturalHeight * scale + gutter });
    // Zoom AND pan: scene (0,0), the Background's corner, sits at the margin.
    canvas.setViewportTransform([scale, 0, 0, scale, CANVAS_MARGIN_PX, CANVAS_MARGIN_PX]);
    canvas.requestRenderAll();
  };

  useEffect(() => {
    activeToolRef.current = activeTool;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.selection = activeTool === 'select';
      annotationObjects(canvas).forEach((object) => {
        object.selectable = activeTool === 'select';
        object.evented = activeTool === 'select';
      });
      if (activeTool !== 'select') {
        canvas.discardActiveObject();
      }
      canvas.requestRenderAll();
    }
  }, [activeTool]);

  useEffect(() => {
    activeColorRef.current = activeColor;
  }, [activeColor]);

  // Ref mirror like activeColorRef above: the canvas-creation effect must NOT
  // depend on activeWeight (that would tear down and rebuild the Fabric
  // canvas on every preset change), so mouse handlers read the ref instead.
  useEffect(() => {
    activeWeightRef.current = activeWeight;
  }, [activeWeight]);

  useEffect(() => {
    if (!canvasElRef.current) return;

    // Seed selection from the current tool. The [activeTool] sync effect runs
    // before this one on mount, so if we hardcode `selection: true` here a
    // non-select initial tool would leave Fabric's group-selection marquee
    // active until the user toggles tools.
    const canvas = new Canvas(canvasElRef.current, {
      preserveObjectStacking: true,
      selection: activeToolRef.current === 'select',
    });
    canvasRef.current = canvas;

    const saveHistory = () => {
      if (restoringRef.current) return;
      const next = serializeAnnotations(canvas);
      const current = historyRef.current[historyIndexRef.current];
      if (next === current) return;
      historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1).concat(next);
      historyIndexRef.current = historyRef.current.length - 1;
      onHistoryChange(historyIndexRef.current > 0, historyIndexRef.current < historyRef.current.length - 1);
    };

    const annotationScale = () => 1 / Math.max(displayScaleRef.current, 0.25);

    const addFinalObject = (object: FabricObject) => {
      // Every drawing tool is sticky: stay on the tool, and keep finalized
      // objects non-interactive so the next click/drag starts a new annotation
      // instead of grabbing the previous one. Fabric IText edit mode uses a
      // hidden textarea that ignores the object's `evented` flag, so text
      // still types and click-outside-to-exit still fires from the canvas.
      const sticky = activeToolRef.current !== 'select';
      object.selectable = !sticky;
      object.evented = !sticky;
      if (!canvas.contains(object)) {
        canvas.add(object);
      }
      if (!sticky) {
        canvas.setActiveObject(object);
      }
      canvas.requestRenderAll();
      saveHistory();
      if (!sticky) {
        onToolChange('select');
      }
    };

    type CanvasPointerEvent = Parameters<typeof canvas.getScenePoint>[0];
    const pointerFromEvent = (event: { e: CanvasPointerEvent }) => canvas.getScenePoint(event.e);

    // New annotations anchor and end on the Background, never in the margin or
    // beyond it (ADR-0013): a drag that overshoots the edge stops at the edge,
    // which is also what the export shows, and a click in the gutter can't
    // place an annotation that is entirely off the image.
    const clampPointToImage = (point: Point) => {
      const element = backgroundElementRef.current;
      if (!element) return point;
      return new Point(
        Math.min(Math.max(point.x, 0), element.naturalWidth),
        Math.min(Math.max(point.y, 0), element.naturalHeight),
      );
    };

    // Keep every moved or resized annotation at least partly over the image
    // (ADR-0013). Runs live while dragging, and again when the gesture ends so
    // a resize that dragged the box off is pulled back before history records it.
    const keepTargetOnImage = (event: { target?: FabricObject }) => {
      const element = backgroundElementRef.current;
      const target = event.target;
      if (!element || !target) return;
      keepOnImage(
        target,
        { width: element.naturalWidth, height: element.naturalHeight },
        MIN_VISIBLE_PX / Math.max(displayScaleRef.current, 1e-6),
      );
    };

    // ADR-0008: while a text is being edited, the next canvas press belongs to
    // it. This runs on mouse:down:before, ahead of Fabric's own target search
    // and selection, and ahead of handleMouseDown's sticky-tool escape.
    const handleMouseDownBefore = (event: { e: CanvasPointerEvent }) => {
      pressToolRef.current = activeToolRef.current;
      dismissGestureRef.current = false;
      const editingText = findEditingText(canvas);
      if (!editingText) return;
      if (editingText.containsPoint(pointerFromEvent(event))) {
        // Click inside: let IText place the caret or drag-select. Fabric only
        // does that for the active object; a text created under the sticky
        // Text tool is not one, so make it active here (it is already
        // evented — see handleTextEditingEntered).
        if (canvas.getActiveObject() !== editingText) canvas.setActiveObject(editingText);
        return;
      }
      // Click outside: finish typing. Under a drawing tool the press is
      // consumed — the editing:exited listener switches the tool to Select,
      // and nothing beneath the click is selected or drawn (#35).
      editingText.exitEditing();
      canvas.requestRenderAll();
      if (pressToolRef.current !== 'select') dismissGestureRef.current = true;
    };

    const handleMouseDown = (event: { e: CanvasPointerEvent }) => {
      if (dismissGestureRef.current) return;
      if (!backgroundElementRef.current || activeToolRef.current === 'select') return;
      const rawPointer = pointerFromEvent(event);
      const pointer = clampPointToImage(rawPointer);

      // A press inside the text being edited moves its caret (see
      // handleMouseDownBefore); it must not hit the sticky-tool escape below,
      // which would flip the tool to Select mid-edit (#46).
      if (findEditingText(canvas)?.containsPoint(pointer)) return;

      // If the click landed on an existing annotation, escape sticky mode:
      // switch to Select and pick the object up instead of stacking a new
      // annotation on top. Annotations are evented=false while a drawing tool
      // is active, so Fabric's own hit-test won't see them — we walk them
      // manually. Hollow Rectangles and Arrows match on border / drawn line
      // only (ADR-0012), so a click in a Rectangle's empty inside falls
      // through to the active tool.
      const hit = annotationObjects(canvas).find((object) =>
        annotationContainsPoint(object, rawPointer, HIT_TOLERANCE_PX / displayScaleRef.current),
      );
      if (hit) {
        activeToolRef.current = 'select';
        hit.selectable = true;
        hit.evented = true;
        canvas.setActiveObject(hit);
        canvas.requestRenderAll();
        onToolChange('select');
        return;
      }

      const scale = annotationScale();

      const color = activeColorRef.current;
      const weight = activeWeightRef.current;

      if (activeToolRef.current === 'rectangle') {
        const rect = new Rect({
          left: pointer.x,
          top: pointer.y,
          width: 1,
          height: 1,
          fill: 'transparent',
          stroke: color,
          strokeWidth: weight * scale,
          rx: 5 * scale,
          ry: 5 * scale,
          data: { kind: 'rectangle' },
        });
        canvas.add(rect);
        drawingRef.current = { kind: 'rectangle', startX: pointer.x, startY: pointer.y, object: rect };
      } else if (activeToolRef.current === 'arrow') {
        const line = new Line([pointer.x, pointer.y, pointer.x, pointer.y], {
          stroke: color,
          strokeWidth: weight * scale,
          strokeLineCap: 'round',
          selectable: false,
          evented: false,
        });
        const head = new Triangle({
          left: pointer.x,
          top: pointer.y,
          // The preview head tracks the weight the same way makeArrow does:
          // cross-axis width scales by weight / 8, length (height) does not.
          width: 34 * scale * (weight / 8),
          height: 42 * scale,
          fill: color,
          originX: 'center',
          originY: 'center',
          selectable: false,
          evented: false,
        });
        canvas.add(line, head);
        drawingRef.current = { kind: 'arrow', startX: pointer.x, startY: pointer.y, line, head };
      } else if (activeToolRef.current === 'blur') {
        const rect = new Rect({
          left: pointer.x,
          top: pointer.y,
          width: 1,
          height: 1,
          fill: hexToLowAlpha(color, 0.08),
          stroke: color,
          strokeDashArray: [12 * scale, 8 * scale],
          strokeWidth: 3 * scale,
          data: { kind: 'blur-preview' },
        });
        canvas.add(rect);
        drawingRef.current = { kind: 'blur', startX: pointer.x, startY: pointer.y, object: rect };
      }
    };

    const handleMouseMove = (event: { e: CanvasPointerEvent }) => {
      const drawing = drawingRef.current;
      if (!drawing) return;
      const pointer = clampPointToImage(pointerFromEvent(event));
      if (drawing.kind === 'rectangle' || drawing.kind === 'blur') {
        drawing.object.set({
          left: Math.min(pointer.x, drawing.startX),
          top: Math.min(pointer.y, drawing.startY),
          width: Math.abs(pointer.x - drawing.startX),
          height: Math.abs(pointer.y - drawing.startY),
        });
        // .set() updates the props but doesn't refresh aCoords, which Fabric
        // uses for hit-testing. Without this, clicks on the finished rect
        // miss because Fabric still thinks it's a 1x1 box at the start point.
        drawing.object.setCoords();
      } else {
        updateArrowPreview(drawing.line, drawing.head, drawing.startX, drawing.startY, pointer.x, pointer.y);
      }
      canvas.requestRenderAll();
    };

    const finishDrawing = async (drawing: DrawingState, event: { e: CanvasPointerEvent }) => {
      const pointer = clampPointToImage(pointerFromEvent(event));

      if (drawing.kind === 'rectangle') {
        if ((drawing.object.width ?? 0) < 4 || (drawing.object.height ?? 0) < 4) {
          canvas.remove(drawing.object);
        } else {
          addFinalObject(drawing.object);
        }
      } else if (drawing.kind === 'arrow') {
        canvas.remove(drawing.line, drawing.head);
        if (Math.hypot(pointer.x - drawing.startX, pointer.y - drawing.startY) > 10) {
          addFinalObject(
            makeArrow(activeColorRef.current, annotationScale(), activeWeightRef.current, drawing.startX, drawing.startY, pointer.x, pointer.y),
          );
        }
      } else {
        canvas.remove(drawing.object);
        const left = Math.min(pointer.x, drawing.startX);
        const top = Math.min(pointer.y, drawing.startY);
        const width = Math.abs(pointer.x - drawing.startX);
        const height = Math.abs(pointer.y - drawing.startY);
        if (width > 8 && height > 8 && backgroundElementRef.current) {
          const dataUrl = createPixelatedCrop(backgroundElementRef.current, left, top, width, height);
          const image = await FabricImage.fromURL(dataUrl);
          image.set({ left, top, data: { kind: 'pixelate' } });
          addFinalObject(image);
        }
      }
      canvas.requestRenderAll();
    };

    const handleCanvasClick = (event: { e: CanvasPointerEvent }) => {
      if (!backgroundElementRef.current) return;
      const pointer = clampPointToImage(pointerFromEvent(event));
      const scale = annotationScale();
      const color = activeColorRef.current;
      if (activeToolRef.current === 'text') {
        // ADR-0008: dismissal guard. Fabric only auto-exits the old editing
        // text when a NEW IText calls enterEditing() (enterEditingImpl in
        // node_modules/fabric/dist/index.mjs), so creating here while a text
        // is editing would spawn a redundant box. handleMouseDownBefore
        // already ended editing for a press outside the text and consumed
        // the gesture; this guard covers what still reaches us — a click
        // inside the editing text (IText moves the caret) and the
        // mouse:dblclick route — so no second text is ever created.
        // containsPoint, not event.target identity: Fabric does not report
        // non-evented objects as event targets.
        const editingText = findEditingText(canvas);
        if (editingText) {
          if (editingText.containsPoint(pointer)) {
            return;
          }
          editingText.exitEditing();
          return;
        }

        const text = makeText(color, scale, pointer.x, pointer.y);
        const image = backgroundElementRef.current;
        if (image) {
          keepOnImage(text, { width: image.naturalWidth, height: image.naturalHeight }, MIN_VISIBLE_PX / Math.max(displayScaleRef.current, 1e-6));
        }
        addFinalObject(text);
        text.enterEditing();
        text.selectAll();
        // ADR-0008: however editing exits (Esc, a click on or off the
        // canvas, the toolbar), snap back to Select so the gesture that
        // finished typing doesn't leave Text armed. This object-level event
        // fires before the canvas-level text:editing:exited, so
        // handleTextEditingExited already sees the Select tool. `once`
        // self-detaches so re-editing the same Textbox later doesn't
        // reapply the snap.
        // The synchronous ref write is defensive against any event
        // ordering where a follow-up mouse handler reads activeToolRef
        // before React's setState flush.
        text.once('editing:exited', () => {
          activeToolRef.current = 'select';
          onToolChange('select');
        });
      } else if (activeToolRef.current === 'callout') {
        addFinalObject(makeCallout(color, scale, pointer.x, pointer.y, nextStepNumber(canvas)));
      }
    };

    // One mouse:up for the whole gesture: a drag finalizes its drawing and
    // stops there; only a press that started under a click-place tool (Text,
    // Step) and still has it places an object. Reading just the current tool
    // let S or T pressed mid-drag add a Step or Text at the release (#43).
    const handleMouseUp = (event: { e: CanvasPointerEvent }) => {
      const pressTool = pressToolRef.current;
      pressToolRef.current = null;
      if (dismissGestureRef.current) {
        dismissGestureRef.current = false;
        return;
      }
      const drawing = drawingRef.current;
      if (drawing) {
        drawingRef.current = null;
        void finishDrawing(drawing, event);
        return;
      }
      const tool = activeToolRef.current;
      if ((tool === 'text' || tool === 'callout') && pressTool === tool) {
        handleCanvasClick(event);
      }
    };

    // Fabric picks the press target before mouse:down:before fires, so a text
    // must already be evented for a click inside it to reach IText (caret
    // placement, drag-select). A text created under the sticky Text tool is
    // not; make any text evented for as long as it is being edited.
    const handleTextEditingEntered = ({ target }: { target: FabricObject }) => {
      target.evented = true;
    };

    // Runs after every exit from text editing, however it ended (Esc, a click
    // on the canvas or outside it, the toolbar, re-editing another text).
    // Fabric's exitEditing() restores the selectable flag saved when editing
    // began — false for a text created under the sticky Text tool — so when
    // the tool was already Select before the exit, nothing else would make
    // the text selectable again (#46). Re-sync it with the current tool; the
    // per-text editing:exited listener has already switched to Select for a
    // fresh text. An emptied text is removed instead of lingering as an
    // invisible box that grabs later clicks (#36).
    const handleTextEditingExited = ({ target }: { target: FabricObject }) => {
      if (!canvas.contains(target)) return;
      if (((target as Textbox).text ?? '').trim() === '') {
        canvas.remove(target);
        canvas.requestRenderAll();
        saveHistory();
        return;
      }
      const isSelect = activeToolRef.current === 'select';
      target.selectable = isSelect;
      target.evented = isSelect;
      if (!isSelect && canvas.getActiveObject() === target) canvas.discardActiveObject();
      canvas.requestRenderAll();
    };

    // A press outside the canvas (page margin, toolbar) ends editing. Fabric's
    // hidden-textarea blur only stops the caret blink, which left the text in
    // edit mode with the Text tool still armed.
    const handleDocumentPointerDown = (event: PointerEvent) => {
      const editingText = findEditingText(canvas);
      if (!editingText) return;
      const target = event.target as Node | null;
      if (target && (canvas.upperCanvasEl.contains(target) || target === editingText.hiddenTextarea)) return;
      editingText.exitEditing();
      canvas.requestRenderAll();
    };

    canvas.on('mouse:down:before', handleMouseDownBefore);
    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);
    canvas.on('mouse:dblclick', handleCanvasClick);
    // Resize hooks (#38, #41). Live, so the stroke never looks stretched and
    // a Step never looks like an oval while the handle is being dragged...
    canvas.on('object:scaling', (event) => {
      const kind = kindOf(event.target);
      if (kind === 'rectangle') bakeRectangleScale(event.target);
      else if (kind === 'callout') keepStepCircular(event.target, event.transform);
    });
    // ...and once more on release, which also covers Rectangles resized as part
    // of a multi-selection (their scale only becomes their own after the
    // selection is dropped). Registered BEFORE the clamp and saveHistory so the
    // snapshot already holds baked, clamped geometry.
    canvas.on('object:modified', (event) => {
      const target = event.target;
      if (target instanceof ActiveSelection) {
        const members = target.getObjects();
        if (members.some((object) => kindOf(object) === 'rectangle')) {
          canvas.discardActiveObject();
          members.forEach((object) => {
            if (kindOf(object) === 'rectangle') bakeRectangleScale(object);
          });
          canvas.setActiveObject(new ActiveSelection(members, { canvas }));
        }
      } else if (kindOf(target) === 'rectangle') {
        bakeRectangleScale(target);
      }
    });
    canvas.on('object:moving', keepTargetOnImage);
    // Registered before saveHistory so the recorded state is the clamped one.
    canvas.on('object:modified', keepTargetOnImage);
    canvas.on('object:modified', rememberResizedTextWrapWidth);
    canvas.on('object:modified', saveHistory);
    // A line break can shorten a Text's longest word; narrow the box to match
    // before the snapshot records it (utils/textWidth). An emptied text is not
    // snapshotted: it is removed when editing ends (#36), and an empty-text
    // state in history would let Undo bring back the invisible box.
    canvas.on('text:changed', ({ target }) => {
      if (fitTextWidthToContent(target)) canvas.requestRenderAll();
      if ((target.text ?? '').trim() !== '') saveHistory();
    });
    canvas.on('text:editing:entered', handleTextEditingEntered);
    canvas.on('text:editing:exited', handleTextEditingExited);
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    const syncStepHandles = () => hideStepSideHandles(canvas);
    canvas.on('selection:created', syncStepHandles);
    canvas.on('selection:updated', syncStepHandles);

    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      canvas.dispose();
      canvasRef.current = null;
    };
  }, [onHistoryChange, onImageLoaded, onToast, onToolChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageDataUrl) return;
    const sourceUrl: string = imageDataUrl;
    const currentCanvas = canvas;

    let cancelled = false;
    async function loadImage() {
      const image = await FabricImage.fromURL(sourceUrl);
      if (cancelled) return;
      const element = image.getElement() as HTMLImageElement;
      backgroundElementRef.current = element;
      currentCanvas.clear();
      currentCanvas.add(makeBackground(image));
      currentCanvas.sendObjectToBack(image);
      fitCanvasToViewport();
      historyRef.current = ['[]'];
      historyIndexRef.current = 0;
      onHistoryChange(false, false);
      onImageLoaded(true);
      currentCanvas.requestRenderAll();
    }

    loadImage().catch(() => onToast('Could not load that clipboard image.', 'warning'));
    return () => {
      cancelled = true;
    };
  }, [imageDataUrl, onHistoryChange, onImageLoaded, onToast]);

  useEffect(() => {
    const handleResize = () => fitCanvasToViewport();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const restoreHistory = async (state: HistoryState) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    restoringRef.current = true;
    annotationObjects(canvas).forEach((object) => canvas.remove(object));
    const parsed = JSON.parse(state) as Record<string, unknown>[];
    const objects = await util.enlivenObjects(parsed);
    objects.forEach((object) => canvas.add(object as FabricObject));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    restoringRef.current = false;
    onHistoryChange(historyIndexRef.current > 0, historyIndexRef.current < historyRef.current.length - 1);
  };

  // Run restores one at a time, in the order Undo/Redo were pressed. The
  // state is read when the key is pressed, so a burst of presses walks the
  // history exactly once per press. `.then(noop, noop)` keeps the chain alive
  // if a restore rejects.
  const queueRestore = (state: HistoryState) => {
    const next = restoreQueueRef.current.then(() => restoreHistory(state));
    restoreQueueRef.current = next.then(
      () => undefined,
      () => undefined,
    );
  };

  const exportDataUrl = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    // Invert the fit-to-viewport scale so the exported PNG keeps the source image's natural resolution.
    const scale = displayScaleRef.current > 0 ? displayScaleRef.current : 1;
    const element = backgroundElementRef.current;
    if (!element) return null;
    // Crop to the Background alone: the margin gutter (ADR-0013) and anything
    // an annotation hangs over the edge never reach the PNG. The crop is half
    // a source pixel taller/wider than the image because Fabric truncates the
    // output size, and width * scale * (1 / scale) can land a hair under the
    // integer (a 2400px image exported as 2399px); the half pixel absorbs
    // that so the PNG is always exactly the Background's size.
    return canvas.toDataURL({
      format: 'png',
      multiplier: 1 / scale,
      left: CANVAS_MARGIN_PX,
      top: CANVAS_MARGIN_PX,
      width: (element.naturalWidth + 0.5) * scale,
      height: (element.naturalHeight + 0.5) * scale,
    });
  };

  useImperativeHandle(ref, () => ({
    undo: () => {
      if (historyIndexRef.current <= 0) return;
      historyIndexRef.current -= 1;
      queueRestore(historyRef.current[historyIndexRef.current]);
    },
    redo: () => {
      if (historyIndexRef.current >= historyRef.current.length - 1) return;
      historyIndexRef.current += 1;
      queueRestore(historyRef.current[historyIndexRef.current]);
    },
    deleteSelected: () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const activeObjects = canvas.getActiveObjects().filter((object) => (object as FabricObject & { data?: { kind?: string } }).data?.kind !== 'background');
      activeObjects.forEach((object) => canvas.remove(object));
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      const next = serializeAnnotations(canvas);
      if (next !== historyRef.current[historyIndexRef.current]) {
        historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1).concat(next);
        historyIndexRef.current = historyRef.current.length - 1;
        onHistoryChange(true, false);
      }
    },
    clearAnnotations: () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      annotationObjects(canvas).forEach((object) => canvas.remove(object));
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1).concat('[]');
      historyIndexRef.current = historyRef.current.length - 1;
      onHistoryChange(historyIndexRef.current > 0, false);
    },
    copyPng: async () => {
      const dataUrl = exportDataUrl();
      if (!dataUrl) return;
      const copied = await copyPngDataUrlToClipboard(dataUrl);
      if (copied) {
        onToast('Copied PNG to clipboard', 'success');
      } else {
        downloadDataUrl(dataUrl);
        onToast('Clipboard copy not supported. Downloaded PNG instead.', 'warning');
      }
    },
    downloadPng: () => {
      const dataUrl = exportDataUrl();
      if (dataUrl) downloadDataUrl(dataUrl);
    },
    recolorSelected: (color: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const activeObjects = canvas
        .getActiveObjects()
        .filter((object) => (object as FabricObject & { data?: { kind?: string } }).data?.kind !== 'background');
      if (activeObjects.length === 0) return;
      activeObjects.forEach((object) => recolorAnnotation(object, color));
      canvas.requestRenderAll();
      const next = serializeAnnotations(canvas);
      if (next !== historyRef.current[historyIndexRef.current]) {
        historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1).concat(next);
        historyIndexRef.current = historyRef.current.length - 1;
        onHistoryChange(true, false);
      }
    },
    reweightSelected: (weight: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const activeObjects = canvas
        .getActiveObjects()
        .filter((object) => (object as FabricObject & { data?: { kind?: string } }).data?.kind !== 'background');
      if (activeObjects.length === 0) return;
      // Drop the selection BEFORE touching geometry: while an ActiveSelection
      // is live, Fabric rewrites members' own transforms to group-relative
      // coordinates, so calcTransformMatrix() inside reweightArrow would bake
      // in the group transform and recover wrong absolute tail/tip points.
      // Discarding restores plain absolute transforms; we re-select below.
      canvas.discardActiveObject();
      // Same annotationScale the annotations were created with, so a preset's
      // canvas-px value lands identically whether set at draw time or here.
      const scale = 1 / Math.max(displayScaleRef.current, 0.25);
      const reselect = activeObjects.map((object) => {
        const kind = (object as FabricObject & { data?: { kind?: string } }).data?.kind;
        if (kind === 'rectangle') {
          object.set({ strokeWidth: weight * scale });
          object.setCoords();
          return object;
        }
        if (kind === 'arrow') {
          // Arrows are rebuilt, not mutated — the returned replacement takes
          // the old polygon's place in the re-selection.
          return reweightArrow(canvas, object as Polygon, weight, scale);
        }
        // Text, Steps, blur, and pixelate have no line weight — silently
        // skip them (recolorSelected's behavior), but keep them selected.
        return object;
      });
      // Serialize while the selection is discarded. serializeAnnotations is
      // absolute even inside an ActiveSelection (toAbsoluteObject), so this
      // order is no longer load-bearing for positions; it simply snapshots
      // the plain, unwrapped objects.
      const next = serializeAnnotations(canvas);
      if (next !== historyRef.current[historyIndexRef.current]) {
        historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1).concat(next);
        historyIndexRef.current = historyRef.current.length - 1;
        onHistoryChange(true, false);
      }
      if (reselect.length === 1) {
        canvas.setActiveObject(reselect[0]);
      } else {
        canvas.setActiveObject(new ActiveSelection(reselect, { canvas }));
      }
      canvas.requestRenderAll();
    },
  }));

  return (
    <section className="canvas-shell" aria-label="Annotation canvas" ref={canvasShellRef}>
      {!imageDataUrl ? (
        <div className="empty-state">
          <div className="empty-icon">⌘V</div>
          <h1>Paste a screenshot to start</h1>
          <p>Use Cmd+V or click Paste Image</p>
        </div>
      ) : null}
      <div className={imageDataUrl ? 'canvas-wrap visible skitch-wrap' : 'canvas-wrap'}>
        <canvas ref={canvasElRef} />
      </div>
    </section>
  );
});
