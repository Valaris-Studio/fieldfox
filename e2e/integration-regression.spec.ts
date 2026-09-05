import { expect, test } from '@playwright/test';
import { CANNED } from './canned.mjs';

const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

test.beforeEach(async ({ page }) => {
  await page.goto('http://localhost:8080/examples/plain-html/');
  // Change the fixture endpoint only; the real server and deterministic
  // OpenAI-compatible provider remain in the complete request path.
  await page.locator('field-fox').evaluate((widget, port) => {
    widget.setAttribute('endpoint', `http://localhost:${port}/api/fill`);
  }, SERVER_PORT);
  await page.locator('#full-name').fill('Original Owner');
  await page.evaluate(() => {
    document.documentElement.dataset.submits = '0';
    document.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      const root = document.documentElement;
      root.dataset.submits = String(Number(root.dataset.submits) + 1);
    });
  });
});

test('a host-altered native value is restored, never confirmed by substring', async ({ page }) => {
  await page.locator('#full-name').evaluate((field, planned) => {
    field.addEventListener('input', () => {
      const input = field as HTMLInputElement;
      if (input.value === planned) input.value = `${planned} Jr.`;
    });
  }, CANNED.fullName);
  await page.locator('field-fox [part="trigger"]').click();
  await page.locator('field-fox [part="context-input"]').fill('Jane Doe, jane@doe.dev.');
  const response = page.waitForResponse((res) =>
    res.url().endsWith('/api/fill') && res.request().method() === 'POST');
  await page.locator('field-fox [part="fill-button"]').click();
  expect((await response).status()).toBe(200);
  await expect(page.locator('field-fox .ff-status')).toContainText('Review, then submit');
  await expect(page.locator('#full-name')).toHaveValue('Original Owner');
  await expect(page.locator('#email')).toHaveValue(CANNED.email);
  await expect(page.locator('#full-name')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-submits', '0');
});

test('disconnect leaves the host unchanged after the local provider completes', async ({ page }) => {
  const marker = `disconnect-${crypto.randomUUID()}`;
  await page.locator('field-fox [part="trigger"]').click();
  await page.locator('field-fox [part="context-input"]').fill(`Jane Doe. ${marker}`);
  await page.locator('field-fox [part="fill-button"]').click();
  await expect(page.locator('#full-name')).toBeDisabled();
  const recorded = async () => {
    const response = await fetch('http://127.0.0.1:8793/__mock/requests');
    const body = await response.json() as {
      requests: Array<{ prompt: string; completedAt?: string }>;
    };
    return body.requests.find((request) => request.prompt.includes(marker));
  };
  await expect.poll(recorded).toBeDefined();
  await page.locator('field-fox').evaluate((widget) => widget.remove());
  // Provider completion is the clock, instead of a fixed sleep that could
  // pass before a late response arrives. No network response is replaced.
  await expect.poll(async () => (await recorded())?.completedAt).toBeDefined();
  await expect(page.locator('#full-name')).toHaveValue('Original Owner');
  await expect(page.locator('#email')).toHaveValue('');
  await expect(page.locator('#full-name')).toBeEnabled();
  await expect(page.locator('#full-name')).not.toHaveClass(/ff-fill-dim/);
  await expect(page.locator('html')).toHaveAttribute('data-submits', '0');
});
