import { useCallback, useEffect, useRef, useState } from 'react';
import { ColorPicker } from '../components/ColorPicker';
import { ShortcutsModal, type ShortcutRow } from '../components/ShortcutsModal';
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
  // ADR-0008 (Canvas color Match mode) — cache of the last successfully
  // extracted dominant color from a pasted Image, plus a flag for whether
  // Match mode is currently driving the Canvas color. Both live in App.tsx
  // because the state machine (auto-engage on first paste, recompute while
  // active, disengage on explicit W/B/T pick, silent fallback on extraction
  // failure) belongs at the same level as the Canvas color picker — the
  // editor stays mode-agnostic and just paints whatever effective color we
  // pass through. NOT pushed to history; both are session settings.
  //
  // Slice 1 (issue #19) intentionally has no 4th swatch and no re-engage
  // path — once the user clicks W/B/T, matchActive flips false and stays
  // there until the next page load. Slice 2 (#20) adds the swatch.
  const [derivedColor, setDerivedColor] = useState<string | null>(null);
  const [matchActive, setMatchActive] = useState(false);
  // Effective color passed down to the editor. When Match is active AND we
  // have a successfully derived color, that wins; otherwise the explicit
  // user pick stays in charge. Transparent / Black / White all flow through
  // unmodified.
  const effectiveCanvasColor: FreeformCanvasColor | string =
    matchActive && derivedColor ? derivedColor : canvasColor;
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
  // Shortcuts modal visibility. Opened by the toolbar button or the `?` key.
  // Closed by clicking the backdrop, the close button, or pressing Esc.
  const [showShortcuts, setShowShortcuts] = useState(false);
  // ADR-0006 right-click context menu. `null` = closed; an `{x, y}` pair
  // means open at that viewport position. Position is in fixed-position
  // pixel coords — see the overlay below. The CanvasEditor handles the
  // right-click semantics (select target Image, decide whether to suppress
  // browser default); App.tsx is responsible only for rendering the menu
  // and routing item clicks back through the imperative handle.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Close the right-click menu. Used by item handlers, Esc, click-outside,
  // and any state change that should reset the menu (tool switch).
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Tool switch dismisses any open menu: right-click reorder is Select-tool
  // only, so a tool change makes any visible menu stale. Cheap dependency-
  // only effect — runs when `activeTool` changes regardless of menu state,
  // and `setContextMenu(null)` short-circuits in React if already null.
  useEffect(() => {
    if (activeTool !== 'select') setContextMenu(null);
  }, [activeTool]);

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

  // ADR-0008 — paste-driven Canvas color update for Match mode.
  //
  // Three behaviors folded into one callback:
  //
  // 1. Cache update on success: if extraction returned a hex string, update
  //    `derivedColor`. We unconditionally cache the latest successful pull
  //    even when Match is inactive — that way, if the user later clicks the
  //    Match swatch (slice 2 / #20), there's something to engage with.
  //
  // 2. Auto-engage on first paste: if the canvas was empty before this paste
  //    AND extraction succeeded, flip `matchActive` to true. `hasImages` in
  //    closure is the pre-paste value because the callback was built from the
  //    previous render and the editor's handle captured it at addImage-call
  //    time. By the time this handler fires, the editor has already called
  //    onHasImagesChange(true), but React batches the resulting re-render so
  //    `hasImages` here still reflects the prior state.
  //
  // 3. Silent fallback on first-paste extraction failure: when the canvas is
  //    empty and extraction returns null (all-white screenshot, all-grayscale
  //    image, CORS-tainted etc.), we leave matchActive=false. Canvas color
  //    stays White. No toast, no engagement. On subsequent pastes while
  //    Match-active, failure simply keeps the previously cached derivedColor
  //    — handled by NOT clearing it on null.
  const handleImagePastedDominantColor = useCallback(
    (color: string | null) => {
      if (color !== null) {
        setDerivedColor(color);
        // Auto-engage only on the first paste into an empty canvas, and only
        // when we actually got a usable color out. If extraction failed,
        // matchActive stays false (silent fallback) so the canvas reads as
        // White until the user pastes something colorful or clicks Match in
        // slice 2.
        if (!hasImages) {
          setMatchActive(true);
        }
      }
      // null path: leave both matchActive and derivedColor alone. If Match
      // was active, the existing derivedColor stays in effect (per ADR-0008's
      // "previous color on subsequent failures" rule). If Match was inactive,
      // nothing happens.
    },
    [hasImages],
  );

  // Wrap setCanvasColor so an explicit W/B/T pick also disengages Match.
  // ADR-0008 makes the carve-out explicit: paste-driven updates apply only
  // while Match is active, and an explicit user pick is the only way to turn
  // Match off in slice 1 (slice 2 / #20 adds the re-engage path via the 4th
  // swatch). Keeping this in a single callback rather than two setX calls on
  // the swatch onClick avoids accidentally forgetting one of them at a
  // future call site.
  const handleCanvasColorPick = useCallback((value: FreeformCanvasColor) => {
    setCanvasColor(value);
    setMatchActive(false);
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
      // Shortcuts modal claims Esc first when open — matches Skitch's layered
      // overlay handling. Any other key is ignored while the modal is open so
      // shortcuts in the list don't fire from the listing itself.
      if (showShortcuts) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setShowShortcuts(false);
        }
        return;
      }
      // `?` opens the shortcuts modal (Shift+/ on US layouts). Skitch uses the
      // same binding; keeping it identical so muscle memory transfers between
      // the two routes.
      if (event.key === '?' && !isEditingText) {
        event.preventDefault();
        setShowShortcuts(true);
        return;
      }
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
        // Delete / Backspace removes whatever is currently selected
        // (Images and/or Annotations — see ADR-0006 consequences for why
        // the earlier Image-only filter was widened). Annotations on top of
        // a deleted Image still stay unless explicitly part of the selection
        // (ADR-0003 keeps Annotations canvas-level).
        event.preventDefault();
        editorRef.current?.deleteSelected();
      } else if (event.key === 'Escape' && !isEditingText) {
        // Esc has two layered jobs: dismiss the right-click menu first if
        // open, otherwise bail any drawing tool back to Select. Mirrors a
        // common app convention (Figma/Photoshop) where a transient overlay
        // claims Esc before the global tool reset does.
        if (contextMenu) {
          closeContextMenu();
        } else {
          setActiveTool('select');
        }
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
        } else if (event.key === ']') {
          // ADR-0006: Bring Image(s) to Front. Editor scopes the action to
          // Image-kind members of the active selection, so empty / Annotation-
          // only selections are no-ops. We don't gate on tool here — in any
          // drawing tool nothing is selected (Images are non-evented), so
          // the editor naturally no-ops. preventDefault stops the browser
          // from also treating `]` as a hotkey (rare but cheap insurance).
          event.preventDefault();
          editorRef.current?.bringSelectedImagesToFront();
        } else if (event.key === '[') {
          // ADR-0006: Send Image(s) to Back. Mirror of the above.
          event.preventDefault();
          editorRef.current?.sendSelectedImagesToBack();
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [appendImageFile, contextMenu, closeContextMenu, showShortcuts]);

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
          {CANVAS_COLOR_OPTIONS.map(({ value, label }) => {
            // ADR-0008: a swatch is "active" only when its value is the
            // explicit pick AND Match is not overriding. When Match is on,
            // none of the three swatches show as active — that's the
            // acceptable interim state called out in #19; #20 adds the 4th
            // swatch which will be the active one in that case.
            const isActive = !matchActive && canvasColor === value;
            return (
              <button
                key={value}
                type="button"
                className={`canvas-color-swatch canvas-color-${value}${isActive ? ' active' : ''}`}
                onClick={() => handleCanvasColorPick(value)}
                aria-label={`Canvas color: ${label}`}
                aria-pressed={isActive}
                title={`Canvas color: ${label}`}
              />
            );
          })}
        </div>
        <button type="button" onClick={() => editorRef.current?.undo()} disabled={!canUndo}>
          Undo
        </button>
        <button type="button" onClick={() => editorRef.current?.redo()} disabled={!canRedo}>
          Redo
        </button>
        {/* Delete button mirrors the Backspace/Delete keyboard shortcut. The
            editor removes any Freeform-tagged objects in the current selection
            — Images and Annotations alike — and no-ops on empty selection. The
            button is enabled whenever something is selected on the canvas
            (driven by `onSelectionChange` from the editor). */}
        <button type="button" onClick={() => editorRef.current?.deleteSelected()} disabled={!hasSelection}>
          Delete
        </button>
        {/* Shortcuts mirrors Skitch's button. Always enabled — it's a reference
            overlay, useful even before any content is on the canvas. The `?`
            key opens the same modal. */}
        <button
          type="button"
          onClick={() => setShowShortcuts(true)}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          Shortcuts
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
          canvasColor={effectiveCanvasColor}
          onHasImagesChange={setHasImages}
          onHistoryChange={handleHistoryChange}
          onToast={showToast}
          onToolChange={setActiveTool}
          onSelectionChange={setHasSelection}
          onHasContentChange={setHasContent}
          onContextMenu={setContextMenu}
          onImagePastedDominantColor={handleImagePastedDominantColor}
        />
      </main>

      {/* ADR-0006 right-click context menu. Rendered at the document root via
          a `position: fixed` div anchored at the click coordinates (which the
          editor passes through verbatim — see CanvasEditor's `handleContextMenu`).
          Click-outside is implemented by a transparent backdrop sibling that
          catches the next pointerdown anywhere on the page; we cannot use Esc
          alone because users might also click on the page to dismiss. */}
      {contextMenu ? (
        <FreeformContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onBringToFront={() => {
            editorRef.current?.bringSelectedImagesToFront();
            closeContextMenu();
          }}
          onSendToBack={() => {
            editorRef.current?.sendSelectedImagesToBack();
            closeContextMenu();
          }}
          onDelete={() => {
            editorRef.current?.deleteSelected();
            closeContextMenu();
          }}
          onDismiss={closeContextMenu}
        />
      ) : null}

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
          sections={FREEFORM_SHORTCUT_SECTIONS}
          footnote="Single-letter shortcuts are ignored while editing text. Annotations live in Canvas coordinates — dragging an Image leaves them behind unless you group-select first."
        />
      ) : null}
    </div>
  );
}

