import { useCallback, useEffect, useRef, useState } from 'react';
import { TopNav } from '../components/TopNav';
import type { ToastMessage } from '../types';
import { fileToDataUrl, getImageFileFromPaste, readImageFromClipboard } from '../utils/clipboard';
import { FreeformCanvasEditor, type FreeformCanvasEditorHandle } from './CanvasEditor';

// Freeform is the multi-image annotation board at /freeform. See
// src/freeform/CONTEXT.md (Canvas/Image/Annotation glossary) and ADR 0002
// (separate route, not mode toggle). This slice (#5) adds additive paste:
// pasting appends an Image to the right of the previous one with a 24px gap,
// the Canvas auto-grows, and the display scales to fit the viewport. No tools,
// no selection, no export yet — those land in later issues.
//
// Key divergence from Skitch: NO useEffect that resets activeColor on paste.
// Skitch resets to red per Background; Freeform Canvas spans multiple pastes
// so the user's color choice must persist. (Active color UI itself lands with
// the color picker in #9 — for now we just refrain from adding the reset.)
export default function FreeformApp() {
  const editorRef = useRef<FreeformCanvasEditorHandle | null>(null);
  const [hasImages, setHasImages] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

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
      // common cross-platform conventions. Tool-specific shortcuts (V, R, etc.)
      // come with the drawing tools in #6.
      if (meta && key === 'z' && !isEditingText) {
        event.preventDefault();
        if (event.shiftKey) editorRef.current?.redo();
        else editorRef.current?.undo();
      } else if (meta && key === 'y' && !isEditingText) {
        event.preventDefault();
        editorRef.current?.redo();
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
      {/* Minimal Freeform toolbar — just a Paste Image action and Undo/Redo for
          now. The full drawing toolbar lands in #6. We deliberately do NOT
          reuse Skitch's Toolbar component, which is bound to Skitch's tool set
          and active-color model. */}
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
      </div>
      <main className="workspace">
        <FreeformCanvasEditor
          ref={editorRef}
          hasImages={hasImages}
          onHasImagesChange={setHasImages}
          onHistoryChange={handleHistoryChange}
          onToast={showToast}
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
