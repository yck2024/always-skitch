import { useCallback, useEffect, useRef, useState } from 'react';
import { ColorPicker } from '../components/ColorPicker';
import { TopNav } from '../components/TopNav';
import { DEFAULT_COLOR, PALETTE } from '../palette';
import type { ToastMessage, Tool } from '../types';
import { fileToDataUrl, getImageFileFromPaste, readImageFromClipboard } from '../utils/clipboard';
import { FreeformCanvasEditor, type FreeformCanvasColor, type FreeformCanvasEditorHandle } from './CanvasEditor';

// Three Canvas color choices: the color of empty space between Images. This is
// independent of the Active color picker — they live in separate toolbar
// groups and never share state. 'transparent' is rendered as a checker
// pattern on .canvas-wrap so users see at-a-glance that the area is
// see-through (vs. just a white page background, which could be confused with
// the White option).
const CANVAS_COLOR_OPTIONS: { value: FreeformCanvasColor; label: string }[] = [
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'transparent', label: 'Transparent' },
];

// Freeform is the multi-image annotation board at /freeform. Wave 3
// integrates #6 (annotations) + #7 (Image select/drag/resize/delete) + #9
// (Canvas color) on top of #5's additive paste foundation.
//
// Key divergence from Skitch: NO useEffect that resets activeColor on paste.
// Skitch resets to red per Background because a Background swap is a fresh
// session; Freeform's Canvas spans multiple pastes, so the user's color
// choice must persist across them.
const FREEFORM_TOOLS: Array<{ tool: Tool; label: string }> = [
  { tool: 'select', label: 'Select' },
  { tool: 'arrow', label: 'Arrow' },
  { tool: 'rectangle', label: 'Rectangle' },
  { tool: 'text', label: 'Text' },
  { tool: 'callout', label: 'Step' },
  // Blur lives at the end of the drawing-tool group. Per-Image semantics
  // (ADR-0005 / issue #8) — cursor management and start-on-Image gating
  // happen in CanvasEditor; from the toolbar's perspective it's just another
  // sticky drawing tool that requires `hasImages`.
  { tool: 'blur', label: 'Blur' },
];