// Freeform-specific shortcut listing. Tools mirror Skitch (V/A/R/T/S/B) so
// muscle memory transfers, but Actions diverge: Freeform has `[` / `]` for
// Image layer order (ADR-0006) and no Clear-annotations (the multi-Image
// model doesn't have a single-screenshot "reset" gesture).
const FREEFORM_TOOL_SHORTCUTS: ShortcutRow[] = [
  ['V', 'Select'],
  ['A', 'Arrow'],
  ['R', 'Rectangle'],
  ['T', 'Text'],
  ['S', 'Step'],
  ['B', 'Blur'],
];

const FREEFORM_ACTION_SHORTCUTS: ShortcutRow[] = [
  [']', 'Bring selected Image(s) to front'],
  ['[', 'Send selected Image(s) to back'],
  ['Esc', 'Switch to Select / close menus'],
  ['?', 'Open this shortcut list'],
];

const FREEFORM_COMBO_SHORTCUTS: ShortcutRow[] = [
  ['Cmd / Ctrl + V', 'Paste an image (adds to Canvas)'],
  ['Cmd / Ctrl + Z', 'Undo'],
  ['Cmd / Ctrl + Shift + Z', 'Redo'],
  ['Cmd / Ctrl + Y', 'Redo'],
  ['Backspace / Delete', 'Delete selected'],
];

