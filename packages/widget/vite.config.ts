import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Single source of truth for WIDGET_VERSION: the published package version.
// `define` replaces `__WIDGET_VERSION__` at build time (and in vitest, which
// shares this config), so src/index.ts can never drift from package.json again
// (F2 skew). The replacement is a source-level text substitution done before
// bundling, so the ES and IIFE outputs get the identical string literal.
const pkgVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
).version;

// IIFE global `FieldFox` powers the script-tag snippet; ESM is the npm entry.
// zod stays server-side: the widget imports shared TYPES only, never its runtime.
export default defineConfig({
  define: {
    __WIDGET_VERSION__: JSON.stringify(pkgVersion),
  },
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
