import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves this repository at /always-skitch/.
  // Keeping the production base explicit prevents blank pages from asset 404s.
  base: '/always-skitch/',
  // Relative assets make the production build work from any GitHub Pages repo path.
  base: './',
});
