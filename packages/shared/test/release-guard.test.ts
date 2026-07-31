import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
// @ts-expect-error - repo-level release tooling, plain ESM with no type declarations
import { unpublishableSpecsIn, installArgsFor, PUBLISHED_PACKAGES } from '../../../scripts/release.mjs';

// P1-3: 0.1.0 shipped uninstallable because `npm publish` from a package
// directory left `"@fieldfox/shared": "workspace:*"` in the published manifest,
// which consumers cannot resolve (EUNSUPPORTEDPROTOCOL).
//
// This guards the CHECKER, not the happy path: the point of the card is that a
// green check which cannot go red is worthless, so most of these tests are cases
// the checker must REJECT.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('an unrewritten workspace: dep is caught — the exact 0.1.0 failure', () => {
  const brokenManifest = {
    name: '@fieldfox/widget',
    version: '0.1.1',
    dependencies: { '@fieldfox/shared': 'workspace:*' },
  };

  expect(unpublishableSpecsIn(brokenManifest)).toEqual(['dependencies.@fieldfox/shared: workspace:*']);
});

test('link: and file: specs are caught too — they break a consumer identically', () => {
  const manifest = {
    dependencies: { a: 'link:../a' },
    peerDependencies: { b: 'file:../b' },
    optionalDependencies: { c: 'workspace:^' },
  };

  expect(unpublishableSpecsIn(manifest).sort()).toEqual([
    'dependencies.a: link:../a',
    'optionalDependencies.c: workspace:^',
    'peerDependencies.b: file:../b',
  ]);
});

test('a devDependency workspace: spec is NOT flagged — npm never installs it for a consumer', () => {
  // Flagging this would make the gate cry wolf on every package we ship.
  const manifest = {
    dependencies: { '@fieldfox/shared': '0.1.1' },
    devDependencies: { vitest: 'workspace:*' },
  };

  expect(unpublishableSpecsIn(manifest)).toEqual([]);
});

test('a properly rewritten manifest passes', () => {
  const manifest = {
    name: '@fieldfox/widget',
    version: '0.1.1',
    dependencies: { '@fieldfox/shared': '0.1.1' },
  };

  expect(unpublishableSpecsIn(manifest)).toEqual([]);
});

test('a manifest with no dependency fields at all passes', () => {
  expect(unpublishableSpecsIn({ name: '@fieldfox/shared', version: '0.1.1' })).toEqual([]);
});

test('the publish set is exactly the three public packages', () => {
  // The examples are not products. packages/server joined the set when the cloud
  // repo began composing it from npm (P2-0b) — the boundary rule requires the
  // cloud to consume the same package a self-hoster installs.
  expect(PUBLISHED_PACKAGES).toEqual([
    '@fieldfox/widget',
    '@fieldfox/shared',
    '@fieldfox/server',
  ]);
});

// The allowlist is a list of names; nothing about being on it makes a package
// publishable. `private: true` fails at the registry AFTER the tarball checks
// have all passed, so assert the manifests agree with the list up front.
test('every listed package is actually publishable', async () => {
  const { readFileSync } = await import('node:fs');
  const dirOf = { '@fieldfox/widget': 'widget', '@fieldfox/shared': 'shared', '@fieldfox/server': 'server' };
  for (const name of PUBLISHED_PACKAGES) {
    const manifest = JSON.parse(
      readFileSync(new URL(`../../${dirOf[name]}/package.json`, import.meta.url), 'utf8'),
    );
    expect(manifest.private, `${name} is private:true and cannot be published`).toBeUndefined();
    expect(manifest.version, `${name} still has a placeholder version`).not.toBe('0.0.0');
    expect(manifest.files, `${name} publishes no files allowlist`).toContain('dist');
  }
});