const FREEFORM_SHORTCUT_SECTIONS = [
  { title: 'Tools', rows: FREEFORM_TOOL_SHORTCUTS },
  { title: 'Actions', rows: FREEFORM_ACTION_SHORTCUTS },
  { title: 'With modifier', rows: FREEFORM_COMBO_SHORTCUTS },
];

interface FreeformContextMenuProps {
  x: number;
  y: number;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDelete: () => void;
  onDismiss: () => void;
}

// ADR-0006 right-click menu. Three items: Bring to Front, Send to Back,
// Delete. The first two are the new ADR-0006 commands; Delete mirrors the
// keyboard Backspace/Delete behavior so the menu is self-sufficient for
// per-Image actions without forcing the user back to the keyboard.
//
// Dismissal:
// - Click-outside: a transparent full-viewport backdrop catches pointerdown
//   *before* the menu's own click handlers (z-order + stopPropagation on the
//   menu div). Cheaper and more reliable than a window-level pointerdown
//   listener with a hit-test against the menu element.
// - Esc: handled at the App level (see the keyboard handler above) so that
//   open-menu Esc and global Esc-to-Select don't compete.
// - Item click: each item calls its handler then onDismiss.
//
// Positioning clamps to the viewport so a right-click near the right or
// bottom edge doesn't push the menu off-screen. Conservative constants
// (slightly larger than the .context-menu min-width and the 3-item natural
// height) avoid a layout-measure pass and the flash that comes with one; if
// the menu ever gains items or its styling changes its size, bump these.
const CONTEXT_MENU_WIDTH = 200;
const CONTEXT_MENU_HEIGHT = 132;
const CONTEXT_MENU_EDGE_MARGIN = 8;

function FreeformContextMenu({
  x,
  y,
  onBringToFront,
  onSendToBack,
  onDelete,
  onDismiss,
}: FreeformContextMenuProps) {
  const maxX = window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_EDGE_MARGIN;
  const maxY = window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_EDGE_MARGIN;
  const clampedX = Math.max(CONTEXT_MENU_EDGE_MARGIN, Math.min(x, maxX));
  const clampedY = Math.max(CONTEXT_MENU_EDGE_MARGIN, Math.min(y, maxY));
  return (
    <>
      <div
        className="context-menu-backdrop"
        onPointerDown={onDismiss}
        // Suppress contextmenu on the backdrop itself — without this, a
        // second right-click while the menu is open would briefly show the
        // browser default before dismissing.
        onContextMenu={(event) => {
          event.preventDefault();
          onDismiss();
        }}
      />
      <div
        className="context-menu"
        role="menu"
        aria-label="Image actions"
        style={{ left: clampedX, top: clampedY }}
        // Stop pointerdown so the backdrop doesn't immediately dismiss when
        // the user clicks a menu item.
        onPointerDown={(event) => event.stopPropagation()}
        // Also suppress contextmenu on the menu itself — right-clicking a
        // menu item shouldn't pop the browser default while our menu is
        // visible. Mirrors the backdrop handler.
        onContextMenu={(event) => {
          event.preventDefault();
          onDismiss();
        }}
      >
        <button type="button" role="menuitem" onClick={onBringToFront}>
          Bring to Front
        </button>
        <button type="button" role="menuitem" onClick={onSendToBack}>
          Send to Back
        </button>
        <button type="button" role="menuitem" onClick={onDelete}>
          Delete
        </button>
      </div>
    </>
  );
}
