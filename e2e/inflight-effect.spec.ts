import { expect, test, type Locator, type Page } from '@playwright/test';
import { CANNED, FORCE_ERROR } from './canned.mjs';

// C4 border-tracer in-flight effect: while a fill is on the wire, a tracer
// overlay circles the ANCHOR (host form / form-less container / native-dialog
// form) from the widget's shadow root, and is torn down on EVERY settle path
// (success, error, abort/disconnect). The retired per-field shimmer class must
// never reappear. These run on the shared e2e stack (real widget → real server →
// mock provider); the mock holds each response FIELDFOX_MOCK_DELAY_MS (800ms in
// e2e-env.mjs) so the overlay is observable before the plan lands.

const PLAIN_URL = 'http://localhost:8080/examples/plain-html/';
const FORMLESS_URL = 'http://localhost:8080/examples/plain-html/formless.html';
const DIALOG_URL = 'http://localhost:8080/examples/plain-html/dialog-host.html';
const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

// The fixtures hardcode endpoint :8787, but the stack runs the real server on
// :8794. Remap only that endpoint's port before any page script runs (identical
// to fill.spec.ts) so the request still traverses the full server pipeline.
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
  overlay: page.locator('field-fox [part="inflight-overlay"]'),
});

async function openPanelAndFill(page: Page, contextText: string): Promise<void> {
  const { trigger, panel, contextInput, fillButton } = ui(page);
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(fillButton).toBeInViewport();
  await contextInput.fill(contextText);
  await fillButton.click();
}

// Positive-area intersection of two rects: the overlay must actually sit OVER the
// anchor, not merely exist somewhere. Zero (or negative) area = no real overlap.
function overlapArea(a: { x: number; y: number; width: number; height: number }, b: typeof a): number {
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlapX * overlapY;
}

async function assertOverlaysAnchor(overlay: Locator, anchor: Locator): Promise<void> {
  const overlayBox = (await overlay.boundingBox())!;
  const anchorBox = (await anchor.boundingBox())!;
  expect(overlayBox, 'the tracer overlay must have a measurable box').toBeTruthy();
  // The overlay is sized from the anchor's getBoundingClientRect, so it should
  // cover essentially all of the anchor — assert a substantial overlap, not an
  // exact match (sub-pixel rounding, position:fixed vs the anchor's own box).
  const covered = overlapArea(overlayBox, anchorBox) / (anchorBox.width * anchorBox.height);
  expect(covered, 'tracer overlay should blanket the anchor it circles').toBeGreaterThan(0.9);
}

test('tracer overlay is visible over the form during flight and gone after a success settle', async ({
  page,
}) => {
  await page.goto(PLAIN_URL);
  const { status, overlay } = ui(page);

  await openPanelAndFill(page, `I am ${CANNED.fullName} (${CANNED.email}), medium shirt, afternoon.`);

  // In flight: the overlay is mounted and positioned over the host form.
  await expect(overlay).toBeVisible();
  await assertOverlaysAnchor(overlay, page.locator('#signup-form'));
  // Exactly one overlay — no leaked duplicates from a prior binding.
  await expect(overlay).toHaveCount(1);

  // After the success settle the overlay is torn down.
  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });
  await expect(overlay).toHaveCount(0);
});

test('tracer overlay is torn down after an error settle', async ({ page }) => {
  await page.goto(PLAIN_URL);
  const { status, overlay } = ui(page);

  // FORCE_ERROR walks the server ladder to exhaustion → 502 → popover error.
  await openPanelAndFill(page, `${FORCE_ERROR} fill this`);
  await expect(overlay).toBeVisible(); // still in flight

  await expect(status).toHaveText('Could not fill the form. Please try again.', { timeout: 20_000 });
  // The error settle path tears the overlay down just like success.
  await expect(overlay).toHaveCount(0);
});

test('no per-field shimmer class appears on fields anymore', async ({ page }) => {
  await page.goto(PLAIN_URL);
  const { overlay } = ui(page);

  await openPanelAndFill(page, `I am ${CANNED.fullName} (${CANNED.email}).`);
  await expect(overlay).toBeVisible(); // in flight, where the shimmer used to be

  // The retired shimmer class must be absent on every planned field; the tracer
  // carries the "working" signal now (a subtle dim is the only per-field change).
  await expect(page.locator('#full-name')).not.toHaveClass(/ff-fill-shimmer/);
  await expect(page.locator('#email')).not.toHaveClass(/ff-fill-shimmer/);
  expect(await page.locator('.ff-fill-shimmer').count()).toBe(0);
});

test('form-less host: tracer overlay circles the resolved container', async ({ page }) => {
  await page.goto(FORMLESS_URL);
  const { status, overlay } = ui(page);

  await openPanelAndFill(page, 'Org is Grupo Andino Logística, email operaciones@grupoandino.cl.');

  // The anchor here is the form-less container (#signup-card), not a <form>.
  await expect(overlay).toBeVisible();
  await assertOverlaysAnchor(overlay, page.locator('#signup-card'));

  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });
  await expect(overlay).toHaveCount(0);
});

test('native-dialog host: tracer overlay paints over the dialog form and settles clean', async ({
  page,
}) => {
  await page.goto(DIALOG_URL);
  const { status, overlay } = ui(page);

  await openPanelAndFill(page, `I am ${CANNED.fullName} (${CANNED.email}).`);

  // The widget lives INSIDE the native <dialog open>; the fixed overlay is a
  // shadow-root descendant, so it paints in the dialog's top-layer stacking
  // context and lands over the form rather than behind the dialog.
  await expect(overlay).toBeVisible();
  await assertOverlaysAnchor(overlay, page.locator('#signup-form'));

  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });
  await expect(overlay).toHaveCount(0);
});
