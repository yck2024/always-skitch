import { useCallback, useEffect, useRef, useState } from 'react';
import { ColorPicker } from '../components/ColorPicker';
import { TopNav } from '../components/TopNav';
import { DEFAULT_COLOR, PALETTE } from '../palette';
import type { ToastMessage, Tool } from '../types';
import { fileToDataUrl, getImageFileFromPaste, readImageFromClipboard } from '../utils/clipboard';
import { FreeformCanvasEditor, type FreeformCanvasEditorHandle } from './CanvasEditor';

// Freeform is the multi-image annotation board at /freeform. See
// src/freeform/CONTEXT.md (Canvas/Image/Annotation glossary) and ADR 0002
// (separate route, not mode toggle). This slice (#6) adds the drawing tools
// (arrow, rectangle, text, step callout) plus the Active color picker on top
// of #5's additive paste foundation.
//
// Key divergence from Skitch: NO useEffect that resets activeColor on paste.
// Skitch resets to red per Background; Freeform Canvas spans multiple pastes
// so the user's color choice must persist. (See ADR-0003 + the CONTEXT.md
// Active color rule.)
//
// Toolbar layout NOTE for parallel agents: #7 (Image select/drag/resize) and
// #9 (Canvas color picker) also touch this file. The toolbar is intentionally
// linear and additive — we append a Tools group and Color picker after the
// existing Paste/Undo/Redo group rather than reorganizing them. Future agents
// should keep appending in the same spirit until someone consciously decides
// to extract a shared component.
const FREEFORM_TOOLS: Array<{ tool: Tool; label: string }> = [
  { tool: 'select', label: 'Select' },
  { tool: 'arrow', label: 'Arrow' },
  { tool: 'rectangle', label: 'Rectangle' },
  { tool: 'text', label: 'Text' },
  { tool: 'callout', label: 'Step' },
  // Blur is stubbed and disabled — owned by issue #8 because of its per-Image
  // behavior. Showing it disabled tells the user the tool exists in the family
  // without pretending it works yet.
  { tool: 'blur', label: 'Blur' },
];

export default function FreeformApp() {
  const editorRef = useRef<FreeformCanvasEditorHandle | null>(null);
  const [hasImages, setHasImages] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  // Default to Select so the first paste isn't met with a sticky drawing tool
  // active. Matches the "open Freeform → paste → look around" flow.
  const [activeTool, setActiveTool] = useState<Tool>('select');
  // Active color is App-state (not Canvas-state) because it persists across
  // pastes and isn't part of undo history. DEFAULT_COLOR is red — the Skitch
  // pen color — and is reused so the two products feel related.
  const [activeColor, setActiveColor] = useState<string>(DEFAULT_COLOR);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);

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
      } else if (event.key === 'Escape' && !isEditingText) {
        // Esc bails out of any drawing tool back to Select. Matches Skitch.
        setActiveTool('select');
      } else if (!meta && !isEditingText) {
        // Single-key tool shortcuts, mirroring Skitch's bindings so muscle
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
      {/* Freeform toolbar. Keeps the linear layout from #5 and appends a Tools
          group + Color picker. We deliberately do NOT reuse Skitch's Toolbar
          component, which is bound to Skitch's tool set, single-image model,
          and per-Background color reset. */}
      <div className="toolbar" role="toolbar" aria-label="Freeform actions">
        <button type="button" className="primary" onClick={handlePasteButton}>
          Paste Image
        </button>
        <button type="button" onClick={() => editorRef.current?.undo()} disabled={!canUndo}>
          Undo
        </button>
        <button type="button" onClick={() => editorRef.current?.redo()} disabled={!canRedo}>
          Redo
        </button>
        <div className="toolbar-group" role="group" aria-label="Annotation tools">
          {FREEFORM_TOOLS.map(({ tool, label }) => (
            <button
              key={tool}
              type="button"
              className={activeTool === tool ? 'active' : ''}
              // Drawing tools require an Image on the Canvas; Select is always
              // available. Blur stays disabled in this slice (issue #8).
              disabled={(tool !== 'select' && !hasImages) || tool === 'blur'}
              onClick={() => setActiveTool(tool)}
              title={tool === 'blur' ? 'Blur (coming soon)' : label}
            >
              {label}
            </button>
          ))}
          <ColorPicker
            palette={PALETTE}
            value={activeColor}
            open={colorPickerOpen}
            disabled={!hasImages}
            onChange={handleColorChange}
            onOpenChange={setColorPickerOpen}
          />
        </div>
      </div>
      <main className="workspace">
        <FreeformCanvasEditor
          ref={editorRef}
          hasImages={hasImages}
          onHasImagesChange={setHasImages}
          onHistoryChange={handleHistoryChange}
          onToast={showToast}
          activeTool={activeTool}
          activeColor={activeColor}
          onToolChange={setActiveTool}
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
