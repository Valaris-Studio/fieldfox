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
    // The element + trigger are DOM-native; jsdom gives us document/customElements.
    // Layout and observers it lacks are stubbed in test/setup.ts.
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
  },
});
