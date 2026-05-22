import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages SPA fallback: serve the same SPA bundle at any unmatched path so
// deep links like /freeform survive a refresh. After the build we copy the
// generated index.html to 404.html — GH Pages then serves 404.html for unknown
// routes, the client router boots from window.location, and the right page
// renders. See ADR 0002 for the routing rationale.
function ghPagesSpaFallback(): PluginOption {
  let outDir = 'dist';
  return {
    name: 'gh-pages-spa-fallback',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const resolvedOut = resolve(process.cwd(), outDir);
      const indexPath = resolve(resolvedOut, 'index.html');
      const fallbackPath = resolve(resolvedOut, '404.html');
      if (existsSync(indexPath)) {
        copyFileSync(indexPath, fallbackPath);
      }
    },
  };
}

export default defineConfig({
  // Absolute base matching the GH Pages repo path. Relative './' assets break
  // trailing-slash deep links (e.g. /always-skitch/freeform/) because the SPA
  // 404.html shim serves the same index.html at that path, then asset URLs
  // resolve under /always-skitch/freeform/assets/ — a directory that does not
  // exist. Hardcoding the repo path is the simplest correct fix.
  base: '/always-skitch/',
  plugins: [
    react(),
    ghPagesSpaFallback(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Mini Skitch',
        short_name: 'Mini Skitch',
        description: 'Quick screenshot annotation tool — paste, mark up, copy.',
        theme_color: '#ff2a1a',
        background_color: '#eef0f3',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
});
