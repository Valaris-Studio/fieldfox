import { defineConfig } from 'vite';

// IIFE global `FieldFox` powers the script-tag snippet; ESM is the npm entry.
// zod stays server-side: the widget imports shared TYPES only, never its runtime.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FieldFox',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'iife' ? 'fieldfox.js' : 'fieldfox.mjs'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
