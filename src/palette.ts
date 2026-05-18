export interface PaletteColor {
  value: string;
  label: string;
}

export const DEFAULT_COLOR = '#ff2a1a';

export const PALETTE: PaletteColor[] = [
  { value: '#ff2a1a', label: 'Red' },
  { value: '#000000', label: 'Black' },
  { value: '#1565c0', label: 'Blue' },
  { value: '#2e7d32', label: 'Green' },
  { value: '#00838f', label: 'Teal' },
  { value: '#c2185b', label: 'Magenta' },
];
