import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Web app build. `npm run dev` runs this config in middleware mode inside the Node server;
 * `npm run build` writes the static bundle to dist-web/, which `npm start` serves.
 */
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  logLevel: 'warn',
  build: { outDir: '../../dist-web', emptyOutDir: true },
});
