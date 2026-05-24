import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  Canvas,
  Circle,
  FabricImage,
  FabricObject,
  Group,
  Line,
  Polygon,
  Rect,
  Text,
  Shadow,
  Textbox,
  Triangle,
  util,
} from 'fabric';
import type { Tool } from '../types';
import { hexToLowAlpha, recolorAnnotation } from '../utils/colors';
import { copyPngBlobToClipboard, dataUrlToBlob, downloadDataUrl } from '../utils/export';

// Fabric v7 changed the default origin to 'center'; this app's positioning math
// (background image at 0,0, drag-rect from start corner, callout offsets, etc.)
// assumes 'left'/'top'. Restore the v6 default globally.
FabricObject.ownDefaults.originX = 'left';
FabricObject.ownDefaults.originY = 'top';

const STROKE_WIDTH = 8;
const FONT_FAMILY = '"Arial Rounded MT Bold", Arial, Helvetica, system-ui, sans-serif';
const FONT_SIZE = 32;
const CALLOUT_SIZE = 42;
const PIXEL_SIZE = 12;

type HistoryState = string;

type DrawingState =
  | { kind: 'rectangle'; startX: number; startY: number; object: Rect }
  | { kind: 'arrow'; startX: number; startY: number; line: Line; head: Triangle }
  | { kind: 'blur'; startX: number; startY: number; object: Rect };

interface CanvasEditorProps {
  imageDataUrl: string | null;
  activeTool: Tool;
  activeColor: string;
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
}

function annotationObjects(canvas: Canvas) {
  return canvas.getObjects().filter((object) => (object as FabricObject & { data?: { kind?: string } }).data?.kind !== 'background');
}

function serializeAnnotations(canvas: Canvas): HistoryState {
  return JSON.stringify(annotationObjects(canvas).map((object) => object.toObject(['data'])));
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

function makeArrow(color: string, scale: number, startX: number, startY: number, endX: number, endY: number) {
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
  const headHalf = headLen * 0.42;
  const bodyHalf = Math.max(headHalf * 0.32, 4 * scale);
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
  { imageDataUrl, activeTool, activeColor, onToolChange, onToast, onImageLoaded, onHistoryChange },
  ref,
) {
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const canvasShellRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const backgroundElementRef = useRef<HTMLImageElement | null>(null);
  const drawingRef = useRef<DrawingState | null>(null);
  const activeToolRef = useRef(activeTool);
  const activeColorRef = useRef(activeColor);
  const historyRef = useRef<HistoryState[]>(['[]']);
  const historyIndexRef = useRef(0);
  const restoringRef = useRef(false);
  const displayScaleRef = useRef(1);

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
    const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);
    displayScaleRef.current = scale;
    canvas.setDimensions({ width: naturalWidth * scale, height: naturalHeight * scale });
    canvas.setZoom(scale);
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

    const handleMouseDown = (event: { e: CanvasPointerEvent }) => {
      if (!backgroundElementRef.current || activeToolRef.current === 'select') return;
      const pointer = pointerFromEvent(event);

      // If the click landed on an existing annotation, escape sticky mode:
      // switch to Select and pick the object up instead of stacking a new
      // annotation on top. Annotations are evented=false while a drawing tool
      // is active, so Fabric's own hit-test won't see them — we walk them
      // manually with containsPoint().
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

      if (activeToolRef.current === 'rectangle') {
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
      } else if (activeToolRef.current === 'arrow') {
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
      const pointer = pointerFromEvent(event);
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

    const handleMouseUp = async (event: { e: CanvasPointerEvent }) => {
      const drawing = drawingRef.current;
      if (!drawing) return;
      drawingRef.current = null;
      const pointer = pointerFromEvent(event);

      if (drawing.kind === 'rectangle') {
        if ((drawing.object.width ?? 0) < 4 || (drawing.object.height ?? 0) < 4) {
          canvas.remove(drawing.object);
        } else {
          addFinalObject(drawing.object);
        }
      } else if (drawing.kind === 'arrow') {
        canvas.remove(drawing.line, drawing.head);
        if (Math.hypot(pointer.x - drawing.startX, pointer.y - drawing.startY) > 10) {
          addFinalObject(makeArrow(activeColorRef.current, annotationScale(), drawing.startX, drawing.startY, pointer.x, pointer.y));
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
      const pointer = pointerFromEvent(event);
      const scale = annotationScale();
      const color = activeColorRef.current;
      if (activeToolRef.current === 'text') {
        const text = makeText(color, scale, pointer.x, pointer.y);
        addFinalObject(text);
        text.enterEditing();
        text.selectAll();
        // System-wide ADR-0003: Text is the one-shot drawing tool. When edit
        // mode exits (click outside, Esc, Tab, programmatic blur), snap back
        // to Select so the gesture that finished typing doesn't silently
        // spawn another text box. `once` self-detaches so re-editing this
        // same Textbox later doesn't reapply the snap.
        text.once('editing:exited', () => onToolChange('select'));
      } else if (activeToolRef.current === 'callout') {
        addFinalObject(makeCallout(color, scale, pointer.x, pointer.y, nextStepNumber(canvas)));
      }
    };

    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);
    canvas.on('mouse:dblclick', handleCanvasClick);
    canvas.on('mouse:up', (event) => {
      if (activeToolRef.current === 'text' || activeToolRef.current === 'callout') {
        handleCanvasClick(event);
      }
    });
    canvas.on('object:modified', saveHistory);
    canvas.on('text:changed', saveHistory);

    return () => {
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

  const exportDataUrl = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    // Invert the fit-to-viewport scale so the exported PNG keeps the source image's natural resolution.
    const multiplier = displayScaleRef.current > 0 ? 1 / displayScaleRef.current : 1;
    return canvas.toDataURL({ format: 'png', multiplier });
  };

  useImperativeHandle(ref, () => ({
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
      const blob = await dataUrlToBlob(dataUrl);
      const copied = await copyPngBlobToClipboard(blob);
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
      <div className={imageDataUrl ? 'canvas-wrap visible' : 'canvas-wrap'}>
        <canvas ref={canvasElRef} />
      </div>
    </section>
  );
});
