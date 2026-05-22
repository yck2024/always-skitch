import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  Canvas,
  Circle,
  FabricImage,
  FabricObject,
  Group,
  Line,
  Point,
  Polygon,
  Rect,
  Shadow,
  Text,
  Textbox,
  Triangle,
  util,
} from 'fabric';
import type { Tool } from '../types';
import { recolorAnnotation } from '../utils/colors';

// Fabric v7 changed the default origin to 'center'; Skitch already resets this
// globally in src/components/CanvasEditor.tsx. We rely on that here. If a user
// loads Freeform first (the singleton there hasn't run), the static field
// assignment is idempotent so importing both is safe — but for robustness we
// repeat it. Cheap and explicit beats "remember the import order".
FabricObject.ownDefaults.originX = 'left';
FabricObject.ownDefaults.originY = 'top';

// Maximum display width for a newly pasted Image. We never touch the underlying
// HTMLImageElement's pixels — only Fabric's `width`/`height` (which control
// display size). Source pixels stay at naturalWidth/naturalHeight, so later
// export at higher resolution remains an option.
const MAX_PASTE_WIDTH = 800;
// Horizontal gap between adjacent pasted Images in the auto-row layout.
const PASTE_GAP = 24;
// Annotation visual constants — these mirror Skitch's exactly so annotations
// drawn in Freeform look identical to ones drawn in Skitch. Duplication is
// intentional: extracting a shared module risks coupling the two editors
// before we know whether they'll diverge (e.g., Freeform might want different
// arrow proportions for multi-image flows). For now, parallel constants beat
// premature abstraction.
const STROKE_WIDTH = 8;
const FONT_FAMILY = '"Arial Rounded MT Bold", Arial, Helvetica, system-ui, sans-serif';
const FONT_SIZE = 32;
const CALLOUT_SIZE = 42;

// Drawing state for mouse-drag tools (arrow, rectangle). Click-place tools
// (text, callout) finalize immediately so they don't appear here.
type DrawingState =
  | { kind: 'rectangle'; startX: number; startY: number; object: Rect }
  | { kind: 'arrow'; startX: number; startY: number; line: Line; head: Triangle };

interface CanvasEditorProps {
  // True when the parent thinks at least one Image is on the canvas. Drives
  // the empty-state vs canvas display in the parent; the canvas itself is the
  // source of truth for object count.
  hasImages: boolean;
  // Currently-selected tool. Drives mouse-handler behavior and selectability of
  // existing Images AND annotations: in Select mode both are interactive; in
  // any drawing mode they're frozen so clicks start new shapes instead of
  // grabbing old ones (with a click-on-existing-annotation escape — see
  // handleMouseDown).
  activeTool: Tool;
  // Active pen color for new annotations. Lives in App.tsx state so it persists
  // across pastes (ADR-0003 / CONTEXT divergence from Skitch). Recolor of the
  // current selection is driven via the imperative `recolorSelected` method,
  // NOT via this prop changing — that way we don't re-fire recolor on every
  // unrelated render.
  activeColor: string;
  onHasImagesChange: (hasImages: boolean) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
  onToast: (text: string, tone?: 'success' | 'warning' | 'info') => void;
  // Called when the editor wants to switch tools itself — e.g., click on an
  // existing annotation while a drawing tool is active escapes to Select.
  onToolChange: (tool: Tool) => void;
}

export interface FreeformCanvasEditorHandle {
  addImage: (dataUrl: string) => Promise<void>;
  undo: () => void;
  redo: () => void;
  recolorSelected: (color: string) => void;
  // Remove every selected Image from the canvas. Annotations on top of a
  // deleted Image stay (ADR-0003: canvas-level annotations). The filter is
  // defensive so a future Annotation selection model can't accidentally
  // vacuum them up.
  deleteSelected: () => void;
}

// Every canvas object Freeform creates gets a `data.kind` tag so future tooling
// (selection, deletion, recolor) can discriminate Image vs Annotation. Image is
// the only non-annotation kind today; anything else with a `data.kind` set is
// an Annotation by elimination.
type TaggedObject = FabricObject & { data?: { kind?: string } };

