#!/usr/bin/env node
// The ONLY sanctioned publish path (card P1-3).
//
// 0.1.0 shipped uninstallable: `npm publish` run from inside a package
// directory does not rewrite `workspace:*` dependency specs, so consumers got a
// package.json carrying `"@fieldfox/shared": "workspace:*"` and npm refused it
// with EUNSUPPORTEDPROTOCOL. pnpm rewrites those specs to the real version at
// pack time; npm does not. That difference is invisible until a stranger tries
// to install, which is the worst possible place to discover it.
//
// This script makes the mistake unreachable instead of remembered:
//   1. refuse to run from inside a package directory (where npm publish is the
//      easy wrong reflex),
//   2. pack through pnpm, then assert no `workspace:` spec survived in the
//      tarball,
//   3. install the packed tarball into a scratch dir and import it, proving
//      installability before the registry ever sees it.
//
// Run `node scripts/release.mjs --dry-run` to rehearse everything except the
// publish itself.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Only these are published; the examples are not products. The server joined
// when the private cloud repo began composing it from npm — consuming the same
// package a self-hoster installs is what keeps the OSS public API honest.
export const PUBLISHED_PACKAGES = ['@fieldfox/widget', '@fieldfox/shared', '@fieldfox/server'];

// A dependency spec npm cannot resolve from a published tarball. `workspace:` is
// the one that actually shipped broken; `link:` and `file:` fail the same way
// for a consumer, so they are refused by the same gate rather than waiting to be
// discovered separately.
const UNPUBLISHABLE_SPEC = /^(workspace|link|file):/;

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

// Exported for the test: it drives this red with a deliberately broken manifest.
// devDependencies are excluded on purpose — npm never installs them for a
// consumer, so a `workspace:` spec there is harmless and failing on it would
// make the gate cry wolf.
export function unpublishableSpecsIn(manifest) {
  const offenders = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec === 'string' && UNPUBLISHABLE_SPEC.test(spec)) {
        offenders.push(`${field}.${name}: ${spec}`);
      }
    }
  }
  return offenders;
}

// What to hand `npm install` when smoke-testing one tarball. A COORDINATED
// release (widget 0.2.0 depending on shared 0.2.0, both unpublished) cannot be
// verified one tarball at a time: the sibling version exists only as another
// tarball, so the registry lookup fails and the gate rejects a correct release.
// `pnpm -r publish` resolves that ordering itself, so the gate was wrong, not
// the release.
//
// Only packages IN THIS RELEASE are substituted. A third-party dependency, or a
// @fieldfox package we are not publishing, still resolves from the registry
// exactly as a consumer's install would — otherwise this check would start
// hiding the missing-dependency failures it exists to catch.
export function installArgsFor(manifest, tarballPath, tarballsByName) {
  const siblings = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      const sibling = tarballsByName[name];
      if (sibling && sibling !== tarballPath && !siblings.includes(sibling)) siblings.push(sibling);
    }
  }
  // Under test first: npm treats the first argument as the thing being added,
  // and the diagnosis should name the package we are actually verifying.
  return [tarballPath, ...siblings];
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

// `pnpm pack` writes <name>-<version>.tgz with the scope flattened; globbing the
// destination is more robust than reconstructing that name.
function packageTarballIn(directory) {
  const tarball = readdirSync(directory).find((entry) => entry.endsWith('.tgz'));
  if (!tarball) throw new Error(`pnpm pack produced no tarball in ${directory}`);
  return join(directory, tarball);
}

function manifestFromTarball(tarballPath) {
  return JSON.parse(run('tar', ['-xzOf', tarballPath, 'package/package.json']));
}

