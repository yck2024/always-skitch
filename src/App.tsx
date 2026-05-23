import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasEditor, type CanvasEditorHandle } from './components/CanvasEditor';
import { ShortcutsModal, type ShortcutRow } from './components/ShortcutsModal';
import { Toolbar } from './components/Toolbar';
import { TopNav } from './components/TopNav';
import { DEFAULT_COLOR } from './palette';
import type { ToastMessage, Tool } from './types';
import { fileToDataUrl, getImageFileFromPaste, readImageFromClipboard } from './utils/clipboard';

export default function App() {
  const editorRef = useRef<CanvasEditorHandle | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>('rectangle');
  const [activeColor, setActiveColor] = useState<string>(DEFAULT_COLOR);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [hasImage, setHasImage] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const handleColorChange = useCallback((color: string) => {
    setActiveColor(color);
    editorRef.current?.recolorSelected(color);
  }, []);

  useEffect(() => {
    setActiveColor(DEFAULT_COLOR);
  }, [imageDataUrl]);

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
      // While the shortcuts modal is open, only Esc (close) is handled here.
      if (showShortcuts) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setShowShortcuts(false);
        }
        return;
      }
      // While the color picker is open, Esc closes it; other shortcuts are suppressed
      // so picking a color doesn't also fire a tool switch.
      if (colorPickerOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setColorPickerOpen(false);
        }
        return;
      }
      if (event.key === '?' && !isEditingText) {
        event.preventDefault();
        setShowShortcuts(true);
        return;
      }
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
  }, [loadImageFile, hasImage, showShortcuts, colorPickerOpen]);

  return (
    <div className="app">
      <TopNav />
      <Toolbar
        activeTool={activeTool}
        activeColor={activeColor}
        colorPickerOpen={colorPickerOpen}
        canUndo={canUndo}
        canRedo={canRedo}
        hasImage={hasImage}
        onPaste={handlePasteButton}
        onToolChange={setActiveTool}
        onColorChange={handleColorChange}
        onColorPickerOpenChange={setColorPickerOpen}
        onUndo={() => editorRef.current?.undo()}
        onRedo={() => editorRef.current?.redo()}
        onDelete={() => editorRef.current?.deleteSelected()}
        onClear={() => editorRef.current?.clearAnnotations()}
        onCopy={() => void editorRef.current?.copyPng()}
        onDownload={() => editorRef.current?.downloadPng()}
        onShowShortcuts={() => setShowShortcuts(true)}
      />

      <main className="workspace">
        <CanvasEditor
          ref={editorRef}
          imageDataUrl={imageDataUrl}
          activeTool={activeTool}
          activeColor={activeColor}
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

      {showShortcuts ? (
        <ShortcutsModal
          onClose={() => setShowShortcuts(false)}
          sections={SKITCH_SHORTCUT_SECTIONS}
          footnote="Single-letter shortcuts are ignored while editing text. Clicking on an existing annotation while a drawing tool is active escapes back to Select and picks it up."
        />
      ) : null}
    </div>
  );
}

const TOOL_SHORTCUTS: ShortcutRow[] = [
  ['V', 'Select'],
  ['A', 'Arrow'],
  ['R', 'Rectangle'],
  ['T', 'Text'],
  ['S', 'Step'],
  ['B', 'Blur'],
];

const ACTION_SHORTCUTS: ShortcutRow[] = [
  ['U', 'Undo'],
  ['Shift + U', 'Redo'],
  ['D', 'Delete selected'],
  ['C', 'Clear annotations (confirms first)'],
  ['Esc', 'Switch to Select'],
  ['?', 'Open this shortcut list'],
];

const COMBO_SHORTCUTS: ShortcutRow[] = [
  ['Cmd / Ctrl + V', 'Paste an image'],
  ['Cmd / Ctrl + C', 'Copy annotated PNG'],
  ['Cmd / Ctrl + Z', 'Undo'],
  ['Cmd / Ctrl + Shift + Z', 'Redo'],
  ['Backspace / Delete', 'Delete selected'],
];

const SKITCH_SHORTCUT_SECTIONS = [
  { title: 'Tools', rows: TOOL_SHORTCUTS },
  { title: 'Actions', rows: ACTION_SHORTCUTS },
  { title: 'With modifier', rows: COMBO_SHORTCUTS },
];