function imageObjects(canvas: Canvas): FabricObject[] {
  return canvas.getObjects().filter((object) => (object as TaggedObject).data?.kind === 'image');
}

function annotationObjects(canvas: Canvas): FabricObject[] {
  return canvas.getObjects().filter((object) => {
    const kind = (object as TaggedObject).data?.kind;
    return kind !== undefined && kind !== 'image';
  });
}

// All Freeform-tagged content, in render order (background-to-foreground).
function freeformObjects(canvas: Canvas): FabricObject[] {
  return canvas.getObjects().filter((object) => (object as TaggedObject).data?.kind !== undefined);
}

// Apply per-Image interaction defaults: hide the middle (side) scaling handles
// and the rotation handle so only corner resize is offered. The aspect-ratio
// lock during corner resize is handled at the Canvas level (uniformScaling:
// true, uniScaleKey: 'shiftKey') — the Image itself doesn't need lockScaling
// flags. Called in two places: when a new Image is added, and after history
// restore (because `_controlsVisibility` is an instance field that isn't
// captured by Fabric's serialization).
function applyImageInteractionDefaults(image: FabricObject) {
  image.setControlsVisibility({
    mt: false,
    mb: false,
    ml: false,
    mr: false,
    mtr: false,
  });
}

// Skitch filters out the background singleton when serializing. Freeform has no
// such thing — every tagged object on the canvas is part of user state. We
// include `selectable`/`evented` in the prop list so per-object interaction
// flags round-trip through history restore. `data` carries our kind tag. The
// per-Image `_controlsVisibility` settings are NOT serialized by Fabric, so
// `restoreHistory` reapplies them via `applyImageInteractionDefaults`.
function serializeAll(canvas: Canvas): string {
  return JSON.stringify(canvas.getObjects().map((object) => object.toObject(['data', 'selectable', 'evented'])));
}

// Compute the right-edge X of the rightmost Image currently on the canvas.
// Derived from canvas content (not a separate ref) so undo/redo naturally
// affect where the next paste lands without us syncing two sources of truth.
// Only Images participate in the auto-row layout — Annotations float on top
// and don't shift the paste cursor.
function nextImageLeft(canvas: Canvas): number {
  const images = imageObjects(canvas);
  if (images.length === 0) return 0;
  let maxRight = 0;
  for (const image of images) {
    const right = (image.left ?? 0) + (image.getScaledWidth?.() ?? image.width ?? 0);
    if (right > maxRight) maxRight = right;
  }
  return maxRight + PASTE_GAP;
}

// Skitch-style tapered arrow: a single polygon with a pointy tail, narrow body,
// and a wide triangular head. Points are pre-rotated so we don't have to fight
// Fabric's bbox-rotation pivot. Lifted from src/components/CanvasEditor.tsx —
// kept as a local helper rather than imported because Freeform may diverge
// (e.g., a future zoom-aware arrow could behave differently per Image).
function makeArrow(color: string, scale: number, startX: number, startY: number, endX: number, endY: number) {
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
  const rawHeadLen = Math.min(Math.max(length * 0.22, 24 * scale), 80 * scale);
  const headLen = Math.min(rawHeadLen, length * 0.4);
  const headHalf = headLen * 0.42;
  const bodyHalf = Math.max(headHalf * 0.32, 4 * scale);
  const bodyEnd = Math.max(0, length - headLen);
  const points = [
    rotate(0, 0),
    rotate(bodyEnd, bodyHalf),
    rotate(bodyEnd, headHalf),
    rotate(length, 0),
    rotate(bodyEnd, -headHalf),
    rotate(bodyEnd, -bodyHalf),
  ];
  const polygon = new Polygon(points, {
    fill: color,
    strokeLineJoin: 'round',
  });
  polygon.set('data', { kind: 'arrow' });
  return polygon;
}

function updateArrowPreview(line: Line, head: Triangle, startX: number, startY: number, endX: number, endY: number) {
  const dx = endX - startX;
  const dy = endY - startY;
  line.set({ x2: endX, y2: endY });
  head.set({ left: endX, top: endY, angle: (Math.atan2(dy, dx) * 180) / Math.PI + 90 });
}

