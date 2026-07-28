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

// The hosted service's fill endpoint, baked in at build time (P0-2). We deploy
// to GCP behind a generated URL and cut a domain over later, so the hostname is
// a build flag rather than a source edit — but it stays a COMPILE-TIME constant
// inlined in the bundle: no discovery round-trip before the first fill.
//
// The default keeps existing builds byte-identical. Applying it HERE rather than
// as a `||` fallback in source matters: `define` is a text substitution, so an
// absent value would inline the literal `undefined` and every bare snippet would
// POST to the relative URL "undefined" — a 404 on the customer's own origin.
const DEFAULT_HOSTED_FILL_ENDPOINT = 'https://api.fieldfox.dev/api/fill';

function resolveHostedFillEndpoint(): string {
  const override = process.env.FIELDFOX_HOSTED_ENDPOINT?.trim();
  if (!override) return DEFAULT_HOSTED_FILL_ENDPOINT;

  // This string is pinned into every CDN snippet we publish, so a typo is
  // expensive to discover in production. Fail the build instead of shipping it.
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(`FIELDFOX_HOSTED_ENDPOINT must be an absolute URL, got: ${override}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`FIELDFOX_HOSTED_ENDPOINT must be https, got: ${override}`);
  }
  return parsed.href;
}

// IIFE global `FieldFox` powers the script-tag snippet; ESM is the npm entry.
// zod stays server-side: the widget imports shared TYPES only, never its runtime.
export default defineConfig({
  define: {
    __WIDGET_VERSION__: JSON.stringify(pkgVersion),
    __HOSTED_FILL_ENDPOINT__: JSON.stringify(resolveHostedFillEndpoint()),
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
