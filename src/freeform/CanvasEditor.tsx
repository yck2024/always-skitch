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
import { hexToLowAlpha, recolorAnnotation } from '../utils/colors';
import { copyPngBlobToClipboard, dataUrlToBlob, downloadDataUrl } from '../utils/export';
import { extractDominantColor } from './utils/extractDominantColor';

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
// Padding around the content bounding box in the exported PNG, in NATURAL
// output pixels (since the export pipeline below renders at 1 scene unit = 1
// output pixel). 20px matches the issue spec's "16-24px" range and gives a
// breathing margin that's visible without dominating the image.
const EXPORT_PADDING = 20;
// Default filename for the Download action. Mirrors Skitch's
// `EXPORT_FILE_NAME` but distinguishes the Freeform output so a user
// downloading from both surfaces in the same session doesn't get filename
// collisions in their Downloads folder.
const EXPORT_FILE_NAME = 'mini-skitch-freeform.png';
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
// Pixel-block size for the Blur tool. Mirrors Skitch's PIXEL_SIZE so a blur
// drawn in Freeform looks identical to one drawn in Skitch at the same source
// resolution. Duplicate-not-import per the wave-3 precedent — extracting a
// shared module risks coupling the two editors before they need it.
const PIXEL_SIZE = 12;
// Minimum drag size for a blur to commit (display-coord pixels). Below this we
// treat the drag as a stray click and silently discard. Mirrors Skitch.
const BLUR_MIN_SIZE = 8;

// macOS-style drop shadow applied to every Image (NOT to annotations). Soft,
// diffuse, predominantly downward. Tuned per issue #11 spec. Shadow blur and
// offsets are in scene coordinates — Fabric scales the shadow naturally with
// the object's transform, and the canvas auto-fit zoom shrinks it visually
// the same way CSS shadows shrink under `transform: scale(...)`.
const IMAGE_SHADOW = { color: 'rgba(0, 0, 0, 0.25)', blur: 30, offsetX: 0, offsetY: 15 };

// Subtle hairline border applied to every Image so its actual edge is clearly
// visible against any Canvas color (especially during corner resize, where the
// shadow alone can blur out the real edge). `strokeUniform: true` keeps the
// stroke at exactly 1 CSS pixel regardless of object scale OR the canvas
// auto-fit zoom — without it the line shrinks to sub-pixel at typical
// fit-to-viewport zooms (<1) and visually disappears. Annotations stay
// unbordered; the "make Images look nicer" treatment is Image-only.
const IMAGE_STROKE = {
  stroke: 'rgba(0, 0, 0, 0.12)',
  strokeWidth: 1,
  strokeUniform: true,
};

// Per-side scene-coord extent the IMAGE_STROKE adds beyond an Image's
// geometry. With strokeUniform: true the rendered stroke is 1 CSS pixel
// regardless of object scale or canvas zoom, so in scene coordinates the bbox
// grows by strokeWidth/(2*displayScale) on each side. At the soft-cap of 2-4
// images (displayScale typically 0.5-1.0) that's at most 1px per side in
// scene coords. Use a flat 1px on each side — overkill but safe, and keeps
// fit-to-viewport and export from clipping the hairline. Stroked annotations
// (rectangle, text halo) get their own per-object strokeWidth/2 expansion
// inside objectBoundsWithShadow — see there.
const STROKE_EXTENT = 1;

// Per-side scene-coord extent the IMAGE_SHADOW adds beyond an Image's geometry.
// Used by bbox math (fit-to-viewport and export) to grow each Image's
// contribution to the content union so the shadow isn't clipped at the canvas
// edge or at the exported PNG boundary. Derived once from IMAGE_SHADOW so any
// future tuning of the shadow params automatically propagates here.
//
// Direction math: with offset (dx, dy), the visible blur reaches `blur` units
// out from each edge in the un-offset case; the offset then pushes the blur
// toward (dx, dy) on the offset side and pulls it in on the opposite side. So
// the right edge extends by `blur + dx`, the left by `blur - dx`, the bottom
// by `blur + dy`, and the top by `blur - dy`. Each side is clamped to >= 0
// (an offset larger than the blur would otherwise produce a negative extent
// on the trailing side, which makes no sense for bbox expansion).
const SHADOW_EXTENT = {
  top: Math.max(0, IMAGE_SHADOW.blur - IMAGE_SHADOW.offsetY),
  bottom: Math.max(0, IMAGE_SHADOW.blur + IMAGE_SHADOW.offsetY),
  left: Math.max(0, IMAGE_SHADOW.blur - IMAGE_SHADOW.offsetX),
  right: Math.max(0, IMAGE_SHADOW.blur + IMAGE_SHADOW.offsetX),
};

// Drawing state for mouse-drag tools (arrow, rectangle, blur). Click-place
// tools (text, callout) finalize immediately so they don't appear here. The
// blur drag carries a reference to the source Image — anchored at mouse-down,
// NOT re-discovered on mouse-up — so a drag that starts on an Image and
// extends past its edge still maps unambiguously to that Image's pixels even
// if the pointer ends over another Image (or empty Canvas).
type DrawingState =
  | { kind: 'rectangle'; startX: number; startY: number; object: Rect }
  | { kind: 'arrow'; startX: number; startY: number; line: Line; head: Triangle }
  | { kind: 'blur'; startX: number; startY: number; object: Rect; source: FabricImage };

