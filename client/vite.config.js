import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // required so the Capacitor WebView can load assets from file-like URLs
  build: {
    target: 'es2020',
    outDir: 'dist',
    chunkSizeWarningLimit: 6000,
  },
  server: { host: true, port: 5173 },
});
