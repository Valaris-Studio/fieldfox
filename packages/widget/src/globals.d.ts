// Compile-time constant replaced by vite `define` from package.json's version
// (see vite.config.ts). Declared here so tsc and the editor know its type; it
// has no runtime existence of its own — the bundler inlines the string literal.
declare const __WIDGET_VERSION__: string;

// Compile-time constant replaced by vite `define` from FIELDFOX_HOSTED_ENDPOINT
// at build time, defaulting to the placeholder host (see vite.config.ts). Same
// no-runtime-existence note as above: the bundler inlines the string literal.
declare const __HOSTED_FILL_ENDPOINT__: string;
