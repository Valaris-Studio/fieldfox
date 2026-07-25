import { expect, test, type Page } from '@playwright/test';
import { CANNED, FORCE_ERROR } from './canned.mjs';

// Pilot-finding 5 (card b395bc7d) + UI polish round 2 (item 3): panel
// Esc/stacking etiquette and the hide-on-fill flow, both real-browser:
//   1. Esc with the panel open closes ONLY the fieldfox panel — the host dialog
//      (a document-level "Esc closes me" handler, like Radix) never sees the key.
//   2. On Fill the panel disappears ENTIRELY for the flight (the border-tracer on
//      the form is the sole progress signal). On SUCCESS it reappears directly as
//      the minimized status strip (clear of the just-filled fields the status line
//      asks the user to review). On ERROR it reappears EXPANDED to retry.
//
// This spec runs on the plain-html host under the shared e2e stack (real widget →
// real server → mock provider). It uses its OWN fixture (dialog-host.html) that
// wraps the form in a native <dialog> — index.html is untouched (its selectors
// are fill.spec.ts's contract).

const DIALOG_URL = 'http://localhost:8080/examples/plain-html/dialog-host.html';
const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

// The fixtures hardcode endpoint :8787, but the stack runs the real server on
// :8794. Remap only that endpoint's port before any page script runs (identical
// to fill.spec.ts) so the request still leaves the browser with a real Origin
// and traverses the full server pipeline.
test.beforeEach(async ({ page }) => {
  if (SERVER_PORT === 8787) return;
  await page.addInitScript((port) => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.startsWith('http://localhost:8787/api/fill')) {
        return original(url.replace(':8787', `:${port}`), init);
      }
      return original(input as RequestInfo, init);
    };
  }, SERVER_PORT);
});

const ui = (page: Page) => ({
  trigger: page.locator('field-fox [part="trigger"]'),
  panel: page.locator('field-fox [part="panel"]'),
  contextInput: page.locator('field-fox [part="context-input"]'),
  fillButton: page.locator('field-fox [part="fill-button"]'),
  status: page.locator('field-fox .ff-status'),
});

test('Esc with the panel open closes only the panel; the host dialog is untouched', async ({
  page,
}) => {
  await page.goto(DIALOG_URL);
  const { trigger, panel } = ui(page);

  await trigger.click();
  await expect(panel).toBeVisible();

  // The host dialog is open and its document-level Esc handler is armed.
  await expect(page.locator('#host-dialog')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => (window as unknown as { __hostEscapeSeen: boolean }).__hostEscapeSeen)).toBe(
    false,
  );

  await page.keyboard.press('Escape');

  // The fieldfox panel closed…
  await expect(panel).toBeHidden();
  // …but the host never saw the Escape, so its dialog stays open.
  expect(await page.evaluate(() => (window as unknown as { __hostEscapeSeen: boolean }).__hostEscapeSeen)).toBe(
    false,
  );
  await expect(page.locator('#host-dialog')).toHaveAttribute('open', '');

  // A SECOND Escape (panel now closed) is no longer owned by fieldfox → it
  // reaches the host, which closes its dialog. Proves the listener is removed on
  // close, not leaked.
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as unknown as { __hostEscapeSeen: boolean }).__hostEscapeSeen)).toBe(
    true,
  );
});

test('on Fill the panel hides for the flight, then reappears as the strip after success', async ({ page }) => {
  await page.goto(DIALOG_URL);
  const { trigger, panel, contextInput, fillButton, status } = ui(page);

  await trigger.click();
  await expect(panel).toBeVisible();
  await contextInput.fill(`I am ${CANNED.fullName} (${CANNED.email}).`);
  await fillButton.click();

  // In flight (mock holds ~800ms): the panel disappears entirely — the border-
  // tracer on the form carries progress — while the tracer overlay is up.
  await expect(panel).toBeHidden();
  await expect(page.locator('field-fox [part="inflight-overlay"]')).toBeVisible();

  // The success report reveals the panel directly as the minimized strip.
  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/ff-minimized/);
  await expect(page.locator('#full-name')).toHaveValue(CANNED.fullName);

  // The minimized panel must not cover the filled fields the user is told to
  // review. Assert no bounding-box overlap between the panel and the form.
  const panelBox = (await panel.boundingBox())!;
  const formBox = (await page.locator('#signup-form').boundingBox())!;
  const overlapX = Math.max(
    0,
    Math.min(panelBox.x + panelBox.width, formBox.x + formBox.width) - Math.max(panelBox.x, formBox.x),
  );
  const overlapY = Math.max(
    0,
    Math.min(panelBox.y + panelBox.height, formBox.y + formBox.height) - Math.max(panelBox.y, formBox.y),
  );
  expect(overlapX * overlapY, 'minimized panel overlaps the form fields it asks the user to review').toBe(0);

  // Still usable: clicking the minimized strip re-expands the intake UI.
  await panel.click();
  await expect(panel).not.toHaveClass(/ff-minimized/);
  await expect(contextInput).toBeVisible();
});

test('on an error the hidden panel reappears EXPANDED with the error message', async ({ page }) => {
  await page.goto(DIALOG_URL);
  const { trigger, panel, contextInput, fillButton, status } = ui(page);

  await trigger.click();
  await expect(panel).toBeVisible();
  // FORCE_ERROR walks the server ladder to exhaustion → 502 → popover error.
  await contextInput.fill(`${FORCE_ERROR} fill this`);
  await fillButton.click();

  // Hidden while the (failing) request is on the wire.
  await expect(panel).toBeHidden();

  // The error settle reveals the panel EXPANDED (not the strip) so the user can
  // read the message and retry; the intake controls are back.
  await expect(status).toHaveText('Could not fill the form. Please try again.', { timeout: 20_000 });
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveClass(/ff-minimized/);
  await expect(status).toHaveClass(/ff-error/);
  await expect(contextInput).toBeVisible();
  await expect(fillButton).toBeEnabled();
});
