import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// W-1: the widget must load on a host page that declares no character encoding.
// A raw non-ASCII byte sequence in the IIFE (a diacritics regex range, a glyph
// in a string) is decoded by the browser with the DOCUMENT's encoding, and a
// page with no charset falls back to windows-1252. A multi-byte UTF-8 range
// endpoint then becomes two characters, the regex literal's range is out of
// order, and the whole script fails to PARSE: <field-fox> is never defined. To
// an integrator that is indistinguishable from an SRI mismatch, so the bundle
// has to be pure ASCII (scripts/check-bundle-size.mjs enforces it).
//
// The dev static server sends `text/html; charset=utf-8`, which hides the bug,
// so the fixture and the bundle are served here through route handlers with a
// charset-less Content-Type. Specs transpile as CJS: __dirname, not import.meta.

const FIXTURE_URL = 'http://localhost:8080/e2e-fixtures/no-charset/index.html';
const BUNDLE_URL = 'http://localhost:8080/e2e-fixtures/no-charset/fieldfox.js';

const fixtureHtml = readFileSync(resolve(__dirname, 'no-charset.html'));
const bundle = readFileSync(resolve(__dirname, '../packages/widget/dist/fieldfox.js'));

test('a host page with no charset declaration still defines <field-fox>', async ({ page }) => {
  const scriptErrors: string[] = [];
  page.on('pageerror', (error) => scriptErrors.push(String(error)));

  await page.route(FIXTURE_URL, (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: fixtureHtml }),
  );
  await page.route(BUNDLE_URL, (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript' }, body: bundle }),
  );

  const bundleResponse = page.waitForResponse(BUNDLE_URL);
  await page.goto(FIXTURE_URL);

  // Premise checks, so the test can never pass vacuously: the page really did
  // fall back to a non-UTF-8 encoding, and the bundle really was served.
  expect(await page.evaluate(() => document.characterSet)).not.toMatch(/utf-?8/i);
  expect((await bundleResponse).status()).toBe(200);

  expect(scriptErrors, 'the bundle must parse under the browser fallback encoding').toEqual([]);
  expect(await page.evaluate(() => customElements.get('field-fox') !== undefined)).toBe(true);
  await expect(page.locator('field-fox [part="trigger"]')).toBeVisible();
});
