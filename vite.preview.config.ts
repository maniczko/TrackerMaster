// PREVIEW ONLY: browser preview with a mocked backend. Not used by `npm run build` or Tauri.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const mock = (file: string) => fileURLToPath(new URL(`./preview/${file}`, import.meta.url));
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: { 'import.meta.env.VITE_TRACKER_TEST_MODE': JSON.stringify('1') },
  resolve: { alias: [
    { find: '@tauri-apps/api/core', replacement: mock('mockCore.ts') },
    { find: '@tauri-apps/api/event', replacement: mock('mockEvent.ts') },
    { find: '@tauri-apps/api/window', replacement: mock('mockWindow.ts') },
  ] },
  server: { port: 1430, strictPort: true, host: '127.0.0.1' },
});