// Proves the tarball is installable by a stranger: a scratch project with no
// workspace, no pnpm linking, and no access to this repo's node_modules.
// `npm install` here is what actually rejects an unrewritten workspace: spec.
function assertInstallable(tarballPath, packageName, installArgs = [tarballPath]) {
  const scratch = mkdtempSync(join(tmpdir(), 'ff-release-'));
  try {
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'release-smoke', private: true, type: 'module' }),
    );
    run('npm', ['install', '--no-audit', '--no-fund', ...installArgs], { cwd: scratch });
    // RESOLVE the entry rather than executing it: a broken "exports" map or a
    // missing dist file ships just as silently as a bad dependency spec, but the
    // widget is a browser component whose module scope touches HTMLElement, so
    // actually importing it under bare Node fails for a reason no consumer would
    // ever hit (they load it in a bundler or a browser).
    // import.meta.resolve (not require.resolve) because these packages publish an
    // ESM-only "exports" map, which the CJS resolver cannot traverse.
    //
    // Then STAT the result: import.meta.resolve walks the exports map and returns
    // a path string without checking anything is there, so a package whose entry
    // points at a dist file that was never built resolved happily and passed this
    // gate. Measured 2026-07-31 — resolving succeeded on a deliberately missing
    // target. The existence check is what makes the claim in this comment true.
    writeFileSync(
      join(scratch, 'resolve-check.mjs'),
      `import { existsSync } from 'node:fs';\n` +
        `import { fileURLToPath } from 'node:url';\n` +
        `const entry = import.meta.resolve(${JSON.stringify(packageName)});\n` +
        `if (!existsSync(fileURLToPath(entry))) {\n` +
        `  throw new Error('exports map resolves to a file that was not published: ' + entry);\n` +
        `}\n`,
    );
    run('node', ['resolve-check.mjs'], { cwd: scratch });
  } catch (error) {
    // A raw execFileSync stack buries the one line that explains the failure, so
    // surface npm's own message and stop — this is a release gate, and the
    // operator needs the diagnosis, not a trace of this script.
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    console.error(
      `FAIL: ${packageName} packed, but a clean install from its tarball did not work:\n` +
        detail.split('\n').map((line) => `  ${line}`).join('\n') +
        '\nA consumer running `npm install` would hit exactly this.',
    );
    process.exit(1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function packageDirectoryOf(packageName) {
  const workspaces = JSON.parse(run('pnpm', ['-r', 'list', '--depth', '-1', '--json'], { cwd: repoRoot }));
  const found = workspaces.find((entry) => entry.name === packageName);
  if (!found) throw new Error(`${packageName} is not a workspace package`);
  return found.path;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  // The guard that makes the original mistake unreachable. Running from inside
  // packages/widget is exactly where `npm publish` looks correct and is not.
  if (process.cwd() !== repoRoot) {
    console.error(
      `FAIL: run this from the repo root (${repoRoot}), not ${process.cwd()}.\n` +
        'Publishing from inside a package directory is what shipped 0.1.0 uninstallable.',
    );
    process.exit(1);
  }

  console.log('Building…');
  run('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' });

  // Pack EVERY package before verifying any of them: a coordinated release means
  // one tarball's dependency is another tarball, so the whole set has to exist
  // before the first install can resolve.
  const destination = mkdtempSync(join(tmpdir(), 'ff-pack-'));
  const tarballsByName = {};
  const manifestsByName = {};

  try {
    for (const packageName of PUBLISHED_PACKAGES) {
      const packDestination = mkdtempSync(join(destination, `${packageName.replace(/\W/g, '-')}-`));
      run('pnpm', ['pack', '--pack-destination', packDestination], {
        cwd: packageDirectoryOf(packageName),
      });
      tarballsByName[packageName] = packageTarballIn(packDestination);
      manifestsByName[packageName] = manifestFromTarball(tarballsByName[packageName]);
    }

    for (const packageName of PUBLISHED_PACKAGES) {
      console.log(`\nChecking ${packageName}…`);
      const tarballPath = tarballsByName[packageName];
      const manifest = manifestsByName[packageName];

      const offenders = unpublishableSpecsIn(manifest);
      if (offenders.length > 0) {
        console.error(
          `FAIL: ${packageName} tarball carries dependency specs npm cannot resolve:\n` +
            offenders.map((o) => `  ${o}`).join('\n') +
            '\nThis is the 0.1.0 failure. Publish through pnpm from the repo root.',
        );
        process.exit(1);
      }
      console.log(`  no unpublishable specs (${manifest.version})`);

      assertInstallable(tarballPath, packageName, installArgsFor(manifest, tarballPath, tarballsByName));
      console.log('  installs from the tarball and its entry resolves');
    }
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }

  if (dryRun) {
    console.log('\nDry run: every gate passed. Re-run without --dry-run to publish.');
    return;
  }

  // A 2FA-protected account makes pnpm prompt for a one-time password, which
  // needs a TTY it does not have when this runs from a script or an agent shell.
  // --otp=<code> is the escape hatch; an automation token needs neither.
  const otp = process.argv.find((arg) => arg.startsWith('--otp='));

  console.log('\nPublishing…');
  run(
    'pnpm',
    [
      '-r',
      ...PUBLISHED_PACKAGES.flatMap((name) => ['--filter', name]),
      'publish',
      '--no-git-checks',
      ...(otp ? [otp] : []),
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  console.log('Published.');
}

// Importing this file for its checker must not trigger a release.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
