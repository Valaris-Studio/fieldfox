#!/usr/bin/env node
// Prints the production embed snippet for the widget: jsDelivr URL pinned to
// the EXACT published version (semver ranges cache ~7 days on the CDN — not
// production-safe; exact versions cache forever, see PLAN §0 Distribution)
// plus the sha384 SRI hash of the IIFE bundle so the CDN can't serve tampered
// bytes.
//
// The hash is taken from the bytes the CDN ACTUALLY SERVES, fetched here, never
// from `packages/widget/dist/`. That local file drifts ahead of the last release
// the moment anyone rebuilds, and a snippet whose integrity describes bytes the
// CDN does not serve is blocked outright by the browser — total failure, with
// the reason visible only in the console. If a local build exists it is compared
// against the published bytes and a mismatch REFUSES to emit a snippet, because
// that mismatch means the dist you are looking at is not what integrators get.
//
// The hosted endpoint compiled into the bundle comes from the build, not from
// here — to cut over to a new host, rebuild with it set and republish:
//   FIELDFOX_HOSTED_ENDPOINT="https://<host>/api/fill" pnpm build
// The endpoint baked into the PUBLISHED bundle is echoed below so a release can
// never silently ship the wrong host (docs/SELF-HOSTING.md).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@fieldfox/widget';

// jsDelivr resolves raw repository paths and ignores the package's `exports`
// map, so the `/dist/` segment is load-bearing: without it the URL 404s and the
// browser reports an opaque ERR_BLOCKED_BY_ORB while the element never upgrades.
export const cdnUrlFor = (version) =>
  `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${version}/dist/fieldfox.js`;

export const sriFor = (bundle) => `sha384-${createHash('sha384').update(bundle).digest('base64')}`;

export class PublishedBundleMismatch extends Error {
  name = 'PublishedBundleMismatch';
}

export function buildSnippet({ version, publishedBundle, localBundle }) {
  const integrity = sriFor(publishedBundle);

  if (localBundle && !publishedBundle.equals(localBundle)) {
    throw new PublishedBundleMismatch(
      `Local build differs from published ${PACKAGE_NAME}@${version}: ` +
        `published ${publishedBundle.length} bytes (${integrity}), ` +
        `local ${localBundle.length} bytes (${sriFor(localBundle)}). ` +
        `The snippet pins @${version}, so a hash of the local bytes would be blocked by the browser. ` +
        `Publish this build first, or bump the version you are generating for.`,
    );
  }

  const src = cdnUrlFor(version);

  return {
    version,
    src,
    integrity,
    html: [
      `<!-- Fieldfox widget v${version} — pinned exact version + SRI -->`,
      `<script src="${src}" integrity="${integrity}" crossorigin="anonymous"></script>`,
      `<field-fox target="#my-form" endpoint="https://fieldfox.example.com/api/fill" site-key="ffx_pk_..."></field-fox>`,
    ].join('\n'),
  };
}

async function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const widgetDir = join(repoRoot, 'packages', 'widget');
  const { version } = JSON.parse(readFileSync(join(widgetDir, 'package.json'), 'utf8'));

  const url = cdnUrlFor(version);
  const response = await fetch(url);
  if (!response.ok) {
    // Failing loudly beats falling back to the local file: a silent fallback is
    // exactly the bug this script had.
    console.error(`Cannot fetch ${url} — HTTP ${response.status}. Is ${PACKAGE_NAME}@${version} published?`);
    process.exit(1);
  }
  const publishedBundle = Buffer.from(await response.arrayBuffer());

  let localBundle;
  try {
    localBundle = readFileSync(join(widgetDir, 'dist', 'fieldfox.js'));
  } catch {
    // No local build is fine — there is then nothing that can disagree.
  }

  let snippet;
  try {
    snippet = buildSnippet({ version, publishedBundle, localBundle });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  // Read the compiled-in hosted default back out of the PUBLISHED bytes, so this
  // reflects what integrators actually load rather than what we last built.
  const hostedEndpoint = publishedBundle.toString('utf8').match(/https:\/\/[^"']*\/api\/fill/)?.[0];
  console.error(
    hostedEndpoint
      ? `Published bundle hosted default: ${hostedEndpoint}`
      : 'WARNING: no hosted default found in the published bundle.',
  );

  console.log(snippet.html);
}

// Importable for tests without running the network path.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