// Canvas color (the empty-space color between Images). 'transparent' means
// "let the wrapping element's background show through" — see ADR-style note
// in App.tsx for why we picked a checker-pattern visual for transparent.
export type FreeformCanvasColor = 'white' | 'black' | 'transparent';

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
  // Effective Canvas color for empty space between Images. NOT undoable — it
  // is a session setting, not an edit (see Canvas color glossary entry).
  //
  // Type widens from FreeformCanvasColor to also accept a hex string so the
  // parent can pass a derived Match-mode color (ADR-0008) without this
  // component needing to know about Match state. Three known names
  // ('white' | 'black' | 'transparent') retain their existing semantics
  // (solid fill, solid fill, checker-pattern-via-CSS); anything else is
  // treated as a literal CSS color and painted directly. The Match-mode
  // state machine — auto-engage, disengage, cached derived color — lives in
  // App.tsx; here we just paint what we're told.
  canvasColor: FreeformCanvasColor | string;
  onHasImagesChange: (hasImages: boolean) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
  onToast: (text: string, tone?: 'success' | 'warning' | 'info') => void;
  // Called when the editor wants to switch tools itself — e.g., click on an
  // existing annotation while a drawing tool is active escapes to Select.
  onToolChange: (tool: Tool) => void;
  // Called when the active selection on the canvas changes. The parent uses
  // this to enable/disable the Delete button (it should be enabled iff
  // something is selected, not just whenever an Image exists).
  onSelectionChange?: (hasSelection: boolean) => void;
  // Called when the count of canvas content (Images + Annotations) crosses
  // the zero / non-zero threshold. Drives Export buttons (Copy PNG, Download)
  // — they're enabled iff the canvas has anything to export. Distinct from
  // `onHasImagesChange` because a stray annotation with no Image still counts
  // as exportable content per issue #10 acceptance criteria.
  onHasContentChange?: (hasContent: boolean) => void;
  // ADR-0006: open the right-click context menu at the given viewport
  // coordinates (relative to the page, not the canvas). The editor handles
  // the right-click semantics itself (selecting the target Image if it isn't
  // already selected, preserving multi-selection if it is) — this callback
  // exists purely to tell the parent WHERE to render the menu overlay.
  // Receives `null` when the menu should close (e.g., right-click in a
  // drawing tool or on empty Canvas).
  onContextMenu?: (position: { x: number; y: number } | null) => void;
  // ADR-0008 (Canvas color Match mode): fired once per successful Image
  // paste, AFTER the FabricImage has decoded. Carries the saturation-weighted,
  // lightness-clamped dominant color of the pasted Image, or `null` when the
  // image yields no usable color (all-white, all-gray, etc.), plus `wasEmpty`
  // — true iff the canvas held no Images at the moment this paste's queued
  // mutation began (i.e., before canvas.add for this paste). The editor owns
  // this signal so the auto-engage gate in App.tsx is race-free across rapid
  // double-pastes: queued mutations are serialized, so paste-1 has already
  // added its Image by the time paste-2's mutation evaluates wasEmpty.
  // Reading React state in App.tsx instead would let two near-simultaneous
  // pastes both observe `hasImages === false` and both auto-engage. The
  // editor has no opinion on what the parent does with these — auto-engage
  // logic, caching, and the active/inactive state of Match mode all live in
  // App.tsx so this component stays mode-agnostic.
  onImagePastedDominantColor?: (color: string | null, wasEmpty: boolean) => void;
}

export interface FreeformCanvasEditorHandle {
  addImage: (dataUrl: string) => Promise<void>;
  undo: () => void;
  redo: () => void;
  recolorSelected: (color: string) => void;
  // Remove every selected object from the canvas (Images and/or Annotations).
  // Pre-ADR-0006 this was Image-only — see ADR-0006 consequences: that filter
  // was a #7-era anachronism (Annotations weren't selectable yet at the time).
  // Now keyboard Backspace/Delete and the right-click menu's Delete share this
  // single entry point.
  deleteSelected: () => void;
  // Copy a PNG of the current canvas (content bbox + padding, Canvas color
  // background, natural resolution) to the clipboard. Falls back to download
  // if the browser doesn't support ClipboardItem image/png. Awaits any
  // in-flight paste/restore before snapshotting (wave-3 mutation queue).
  copyPng: () => Promise<void>;
  // Save the same PNG to the user's Downloads folder.
  downloadPng: () => Promise<void>;
  // ADR-0006 layer reorder. Operate on the current active selection, scoped
  // to Image-kind members (Annotations in a mixed selection are ignored and
  // stay in place). No-op on empty or Annotation-only selections. Each call
  // is its own undo step.
  bringSelectedImagesToFront: () => void;
  sendSelectedImagesToBack: () => void;
  // ADR-0007: wipe every Freeform-tagged object (Images and Annotations) in a
  // single undoable step. Diverges from Skitch's `clearAnnotations` (which
  // keeps the Background) because Freeform has no Background — clearing means
  // clearing everything. Settings (Active color, Canvas color, active tool)
  // are preserved.
  clearCanvas: () => void;
}

// Every canvas object Freeform creates gets a `data.kind` tag so future tooling
// (selection, deletion, recolor) can discriminate Image vs Annotation. Image is
// the only non-annotation kind today; anything else with a `data.kind` set is
// an Annotation by elimination.
type TaggedObject = FabricObject & { data?: { kind?: string } };

function imageObjects(canvas: Canvas): FabricObject[] {
  return canvas.getObjects().filter((object) => (object as TaggedObject).data?.kind === 'image');
}

function isImageObject(object: FabricObject): boolean {
  return (object as TaggedObject).data?.kind === 'image';
}

function isAnnotationObject(object: FabricObject): boolean {
  const kind = (object as TaggedObject).data?.kind;
  return kind !== undefined && kind !== 'image';
}

function annotationObjects(canvas: Canvas): FabricObject[] {
  return canvas.getObjects().filter(isAnnotationObject);
}

// All Freeform-tagged content, in render order (background-to-foreground).
function freeformObjects(canvas: Canvas): FabricObject[] {
  return canvas.getObjects().filter((object) => (object as TaggedObject).data?.kind !== undefined);
}

// Display/scene-coord bounding rect of a Freeform object, expanded to include
// shadow extent for Images only. Annotations sit flush with their own geometry
// (no shadow), so they contribute their bare rect. Used by both
// fitCanvasToViewport and contentBoundingBox so the shadow isn't clipped at
// the viewport edge OR at the export PNG boundary. Returns {left, top, right,
// bottom}. Centralizing here means a future tweak to SHADOW_EXTENT can't drift
// between the two call sites.
function objectBoundsWithShadow(object: FabricObject): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const left = object.left ?? 0;
  const top = object.top ?? 0;
  const right = left + (object.getScaledWidth?.() ?? object.width ?? 0);
  const bottom = top + (object.getScaledHeight?.() ?? object.height ?? 0);
  if ((object as TaggedObject).data?.kind === 'image') {
    // Shadow expansion first, then the hairline stroke (#11 follow-up). Stroke
    // is a tiny extra 1px per side but matters at the exported PNG boundary —
    // without it the stroke would be clipped at the right/bottom edges.
    return {
      left: left - SHADOW_EXTENT.left - STROKE_EXTENT,
      top: top - SHADOW_EXTENT.top - STROKE_EXTENT,
      right: right + SHADOW_EXTENT.right + STROKE_EXTENT,
      bottom: bottom + SHADOW_EXTENT.bottom + STROKE_EXTENT,
    };
  }
  // For stroked annotations (rectangles, text halos), Fabric paints the stroke
  // centered on the geometric edge, so half the strokeWidth hangs outside the
  // nominal rect. Without this, a rectangle whose right edge defines maxRight
  // gets its outer-half stroke clipped flush against the canvas pixel buffer.
  // Filled-only shapes (arrows, blur) have no `stroke` set and contribute 0.
  const strokeHalf = (object as FabricObject).stroke
    ? ((object as FabricObject).strokeWidth ?? 0) / 2
    : 0;
  return {
    left: left - strokeHalf,
    top: top - strokeHalf,
    right: right + strokeHalf,
    bottom: bottom + strokeHalf,
  };
}

