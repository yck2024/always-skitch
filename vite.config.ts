import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative assets make the production build work from any GitHub Pages repo path.
  base: './',
});
