import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { HOSTED_FILL_ENDPOINT } from '../src/element.js';

// P0-2: the hosted host is a BUILD-TIME injected value, not a source constant —
// we ship to GCP behind a generated URL first and plug a domain in later, so the
// hostname must be a build flag rather than a code edit.
//
// What must NOT change: it is still a compile-time constant inlined in the
// bundle. These tests assert the constant's VALUE comes from the build, and the
// bundle-level tests below prove the string is literally present in the output —
// i.e. no runtime lookup crept in.

const widgetDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ENDPOINT = 'https://api.fieldfox.dev/api/fill';

const buildDirs: string[] = [];

afterAll(() => {
  for (const dir of buildDirs) rmSync(dir, { recursive: true, force: true });
});

// A real `vite build` is the only honest way to test a `define` substitution:
// the value is baked by the bundler, so asserting on source or on the vitest
// process would prove nothing about what ships.
function buildBundleWith(env: Record<string, string>): string {
  const outDir = mkdtempSync(join(tmpdir(), 'ff-endpoint-'));
  buildDirs.push(outDir);
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: widgetDir,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
  return readFileSync(join(outDir, 'fieldfox.js'), 'utf8');
}

test('the default build bakes in today endpoint exactly', () => {
  // Existing snippets in the wild are pinned to this string; an unset build
  // variable must not change it.
  expect(HOSTED_FILL_ENDPOINT).toBe(DEFAULT_ENDPOINT);
});

test('the constant is never the literal string "undefined"', () => {
  // The failure mode of a `define` whose value is absent: the bundler inlines
  // `undefined`, every bare snippet POSTs to the relative URL "undefined", and
  // the break shows up as a 404 on the customer's own origin rather than here.
  expect(HOSTED_FILL_ENDPOINT).not.toBe('undefined');
  expect(HOSTED_FILL_ENDPOINT).toMatch(/^https:\/\//);
});

test('a build with FIELDFOX_HOSTED_ENDPOINT set bakes THAT endpoint into the bundle', () => {
  const deployed = 'https://fieldfox-api-abc123-uc.a.run.app/api/fill';
  const bundle = buildBundleWith({ FIELDFOX_HOSTED_ENDPOINT: deployed });

  expect(bundle).toContain(deployed);
  // The placeholder must be gone, not merely shadowed — a bundle containing
  // both strings would mean the default is still reachable somewhere.
  expect(bundle).not.toContain(DEFAULT_ENDPOINT);
}, 120_000);

test('an unset build variable bakes the default endpoint into the bundle', () => {
  const bundle = buildBundleWith({ FIELDFOX_HOSTED_ENDPOINT: '' });

  expect(bundle).toContain(DEFAULT_ENDPOINT);
  // Proves the constant is still INLINED rather than read at runtime: a
  // `process.env`/lookup form would leave no literal URL in the output.
  expect(bundle).not.toContain('__HOSTED_FILL_ENDPOINT__');
}, 120_000);

test('a non-https endpoint FAILS the build instead of shipping a broken bundle', () => {
  // This string is baked into every CDN-pinned snippet, so a typo is expensive
  // to discover in production. Fail loudly at build time.
  expect(() => buildBundleWith({ FIELDFOX_HOSTED_ENDPOINT: 'not-a-url' })).toThrow();
}, 120_000);
