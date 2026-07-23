import { useEffect, useRef } from 'react';
import type { LineWeightPreset } from '../weights';

interface WeightPickerProps {
  weights: LineWeightPreset[];
  value: number;
  open: boolean;
  disabled?: boolean;
  onChange: (weight: number) => void;
  onOpenChange: (open: boolean) => void;
}

// Map a canvas-px weight (4/8/14) to an on-screen bar height that reads
// clearly at toolbar size. Rendering the literal px would make Thin nearly
// invisible next to a 2.4rem button; this keeps the three options visually
// ranked without being to-scale.
function barHeight(weight: number): number {
  return Math.max(2, Math.round(weight * 0.75));
}

// Line weight picker (ADR-0011). Deliberately a structural clone of
// ColorPicker: same open/close contract (controlled `open` + click-outside
// dismiss), same swatch-button-plus-popover layout, so the two toolbar
// controls feel like one family.
export function WeightPicker({
  weights,
  value,
  open,
  disabled,
  onChange,
  onOpenChange,
}: WeightPickerProps) {
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

  const handleOptionClick = (weight: number) => {
    onChange(weight);
    onOpenChange(false);
  };

  const activeLabel = weights.find((preset) => preset.value === value)?.label ?? String(value);

  return (
    <div className="weight-picker" ref={containerRef}>
      <button
        type="button"
        className={`weight-swatch-button${open ? ' open' : ''}`}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        aria-label="Line weight"
        aria-haspopup="true"
        aria-expanded={open}
        title={`Line weight (${activeLabel})`}
      >
        <span className="weight-bar" style={{ height: barHeight(value) }} />
      </button>
      {open ? (
        <div className="weight-popover" role="dialog" aria-label="Line weight presets">
          {weights.map(({ value: weight, label }) => (
            <button
              key={weight}
              type="button"
              className="weight-option"
              onClick={() => handleOptionClick(weight)}
              aria-label={label}
              aria-pressed={weight === value}
              title={label}
            >
              <span className="weight-bar" style={{ height: barHeight(weight) }} />
              <span className="weight-option-label">{label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
