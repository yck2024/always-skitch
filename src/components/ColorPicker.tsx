import { useEffect, useRef } from 'react';
import type { PaletteColor } from '../palette';

interface ColorPickerProps {
  palette: PaletteColor[];
  value: string;
  open: boolean;
  disabled?: boolean;
  onChange: (color: string) => void;
  onOpenChange: (open: boolean) => void;
}

export function ColorPicker({
  palette,
  value,
  open,
  disabled,
  onChange,
  onOpenChange,
}: ColorPickerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [open, onOpenChange]);

  const handleSwatchClick = (color: string) => {
    onChange(color);
    onOpenChange(false);
  };

  return (
    <div className="color-picker" ref={containerRef}>
      <button
        type="button"
        className={`color-swatch-button${open ? ' open' : ''}`}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        aria-label="Color"
        aria-haspopup="true"
        aria-expanded={open}
        title="Color"
      >
        <span className="color-swatch" style={{ backgroundColor: value }} />
      </button>
      {open ? (
        <div className="color-palette-popover" role="dialog" aria-label="Color palette">
          {palette.map(({ value: color, label }) => (
            <button
              key={color}
              type="button"
              className="palette-swatch"
              onClick={() => handleSwatchClick(color)}
              aria-label={label}
              aria-pressed={color === value}
              title={label}
            >
              <span className="color-swatch" style={{ backgroundColor: color }} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
