import { expect, test, type Locator, type Page } from '@playwright/test';
import { CANNED } from './canned.mjs';

// Adjustment mode (attribute: adjust) end to end. The plain-HTML fixture carries
// `adjust` permanently (it is the integration demo), so the behavior tests run
// there directly. The FORMLESS fixture does NOT carry it: the lifecycle test uses
// that host to prove the attribute gate in both directions at runtime via
// page.evaluate (attributeChangedCallback re-binds the widget each way).
//
// Coverage: the toggle appears only with the attribute and enters/leaves mode; the
// badges overlay the form's fields; an edit made through the editor UI rides the
// very next Fill (the widget re-introspects per Fill); toggling ignore drops the
// field from the next POSTed schema; and the export textarea carries the edited
// field's data-ff-* line. The mock stack delays responses so the in-flight window
// is observable; CANNED values live in canned.mjs.

const PLAIN_URL = 'http://localhost:8080/examples/plain-html/';
const FORMLESS_URL = 'http://localhost:8080/examples/plain-html/formless.html';
const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

// The fixtures hardcode endpoint :8787, but the stack runs the real server on
// :8794. Remap only that endpoint's port before any page script runs (identical
// to fill.spec.ts) so the request still traverses the full server pipeline.
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
  adjustToggle: page.locator('field-fox [part="adjust-toggle"]'),
  badges: page.locator('field-fox [part="adjust-badge"]'),
  editor: page.locator('field-fox [part="adjust-editor"]'),
  exportChip: page.locator('field-fox button[part="adjust-export"]'),
  exportArea: page.locator('field-fox textarea[part="adjust-export"]'),
  panel: page.locator('field-fox [part="panel"]'),
  contextInput: page.locator('field-fox [part="context-input"]'),
  fillButton: page.locator('field-fox [part="fill-button"]'),
});

// Turn adjustment mode on at runtime — used on the formless host (whose fixture
// omits the attribute) to prove the re-mount path. The plain host carries
// `adjust` in its fixture, so tests there need no runtime enable.
async function enableAdjust(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector('field-fox')!.setAttribute('adjust', ''));
}

// Resolves with the first /api/fill POST body (parsed). The remap shim may change
// the port, so match on the /api/fill suffix (same as documents.spec.ts).
function firstFillBody(page: Page): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/fill')) {
        resolve(JSON.parse(req.postData() ?? '{}'));
      }
    });
  });
}

// Positive-area overlap ratio of a badge over a field (same helper shape as
// inflight-effect.spec.ts): a badge must sit ON its field, not merely exist.
function overlapArea(
  a: { x: number; y: number; width: number; height: number },
  b: typeof a,
): number {
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlapX * overlapY;
}

// Opens the editor for the field with the given #id by clicking its badge. The
// badge is pinned to the field's top-left, so click the badge nearest that corner.
async function openEditorFor(page: Page, fieldId: string): Promise<void> {
  const { badges, editor } = ui(page);
  const fieldBox = (await page.locator(`#${fieldId}`).boundingBox())!;
  const count = await badges.count();
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < count; i++) {
    const box = await badges.nth(i).boundingBox();
    if (!box) continue;
    const dist = Math.hypot(box.x - fieldBox.x, box.y - (fieldBox.y - 18));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  await badges.nth(best).click();
  await expect(editor).toBeVisible();
}

