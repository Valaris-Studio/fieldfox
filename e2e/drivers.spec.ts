import { expect, test, type Page } from '@playwright/test';
import { CANNED } from './canned.mjs';

// Card v1.1a — custom-widget fill drivers end to end (RESEARCH §9).
//
// Two hosts, deliberately: the plain-HTML fixture drives hand-rolled APG
// widgets, so a failure there means the DRIVER is wrong against the pure ARIA
// contract; the react-host drives real Radix, so a failure only there means the
// driver mishandles what an actual design system does (body portal, hideOthers,
// the late-mirroring hidden input of radix-ui#3521).
//
// The load-bearing assertion in this file is the NEGATIVE one: the billing-plan
// combobox is planned an unmatchable value and must end the fill untouched.
// Leave-on-uncertainty is the invariant the whole driver layer rests on — a
// driver that forces a wrong pick is worse than one that fills nothing.

const ARIA_URL = 'http://localhost:8080/examples/plain-html/aria-widgets.html';
// Its own route: the Radix fixture must not share a page with the profile form,
// whose bare `field-fox [part="…"]` locators are the framework-matrix contract.
const RADIX_URL = 'http://localhost:5173/radix';
const EDITOR_URL = 'http://localhost:5173/editor';
const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

// Same endpoint-port remap as fill.spec.ts: the fixtures hardcode :8787 while
// the stack runs the real server on :8794, and the request must still traverse
// the whole server pipeline with a real Origin.
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
  contextInput: page.locator('field-fox [part="context-input"]'),
  fillButton: page.locator('field-fox [part="fill-button"]'),
  status: page.locator('field-fox .ff-status'),
});

async function openPanelAndFill(page: Page, contextText: string): Promise<void> {
  const { trigger, panel, contextInput, fillButton } = ui(page);
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(fillButton).toBeInViewport();
  await contextInput.fill(contextText);
  await fillButton.click();
}

test('plain-html ARIA widgets: comboboxes and switches fill; an unmatchable value leaves its field', async ({
  page,
}) => {
  await page.goto(ARIA_URL);

  // Capture what the un-fillable combobox reads BEFORE the fill, so the
  // leave-assertion compares against reality rather than a hardcoded string.
  const planBefore = await page.locator('#plan').textContent();

  await openPanelAndFill(page, 'Deploy in Frankfurt on the gold tier, with nightly backups on.');
  await expect(ui(page).status).toContainText('Review, then submit', { timeout: 15_000 });

  // Driven: matched by accessible name at fill time, never by an option list
  // harvested at introspection (there is no open-probe).
  await expect(page.locator('#region')).toHaveText(CANNED.comboboxByLabel.region);
  await expect(page.locator('#tier')).toHaveText(CANNED.comboboxByLabel.tier);
  await expect(page.locator('#backups')).toHaveAttribute('aria-checked', 'true');

  // LEFT: no option is named "Atlantis", so the driver reverts and the widget
  // keeps its placeholder. A forced pick here would be a product bug.
  await expect(page.locator('#plan')).toHaveText(planBefore!.trim());
  await expect(page.locator('#plan')).toHaveAttribute('data-value', '');

  // No popup may survive the fill — a half-open dropdown is the failure mode
  // the revert path exists to prevent.
  await expect(page.locator('[role="listbox"]:not([hidden])')).toHaveCount(0);
  await expect(page.locator('[role="combobox"][aria-expanded="true"]')).toHaveCount(0);

  // The native input alongside the widgets still fills — drivers must not
  // regress the native path they share a loop with.
  await expect(page.locator('#project-name')).not.toHaveValue('');
});

test('react-host Radix: portalled Select and Switch fill through the real design system', async ({
  page,
}) => {
  await page.goto(RADIX_URL);

  await openPanelAndFill(page, 'Deploy in Frankfurt on the gold tier, nightly backups on.');
  await expect(ui(page).status).toContainText('Review, then submit', { timeout: 15_000 });

  // Radix mirrors committed state into the app, so the rendered state blob is
  // the honest witness that the value actually landed in the framework model —
  // not just in the DOM the driver happened to touch.
  await expect(page.locator('#radix-state')).toContainText('eu-central-1');
  await expect(page.locator('#radix-state')).toContainText('gold');
  await expect(page.locator('#radix-state')).toContainText('"backups":true');

  await expect(page.locator('[role="listbox"]')).toHaveCount(0);
});

// Card 5594ae4b (v1.1c). Real tiptap, because ProseMirror keeps a document model
// separate from the DOM and discards out-of-band writes — only a real editor can
// prove the execCommand path reaches the transaction pipeline. The bare
// contenteditable on the same page is the negative control.
test('react-host tiptap: the rich-text editor fills; a bare contenteditable is left alone', async ({
  page,
}) => {
  await page.goto(EDITOR_URL);

  const notesBefore = await page.locator('#internal-notes').textContent();

  await openPanelAndFill(
    page,
    'Disk pressure on node 7 triggered a failover at 02:14 UTC. Title it "Node 7 failover".',
  );
  await expect(ui(page).status).toContainText('Review, then submit', { timeout: 15_000 });

  // The text must be in the EDITOR'S model, not merely in the DOM the driver
  // touched — clicking Save reads it back through tiptap's own getText().
  await page.locator('#editor-section button', { hasText: 'Save report' }).click();
  await expect(page.locator('#editor-saved')).toHaveText(CANNED.editorBody);

  // No ProseMirror behind it → never driven, whatever the plan said.
  await expect(page.locator('#internal-notes')).toHaveText(notesBefore!.trim());
});
