import { expect, test, type Page } from '@playwright/test';

// INT-rebind (pilot finding 4): when the host removes the widget's target form,
// the trigger/panel must not orphan on screen; when the host re-renders a new
// matching target, the widget must re-anchor to it. Exercised on the react-host,
// whose dev-only #toggle-form button unmounts/remounts <form id="profile-form">
// under a continuously-mounted <field-fox target="#profile-form">.

const REACT_URL = 'http://localhost:5173/';

// Widget UI lives in the field-fox open shadow root; Playwright CSS pierces it.
const ui = (page: Page) => ({
  trigger: page.locator('field-fox [part="trigger"]'),
});

test('react-host: removing the target hides the trigger; remounting re-anchors it', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(REACT_URL);
  const { trigger } = ui(page);

  // Baseline: the widget mounted and anchored to the form's top-right corner.
  await expect(trigger).toBeVisible();
  const formBox = (await page.locator('#profile-form').boundingBox())!;
  const trigBox = (await trigger.boundingBox())!;
  expect(Math.abs(trigBox.x + trigBox.width - (formBox.x + formBox.width))).toBeLessThan(40);

  // Host unmounts the target form (like a dialog closing). The orphaned trigger
  // must go away instead of floating over the page.
  await page.locator('#toggle-form').click();
  await expect(page.locator('#profile-form')).toHaveCount(0);
  await expect(trigger).toHaveCount(0);

  // Host re-renders a fresh matching form: the widget re-resolves the selector
  // and re-anchors to the NEW node.
  await page.locator('#toggle-form').click();
  await expect(page.locator('#profile-form')).toHaveCount(1);
  await expect(trigger).toBeVisible();
  const newFormBox = (await page.locator('#profile-form').boundingBox())!;
  const newTrigBox = (await trigger.boundingBox())!;
  expect(Math.abs(newTrigBox.x + newTrigBox.width - (newFormBox.x + newFormBox.width))).toBeLessThan(40);

  // The re-anchor must not have thrown (React 19 host stays alive).
  expect(pageErrors).toEqual([]);
});