test('the adjust toggle appears only with the attribute and enters/leaves mode', async ({ page }) => {
  // The formless fixture carries no `adjust` attribute, so both directions of the
  // runtime attribute gate (and the re-mount each way) are provable here.
  await page.goto(FORMLESS_URL);
  const { adjustToggle, badges } = ui(page);

  // Without the attribute the toggle is absent.
  await expect(adjustToggle).toHaveCount(0);

  await enableAdjust(page);
  await expect(adjustToggle).toHaveCount(1);
  await expect(adjustToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(badges).toHaveCount(0); // no badges until entered

  // Entering mode lights the toggle and mounts the badges.
  await adjustToggle.click();
  await expect(adjustToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(badges.first()).toBeVisible();

  // Leaving mode tears the badges down.
  await adjustToggle.click();
  await expect(adjustToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(badges).toHaveCount(0);

  // Removing the attribute re-binds without the toggle at all.
  await page.evaluate(() => document.querySelector('field-fox')!.removeAttribute('adjust'));
  await expect(adjustToggle).toHaveCount(0);
});

test('badges overlay the form fields', async ({ page }) => {
  await page.goto(PLAIN_URL);
  const { adjustToggle, badges } = ui(page);
  await adjustToggle.click();
  await expect(badges.first()).toBeVisible();

  // A badge sits over the email field's top-left corner.
  const emailBox = (await page.locator('#email').boundingBox())!;
  let covered = false;
  const count = await badges.count();
  for (let i = 0; i < count; i++) {
    const badgeBox = await badges.nth(i).boundingBox();
    if (!badgeBox) continue;
    // The badge is pinned just above the field; widen the field box upward so the
    // overlap check accounts for that offset.
    const anchor = { ...emailBox, y: emailBox.y - 20, height: emailBox.height + 20 };
    if (overlapArea(badgeBox, anchor) > 0) covered = true;
  }
  expect(covered, 'a badge should overlap the email field').toBe(true);
});

test('an edit made through the editor rides the very next Fill', async ({ page }) => {
  await page.goto(PLAIN_URL);
  const { adjustToggle, editor, trigger, panel, contextInput, fillButton } = ui(page);
  await adjustToggle.click();

  // Edit the email field's hint through the editor UI, then Apply.
  await openEditorFor(page, 'email');
  await editor.locator('input[data-ff-attr="hint"]').fill('company email only');
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(editor).toHaveCount(0);

  // The applied edit is written straight onto the live host field.
  await expect(page.locator('#email')).toHaveAttribute('data-ff-hint', 'company email only');

  // Now run a real fill; the widget re-introspects per Fill, so the POSTed schema
  // carries the just-edited hint for the email field.
  const bodyPromise = firstFillBody(page);
  await trigger.click();
  await expect(panel).toBeVisible();
  await contextInput.fill(`I am ${CANNED.fullName} (${CANNED.email}).`);
  await fillButton.click();

  const posted = await bodyPromise;
  const schema = posted.formSchema as { fields: Array<Record<string, unknown>> };
  const emailField = schema.fields.find((f) => f.name === 'email')!;
  expect(emailField, 'the email field must be in the posted schema').toBeTruthy();
  expect((emailField.authorHints as { hint?: string }).hint).toBe('company email only');
});

test('toggling ignore on a field drops it from the next POSTed schema', async ({ page }) => {
  await page.goto(PLAIN_URL);
  const { adjustToggle, editor, trigger, panel, contextInput, fillButton } = ui(page);
  await adjustToggle.click();

  // The email field starts in the schema; ignore it through the editor.
  await openEditorFor(page, 'email');
  await editor.locator('input[type="checkbox"]').check();
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('#email')).toHaveAttribute('data-ff-ignore', '');

  const bodyPromise = firstFillBody(page);
  await trigger.click();
  await expect(panel).toBeVisible();
  await contextInput.fill(`I am ${CANNED.fullName} (${CANNED.email}).`);
  await fillButton.click();

  const posted = await bodyPromise;
  const schema = posted.formSchema as { fields: Array<Record<string, unknown>> };
  // An ignored field is stripped client-side, so it never reaches the server.
  expect(schema.fields.some((f) => f.name === 'email')).toBe(false);
});

test('the export textarea contains the edited field\'s data-ff-hint line', async ({ page }) => {
  await page.goto(PLAIN_URL);
  const { adjustToggle, editor, exportChip, exportArea } = ui(page);
  await adjustToggle.click();

  // Edit a hint so there is a fresh annotation to export.
  await openEditorFor(page, 'email');
  await editor.locator('input[data-ff-attr="hint"]').fill('work address preferred');
  await editor.getByRole('button', { name: 'Apply' }).click();

  // Open the export; the textarea carries a selector + attribute line for #email.
  await exportChip.click();
  await expect(exportArea).toBeVisible();
  const text = await exportArea.inputValue();
  expect(text).toContain('#email');
  expect(text).toContain('data-ff-hint="work address preferred"');
});
