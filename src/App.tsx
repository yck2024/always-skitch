import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasEditor, type CanvasEditorHandle } from './components/CanvasEditor';
import { Toolbar } from './components/Toolbar';
import type { ToastMessage, Tool } from './types';
import { fileToDataUrl, getImageFileFromPaste, readImageFromClipboard } from './utils/clipboard';

export default function App() {
  const editorRef = useRef<CanvasEditorHandle | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>('rectangle');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [hasImage, setHasImage] = useState(false);
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

  const loadImageFile = useCallback(
    async (file: File | Blob | null) => {
      if (!file) {
        showToast('No image found on the clipboard.', 'warning');
        return;
      }
      if (hasImage) {
        const ok = window.confirm(
          'Replace the current image? Annotations on it will be lost. Use Copy PNG or Download first if you want to keep them.',
        );
        if (!ok) return;
      }
      const dataUrl = await fileToDataUrl(file);
      setImageDataUrl(dataUrl);
    },
    [hasImage, showToast],
  );

  const handlePasteButton = useCallback(async () => {
    try {
      const file = await readImageFromClipboard();
      await loadImageFile(file);
    } catch {
      showToast('Clipboard image read was blocked. Try Cmd+V in the page.', 'warning');
    }
  }, [loadImageFile, showToast]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const file = getImageFileFromPaste(event);
      if (!file) return;
      event.preventDefault();
      void loadImageFile(file);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const isEditingText = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.isContentEditable;
      const key = event.key.toLowerCase();
      if (meta && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          editorRef.current?.redo();
        } else {
          editorRef.current?.undo();
        }
      } else if (meta && key === 'c' && !isEditingText && hasImage) {
        event.preventDefault();
        void editorRef.current?.copyPng();
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        if (!isEditingText) {
          event.preventDefault();
          editorRef.current?.deleteSelected();
        }
      } else if (event.key === 'Escape') {
        setActiveTool('select');
      } else if (!meta && !isEditingText) {
        // Single-key tool / action shortcuts, Photoshop/Figma style.
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
          event.preventDefault();
          setActiveTool('blur');
        } else if (key === 'u') {
          event.preventDefault();
          if (event.shiftKey) editorRef.current?.redo();
          else editorRef.current?.undo();
        } else if (key === 'd') {
          event.preventDefault();
          editorRef.current?.deleteSelected();
        } else if (key === 'c') {
          event.preventDefault();
          if (hasImage && window.confirm('Clear all annotations? This cannot be reversed except via Undo.')) {
            editorRef.current?.clearAnnotations();
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [loadImageFile, hasImage]);

  return (
    <div className="app">
      <Toolbar
        activeTool={activeTool}
        canUndo={canUndo}
        canRedo={canRedo}
        hasImage={hasImage}
        onPaste={handlePasteButton}
        onToolChange={setActiveTool}
        onUndo={() => editorRef.current?.undo()}
        onRedo={() => editorRef.current?.redo()}
        onDelete={() => editorRef.current?.deleteSelected()}
        onClear={() => editorRef.current?.clearAnnotations()}
        onCopy={() => void editorRef.current?.copyPng()}
        onDownload={() => editorRef.current?.downloadPng()}
      />

      <main className="workspace">
        <CanvasEditor
          ref={editorRef}
          imageDataUrl={imageDataUrl}
          activeTool={activeTool}
          onToolChange={setActiveTool}
          onToast={showToast}
          onImageLoaded={setHasImage}
          onHistoryChange={handleHistoryChange}
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
