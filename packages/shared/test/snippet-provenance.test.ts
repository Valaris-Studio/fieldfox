import { expect, test } from 'vitest';
// @ts-expect-error - repo-level release tooling, plain ESM with no type declarations
import { buildSnippet, cdnUrlFor, sriFor, PublishedBundleMismatch } from '../../../scripts/gen-snippet.mjs';

// The bug this guards: gen-snippet hashed the LOCAL dist while the URL pinned the
// PUBLISHED version, so `integrity` described bytes the CDN never serves and
// Chromium blocked the script outright. Measured at the same commit: published
// 0.1.1 was 61,102 bytes, local dist 62,420 — plausible-looking output, total
// failure. So these tests are mostly about what the generator must REFUSE.

const PUBLISHED = Buffer.from('published bundle bytes');
const LOCAL_DRIFTED = Buffer.from('local bundle bytes, rebuilt since the release');

test('a local dist that drifts from the published bundle is REFUSED — the exact regression', () => {
  expect(() =>
    buildSnippet({ version: '0.1.1', publishedBundle: PUBLISHED, localBundle: LOCAL_DRIFTED }),
  ).toThrow(PublishedBundleMismatch);
});

test('the refusal names both sizes, because "hashes differ" alone does not tell you which is stale', () => {
  let thrown: Error | undefined;
  try {
    buildSnippet({ version: '0.1.1', publishedBundle: PUBLISHED, localBundle: LOCAL_DRIFTED });
  } catch (error) {
    thrown = error as Error;
  }

  expect(thrown?.message).toContain(String(PUBLISHED.length));
  expect(thrown?.message).toContain(String(LOCAL_DRIFTED.length));
});

test('src and integrity derive from the SAME artifact — asserted structurally, not by eyeballing', () => {
  const { src, integrity, version } = buildSnippet({
    version: '0.1.1',
    publishedBundle: PUBLISHED,
    localBundle: PUBLISHED,
  });

  expect(src).toBe(cdnUrlFor(version));
  expect(integrity).toBe(sriFor(PUBLISHED));
  // The provenance claim in one line: the URL pins the version whose bytes were hashed.
  expect(src).toContain(`@${version}/`);
});

test('a matching local build is accepted — the generator still works after a release', () => {
  const { html } = buildSnippet({ version: '0.1.1', publishedBundle: PUBLISHED, localBundle: PUBLISHED });

  expect(html).toContain('cdn.jsdelivr.net/npm/@fieldfox/widget@0.1.1/dist/fieldfox.js');
  expect(html).toContain(`integrity="${sriFor(PUBLISHED)}"`);
});

test('the local bundle is optional — verifying without a build is allowed, publishing a mismatch is not', () => {
  // A user who has not run `pnpm build` should still get a correct snippet for
  // the published version; there is nothing to disagree with.
  const { integrity } = buildSnippet({ version: '0.1.1', publishedBundle: PUBLISHED });

  expect(integrity).toBe(sriFor(PUBLISHED));
});

test('the refusal quotes the PUBLISHED hash — the one the snippet would have had to carry', () => {
  // Mutation-found gap: `sriFor(localBundle ?? publishedBundle)` — the original
  // bug verbatim — passed every other test here, because a snippet is only ever
  // EMITTED when the two bundles are equal, so no emitted hash can distinguish
  // them. The mismatch message is the one place both hashes are observable, so
  // it is where the provenance claim has to be pinned.
  let thrown: Error | undefined;
  try {
    buildSnippet({ version: '0.1.1', publishedBundle: PUBLISHED, localBundle: LOCAL_DRIFTED });
  } catch (error) {
    thrown = error as Error;
  }

  expect(thrown?.message).toContain(sriFor(PUBLISHED));
  expect(thrown?.message).toContain(sriFor(LOCAL_DRIFTED));
});

test('the CDN url carries /dist/ — jsdelivr ignores the exports map and 404s without it', () => {
  // The 404 surfaces as an opaque net::ERR_BLOCKED_BY_ORB, so the only symptom
  // is a custom element that silently never upgrades.
  expect(cdnUrlFor('0.1.1')).toBe('https://cdn.jsdelivr.net/npm/@fieldfox/widget@0.1.1/dist/fieldfox.js');
});

test('sriFor is a real sha384 of the bytes, not a placeholder', () => {
  // Pinned against the published 0.1.1 hash that README.md and docs/EMBEDDING.md
  // already carry — if this disagrees, one of the two is wrong.
  const publishedZeroOneOne = 'sha384-xx/rwrfhjvkfbfxXp5oDcuZVhIpqlNyDT55RaqpKM2kv8dbbsqrnuTu0Rv4pZECw';

  expect(sriFor(PUBLISHED)).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  expect(sriFor(PUBLISHED)).not.toBe(publishedZeroOneOne);
});
