import type { Tool } from '../types';
import { PALETTE } from '../palette';
import { ColorPicker } from './ColorPicker';

interface ToolbarProps {
  activeTool: Tool;
  activeColor: string;
  colorPickerOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasImage: boolean;
  onPaste: () => void;
  onToolChange: (tool: Tool) => void;
  onColorChange: (color: string) => void;
  onColorPickerOpenChange: (open: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onClear: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onShowShortcuts: () => void;
}

const tools: Array<{ tool: Tool; label: string }> = [
  { tool: 'select', label: 'Select' },
  { tool: 'arrow', label: 'Arrow' },
  { tool: 'rectangle', label: 'Rectangle' },
  { tool: 'text', label: 'Text' },
  { tool: 'callout', label: 'Step' },
  { tool: 'blur', label: 'Blur' },
];

export function Toolbar({
  activeTool,
  activeColor,
  colorPickerOpen,
  canUndo,
  canRedo,
  hasImage,
  onPaste,
  onToolChange,
  onColorChange,
  onColorPickerOpenChange,
  onUndo,
  onRedo,
  onDelete,
  onClear,
  onCopy,
  onDownload,
  onShowShortcuts,
}: ToolbarProps) {
  return (
    <header className="toolbar" aria-label="Mini Skitch toolbar">
      <div className="toolbar-group">
        <button className="primary" type="button" onClick={onPaste}>
          Paste Image
        </button>
      </div>

      <div className="toolbar-group" role="group" aria-label="Annotation tools">
        {tools.map(({ tool, label }) => (
          <button
            key={tool}
            type="button"
            className={activeTool === tool ? 'active' : ''}
            disabled={!hasImage && tool !== 'select'}
            onClick={() => onToolChange(tool)}
          >
            {label}
          </button>
        ))}
        <ColorPicker
          palette={PALETTE}
          value={activeColor}
          open={colorPickerOpen}
          disabled={!hasImage}
          onChange={onColorChange}
          onOpenChange={onColorPickerOpenChange}
        />
      </div>

      <div className="toolbar-group" role="group" aria-label="Edit commands">
        <button type="button" disabled={!canUndo} onClick={onUndo}>
          Undo
        </button>
        <button type="button" disabled={!canRedo} onClick={onRedo}>
          Redo
        </button>
        <button type="button" disabled={!hasImage} onClick={onDelete}>
          Delete
        </button>
        <button type="button" disabled={!hasImage} onClick={onClear}>
          Clear annotations
        </button>
        <button type="button" onClick={onShowShortcuts} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
          Shortcuts
        </button>
      </div>

      <div className="toolbar-group export-actions" role="group" aria-label="Export commands">
        <button type="button" disabled={!hasImage} onClick={onCopy}>
          Copy PNG
        </button>
        <button type="button" disabled={!hasImage} onClick={onDownload}>
          Download
        </button>
      </div>
    </header>
  );
}