function makeText(color: string, scale: number, left: number, top: number) {
  return new Textbox('Text', {
    left,
    top,
    width: 260 * scale,
    fill: color,
    stroke: '#ffffff',
    strokeWidth: 2.5 * scale,
    paintFirst: 'stroke',
    shadow: new Shadow({ color: 'rgba(0,0,0,0.35)', offsetX: 2 * scale, offsetY: 2 * scale, blur: 3 * scale }),
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE * scale,
    fontWeight: 900,
    editable: true,
    data: { kind: 'text' },
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

export const FreeformCanvasEditor = forwardRef<FreeformCanvasEditorHandle, CanvasEditorProps>(
  function FreeformCanvasEditor(
    { hasImages, activeTool, activeColor, onHasImagesChange, onHistoryChange, onToast, onToolChange },
    ref,
  ) {
    const canvasElRef = useRef<HTMLCanvasElement | null>(null);
    const canvasShellRef = useRef<HTMLElement | null>(null);
    const canvasRef = useRef<Canvas | null>(null);
    // History parallels Skitch's pattern: a linear array of serialized snapshots
    // and a pointer for the "current" index. Diff from Skitch: snapshots include
    // ALL objects (no background filter) and the seed is '[]' meaning "empty
    // canvas" rather than "background only, no annotations".
    const historyRef = useRef<string[]>(['[]']);
    const historyIndexRef = useRef(0);
    // `restoringRef` suppresses `saveHistorySnapshot` while a restore is
    // mutating the canvas (Fabric fires object events as we remove/add). It's
    // set true at the start of every restore and only cleared by the most
    // recent one — older (stale) restores leave it set so concurrent newer
    // calls keep the gate closed across their async gap.
    const restoringRef = useRef(false);
    // `restoreSeqRef` defends against rapid undo/redo. Each `restoreHistory`
    // call captures its sequence number before `await util.enlivenObjects`;
    // when it resumes, it bails if a newer call has started. Without this,
    // an in-flight stale restore would clobber the freshly-restored canvas
    // (canvas is cleared BEFORE the await), corrupting history walks.
    const restoreSeqRef = useRef(0);
    const displayScaleRef = useRef(1);
    // Paste queue. Each `addImage` waits for the previous one to finish before
    // decoding so concurrent pastes (which fire as `void appendImageFile` in
    // App.tsx) reserve sequential row positions in invocation order rather
    // than in decode-completion order. See SHOULD-FIX #3 in the branch notes.
    const pasteQueueRef = useRef<Promise<void>>(Promise.resolve());
    // Mirrors of activeTool / activeColor so mouse handlers (closed over inside
    // the canvas-setup effect) always see the latest value without needing to
    // re-bind handlers on every prop change. Matches Skitch's pattern.
    const activeToolRef = useRef(activeTool);
    const activeColorRef = useRef(activeColor);
    // Active drag-tool state (arrow/rectangle). null between drags.
    const drawingRef = useRef<DrawingState | null>(null);
    // Step-callout counter. Starts at 1 on a fresh Canvas; increments across
    // the whole Canvas (NOT per-Image, matching the spec). We deliberately do
    // NOT reset on paste — Freeform's Canvas spans multiple Images.
    const calloutNumberRef = useRef(1);

    // Auto-fit: scale the whole canvas so the bounding box of all visible
    // Freeform content (Images + Annotations) fits the viewport (the
    // .canvas-shell flex slot). Mirrors Skitch's fitCanvasToViewport but keyed
    // off "bounding box of all tagged content" — Annotations can extend past
    // Image edges (e.g., an arrow whose tip pokes beyond a screenshot), so we
    // must include them in the union or they'll be clipped off-canvas.
    const fitCanvasToViewport = () => {
      const canvas = canvasRef.current;
      const shell = canvasShellRef.current;
      if (!canvas || !shell) return;
      const content = freeformObjects(canvas);
      // Keep auto-fit anchored on Images: don't grow the canvas just because an
      // Annotation exists without any underlying Image. (Annotations alone
      // shouldn't exist in normal flow, but guards against accidental empty-
      // Image, only-Annotation undo states.)
      if (imageObjects(canvas).length === 0) return;
      // Bounding box: union of all content display rectangles. Images are
      // placed in a horizontal row starting at top=0; Annotations can sit
      // anywhere relative to their Image. Compute generically.
      let minLeft = Infinity;
      let minTop = Infinity;
      let maxRight = -Infinity;
      let maxBottom = -Infinity;
      for (const object of content) {
        const left = object.left ?? 0;
        const top = object.top ?? 0;
        const right = left + (object.getScaledWidth?.() ?? object.width ?? 0);
        const bottom = top + (object.getScaledHeight?.() ?? object.height ?? 0);
        if (left < minLeft) minLeft = left;
        if (top < minTop) minTop = top;
        if (right > maxRight) maxRight = right;
        if (bottom > maxBottom) maxBottom = bottom;
      }
      if (!isFinite(minLeft) || !isFinite(maxRight)) return;
      // Track min as well as max: Annotations can have negative left/top (e.g.,
      // a callout placed near an Image corner uses centered origin and lands
      // at left = clickX - size/2). Without minLeft/minTop the off-origin
      // content is clipped because absolutePan stays at (0, 0).
      const width = maxRight - minLeft;
      const height = maxBottom - minTop;
      if (width <= 0 || height <= 0) return;
      const rect = shell.getBoundingClientRect();
      const fallbackWidth = Math.max(1, window.innerWidth - 64);
      const fallbackHeight = Math.max(1, window.innerHeight - 150);
      const maxWidth = rect.width > 0 ? rect.width : fallbackWidth;
      const maxHeight = rect.height > 0 ? rect.height : fallbackHeight;
      const scale = Math.min(maxWidth / width, maxHeight / height, 1);
      displayScaleRef.current = scale;
      canvas.setDimensions({ width: width * scale, height: height * scale });
      canvas.setZoom(scale);
      // Translate so scene (minLeft, minTop) renders at display (0, 0). When
      // all content sits at left/top >= 0 (the only case in this slice — no
      // Annotations yet), the pan is a no-op.
      canvas.absolutePan(new Point(minLeft, minTop));
      canvas.requestRenderAll();
    };

    const saveHistorySnapshot = () => {
      if (restoringRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const next = serializeAll(canvas);
      const current = historyRef.current[historyIndexRef.current];
      if (next === current) return;
      historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1).concat(next);
      historyIndexRef.current = historyRef.current.length - 1;
      onHistoryChange(historyIndexRef.current > 0, historyIndexRef.current < historyRef.current.length - 1);
    };

    // Unified interactivity sync: apply selectable/evented to BOTH Images
    // (concern from #7) AND annotations (concern from #6) based on the current
    // tool. In Select mode every Freeform object is interactive; in any drawing
    // mode they're frozen so a drag starts a new annotation instead of moving
    // or grabbing an existing object. Per principles 3 & 8 of the wave-3
    // integration brief: one sync, both kinds.
    const syncObjectInteractivity = (canvas: Canvas, tool: Tool) => {
      const isSelect = tool === 'select';
      canvas.selection = isSelect;
      freeformObjects(canvas).forEach((object) => {
        object.selectable = isSelect;
        object.evented = isSelect;
      });
      if (!isSelect) {
        canvas.discardActiveObject();
      }
      canvas.requestRenderAll();
    };

    useEffect(() => {
      activeToolRef.current = activeTool;
      const canvas = canvasRef.current;
      if (canvas) syncObjectInteractivity(canvas, activeTool);
    }, [activeTool]);

    useEffect(() => {
      activeColorRef.current = activeColor;
    }, [activeColor]);

    useEffect(() => {
      if (!canvasElRef.current) return;

      // Seed selection from the current tool so a non-select initial tool
      // doesn't leave the marquee active until the user toggles.
      const canvas = new Canvas(canvasElRef.current, {
        preserveObjectStacking: true,
        // Group-selection marquee follows the active tool. Only the Select
        // tool turns it on; drawing tools keep it off so a drag starts a draw,
        // not a marquee.
        selection: activeToolRef.current === 'select',
        // Fabric v7 defaults: uniformScaling true, uniScaleKey 'shiftKey'.
        // Repeated here explicitly so the aspect-lock-by-default + Shift-to-
        // free-resize contract is visible at the call site and survives any
        // future Fabric default flip. Owned by issue #7's corner-resize spec.
        uniformScaling: true,
        uniScaleKey: 'shiftKey',
      });
      canvasRef.current = canvas;

      // Inverse of displayScale: drawing a stroke that *looks* 8px wide on
      // screen requires a scene-coordinate stroke of 8/zoom. Clamp the divisor
      // so an extremely small zoom doesn't produce an absurdly thick stroke.
      const annotationScale = () => 1 / Math.max(displayScaleRef.current, 0.25);

      // Finalize a drawn annotation: add to canvas, snapshot history, optionally
      // exit sticky mode. Sticky behavior matches Skitch: drawing tools stay
      // active so the user can draw multiple shapes in a row; Select mode
      // finalizes a single shape and re-selects it for tweaking.
      const addFinalObject = (object: FabricObject) => {
        const tool = activeToolRef.current;
        const sticky = tool !== 'select';
        // While sticky, finalized objects are non-interactive so the next click
        // starts a new annotation instead of grabbing the previous one. Fabric
        // IText edit mode uses a hidden textarea that ignores `evented`, so
        // text still types and click-outside-to-exit still fires.
        object.selectable = !sticky;
        object.evented = !sticky;
        if (!canvas.contains(object)) {
          canvas.add(object);
        }
        if (!sticky) {
          canvas.setActiveObject(object);
        }
        canvas.requestRenderAll();
        saveHistorySnapshot();
        if (!sticky) {
          onToolChange('select');
        }
      };

      type CanvasPointerEvent = Parameters<typeof canvas.getScenePoint>[0];
      const pointerFromEvent = (event: { e: CanvasPointerEvent }) => canvas.getScenePoint(event.e);

      const handleMouseDown = (event: { e: CanvasPointerEvent }) => {
        const tool = activeToolRef.current;
        // Select mode is handled by Fabric's built-ins (drag, marquee). Only
        // the drag-tools (arrow, rectangle) start a drawing here; click-place
        // tools (text, callout) finalize in mouse:up below.
        if (tool === 'select') return;
        // Require at least one Image — drawing on an empty Canvas has no anchor
        // and the auto-fit logic relies on at least one Image being present.
        if (imageObjects(canvas).length === 0) return;
        const pointer = pointerFromEvent(event);

        // Click-on-existing-annotation escape: if the click lands on an
        // existing annotation while a drawing tool is active, switch to Select
        // and pick the object up instead of stacking a new annotation on top.
        // Annotations are evented=false while a drawing tool is active, so
        // Fabric's own hit-test won't see them — we walk them manually.
        // NOTE (wave 3): we intentionally only check `annotationObjects`, not
        // Images. Clicking an Image while a drawing tool is active starts a
        // new drawing on top (per principle 5 of the integration brief).
        const hit = annotationObjects(canvas).find((object) => object.containsPoint(pointer));
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

        if (tool === 'rectangle') {
          const rect = new Rect({
            left: pointer.x,
            top: pointer.y,
            width: 1,
            height: 1,
            fill: 'transparent',
            stroke: color,
            strokeWidth: STROKE_WIDTH * scale,
            rx: 5 * scale,
            ry: 5 * scale,
            data: { kind: 'rectangle' },
          });
          canvas.add(rect);
          drawingRef.current = { kind: 'rectangle', startX: pointer.x, startY: pointer.y, object: rect };
        } else if (tool === 'arrow') {
          // While dragging we draw a cheap line+triangle preview; the final
          // polygon arrow is constructed in mouse:up. The preview is two
          // primitives because they're trivial to update per frame.
          const line = new Line([pointer.x, pointer.y, pointer.x, pointer.y], {
            stroke: color,
            strokeWidth: STROKE_WIDTH * scale,
            strokeLineCap: 'round',
            selectable: false,
            evented: false,
          });
          const head = new Triangle({
            left: pointer.x,
            top: pointer.y,
            width: 34 * scale,
            height: 42 * scale,
            fill: color,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false,
          });
          canvas.add(line, head);
          drawingRef.current = { kind: 'arrow', startX: pointer.x, startY: pointer.y, line, head };
        }
      };

      const handleMouseMove = (event: { e: CanvasPointerEvent }) => {
        const drawing = drawingRef.current;
        if (!drawing) return;
        const pointer = pointerFromEvent(event);
        if (drawing.kind === 'rectangle') {
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

      const handleMouseUp = (event: { e: CanvasPointerEvent }) => {
        const drawing = drawingRef.current;
        const tool = activeToolRef.current;
        const pointer = pointerFromEvent(event);

        if (drawing) {
          drawingRef.current = null;
          if (drawing.kind === 'rectangle') {
            if ((drawing.object.width ?? 0) < 4 || (drawing.object.height ?? 0) < 4) {
              canvas.remove(drawing.object);
            } else {
              addFinalObject(drawing.object);
            }
          } else {
            // Arrow: drop preview line+head, build the final polygon arrow if
            // the drag was long enough to look intentional. <10px is treated
            // as a stray click.
            canvas.remove(drawing.line, drawing.head);
            if (Math.hypot(pointer.x - drawing.startX, pointer.y - drawing.startY) > 10) {
              addFinalObject(
                makeArrow(activeColorRef.current, annotationScale(), drawing.startX, drawing.startY, pointer.x, pointer.y),
              );
            }
          }
          canvas.requestRenderAll();
          return;
        }

        // No drag in progress — handle click-place tools (text, callout). We
        // intentionally do NOT require a hit-test on an underlying Image: text
        // and callouts are Canvas-level (ADR-0003), so dropping one in the gap
        // between Images is allowed. We still require *some* Image on the
        // canvas (otherwise the auto-fit anchor is gone).
        if (imageObjects(canvas).length === 0) return;
        const scale = annotationScale();
        const color = activeColorRef.current;
        if (tool === 'text') {
          const text = makeText(color, scale, pointer.x, pointer.y);
          addFinalObject(text);
          text.enterEditing();
          text.selectAll();
        } else if (tool === 'callout') {
          addFinalObject(makeCallout(color, scale, pointer.x, pointer.y, calloutNumberRef.current++));
        }
      };

      // Clamp Image position so the user can't drag an Image into negative
      // coordinate space (#7). Per issue #7 MVP scope, the Canvas only grows
      // down/right — never up/left of origin. Annotations (#6) are
      // intentionally NOT clamped: a callout near an Image's top-left edge
      // legitimately lands slightly off-origin because of its centered origin.
      const handleObjectMoving = (event: { target?: FabricObject }) => {
        const target = event.target as TaggedObject | undefined;
        if (!target || target.data?.kind !== 'image') return;
        if ((target.left ?? 0) < 0) target.set('left', 0);
        if ((target.top ?? 0) < 0) target.set('top', 0);
      };

      // History on user-driven mutations: drag, resize, rotate
      // (object:modified); typing into a text annotation (text:changed).
      // After object:modified the bounding box may have grown or shrunk, so
      // re-fit. fitCanvasToViewport is idempotent.
      const handleObjectModified = () => {
        saveHistorySnapshot();
        fitCanvasToViewport();
      };

      canvas.on('mouse:down', handleMouseDown);
      canvas.on('mouse:move', handleMouseMove);
      canvas.on('mouse:up', handleMouseUp);
      canvas.on('object:moving', handleObjectMoving);
      canvas.on('object:modified', handleObjectModified);
      canvas.on('text:changed', saveHistorySnapshot);

      return () => {
        canvas.dispose();
        canvasRef.current = null;
      };
      // Intentionally one-time setup. Callbacks captured via refs in handlers
      // so they don't need to be in deps.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const handleResize = () => fitCanvasToViewport();
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, []);

    // When transitioning from empty-state to canvas display, the canvas element
    // is freshly visible and its container has just acquired a measurable size.
    // Re-fit so the first paste isn't sized against a 0x0 shell.
    useEffect(() => {
      if (hasImages) fitCanvasToViewport();
    }, [hasImages]);

    const restoreHistory = async (state: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Sequence guard: rapid undo/redo can fire multiple restores. Each
      // captures its sequence number; after the async `enlivenObjects` we
      // check that no newer restore has started. If one has, bail without
      // mutating the canvas — the newer call owns the final state. We do NOT
      // clear `restoringRef` in the stale branch because the newer call is
      // still in flight and still needs the save-snapshot gate closed.
      restoringRef.current = true;
      restoreSeqRef.current += 1;
      const mySeq = restoreSeqRef.current;
      // Remove every object then re-enliven from the snapshot. enlivenObjects
      // is async because FabricImage objects need to re-decode their data URLs;
      // calling it on a state with N images is O(N) reloads. For typical
      // Freeform sessions (handful of images) this is fine. If pasted-image
      // counts grow large we may want a structural undo log instead.
      canvas.discardActiveObject();
      canvas.getObjects().forEach((object) => canvas.remove(object));
      const parsed = JSON.parse(state) as Record<string, unknown>[];
      const objects = await util.enlivenObjects(parsed);
      if (mySeq !== restoreSeqRef.current) return;
      // `selectable`/`evented` are serialized into the snapshot (see
      // `serializeAll`), so the enlivened objects round-trip those flags
      // naturally. `_controlsVisibility` (set via setControlsVisibility) is
      // NOT serialized — it's an instance field Fabric ignores. Re-apply the
      // hidden-side-handle defaults to every Image-kind object so undo/redo
      // doesn't resurrect the mid-side stretch handles (#7 concern).
      objects.forEach((object) => {
        canvas.add(object as FabricObject);
        if ((object as TaggedObject).data?.kind === 'image') {
          applyImageInteractionDefaults(object as FabricObject);
        }
      });
      // Reconcile selectable/evented with the current active tool: a snapshot
      // captured while the Select tool was active will round-trip selectable=
      // true, but if the user has since switched to a drawing tool we want
      // restored Images AND annotations to be non-interactive. Single unified
      // sync (principle 8 of the wave-3 brief).
      syncObjectInteractivity(canvas, activeToolRef.current);
      canvas.requestRenderAll();
      restoringRef.current = false;
      onHasImagesChange(imageObjects(canvas).length > 0);
      fitCanvasToViewport();
      onHistoryChange(historyIndexRef.current > 0, historyIndexRef.current < historyRef.current.length - 1);
    };

    useImperativeHandle(
      ref,
      () => ({
        addImage: (dataUrl: string) => {
          // Queue: chain onto the previous paste so concurrent calls decode
          // (and therefore reserve their row positions) in invocation order.
          // We considered an in-place reservation approach — capturing
          // `nextImageLeft(canvas)` synchronously and bumping a pending ref —
          // but without knowing the decoded width up front we'd have to
          // reserve `MAX_PASTE_WIDTH` per paste, which leaves visible gaps
          // between sub-800px images. Serializing decodes via a promise chain
          // keeps tight packing and is simpler. `.catch(() => {})` keeps the
          // chain alive when any single paste rejects.
          const previousPaste = pasteQueueRef.current;
          const thisPaste = previousPaste.then(async () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            let image: FabricImage;
            try {
              image = await FabricImage.fromURL(dataUrl);
            } catch {
              onToast('Could not load that clipboard image.', 'warning');
              return;
            }
            const naturalWidth = image.width ?? 0;
            const naturalHeight = image.height ?? 0;
            if (!naturalWidth || !naturalHeight) {
              onToast('Clipboard image had no size.', 'warning');
              return;
            }
            // Scale-to-fit at paste time: clamp display width at MAX_PASTE_WIDTH.
            // We modify Fabric's scaleX/scaleY, NOT the underlying source pixels —
            // the HTMLImageElement keeps its naturalWidth/naturalHeight. This means
            // a future "export at full resolution" feature can still recover the
            // original pixels.
            const scale = naturalWidth > MAX_PASTE_WIDTH ? MAX_PASTE_WIDTH / naturalWidth : 1;
            const isSelect = activeToolRef.current === 'select';
            image.set({
              left: nextImageLeft(canvas),
              top: 0,
              scaleX: scale,
              scaleY: scale,
              // Pasted Images are interactive when Select is active (#7). When
              // a drawing tool (#6) is active they become non-interactive so a
              // drag-on-Image starts a draw on top of it. The unified
              // syncObjectInteractivity effect keeps this in sync as the tool
              // toggles after paste.
              selectable: isSelect,
              evented: isSelect,
              data: { kind: 'image' },
            });
            applyImageInteractionDefaults(image);
            canvas.add(image);
            // Layer invariant (ADR-0003 layer rule): every Image renders below
            // every Annotation, regardless of paste/draw order. Without this,
            // pasting a NEW Image after an Annotation was drawn would cover
            // the drawing. sendObjectToBack puts the freshly-added Image at
            // the bottom of the stack; existing Annotations stay on top.
            canvas.sendObjectToBack(image);
            canvas.requestRenderAll();
            // Inform parent BEFORE fitting: the canvas element only becomes
            // visible (display: block) on the parent's hasImages flip, so the
            // first fit needs a layout pass after that switch. The effect on
            // [hasImages] above handles that case; this call covers subsequent
            // pastes where the shell is already sized.
            onHasImagesChange(true);
            fitCanvasToViewport();
            saveHistorySnapshot();
          });
          pasteQueueRef.current = thisPaste.catch(() => {});
          return thisPaste;
        },
        undo: () => {
          if (historyIndexRef.current <= 0) return;
          historyIndexRef.current -= 1;
          void restoreHistory(historyRef.current[historyIndexRef.current]);
        },
        redo: () => {
          if (historyIndexRef.current >= historyRef.current.length - 1) return;
          historyIndexRef.current += 1;
          void restoreHistory(historyRef.current[historyIndexRef.current]);
        },
        recolorSelected: (color: string) => {
          // Recolor whatever is currently selected. Mirrors Skitch's behavior:
          // changing Active color in the picker recolors the current selection
          // (if any) AND becomes the pen for future annotations. The pen-color
          // side lives in App.tsx state; this handle covers the selection
          // side. Image objects are skipped — they aren't annotations and have
          // no notion of color.
          const canvas = canvasRef.current;
          if (!canvas) return;
          const activeObjects = canvas
            .getActiveObjects()
            .filter((object) => (object as TaggedObject).data?.kind !== 'image');
          if (activeObjects.length === 0) return;
          activeObjects.forEach((object) => recolorAnnotation(object, color));
          canvas.requestRenderAll();
          saveHistorySnapshot();
        },
        deleteSelected: () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          // Scope deletion to Image-kind objects (#7). Annotations on top of a
          // deleted Image are explicitly preserved per ADR-0003: they're
          // canvas-level, not bound to any Image. When Annotation selection
          // becomes its own concern, this filter is the right place to widen.
          const targets = canvas
            .getActiveObjects()
            .filter((object) => (object as TaggedObject).data?.kind === 'image');
          if (targets.length === 0) return;
          targets.forEach((object) => canvas.remove(object));
          canvas.discardActiveObject();
          canvas.requestRenderAll();
          onHasImagesChange(imageObjects(canvas).length > 0);
          fitCanvasToViewport();
          // `object:modified` doesn't fire on remove, so we push the snapshot
          // here. (The Skitch path does the equivalent.)
          saveHistorySnapshot();
        },
      }),
      // Stable handle: the closures above read from refs and the latest props
      // via the callback identities below. Callbacks are stable in the parent
      // (useCallback), so this list is effectively constant — but listing them
      // keeps the React lint rule happy if/when that changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [onHasImagesChange, onHistoryChange, onToast, onToolChange],
    );

    return (
      <section className="canvas-shell" aria-label="Freeform canvas" ref={canvasShellRef}>
        {!hasImages ? (
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">
              ∞
            </div>
            <h1>Freeform</h1>
            <p>Paste an image to start — or paste several to build a board.</p>
          </div>
        ) : null}
        <div className={hasImages ? 'canvas-wrap visible' : 'canvas-wrap'}>
          <canvas ref={canvasElRef} />
        </div>
      </section>
    );
  },
);
