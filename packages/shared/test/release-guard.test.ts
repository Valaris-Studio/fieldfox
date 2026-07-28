import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
// @ts-expect-error - repo-level release tooling, plain ESM with no type declarations
import { unpublishableSpecsIn, PUBLISHED_PACKAGES } from '../../../scripts/release.mjs';

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

test('the publish set is exactly the two public packages', () => {
  // packages/server is private:true and the examples are not products; adding a
  // package here without making it publishable would fail at the registry.
  expect(PUBLISHED_PACKAGES).toEqual(['@fieldfox/widget', '@fieldfox/shared']);
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
