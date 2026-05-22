import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Canvas, FabricImage, FabricObject, Point, util } from 'fabric';

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

interface CanvasEditorProps {
  // True when the parent thinks at least one Image is on the canvas. Drives
  // the empty-state vs canvas display in the parent; the canvas itself is the
  // source of truth for object count.
  hasImages: boolean;
  onHasImagesChange: (hasImages: boolean) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
  onToast: (text: string, tone?: 'success' | 'warning' | 'info') => void;
}

export interface FreeformCanvasEditorHandle {
  addImage: (dataUrl: string) => Promise<void>;
  undo: () => void;
  redo: () => void;
}

// Every canvas object Freeform creates gets a `data.kind` tag so future tooling
// (selection, deletion, recolor) can discriminate Image vs Annotation. For this
// slice, only 'image' exists — annotations land in #6 and beyond.
type TaggedObject = FabricObject & { data?: { kind?: string } };

// Image is the only tagged kind today. Anything else with a `data.kind` set is
// an Annotation by elimination. We deliberately do NOT enumerate annotation
// kinds here — annotations will be added incrementally in #6/#8 and we want
// this helper to keep working without edits each time a new kind lands.
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

// Skitch filters out the background singleton when serializing. Freeform has no
// such thing — every tagged object on the canvas is part of user state. We
// include `selectable`/`evented` in the prop list so per-object interaction
// flags round-trip through history restore (otherwise undo would silently
// re-flip these to Fabric defaults when downstream slices make Images
// draggable). `data` carries our kind tag.
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

export const FreeformCanvasEditor = forwardRef<FreeformCanvasEditorHandle, CanvasEditorProps>(
  function FreeformCanvasEditor({ hasImages, onHasImagesChange, onHistoryChange, onToast }, ref) {
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

    useEffect(() => {
      if (!canvasElRef.current) return;

      const canvas = new Canvas(canvasElRef.current, {
        preserveObjectStacking: true,
        // No selection in this slice — Images are not interactive yet.
        selection: false,
      });
      canvasRef.current = canvas;

      return () => {
        canvas.dispose();
        canvasRef.current = null;
      };
      // Intentionally one-time setup. Callbacks captured via refs in handlers
      // so they don't need to be in deps.
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
      canvas.getObjects().forEach((object) => canvas.remove(object));
      const parsed = JSON.parse(state) as Record<string, unknown>[];
      const objects = await util.enlivenObjects(parsed);
      if (mySeq !== restoreSeqRef.current) return;
      // `selectable`/`evented` are serialized into the snapshot (see
      // `serializeAll`), so the enlivened objects round-trip those flags
      // naturally — no per-object override needed here. This matters once
      // downstream slices make Images draggable: without round-trip, undo
      // would silently re-disable interaction.
      objects.forEach((object) => canvas.add(object as FabricObject));
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
            image.set({
              left: nextImageLeft(canvas),
              top: 0,
              scaleX: scale,
              scaleY: scale,
              selectable: false,
              evented: false,
              hasControls: false,
              hasBorders: false,
              data: { kind: 'image' },
            });
            canvas.add(image);
            // Layer invariant: every Image renders below every Annotation,
            // regardless of paste/draw order (ADR-0005 layer rule). Today there
            // are no Annotations so this is a no-op; once #6 lands and the user
            // can draw over existing Images, this prevents a freshly-pasted
            // Image from covering the drawings on it.
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
      }),
      // Stable handle: the closures above read from refs and the latest props
      // via the callback identities below. Callbacks are stable in the parent
      // (useCallback), so this list is effectively constant — but listing them
      // keeps the React lint rule happy if/when that changes.
      [onHasImagesChange, onHistoryChange, onToast],
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
