import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { WIDGET_VERSION } from '../src/index.js';

// WIDGET_VERSION must track the published package version, not a hardcoded
// literal (F2 shipped 0.1.0 while the source still said 0.0.0). It's injected at
// build time via vite `define` from package.json, so this pins the two together
// by READING package.json — never hardcode the expected version here.
test('WIDGET_VERSION equals the version in package.json', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { version: string };
  expect(WIDGET_VERSION).toBe(pkg.version);
});
