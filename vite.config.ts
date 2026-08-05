import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 18384,
    strictPort: true,
    // Polling-based watching: reliable under sandboxed/restricted runtimes
    // where native file watchers (fsevents/inotify) are unavailable.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
