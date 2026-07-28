#!/usr/bin/env node
// Prints the production embed snippet for the widget: jsDelivr URL pinned to
// the EXACT published version (semver ranges cache ~7 days on the CDN — not
// production-safe; exact versions cache forever, see PLAN §0 Distribution)
// plus the sha384 SRI hash of the IIFE bundle so the CDN can't serve tampered
// bytes. Run after `pnpm build`; the hash is only valid for the bytes you
// actually publish.
//
// The hosted endpoint compiled into the bundle comes from the build, not from
// here — to cut over to a new host, rebuild with it set and republish:
//   FIELDFOX_HOSTED_ENDPOINT="https://<host>/api/fill" pnpm build
// The endpoint actually baked into the bundle is echoed below so a release can
// never silently ship the wrong host (docs/SELF-HOSTING.md).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const widgetDir = join(repoRoot, 'packages', 'widget');
const bundlePath = join(widgetDir, 'dist', 'fieldfox.js');

let bundle;
try {
  bundle = readFileSync(bundlePath);
} catch {
  console.error(`Missing ${bundlePath} — run \`pnpm build\` first.`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(widgetDir, 'package.json'), 'utf8'));
const integrity = `sha384-${createHash('sha384').update(bundle).digest('base64')}`;

// Read the compiled-in hosted default back OUT of the bundle rather than
// re-deriving it from the environment: this reflects the bytes being published,
// so a stale `dist/` from an earlier build is visible instead of assumed.
const hostedEndpoint = bundle.toString('utf8').match(/https:\/\/[^"']*\/api\/fill/)?.[0];
console.error(
  hostedEndpoint
    ? `Bundle hosted default: ${hostedEndpoint}`
    : 'WARNING: no hosted default found in the bundle — rebuild before publishing.',
);

console.log(`<!-- Fieldfox widget v${version} — pinned exact version + SRI -->`);
console.log(
  `<script src="https://cdn.jsdelivr.net/npm/@fieldfox/widget@${version}/dist/fieldfox.js" integrity="${integrity}" crossorigin="anonymous"></script>`,
);
console.log(`<field-fox target="#my-form" endpoint="https://fieldfox.example.com/api/fill" site-key="ffx_pk_..."></field-fox>`);