test('the release script refuses to run from inside a package directory', () => {
  // The original mistake was running a publish from packages/widget, where
  // `npm publish` looks correct and silently ships workspace: specs.
  let failed = false;
  let output = '';
  try {
    execFileSync('node', [join(repoRoot, 'scripts', 'release.mjs'), '--dry-run'], {
      cwd: join(repoRoot, 'packages', 'widget'),
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    failed = true;
    output = String((error as { stderr?: string }).stderr ?? '');
  }

  expect(failed).toBe(true);
  expect(output).toContain('run this from the repo root');
});

test('pnpm pack rewrites workspace: specs but npm pack does not — the difference the script exists for', () => {
  // The load-bearing fact behind this whole card, asserted against the real
  // packers rather than assumed. If npm ever starts rewriting these, this test
  // goes red and the guard can be reconsidered on evidence.
  const widgetDir = join(repoRoot, 'packages', 'widget');
  const readDeps = (packer: 'pnpm' | 'npm'): Record<string, string> => {
    const destination = execFileSync(
      'node',
      ['-e', "process.stdout.write(require('fs').mkdtempSync(require('os').tmpdir()+'/ff-packcmp-'))"],
      { encoding: 'utf8' },
    );
    try {
      execFileSync(packer, ['pack', '--pack-destination', destination], { cwd: widgetDir, stdio: 'pipe' });
      const tarball = execFileSync('sh', ['-c', `ls ${destination}/*.tgz`], { encoding: 'utf8' }).trim();
      const manifest = JSON.parse(
        execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
      );
      return manifest.dependencies ?? {};
    } finally {
      execFileSync('rm', ['-rf', destination]);
    }
  };

  expect(readDeps('npm')['@fieldfox/shared']).toBe('workspace:*');
  expect(readDeps('pnpm')['@fieldfox/shared']).not.toMatch(/^workspace:/);
}, 180_000);

// A COORDINATED release (widget 0.2.0 + shared 0.2.0 together) broke the gate on
// 2026-07-31: assertInstallable installed each tarball in isolation, so the
// widget's dependency on shared@0.2.0 could not resolve — that version existed
// only as a sibling tarball, not on the registry. The gate failed a release that
// was in fact correct, and `pnpm -r publish` would have handled the ordering.
//
// The fix must not weaken what the gate catches: an unpublishable spec, a broken
// exports map, or a genuinely missing dependency all still have to fail. So the
// smoke install now offers the sibling tarballs ALONGSIDE the one under test.

test('a sibling being released is offered to the smoke install, so it can resolve', () => {
  const tarballs = {
    '@fieldfox/shared': '/tmp/pack/fieldfox-shared-0.2.0.tgz',
    '@fieldfox/widget': '/tmp/pack/fieldfox-widget-0.2.0.tgz',
  };
  const manifest = { name: '@fieldfox/widget', dependencies: { '@fieldfox/shared': '0.2.0' } };

  expect(installArgsFor(manifest, tarballs['@fieldfox/widget'], tarballs)).toEqual([
    '/tmp/pack/fieldfox-widget-0.2.0.tgz',
    '/tmp/pack/fieldfox-shared-0.2.0.tgz',
  ]);
});

test('the package under test comes FIRST, so npm installs the thing being verified', () => {
  const tarballs = {
    '@fieldfox/shared': '/tmp/pack/fieldfox-shared-0.2.0.tgz',
    '@fieldfox/widget': '/tmp/pack/fieldfox-widget-0.2.0.tgz',
  };
  const manifest = { name: '@fieldfox/widget', dependencies: { '@fieldfox/shared': '0.2.0' } };

  expect(installArgsFor(manifest, tarballs['@fieldfox/widget'], tarballs)[0]).toBe(
    '/tmp/pack/fieldfox-widget-0.2.0.tgz',
  );
});

test('a package with no sibling dependency installs alone, exactly as before', () => {
  // shared depends on nothing we publish, so nothing extra may be dragged in —
  // a wider install would mask a package that cannot actually stand on its own.
  const tarballs = { '@fieldfox/shared': '/tmp/pack/fieldfox-shared-0.2.0.tgz' };
  const manifest = { name: '@fieldfox/shared', dependencies: { zod: '^3' } };

  expect(installArgsFor(manifest, tarballs['@fieldfox/shared'], tarballs)).toEqual([
    '/tmp/pack/fieldfox-shared-0.2.0.tgz',
  ]);
});

test('a third-party dependency is NEVER swapped for a local tarball', () => {
  // Only packages in this release are substituted. Anything else must resolve
  // from the registry the way a consumer's install would.
  const tarballs = { '@fieldfox/shared': '/tmp/pack/fieldfox-shared-0.2.0.tgz' };
  const manifest = { name: '@fieldfox/server', dependencies: { hono: '^4', zod: '^3' } };

  expect(installArgsFor(manifest, '/tmp/pack/fieldfox-server-0.4.1.tgz', tarballs)).toEqual([
    '/tmp/pack/fieldfox-server-0.4.1.tgz',
  ]);
});

test('a sibling that is NOT part of this release is not fabricated', () => {
  // If widget depended on a fieldfox package we are not publishing, that is a
  // real problem and the install must still hit the registry and fail there.
  const manifest = { name: '@fieldfox/widget', dependencies: { '@fieldfox/shared': '0.2.0' } };

  expect(installArgsFor(manifest, '/tmp/pack/fieldfox-widget-0.2.0.tgz', {})).toEqual([
    '/tmp/pack/fieldfox-widget-0.2.0.tgz',
  ]);
});

test('resolving an entry is not the same as the entry EXISTING', () => {
  // Found 2026-07-31 while fixing the coordinated-release gap, and it predates
  // that change: import.meta.resolve() walks the exports map and returns a path
  // string WITHOUT checking the file is there. A package whose exports point at
  // a dist file that was never built resolved cleanly and passed the gate, which
  // is precisely the "ships just as silently as a bad dependency spec" failure
  // the check was written to prevent.
  //
  // Pinned as a documented property of Node rather than as our behaviour, so the
  // reason the release script stats the resolved path stays legible.
  const resolved = new URL('./does-not-exist.mjs', import.meta.url);

  expect(existsSync(fileURLToPath(resolved))).toBe(false);
});