// ADR-0006 layer-order helpers. The Annotation-above-Image invariant from
// ADR-0003 is ABSOLUTE: we never call Fabric's raw `bringObjectToFront(image)`
// because that would put the Image above every Annotation. Instead, these
// helpers compute the target index manually so the Image lands at the top
// (or bottom) of the **Image** stack only.
//
// Implementation note for `bringImageToTopOfImages`: Fabric's
// `moveObjectTo(obj, idx)` removes the object first, then splices at `idx`.
// If the image currently sits before the lowest-indexed Annotation, removing
// it shifts that annotation index left by 1 — hence the `< aIdx ? aIdx - 1 : aIdx`
// branch. When there are no Annotations, the top of the Image stack is just
// the end of the array (post-removal length).
function bringImageToTopOfImages(canvas: Canvas, image: FabricObject): boolean {
  const objects = canvas.getObjects();
  const currentIdx = objects.indexOf(image);
  if (currentIdx === -1) return false;
  const lowestAnnotationIdx = objects.findIndex(isAnnotationObject);
  let targetIdx: number;
  if (lowestAnnotationIdx === -1) {
    // No annotations: top of Image stack is the end of the array post-removal.
    targetIdx = objects.length - 1;
  } else {
    // Just below the lowest annotation. Adjust for removal shift.
    targetIdx = currentIdx < lowestAnnotationIdx ? lowestAnnotationIdx - 1 : lowestAnnotationIdx;
  }
  if (currentIdx === targetIdx) return false;
  return canvas.moveObjectTo(image, targetIdx);
}

// Bottom of the Image stack is always index 0 — Annotations all sit above the
// Image strata so we never need to clamp against them on the back side.
function sendImageToBackOfImages(canvas: Canvas, image: FabricObject): boolean {
  const objects = canvas.getObjects();
  if (objects.indexOf(image) === 0) return false;
  return canvas.moveObjectTo(image, 0);
}

