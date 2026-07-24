import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// Real-browser proof of the C4 fill executor on a VANILLA form. This is a
// SCAFFOLD: it needs @playwright/test + a playwright.config to run and is NOT
// wired into `pnpm test` (which is jsdom/vitest — the engine invariants are
// covered there in test/fill.test.ts). Running the framework matrix (React 19
// controlled inputs + react-hook-form) — the actual early-warning system for the
// undocumented React value-tracker dependency (RESEARCH §2, PLAN §5 risk 1) —
// belongs to card INT-fill-flow (5ecdce29), which stands up the example hosts and
// the mocked provider. Keep this file as the vanilla baseline only.
//
// To run locally once Playwright is installed:
//   pnpm --filter @fieldfox/widget build
//   npx playwright test packages/widget/e2e/vanilla-fill.spec.ts

const here = dirname(fileURLToPath(import.meta.url));
const widgetBundle = resolve(here, '../dist/fieldfox.js');
const fixtureHtml = readFileSync(resolve(here, 'vanilla-form.html'), 'utf8');

test.beforeEach(async ({ page }) => {
  // Serve the fixture and stub /api/fill with a deterministic FillPlan so the
  // test never touches a real provider (mirrors INT-fill-flow's mock seam).
  await page.route('**/api/fill', async (route) => {
    // The introspector assigns ff-N ids in document order; the fixture's order is
    // name, email, message, country, plan(radio group), terms(checkbox).
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        fills: [
          { fieldId: 'ff-0', action: 'set', value: 'Ada Lovelace' },
          { fieldId: 'ff-1', action: 'set', value: 'ada@example.com' },
          { fieldId: 'ff-2', action: 'set', value: 'Please reach out.' },
          { fieldId: 'ff-3', action: 'set', value: 'de' },
          { fieldId: 'ff-4', action: 'set', value: 'pro' },
          { fieldId: 'ff-5', action: 'set', value: 'true' },
        ],
      }),
    });
  });

  await page.setContent(fixtureHtml);
  await page.addScriptTag({ content: readFileSync(widgetBundle, 'utf8') });
});

test('vanilla: the widget fills native controls and leaves the readonly field', async ({
  page,
}) => {
  // Open the panel via the anchored trigger (in the widget's open shadow root),
  // type context, and press Fill.
  await page.locator('field-fox').evaluate((el) => {
    const trigger = el.shadowRoot?.querySelector('[part="trigger"]') as HTMLElement;
    trigger.click();
  });
  await page.locator('field-fox').evaluate((el) => {
    const ta = el.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = "Ada Lovelace, ada@example.com, wants the pro plan in Germany.";
    const fill = el.shadowRoot?.querySelector('[part="fill-button"]') as HTMLElement;
    fill.click();
  });

  await expect(page.locator('#name')).toHaveValue('Ada Lovelace');
  await expect(page.locator('#email')).toHaveValue('ada@example.com');
  await expect(page.locator('#message')).toHaveValue('Please reach out.');
  await expect(page.locator('#country')).toHaveValue('de');
  await expect(page.locator('input[name="plan"][value="pro"]')).toBeChecked();
  await expect(page.locator('#terms')).toBeChecked();
  // Readonly is non-fillable → left at its original value (fill-or-leave).
  await expect(page.locator('#readonly')).toHaveValue('LOCKED');
});
