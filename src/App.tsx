import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasEditor, type CanvasEditorHandle } from './components/CanvasEditor';
import { Toolbar } from './components/Toolbar';
import type { ToastMessage, Tool } from './types';
import { fileToDataUrl, getImageFileFromPaste, readImageFromClipboard } from './utils/clipboard';

export default function App() {
  const editorRef = useRef<CanvasEditorHandle | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>('select');
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
      const dataUrl = await fileToDataUrl(file);
      setImageDataUrl(dataUrl);
      setActiveTool('select');
    },
    [showToast],
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
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          editorRef.current?.redo();
        } else {
          editorRef.current?.undo();
        }
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        const target = event.target as HTMLElement | null;
        const isEditingText = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.isContentEditable;
        if (!isEditingText) {
          event.preventDefault();
          editorRef.current?.deleteSelected();
        }
      } else if (event.key === 'Escape') {
        setActiveTool('select');
      }
    };

    window.addEventListener('paste', handlePaste);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [loadImageFile]);

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