// Apply per-Image interaction defaults: hide the middle (side) scaling handles
// and the rotation handle so only corner resize is offered, and attach the
// macOS-style drop shadow (#11). The aspect-ratio lock during corner resize is
// handled at the Canvas level (uniformScaling: true, uniScaleKey: 'shiftKey')
// — the Image itself doesn't need lockScaling flags. Called in two places:
// when a new Image is added, and after history restore (because
// `_controlsVisibility` is an instance field that isn't captured by Fabric's
// serialization, and `shadow` isn't in our serializeAll prop list either —
// re-applying here means restored Images render with the shadow on the same
// frame they appear, no flicker).
function applyImageInteractionDefaults(image: FabricObject) {
  image.setControlsVisibility({
    mt: false,
    mb: false,
    ml: false,
    mr: false,
    mtr: false,
  });
  image.shadow = new Shadow(IMAGE_SHADOW);
  // Hairline border (#11 follow-up). Like `shadow` above, stroke props are
  // not in the `serializeAll` prop list — they're owned by this function so
  // restored Images pick them back up on the same frame they appear.
  image.set({ ...IMAGE_STROKE });
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

// Pixelate a crop of an HTMLImageElement's natural-resolution pixels by
// downsampling then nearest-neighbor upscaling. Returns a data URL. Duplicate
// of Skitch's identically-named util (src/components/CanvasEditor.tsx) by
// design — the wave-3 brief explicitly calls out "duplication is fine" rather
// than risk coupling two editors that may diverge.
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

// Display-coord bounding rect of a Fabric Image. Computed from left/top and
// the scaled width/height because the Image may have been resized at paste
// time (scaleX/scaleY != 1) or by the user (#7 corner resize). Used both for
// the mouse-down hit-test (start-on-Image rule) and for clipping the final
// blur rect to the source Image's bounds on mouse-up.
function imageDisplayBounds(image: FabricImage) {
  const left = image.left ?? 0;
  const top = image.top ?? 0;
  const width = image.getScaledWidth?.() ?? image.width ?? 0;
  const height = image.getScaledHeight?.() ?? image.height ?? 0;
  return { left, top, right: left + width, bottom: top + height, width, height };
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
    {
      hasImages,
      activeTool,
      activeColor,
      canvasColor,
      onHasImagesChange,
      onHistoryChange,
      onToast,
      onToolChange,
      onSelectionChange,
      onHasContentChange,
      onContextMenu,
      onImagePastedDominantColor,
    },
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
    // Unified mutation queue. Serializes ALL async canvas mutations — paste
    // applies AND history restores — so they can't interleave. Two race
    // shapes this prevents:
    //   1. A paste lands between `canvas.clear` and `enlivenObjects` inside
    //      restore, ending up on a canvas the restore is about to repopulate.
    //   2. An undo arrives mid-paste-decode, with the paste then committing
    //      its image into the freshly-restored state.
    // The existing `restoreSeqRef` guards stale restores within `restoreHistory`
    // itself; this queue is additive and operates one level higher.
    // `.catch(() => {})` keeps the chain alive when any single op rejects.
    const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
    // Mirrors of activeTool / activeColor so mouse handlers (closed over inside
    // the canvas-setup effect) always see the latest value without needing to
    // re-bind handlers on every prop change. Matches Skitch's pattern.
    const activeToolRef = useRef(activeTool);
    const activeColorRef = useRef(activeColor);
    // Same trick for the optional selection-change callback: the canvas-setup
    // effect runs once, so we read through a ref to pick up identity changes.
    const onSelectionChangeRef = useRef(onSelectionChange);
    // Same pattern for the content-change callback: the imperative handle and
    // history paths need to push hasContent updates without re-binding.
    const onHasContentChangeRef = useRef(onHasContentChange);
    // Context-menu callback, mirrored for the same reason: the `contextmenu`
    // handler bound during canvas setup needs to fire the latest callback
    // identity without re-binding.
    const onContextMenuRef = useRef(onContextMenu);
    // Mirror of canvasColor so `exportDataUrl` (called from imperative-handle
    // methods, NOT inside an effect) can read the latest value via ref. We
    // could read it through closure capture in the handle deps, but the ref
    // pattern is already established here and keeps the handle stable.
    const canvasColorRef = useRef(canvasColor);
    // Track the last-pushed hasContent so we don't spam the parent on every
    // mutation when the boolean hasn't changed. Reset on canvas dispose via
    // the cleanup branch of the canvas-setup effect.
    const hasContentRef = useRef(false);
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
      //
      // Per-Image shadow extent (#11) is folded in via objectBoundsWithShadow
      // so the shadow doesn't get clipped at the viewport edge. Annotations
      // contribute their bare rect — they have no shadow. We deliberately do
      // NOT expand the final union by SHADOW_EXTENT on all sides: an
      // Annotation that sits flush with its right edge against the page
      // shouldn't add unnecessary margin.
      let minLeft = Infinity;
      let minTop = Infinity;
      let maxRight = -Infinity;
      let maxBottom = -Infinity;
      for (const object of content) {
        const bounds = objectBoundsWithShadow(object);
        if (bounds.left < minLeft) minLeft = bounds.left;
        if (bounds.top < minTop) minTop = bounds.top;
        if (bounds.right > maxRight) maxRight = bounds.right;
        if (bounds.bottom > maxBottom) maxBottom = bounds.bottom;
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
      // Translate so scene (minLeft, minTop) renders at display (0, 0).
      // Fabric's absolutePan writes its argument straight into
      // viewportTransform[4]/[5], which are DISPLAY-pixel translations — so
      // the argument must be pre-multiplied by the current zoom. Without the
      // `* scale`, when zoom < 1 the pan over-shifts by (1 - scale) * |minLeft|
      // display pixels, leaving a wide gap on the left and clipping content
      // off the right edge of the canvas pixel buffer.
      canvas.absolutePan(new Point(minLeft * scale, minTop * scale));
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

    // Push a hasContent update to the parent iff the boolean has actually
    // changed. Every mutation entry point (addImage, deleteSelected, draw
    // finalize, history restore, clear) calls this — it's idempotent and
    // cheap. The parent uses the flag to enable/disable the Copy PNG and
    // Download buttons.
    const pushHasContentChange = (canvas: Canvas) => {
      const next = freeformObjects(canvas).length > 0;
      if (next === hasContentRef.current) return;
      hasContentRef.current = next;
      onHasContentChangeRef.current?.(next);
    };

    // ADR-0006 layer reorder applied to the current active selection.
    //
    // Direction-of-iteration math: each `bringImageToTopOfImages` call lands
    // its target at the top of the Image stack (just below any Annotations).
    // To preserve internal relative order while sending the whole group to
    // the top, walk lowest-current-index first — the last image processed
    // ends up topmost, matching its higher pre-call position. For send-to-
    // back the mirror image: each call drops its target to index 0, so walk
    // highest-current-index first.
    //
    // Mixed selections: Annotations in the selection are ignored. Empty or
    // Annotation-only selections are no-ops. Each invocation is its own undo
    // step (snapshot pushed at the end). The active selection itself is
    // preserved — Fabric's `ActiveSelection` references survive index moves
    // because we operate on the underlying objects, not on the selection
    // wrapper.
    const applyLayerReorder = (direction: 'front' | 'back') => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const selected = canvas.getActiveObjects().filter(isImageObject);
      if (selected.length === 0) return;
      const objects = canvas.getObjects();
      // Iterate so each call to bring/sendImageTo*OfImages walks the group
      // forward without scrambling its internal order. For `front`, iterate
      // ascending (lowest-index Image first) — each is moved on top of the
      // Image stack, so the highest-index Image ends up topmost at the end.
      // For `back`, iterate descending (highest-index first) — each is moved
      // to the bottom, so the lowest-index Image lands at the very bottom
      // last. Either way, the group's internal stacking is preserved.
      const sorted = [...selected].sort((a, b) => objects.indexOf(a) - objects.indexOf(b));
      const ordered = direction === 'front' ? sorted : [...sorted].reverse();
      let changed = false;
      for (const image of ordered) {
        const moved =
          direction === 'front'
            ? bringImageToTopOfImages(canvas, image)
            : sendImageToBackOfImages(canvas, image);
        if (moved) changed = true;
      }
      if (!changed) return;
      canvas.requestRenderAll();
      saveHistorySnapshot();
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
        const hadSelection = canvas.getActiveObjects().length > 0;
        canvas.discardActiveObject();
        // Programmatic discardActiveObject doesn't always fire
        // `selection:cleared` (Fabric reserves it for user interaction in
        // some versions), so notify the parent directly when we know we
        // just cleared a selection by switching off Select mode.
        if (hadSelection) onSelectionChangeRef.current?.(false);
      }
      canvas.requestRenderAll();
    };

    // Schedule any async canvas mutation behind the previous one. Used by
    // `addImage`, by `undo`/`redo` (via `restoreHistory`), AND by the Blur
    // tool's mouse-up handler when it kicks off a FabricImage.fromURL decode.
    // See the mutationQueueRef declaration for the race shapes this prevents.
    // Lifted to component-body scope (rather than living inside the
    // useImperativeHandle factory) so the canvas-setup effect can reach it
    // from inside mouse handlers — keeps a single queue across all async
    // canvas mutations regardless of which entry point triggered them.
    const queueMutation = <T,>(op: () => Promise<T>): Promise<T> => {
      const previous = mutationQueueRef.current;
      const next = previous.then(op);
      mutationQueueRef.current = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

    useEffect(() => {
      activeToolRef.current = activeTool;
      const canvas = canvasRef.current;
      if (canvas) {
        syncObjectInteractivity(canvas, activeTool);
        // Tool-aware cursor (#8): Blur is the first tool with per-Image
        // semantics — the cursor over empty Canvas must signal "disabled"
        // (`not-allowed`) and over an Image must signal "draw here"
        // (`crosshair`). The actual over-Image vs over-empty decision lives
        // in the `mouse:move` listener (it has the pointer); here we set the
        // baseline so the cursor is correct even before the first mouse-move
        // event fires (e.g., the moment the user picks the tool with the
        // pointer outside the canvas). For non-Blur tools we restore the
        // Fabric defaults — Select uses 'move', drawing tools use the
        // browser default — so this doesn't bleed across tools.
        if (activeTool === 'blur') {
          canvas.defaultCursor = 'not-allowed';
          canvas.hoverCursor = 'not-allowed';
        } else {
          // Fabric's built-in defaults. Setting back explicitly so a previous
          // Blur tool selection doesn't leave 'not-allowed' baked in.
          canvas.defaultCursor = 'default';
          canvas.hoverCursor = 'move';
        }
      }
    }, [activeTool]);

    useEffect(() => {
      activeColorRef.current = activeColor;
    }, [activeColor]);

    useEffect(() => {
      onSelectionChangeRef.current = onSelectionChange;
    }, [onSelectionChange]);

    useEffect(() => {
      onHasContentChangeRef.current = onHasContentChange;
    }, [onHasContentChange]);

    useEffect(() => {
      onContextMenuRef.current = onContextMenu;
    }, [onContextMenu]);

    useEffect(() => {
      canvasColorRef.current = canvasColor;
    }, [canvasColor]);

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
        // The annotation we just added counts as content for the Export
        // buttons; an Image-only canvas adding its first annotation doesn't
        // change hasContent (still true), but the first thing on a fresh
        // canvas does. pushHasContentChange is a no-op on no-change.
        pushHasContentChange(canvas);
        // Refit immediately after committing the annotation. A callout placed
        // near an Image corner uses centered origin and lands at a negative
        // left/top (e.g., left = clickX - size/2); without a refit here the
        // off-origin pixels render outside the visible bbox until some later
        // action (drag, undo, resize) triggers a fit.
        fitCanvasToViewport();
        if (!sticky) {
          onToolChange('select');
        }
      };

      type CanvasPointerEvent = Parameters<typeof canvas.getScenePoint>[0];
      const pointerFromEvent = (event: { e: CanvasPointerEvent }) => canvas.getScenePoint(event.e);

      const handleMouseDown = (event: { e: CanvasPointerEvent }) => {
        const tool = activeToolRef.current;
        // Select mode is handled by Fabric's built-ins (drag, marquee). Only
        // the drag-tools (arrow, rectangle, blur) start a drawing here;
        // click-place tools (text, callout) finalize in mouse:up below.
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
        } else if (tool === 'blur') {
          // Per-Image gate (ADR-0005 / issue #8): a blur drag can only START
          // on top of an Image. Walk Images top-to-bottom in render order
          // (last-added wins on overlap, matching visual stacking). If the
          // pointer is over empty Canvas, do nothing — no preview, no
          // drawing state. The cursor is already `not-allowed` (see the
          // tool-aware cursor effect below) so the user has a clear signal.
          const images = imageObjects(canvas) as FabricImage[];
          let source: FabricImage | undefined;
          for (let i = images.length - 1; i >= 0; i -= 1) {
            if (images[i].containsPoint(pointer)) {
              source = images[i];
              break;
            }
          }
          if (!source) return;
          const rect = new Rect({
            left: pointer.x,
            top: pointer.y,
            width: 1,
            height: 1,
            fill: hexToLowAlpha(color, 0.08),
            stroke: color,
            strokeDashArray: [12 * scale, 8 * scale],
            strokeWidth: 3 * scale,
            // Tag the preview with 'blur-preview' so recolorAnnotation's
            // existing switch case (utils/colors.ts) handles live recolor if
            // the user changes the pen color mid-drag. Matches Skitch.
            data: { kind: 'blur-preview' },
            selectable: false,
            evented: false,
          });
          canvas.add(rect);
          drawingRef.current = { kind: 'blur', startX: pointer.x, startY: pointer.y, object: rect, source };
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
        // Dynamic cursor for the Blur tool (#8): `crosshair` over an Image
        // signals "draw here", `not-allowed` over empty Canvas signals
        // "disabled". Only active while the Blur tool is selected — for other
        // tools we leave the [activeTool]-effect-set defaults alone so the
        // Select tool's 'move' hover and the drawing tools' default cursor
        // still work. We update `hoverCursor`/`defaultCursor` (not
        // `canvas.setCursor`) because Fabric reapplies the canvas-level cursor
        // every render — a one-shot `setCursor` flickers as the canvas redraws.
        if (activeToolRef.current === 'blur' && !drawingRef.current) {
          const pointer = pointerFromEvent(event);
          const overImage = (imageObjects(canvas) as FabricImage[]).some((image) => image.containsPoint(pointer));
          const next = overImage ? 'crosshair' : 'not-allowed';
          if (canvas.defaultCursor !== next) {
            canvas.defaultCursor = next;
            canvas.hoverCursor = next;
          }
        }
        const drawing = drawingRef.current;
        if (!drawing) return;
        const pointer = pointerFromEvent(event);
        if (drawing.kind === 'rectangle' || drawing.kind === 'blur') {
          // Blur preview is allowed to extend past the source Image's edges
          // during drag — only the FINAL committed rect is clipped at
          // mouse-up. Showing the unclipped preview matches what Skitch does
          // and gives the user a clear "I'm dragging" affordance even if the
          // intended bottom-right falls outside the Image.
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
          } else if (drawing.kind === 'blur') {
            // Drop the dashed preview rect regardless of outcome.
            canvas.remove(drawing.object);
            // Drag rect in Canvas (display) coordinates, normalized so
            // (x0, y0) is top-left and (x1, y1) is bottom-right.
            const dragLeft = Math.min(pointer.x, drawing.startX);
            const dragTop = Math.min(pointer.y, drawing.startY);
            const dragRight = Math.max(pointer.x, drawing.startX);
            const dragBottom = Math.max(pointer.y, drawing.startY);
            // Hard-clip the drag rect to the source Image's display bounds.
            // The Image may have been moved or resized since paste (#7), so
            // we read its bounds fresh here rather than caching at mouse-down.
            const bounds = imageDisplayBounds(drawing.source);
            const clipLeft = Math.max(dragLeft, bounds.left);
            const clipTop = Math.max(dragTop, bounds.top);
            const clipRight = Math.min(dragRight, bounds.right);
            const clipBottom = Math.min(dragBottom, bounds.bottom);
            const clipWidth = clipRight - clipLeft;
            const clipHeight = clipBottom - clipTop;
            // Discard tiny rects (stray clicks, or drags whose intersection
            // with the source Image is too small to be intentional). Mirrors
            // Skitch's < 8px guard.
            if (clipWidth < BLUR_MIN_SIZE || clipHeight < BLUR_MIN_SIZE) {
              canvas.requestRenderAll();
              return;
            }
            // Map the clipped display rect into the source Image's NATURAL
            // pixel coordinates. The Image's display origin is (left, top)
            // and each natural pixel occupies `scaleX` display units along x
            // (and `scaleY` along y). Sampling from natural pixels — not from
            // the resized display — preserves source quality so the blur
            // matches Skitch's per-Background blur byte-for-byte at the same
            // PIXEL_SIZE.
            const source = drawing.source;
            const scaleX = source.scaleX ?? 1;
            const scaleY = source.scaleY ?? 1;
            const naturalX = (clipLeft - bounds.left) / scaleX;
            const naturalY = (clipTop - bounds.top) / scaleY;
            const naturalWidth = clipWidth / scaleX;
            const naturalHeight = clipHeight / scaleY;
            const element = source.getElement() as HTMLImageElement;
            const dataUrl = createPixelatedCrop(element, naturalX, naturalY, naturalWidth, naturalHeight);
            const blurLeft = clipLeft;
            const blurTop = clipTop;
            // Schedule the FabricImage.fromURL decode behind any other
            // in-flight async mutation (paste, restore). Skipping the queue
            // would reintroduce the race that wave-3 fixed — a concurrent
            // undo could clear the canvas while we're still decoding, and
            // the blur would land on the freshly-restored state.
            void queueMutation(async () => {
              const c = canvasRef.current;
              if (!c) return;
              const blurImage = await FabricImage.fromURL(dataUrl);
              // Scale the natural-resolution pixelated crop down into the
              // clipped display rect's display dimensions. Without this the
              // blur would render at natural-pixel size on the canvas and
              // visually overshoot the source Image's resized footprint.
              const finalScaleX = clipWidth / (blurImage.width ?? clipWidth);
              const finalScaleY = clipHeight / (blurImage.height ?? clipHeight);
              blurImage.set({
                left: blurLeft,
                top: blurTop,
                scaleX: finalScaleX,
                scaleY: finalScaleY,
                data: { kind: 'blur' },
              });
              addFinalObject(blurImage);
            });
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

      // Selection-change bridge: the Delete button (and any future
      // selection-aware UI) needs to know whether *anything* is selected on
      // the canvas. Fabric fires selection:created when the first object is
      // grabbed, selection:updated when the active selection swaps, and
      // selection:cleared on discard. We collapse all three into a single
      // boolean push.
      const emitSelectionChange = () => {
        const callback = onSelectionChangeRef.current;
        if (!callback) return;
        callback(canvas.getActiveObjects().length > 0);
      };

      // ADR-0006 right-click context menu.
      //
      // Rules:
      // - Select tool + right-click ON an Image: select-then-show. If the
      //   image isn't currently in the active selection, replace selection
      //   with just it; if it IS already part of an ActiveSelection, preserve
      //   the existing multi-selection (Apple Freeform / Figma convention).
      //   Then suppress the browser default and fire the menu-open callback.
      // - Select tool + right-click on empty Canvas or an Annotation: let
      //   the browser default fire (no custom menu). The spec describes the
      //   menu specifically for Images.
      // - Any drawing tool: also let the browser default through. Images are
      //   non-evented in drawing tools by construction (#7 + #6 freeze),
      //   so reorder is Select-tool-only.
      //
      // We bind directly to the upper canvas element's DOM `contextmenu`
      // event rather than using Fabric's `mouse:down` with button===2 because
      // (a) DOM contextmenu fires once per gesture and lets us preventDefault
      // cleanly, and (b) Fabric's mouse event normalizes away the `button`
      // index on some platforms.
      const handleContextMenu = (event: MouseEvent) => {
        const tool = activeToolRef.current;
        if (tool !== 'select') {
          // Drawing tools: browser default. Bail without touching anything.
          return;
        }
        // Hit-test in scene coords. Walk ALL Freeform objects top-to-bottom
        // in render order — the visually-frontmost hit wins. If the topmost
        // hit is an Annotation (or there's no Freeform hit at all), the menu
        // doesn't open: we own it only for direct Image right-clicks per
        // spec. This avoids the surprise of right-clicking a callout sitting
        // on top of an Image and getting the underlying-Image menu.
        const scenePoint = canvas.getScenePoint(event);
        const all = freeformObjects(canvas);
        let topHit: FabricObject | undefined;
        for (let i = all.length - 1; i >= 0; i -= 1) {
          if (all[i].containsPoint(scenePoint)) {
            topHit = all[i];
            break;
          }
        }
        const target = topHit && isImageObject(topHit) ? topHit : undefined;
        if (!target) {
          // Right-click on empty Canvas, an Annotation, or anything else.
          // Per spec we only own the menu for direct Image hits; let the
          // browser default through and ensure any open menu closes.
          onContextMenuRef.current?.(null);
          return;
        }
        // Selection-on-right-click. Preserve a multi-selection that already
        // contains the right-clicked Image (`ActiveSelection` is Fabric's
        // wrapper around multi-select); otherwise replace selection with
        // just the target.
        const activeObjects = canvas.getActiveObjects();
        const alreadyPartOfMultiSelection = activeObjects.length > 1 && activeObjects.includes(target);
        if (!alreadyPartOfMultiSelection) {
          canvas.setActiveObject(target);
          // setActiveObject doesn't always emit selection:updated for a
          // replace-from-different-target case; push the change so the
          // parent's Delete button + any other selection-aware UI updates.
          emitSelectionChange();
        }
        canvas.requestRenderAll();
        event.preventDefault();
        // Anchor the menu at the click coordinates in viewport-relative
        // pixels. The overlay in App.tsx is `position: fixed` so these map
        // directly without any further translation.
        onContextMenuRef.current?.({ x: event.clientX, y: event.clientY });
      };

      const upperCanvas = canvas.upperCanvasEl;
      upperCanvas.addEventListener('contextmenu', handleContextMenu);

      canvas.on('mouse:down', handleMouseDown);
      canvas.on('mouse:move', handleMouseMove);
      canvas.on('mouse:up', handleMouseUp);
      canvas.on('object:moving', handleObjectMoving);
      canvas.on('object:modified', handleObjectModified);
      canvas.on('text:changed', saveHistorySnapshot);
      canvas.on('selection:created', emitSelectionChange);
      canvas.on('selection:updated', emitSelectionChange);
      canvas.on('selection:cleared', emitSelectionChange);

      return () => {
        upperCanvas.removeEventListener('contextmenu', handleContextMenu);
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

    // Apply Canvas color (empty-space color between Images). White/Black set
    // a solid Fabric backgroundColor; Transparent clears it so the wrapping
    // element's background shows through — the canvas-wrap gets a
    // data-canvas-color attribute and styles.css renders a checker pattern
    // there to make "transparent" visually unambiguous. NOT pushed to history:
    // this is a session setting, not an edit (see the Canvas color glossary
    // entry).
    //
    // ADR-0008: a hex string (anything not 'white' / 'black' / 'transparent')
    // is treated as a literal CSS color and painted directly. That's the
    // Match-mode case — the parent computes the effective color from the
    // derived-color cache and passes it through here.
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvasColor === 'white') {
        canvas.backgroundColor = '#ffffff';
      } else if (canvasColor === 'black') {
        canvas.backgroundColor = '#000000';
      } else if (canvasColor === 'transparent') {
        // Fabric treats falsy backgroundColor as "no fill" — the underlying
        // DOM canvas remains transparent, letting `.canvas-wrap`'s background
        // (the checker pattern, applied via a data attribute) show through.
        canvas.backgroundColor = '';
      } else {
        // Literal color (Match-derived hex). Paint it straight into Fabric's
        // backgroundColor — no transparent / checker semantics, just a solid
        // fill that follows the dominant color of the latest paste.
        canvas.backgroundColor = canvasColor;
      }
      canvas.requestRenderAll();
    }, [canvasColor]);

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
      const hadSelection = canvas.getActiveObjects().length > 0;
      canvas.discardActiveObject();
      // Programmatic discardActiveObject doesn't always fire `selection:cleared`,
      // so push directly to the parent when we know a selection was dropped.
      if (hadSelection) onSelectionChangeRef.current?.(false);
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
      pushHasContentChange(canvas);
      fitCanvasToViewport();
      onHistoryChange(historyIndexRef.current > 0, historyIndexRef.current < historyRef.current.length - 1);
    };

    // Compute the bounding box of all Freeform content (Images + Annotations)
    // in scene coordinates. Returns null when the canvas is empty — callers
    // should check before computing an export. Mirrors the bbox math in
    // fitCanvasToViewport but does NOT filter on "must have an Image": a
    // stray-annotation-only canvas is still exportable per issue #10.
    //
    // Per-Image shadow extent (#11) is folded in via objectBoundsWithShadow so
    // the export PNG includes the full shadow halo. EXPORT_PADDING is then
    // additive on top of this expanded bbox.
    const contentBoundingBox = (canvas: Canvas) => {
      const content = freeformObjects(canvas);
      if (content.length === 0) return null;
      let minLeft = Infinity;
      let minTop = Infinity;
      let maxRight = -Infinity;
      let maxBottom = -Infinity;
      for (const object of content) {
        const bounds = objectBoundsWithShadow(object);
        if (bounds.left < minLeft) minLeft = bounds.left;
        if (bounds.top < minTop) minTop = bounds.top;
        if (bounds.right > maxRight) maxRight = bounds.right;
        if (bounds.bottom > maxBottom) maxBottom = bounds.bottom;
      }
      if (!isFinite(minLeft) || !isFinite(maxRight)) return null;
      const width = maxRight - minLeft;
      const height = maxBottom - minTop;
      if (width <= 0 || height <= 0) return null;
      return { left: minLeft, top: minTop, width, height };
    };

    // Build the export PNG dataUrl. Pipeline: compute the content bbox,
    // temporarily reset zoom + pan to identity (so 1 scene unit = 1 output
    // pixel — i.e., natural per-Image resolution preserved, only the
    // auto-fit display zoom is inverted), apply the chosen Canvas color as
    // the Fabric backgroundColor, ask Fabric to crop to the bbox + padding
    // via `toDataURL`'s {left, top, width, height} region, then restore the
    // original viewport + background. We use Fabric's built-in region
    // cropping rather than a hand-rolled offscreen canvas because: (a) the
    // region option is exactly the right shape, and (b) Fabric handles
    // backgroundColor fill and object rendering in one shot — re-doing that
    // ourselves would duplicate the renderer.
    //
    // Transparent canvas color: leave Fabric's backgroundColor as '' for the
    // export. Fabric's _renderBackgroundOrOverlay early-returns on falsy
    // backgroundColor (verified in node_modules/fabric/dist/index.node.mjs
    // around line 2227), so the output PNG retains its alpha channel and
    // any empty space stays transparent.
    const exportDataUrl = (): string | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const bbox = contentBoundingBox(canvas);
      if (!bbox) return null;

      // Drop any active selection so its bounding box handles don't render
      // into the exported PNG. (Fabric draws controls as part of the canvas
      // by default; skipControlsDrawing is set inside toCanvasElement, but
      // discarding the active object is the cleaner-truth signal.)
      canvas.discardActiveObject();

      // Snapshot state we're about to mutate so the restoration path is one
      // place rather than scattered throughout. viewportTransform is a tuple;
      // copy via spread so a later setViewportTransform won't mutate our
      // snapshot in place.
      const originalVpt: [number, number, number, number, number, number] = [
        ...canvas.viewportTransform,
      ] as [number, number, number, number, number, number];
      const originalBg = canvas.backgroundColor;
      const originalWidth = canvas.getWidth();
      const originalHeight = canvas.getHeight();

      // Identity viewport: scene 1 unit = display 1 pixel. With multiplier=1
      // below, output 1 pixel = scene 1 unit, which means each Image renders
      // at its paste-time scaled size — the auto-fit display zoom is undone,
      // but per-Image scaleX (from MAX_PASTE_WIDTH clamping) stays. That
      // matches the issue spec's "natural resolution of pasted screenshots".
      canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);

      // Canvas color → export background. Transparent => '' (Fabric skips
      // the fill, alpha preserved). Capturing canvasColor through a ref so a
      // mid-session change after canvas init is reflected. A hex string from
      // Match mode (ADR-0008) is painted as a literal solid fill — exported
      // PNG matches what the user sees on screen.
      const exportColor = canvasColorRef.current;
      if (exportColor === 'white') {
        canvas.backgroundColor = '#ffffff';
      } else if (exportColor === 'black') {
        canvas.backgroundColor = '#000000';
      } else if (exportColor === 'transparent') {
        canvas.backgroundColor = '';
      } else {
        canvas.backgroundColor = exportColor;
      }

      // Bbox + padding in scene coords. EXPORT_PADDING is in NATURAL output
      // pixels (= scene units under identity vpt + multiplier=1). Padding is
      // additive on each side so the visible margin is EXPORT_PADDING px on
      // top/bottom/left/right.
      const left = bbox.left - EXPORT_PADDING;
      const top = bbox.top - EXPORT_PADDING;
      const width = bbox.width + EXPORT_PADDING * 2;
      const height = bbox.height + EXPORT_PADDING * 2;

      let dataUrl: string;
      try {
        dataUrl = canvas.toDataURL({
          format: 'png',
          multiplier: 1,
          left,
          top,
          width,
          height,
        });
      } finally {
        // Restore. Order matters: width/height first (toCanvasElement reads
        // them during render but already restored its own changes; we're
        // restoring OUR mutation of viewportTransform/backgroundColor here).
        canvas.setViewportTransform(originalVpt);
        canvas.backgroundColor = originalBg;
        // toCanvasElement also temporarily resets width/height but restores
        // them. Just in case our snapshot drifted (paranoid), reassert.
        if (canvas.getWidth() !== originalWidth || canvas.getHeight() !== originalHeight) {
          canvas.setDimensions({ width: originalWidth, height: originalHeight });
        }
        canvas.requestRenderAll();
      }
      return dataUrl;
    };

    useImperativeHandle(
      ref,
      () => ({
        addImage: (dataUrl: string) => {
          // Queue: chain onto the previous mutation so concurrent calls decode
          // (and therefore reserve their row positions) in invocation order,
          // and so they can't interleave with an in-flight history restore.
          // We considered an in-place reservation approach — capturing
          // `nextImageLeft(canvas)` synchronously and bumping a pending ref —
          // but without knowing the decoded width up front we'd have to
          // reserve `MAX_PASTE_WIDTH` per paste, which leaves visible gaps
          // between sub-800px images. Serializing decodes via the shared
          // mutation queue keeps tight packing AND coordinates with restores.
          return queueMutation(async () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            // ADR-0008 race fix: capture "was the canvas empty before this
            // paste" synchronously, at the moment this paste's queued mutation
            // starts running and BEFORE canvas.add. Mutations are serialized
            // by queueMutation, so a previous paste in the same batch has
            // already landed its Image on the canvas by the time we read this.
            // This is the source of truth the auto-engage gate in App.tsx
            // depends on — reading React `hasImages` instead would let two
            // rapid pastes both observe `false` and both auto-engage.
            const wasEmpty = imageObjects(canvas).length === 0;
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
            // ADR-0006: a freshly pasted Image lands at the TOP of the Image
            // stack, still below all Annotations. This replaces the earlier
            // `sendObjectToBack` call — whose original intent was "stay below
            // Annotations," not "stay below older Images." The helper keeps
            // the Annotation-above-Image invariant from ADR-0003 in one place
            // and preserves the same intent without the side effect of
            // reverse paste order (which made newer pastes hide behind
            // older ones).
            bringImageToTopOfImages(canvas, image);
            canvas.requestRenderAll();
            // Inform parent BEFORE fitting: the canvas element only becomes
            // visible (display: block) on the parent's hasImages flip, so the
            // first fit needs a layout pass after that switch. The effect on
            // [hasImages] above handles that case; this call covers subsequent
            // pastes where the shell is already sized.
            onHasImagesChange(true);
            pushHasContentChange(canvas);
            fitCanvasToViewport();
            saveHistorySnapshot();
            // ADR-0008: extract a softened dominant color and hand it up to
            // App.tsx, which owns the Match-mode state machine. We do this
            // AFTER history snapshot so a successful paste is recorded even
            // if extraction throws — the cached derived color is a session
            // setting, not part of canvas history. Extraction failure is
            // signaled with `null` so the parent can decide what "silent
            // fallback" means in its current state (per ADR-0008: White on
            // first paste, previous derived color on subsequent pastes).
            // `wasEmpty` (captured pre-add at the top of this mutation) is the
            // race-free source of truth for App.tsx's auto-engage gate.
            if (onImagePastedDominantColor) {
              const element = image.getElement();
              const color =
                element instanceof HTMLImageElement ? extractDominantColor(element) : null;
              onImagePastedDominantColor(color, wasEmpty);
            }
          });
        },
        undo: () => {
          if (historyIndexRef.current <= 0) return;
          historyIndexRef.current -= 1;
          const state = historyRef.current[historyIndexRef.current];
          // Queue the restore behind any in-flight paste so the two can't
          // interleave. `restoreSeqRef` still defends against rapid undo/redo
          // within the restore itself; this queue defends across mutation
          // kinds.
          void queueMutation(() => restoreHistory(state));
        },
        redo: () => {
          if (historyIndexRef.current >= historyRef.current.length - 1) return;
          historyIndexRef.current += 1;
          const state = historyRef.current[historyIndexRef.current];
          void queueMutation(() => restoreHistory(state));
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
        copyPng: async () => {
          // Drain the mutation queue first. If a paste or undo/redo is in
          // flight, snapshotting now would either miss the new content or
          // capture a half-applied state mid-restore. The queue resolves
          // ordered, so once previous-tail settles all earlier ops have
          // landed. Wave-3 mutation queue heads-up.
          await mutationQueueRef.current;
          const dataUrl = exportDataUrl();
          if (!dataUrl) {
            // Buttons are gated on hasContent so this branch is rare — but
            // a race (e.g., last Image deleted between click and queue drain)
            // can land us here. Silent-skip rather than surface a toast for
            // what looks like a no-op to the user.
            return;
          }
          const blob = await dataUrlToBlob(dataUrl);
          const copied = await copyPngBlobToClipboard(blob);
          if (copied) {
            onToast('Copied PNG to clipboard', 'success');
          } else {
            // Mirror Skitch's fallback: if ClipboardItem image/png is
            // unsupported (Firefox without permission, older Safari, etc.),
            // download the file and surface the substitution as a warning
            // so the user understands why their paste target is empty.
            downloadDataUrl(dataUrl, EXPORT_FILE_NAME);
            onToast('Clipboard copy not supported. Downloaded PNG instead.', 'warning');
          }
        },
        downloadPng: async () => {
          await mutationQueueRef.current;
          const dataUrl = exportDataUrl();
          if (!dataUrl) return;
          downloadDataUrl(dataUrl, EXPORT_FILE_NAME);
        },
        deleteSelected: () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          // ADR-0006: delete ANY selected Freeform object (Images and/or
          // Annotations). The earlier #7 filter to Image-kind only was an
          // anachronism — at that time Annotations weren't selectable. Now
          // both kinds are selectable, and matching keyboard + right-click
          // menu behavior is to vacuum up whatever the user picked. We still
          // filter to `data.kind !== undefined` so any future non-Freeform
          // object (e.g., a guideline overlay) can't be killed accidentally.
          const targets = canvas
            .getActiveObjects()
            .filter((object) => (object as TaggedObject).data?.kind !== undefined);
          if (targets.length === 0) return;
          targets.forEach((object) => canvas.remove(object));
          canvas.discardActiveObject();
          // Programmatic discardActiveObject doesn't always fire
          // `selection:cleared`; notify the parent so the Delete button's
          // disabled state reflects the now-empty selection.
          onSelectionChangeRef.current?.(false);
          canvas.requestRenderAll();
          onHasImagesChange(imageObjects(canvas).length > 0);
          pushHasContentChange(canvas);
          fitCanvasToViewport();
          // `object:modified` doesn't fire on remove, so we push the snapshot
          // here. (The Skitch path does the equivalent.)
          saveHistorySnapshot();
        },
        // ADR-0006 layer reorder. The two methods share a single helper that
        // collects Image-kind members of the active selection, sorts them by
        // current canvas index, and walks them in the order that preserves
        // internal relative stacking. See `applyLayerReorder` for the
        // direction-of-iteration math.
        bringSelectedImagesToFront: () => {
          applyLayerReorder('front');
        },
        sendSelectedImagesToBack: () => {
          applyLayerReorder('back');
        },
        // ADR-0007: wipes Images too — Skitch's clearAnnotations only kills
        // annotations, but Freeform has no Background, so clearing means
        // clearing everything. Single history snapshot via saveHistorySnapshot
        // (same shape every other mutation pushes), so Cmd+Z restores prior
        // state.
        clearCanvas: () => {
          void queueMutation(async () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const targets = canvas
              .getObjects()
              .filter((object) => (object as TaggedObject).data?.kind !== undefined);
            if (targets.length === 0) return;
            targets.forEach((object) => canvas.remove(object));
            canvas.discardActiveObject();
            // Programmatic discardActiveObject doesn't always fire
            // `selection:cleared`; notify the parent so the Delete button's
            // disabled state reflects the now-empty selection. Mirrors
            // deleteSelected.
            onSelectionChangeRef.current?.(false);
            canvas.requestRenderAll();
            onHasImagesChange(false);
            pushHasContentChange(canvas);
            fitCanvasToViewport();
            saveHistorySnapshot();
          });
        },
      }),
      // Stable handle: the closures above read from refs and the latest props
      // via the callback identities below. Callbacks are stable in the parent
      // (useCallback), so this list is effectively constant — but listing them
      // keeps the React lint rule happy if/when that changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [onHasImagesChange, onHistoryChange, onToast, onToolChange, onImagePastedDominantColor],
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
        <div
          className={hasImages ? 'canvas-wrap visible' : 'canvas-wrap'}
          // For the three named modes the data-canvas-color CSS selectors in
          // styles.css paint the wrap (solid for white/black, checker for
          // transparent). A hex string from Match mode (ADR-0008) doesn't
          // match any selector, so we paint the wrap inline so the canvas's
          // visible edges blend with Fabric's interior fill.
          data-canvas-color={canvasColor}
          style={
            canvasColor === 'white' || canvasColor === 'black' || canvasColor === 'transparent'
              ? undefined
              : { background: canvasColor }
          }
        >
          <canvas ref={canvasElRef} />
        </div>
      </section>
    );
  },
);
