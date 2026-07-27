import { expect, test, type Page } from '@playwright/test';

// CLOUD-3 acceptance: the allowance-exhausted surface in a real browser. The
// server's 402 is injected at the route layer rather than by draining a real
// allowance — the widget's behaviour is what this card is about, and the 402
// body is CLOUD-2's tested contract.

const PLAIN_URL = 'http://localhost:8080/examples/plain-html/';
const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

// The refusal packages/server sends when a free-lane origin is out of fills.
const EXHAUSTED_BODY = {
  error: 'free_allowance_exhausted',
  allowance: 25,
  message: 'this site has used its 25 free fills for today',
  signupUrl: 'https://fieldfox.dev/signup',
};

const ui = (page: Page) => ({
  trigger: page.locator('field-fox [part="trigger"]'),
  panel: page.locator('field-fox [part="panel"]'),
  contextInput: page.locator('field-fox [part="context-input"]'),
  fillButton: page.locator('field-fox [part="fill-button"]'),
  status: page.locator('field-fox .ff-status'),
});

// The fixture posts to :8787; the stack may serve on another port. Match both so
// the interception is independent of the port remap the other specs perform.
const FILL_URL_PATTERN = /\/api\/fill$/;

async function fillWith(page: Page, status: number, body: unknown): Promise<void> {
  await page.route(FILL_URL_PATTERN, async (route) => {
    await route.fulfill({
      status,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': 'http://localhost:8080',
      },
      body: JSON.stringify(body),
    });
  });
}

async function openPanelAndFill(page: Page, contextText: string): Promise<void> {
  const { trigger, panel, contextInput, fillButton } = ui(page);
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(fillButton).toBeInViewport();
  await contextInput.fill(contextText);
  await fillButton.click();
}

test('allowance exhausted: actionable offer, form verifiably unchanged', async ({ page }) => {
  await fillWith(page, 402, EXHAUSTED_BODY);
  await page.goto(PLAIN_URL);

  // Pre-fill so "unchanged" is observable rather than vacuous.
  await page.locator('#full-name').fill('Original Owner');
  await page.locator('#email').fill('original@example.com');

  await page.evaluate(() => {
    (window as { __ffSubmits?: number } & Window).__ffSubmits = 0;
    document.querySelector('#signup-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      (window as { __ffSubmits?: number } & Window).__ffSubmits!++;
    });
  });

  await openPanelAndFill(page, 'I am Jane Doe, jane@doe.dev');

  const { status } = ui(page);
  await expect(status).toContainText('free fills', { timeout: 20_000 });

  // NOT an error state — the product did not break.
  await expect(status).not.toHaveClass(/ff-error/);
  await expect(status).toHaveClass(/ff-offer/);

  // A real, reachable call to action.
  const link = status.locator('a');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', EXHAUSTED_BODY.signupUrl);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);

  // Fill-or-leave across the WHOLE request: nothing written, nothing left
  // disabled, and certainly never submitted.
  await expect(page.locator('#full-name')).toHaveValue('Original Owner');
  await expect(page.locator('#email')).toHaveValue('original@example.com');
  await expect(page.locator('#full-name')).toBeEnabled();
  await expect(page.locator('#email')).toBeEnabled();
  await expect(page.locator('#full-name')).not.toHaveClass(/ff-fill-dim/);
  expect(await page.evaluate(() => (window as { __ffSubmits?: number } & Window).__ffSubmits)).toBe(0);
});

test('a genuine server fault still shows the ordinary error state, distinctly', async ({ page }) => {
  // The contrast that makes the exhaustion surface meaningful: a real fault must
  // still look like a fault.
  await fillWith(page, 502, { error: 'fill_failed', message: 'upstream exploded' });
  await page.goto(PLAIN_URL);

  await openPanelAndFill(page, 'I am Jane Doe, jane@doe.dev');

  const { status } = ui(page);
  await expect(status).toHaveClass(/ff-error/, { timeout: 20_000 });
  await expect(status).not.toHaveClass(/ff-offer/);
  await expect(status.locator('a')).toHaveCount(0);
});
