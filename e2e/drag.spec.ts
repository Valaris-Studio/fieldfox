import { expect, test, type Page } from '@playwright/test';
import { CANNED } from './canned.mjs';

// Draggable-panel card: the panel header is a drag handle; the panel moves in
// fixed/viewport coords, clamps fully inside the viewport, and — once dragged —
// the user's position wins for the session (auto-reposition, minimize/expand,
// and resize must not override it). Runs on chromium + webkit under the shared
// e2e stack (real widget → real server → mock provider), same conventions as
// fill.spec.ts / panel-etiquette.spec.ts.

const PLAIN_URL = 'http://localhost:8080/examples/plain-html/';
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
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
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
  header: page.locator('field-fox [part="panel-header"]'),
  contextInput: page.locator('field-fox [part="context-input"]'),
  fillButton: page.locator('field-fox [part="fill-button"]'),
  status: page.locator('field-fox .ff-status'),
});

async function openPanel(page: Page): Promise<void> {
  const { trigger, panel, fillButton } = ui(page);
  await trigger.click();
  await expect(panel).toBeVisible();
  // Same reachability gate fill.spec.ts uses: fail fast if the panel rendered
  // off-screen instead of timing out on a later interaction.
  await expect(fillButton).toBeInViewport();
}

// Drag the header from its current center by (dx,dy) using real pointer events.
async function dragHeaderBy(page: Page, dx: number, dy: number): Promise<void> {
  const box = (await ui(page).header.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Intermediate move so engines that gate drag on movement register it.
  await page.mouse.move(startX + dx / 2, startY + dy / 2);
  await page.mouse.move(startX + dx, startY + dy);
  await page.mouse.up();
}

test('dragging the header moves the panel by the drag delta', async ({ page }) => {
  await page.goto(PLAIN_URL);
  await openPanel(page);
  const { panel } = ui(page);

  const before = (await panel.boundingBox())!;
  const dx = 120;
  const dy = 90;
  await dragHeaderBy(page, dx, dy);
  const after = (await panel.boundingBox())!;

  // The panel followed the pointer (allow a px of rounding); it did not jump
  // back to its anchor.
  expect(Math.abs(after.x - (before.x + dx))).toBeLessThan(2);
  expect(Math.abs(after.y - (before.y + dy))).toBeLessThan(2);
});

test('dragging far past a viewport edge clamps the panel fully inside', async ({ page }) => {
  await page.goto(PLAIN_URL);
  await openPanel(page);
  const { header, panel } = ui(page);

  // Grab the header and shove the pointer far beyond the top-left corner.
  const box = (await header.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(-2000, -2000);
  await page.mouse.up();

  const viewport = page.viewportSize()!;
  const clampedTopLeft = (await panel.boundingBox())!;
  // Fully inside the viewport with a small (~8px) margin, never off the top/left.
  expect(clampedTopLeft.x).toBeGreaterThanOrEqual(0);
  expect(clampedTopLeft.y).toBeGreaterThanOrEqual(0);

  // Now shove far past the bottom-right corner.
  const box2 = (await header.boundingBox())!;
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewport.width + 2000, viewport.height + 2000);
  await page.mouse.up();

  const clampedBottomRight = (await panel.boundingBox())!;
  expect(clampedBottomRight.x + clampedBottomRight.width).toBeLessThanOrEqual(viewport.width);
  expect(clampedBottomRight.y + clampedBottomRight.height).toBeLessThanOrEqual(viewport.height);
});

test('the dragged position survives a fill round-trip', async ({ page }) => {
  await page.goto(PLAIN_URL);
  await openPanel(page);
  const { panel, contextInput, fillButton, status } = ui(page);

  await dragHeaderBy(page, 100, 70);
  const dragged = (await panel.boundingBox())!;

  // Run the mocked fill (fill.spec.ts conventions). With hide-on-fill the panel
  // disappears for the flight and reappears at settle directly as the minimized
  // (docked) strip; re-expanding must then restore the dragged spot.
  await contextInput.fill(`I am ${CANNED.fullName} (${CANNED.email}).`);
  await fillButton.click();
  await expect(panel).toBeHidden(); // hidden while the request is on the wire
  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });
  await expect(panel).toHaveClass(/ff-minimized/);

  // Re-expand by clicking the minimized strip.
  await panel.click();
  await expect(panel).not.toHaveClass(/ff-minimized/);
  await expect(contextInput).toBeVisible();

  const restored = (await panel.boundingBox())!;
  expect(Math.abs(restored.x - dragged.x)).toBeLessThan(2);
  expect(Math.abs(restored.y - dragged.y)).toBeLessThan(2);
});

test('minimize then expand restores the dragged position', async ({ page }) => {
  await page.goto(PLAIN_URL);
  await openPanel(page);
  const { panel, contextInput, fillButton, status } = ui(page);

  await dragHeaderBy(page, 140, 110);
  const dragged = (await panel.boundingBox())!;

  // Drive to the minimized (done) state via a mocked fill. Hide-on-fill hides the
  // panel for the flight; it reappears at settle as the docked strip …
  await contextInput.fill(`I am ${CANNED.fullName} (${CANNED.email}).`);
  await fillButton.click();
  await expect(panel).toBeHidden(); // hidden while the request is on the wire
  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });
  await expect(panel).toHaveClass(/ff-minimized/);

  // The docked strip is a different position than the dragged full panel …
  const docked = (await panel.boundingBox())!;
  const moved = Math.abs(docked.x - dragged.x) > 2 || Math.abs(docked.y - dragged.y) > 2;
  expect(moved).toBe(true);

  // … and expanding snaps back to the user's dragged spot.
  await panel.click();
  await expect(panel).not.toHaveClass(/ff-minimized/);
  const restored = (await panel.boundingBox())!;
  expect(Math.abs(restored.x - dragged.x)).toBeLessThan(2);
  expect(Math.abs(restored.y - dragged.y)).toBeLessThan(2);
});
