export interface LineWeightPreset {
  value: number;
  label: string;
}

export const DEFAULT_WEIGHT = 8;

// Line weight presets (ADR-0011): three fixed choices instead of a free
// slider, mirroring the constrained color Palette (ADR-0001). Medium is
// pinned at 8 — the historical hardcoded STROKE_WIDTH — so the default look
// of every annotation is pixel-identical to before the feature existed.
// Values are canvas px, multiplied by each editor's annotationScale at draw
// time exactly as STROKE_WIDTH was.
export const LINE_WEIGHTS: LineWeightPreset[] = [
  { value: 4, label: 'Thin' },
  { value: 8, label: 'Medium' },
  { value: 14, label: 'Thick' },
];
