import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/server/ui',
  build: { outDir: '../../../dist/ui', emptyOutDir: true },
});