export default function FreeformApp() {
  const editorRef = useRef<FreeformCanvasEditorHandle | null>(null);
  const [hasImages, setHasImages] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  // Default to Select so the first paste isn't met with a sticky drawing tool
  // active. Matches the "open Freeform → paste → look around" flow. With #7
  // integrated, Select also makes Images draggable/resizable; with a drawing
  // tool active, Images become non-interactive (clicks start a draw).
  const [activeTool, setActiveTool] = useState<Tool>('select');
  // Active color is App-state (not Canvas-state) because it persists across
  // pastes and isn't part of undo history. DEFAULT_COLOR is red — the Skitch
  // pen color — and is reused so the two products feel related.
  const [activeColor, setActiveColor] = useState<string>(DEFAULT_COLOR);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  // Canvas color (empty-space color between Images). Component state only —
  // no localStorage, no router. Defaults to 'white' on every fresh session.
  // Not pushed to history; switching is a setting, not an edit.
  const [canvasColor, setCanvasColor] = useState<FreeformCanvasColor>('white');
  // Whether the canvas has at least one selected object. Drives the Delete
  // button's enabled state — the operation is a no-op when nothing is
  // selected, so the button should reflect that.
  const [hasSelection, setHasSelection] = useState(false);
  // Whether the canvas has any exportable content (Images OR Annotations).
  // Drives the Copy PNG / Download button enabled state per issue #10. We
  // need a separate flag from `hasImages` because a stray annotation alone
  // also counts as content — though in normal flow Annotations require an
  // Image; this just keeps the gating expressive and forward-compatible.
  const [hasContent, setHasContent] = useState(false);

  const showToast = useCallback((text: string, tone: ToastMessage['tone'] = 'info') => {
    const id = Date.now();
    setToasts((current) => current.concat({ id, text, tone }));
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3200);
  }, []);

  const handleHistoryChange = useCallback((undo: boolean, redo: boolean) => {
    setCanUndo(undo);
    setCanRedo(redo);
  }, []);

  // Color picker change: set the pen color AND recolor the current selection
  // (if any). Mirrors Skitch's pattern — see src/App.tsx handleColorChange.
  // Deliberately NOT wrapped in an effect that watches pastes: Active color
  // must persist across pastes (this is the headline divergence from Skitch).
  const handleColorChange = useCallback((color: string) => {
    setActiveColor(color);
    editorRef.current?.recolorSelected(color);
  }, []);

  // Append an image to the Canvas. Unlike Skitch's loadImageFile, this never
  // prompts to replace — Freeform is additive by definition.
  const appendImageFile = useCallback(
    async (file: File | Blob | null) => {
      if (!file) {
        showToast('No image found on the clipboard.', 'warning');
        return;
      }
      const dataUrl = await fileToDataUrl(file);
      await editorRef.current?.addImage(dataUrl);
    },
    [showToast],
  );

  const handlePasteButton = useCallback(async () => {
    try {
      const file = await readImageFromClipboard();
      await appendImageFile(file);
    } catch {
      showToast('Clipboard image read was blocked. Try Cmd+V in the page.', 'warning');
    }
  }, [appendImageFile, showToast]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const file = getImageFileFromPaste(event);
      if (!file) return;
      event.preventDefault();
      void appendImageFile(file);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const isEditingText = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.isContentEditable;
      const key = event.key.toLowerCase();
      // Undo / Redo. We support both Cmd+Shift+Z and Cmd+Y for redo, matching
      // common cross-platform conventions.
      if (meta && key === 'z' && !isEditingText) {
        event.preventDefault();
        if (event.shiftKey) editorRef.current?.redo();
        else editorRef.current?.undo();
      } else if (meta && key === 'y' && !isEditingText) {
        event.preventDefault();
        editorRef.current?.redo();
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && !isEditingText) {
        // Delete / Backspace removes selected Images (#7). The editor's
        // `deleteSelected` filters to Image-kind objects, so this is a no-op
        // when nothing is selected or only Annotations are. Annotations on
        // top of the deleted Image stay (ADR-0003).
        event.preventDefault();
        editorRef.current?.deleteSelected();
      } else if (event.key === 'Escape' && !isEditingText) {
        // Esc bails out of any drawing tool back to Select. Matches Skitch.
        setActiveTool('select');
      } else if (!meta && !isEditingText) {
        // Single-key tool shortcuts (#6), mirroring Skitch's bindings so muscle
        // memory transfers between the two products.
        if (key === 'v') {
          event.preventDefault();
          setActiveTool('select');
        } else if (key === 'a') {
          event.preventDefault();
          setActiveTool('arrow');
        } else if (key === 'r') {
          event.preventDefault();
          setActiveTool('rectangle');
        } else if (key === 't') {
          event.preventDefault();
          setActiveTool('text');
        } else if (key === 's') {
          event.preventDefault();
          setActiveTool('callout');
        } else if (key === 'b') {
          // Blur shortcut (#8). Matches Skitch's `b` binding so muscle
          // memory transfers between the two products.
          event.preventDefault();
          setActiveTool('blur');
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [appendImageFile]);

  return (
    <div className="app">
      <TopNav />
      {/* Freeform toolbar. Wave-3 order, left to right:
            Paste Image | Tools group | Active color | Canvas color
            | Undo | Redo | Delete
          We deliberately do NOT reuse Skitch's Toolbar component, which is
          bound to Skitch's tool set, single-image model, and per-Background
          color reset. */}
      <div className="toolbar" role="toolbar" aria-label="Freeform actions">
        <button type="button" className="primary" onClick={handlePasteButton}>
          Paste Image
        </button>
        <div className="toolbar-group" role="group" aria-label="Annotation tools">
          {FREEFORM_TOOLS.map(({ tool, label }) => (
            <button
              key={tool}
              type="button"
              className={activeTool === tool ? 'active' : ''}
              // Drawing tools require an Image on the Canvas; Select is always
              // available. Blur (#8) is now live — same gating as other
              // drawing tools.
              disabled={tool !== 'select' && !hasImages}
              onClick={() => setActiveTool(tool)}
              title={label}
            >
              {label}
            </button>
          ))}
        </div>
        <ColorPicker
          palette={PALETTE}
          value={activeColor}
          open={colorPickerOpen}
          disabled={!hasImages}
          onChange={handleColorChange}
          onOpenChange={setColorPickerOpen}
        />
        {/* Canvas color picker — three small swatches in a dedicated toolbar
            group, intentionally visually distinct from the Active color picker
            (single circular swatch with a popover). Distinct shape +
            always-visible three swatches prevents users confusing "color of
            empty space" with "color of new annotations". Not part of undo
            history; selection is a setting, not an edit. */}
        <div className="canvas-color-group" role="group" aria-label="Canvas color">
          <span className="canvas-color-label" aria-hidden="true">Canvas</span>
          {CANVAS_COLOR_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`canvas-color-swatch canvas-color-${value}${canvasColor === value ? ' active' : ''}`}
              onClick={() => setCanvasColor(value)}
              aria-label={`Canvas color: ${label}`}
              aria-pressed={canvasColor === value}
              title={`Canvas color: ${label}`}
            />
          ))}
        </div>
        <button type="button" onClick={() => editorRef.current?.undo()} disabled={!canUndo}>
          Undo
        </button>
        <button type="button" onClick={() => editorRef.current?.redo()} disabled={!canRedo}>
          Redo
        </button>
        {/* Delete button mirrors the Backspace/Delete keyboard shortcut. The
            editor filters to Image-kind selected objects and no-ops if none —
            so the button is only enabled when something is actually selected
            on the canvas (driven by `onSelectionChange` from the editor). */}
        <button type="button" onClick={() => editorRef.current?.deleteSelected()} disabled={!hasSelection}>
          Delete
        </button>
        {/* Export group (issue #10). Right-aligned via the .export-actions
            margin-left:auto rule shared with Skitch's toolbar. Both buttons
            disabled when canvas has no Images AND no Annotations — driven by
            `onHasContentChange` from the editor. Copy PNG falls back to
            Download when the browser doesn't support ClipboardItem image/png,
            matching Skitch's behavior; the editor surfaces a toast in that
            case so the user knows why their paste target is empty. */}
        <div className="toolbar-group export-actions" role="group" aria-label="Export commands">
          <button
            type="button"
            disabled={!hasContent}
            onClick={() => void editorRef.current?.copyPng()}
          >
            Copy PNG
          </button>
          <button
            type="button"
            disabled={!hasContent}
            onClick={() => void editorRef.current?.downloadPng()}
          >
            Download
          </button>
        </div>
      </div>
      <main className="workspace">
        <FreeformCanvasEditor
          ref={editorRef}
          hasImages={hasImages}
          activeTool={activeTool}
          activeColor={activeColor}
          canvasColor={canvasColor}
          onHasImagesChange={setHasImages}
          onHistoryChange={handleHistoryChange}
          onToast={showToast}
          onToolChange={setActiveTool}
          onSelectionChange={setHasSelection}
          onHasContentChange={setHasContent}
        />
      </main>

      <div className="toast-stack" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}
