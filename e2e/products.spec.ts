import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { FORCE_ERROR } from './canned.mjs';
import { PRODUCT_SAMPLE } from './product-sample.mjs';

const PRODUCT_URL = 'http://localhost:8080/examples/plain-html/products.html';
const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

test.beforeEach(async ({ page }) => {
  await page.goto(PRODUCT_URL);
  await expect(page).toHaveTitle('Fieldfox | Ficha de producto');
  await page.locator('field-fox').evaluate((widget, port) => {
    widget.setAttribute('endpoint', 'http://localhost:' + port + '/api/fill');
  }, SERVER_PORT);
  await page.evaluate(() => {
    document.documentElement.dataset.submits = '0';
    document.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      document.documentElement.dataset.submits = String(Number(document.documentElement.dataset.submits) + 1);
    });
  });
});

test('product fixture supports manual review without submitting or sending data', async ({ page }, testInfo) => {
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET') writes.push(request.url());
  });
  await page.getByLabel('Nombre del producto', { exact: true }).fill('Mesa Brisa');
  await page.getByLabel('SKU', { exact: true }).fill('BRI-101');
  await page.getByLabel('Nota interna', { exact: true }).fill('Revisada por el operador');
  await page.getByRole('button', { name: 'Marcar revisión local' }).click();
  await expect(page.locator('#review-status')).toContainText('Revisión marcada');
  await page.getByLabel('Nombre del producto', { exact: true }).fill('Mesa Brisa corregida');
  await expect(page.locator('#review-status')).toContainText('Hay cambios por revisar');
  expect(writes).toEqual([]);
  await expect(page.locator('button[type="submit"]')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-submits', '0');
  await page.screenshot({ path: testInfo.outputPath('product-manual.png'), fullPage: true });
});

async function prepareFill(page: Page, text: string) {
  await page.locator('#weight').fill('8.5');
  await page.locator('#manual-note').fill('NOTA-PRIVADA-NO-ENVIAR');
  await page.locator('field-fox [part="trigger"]').click();
  await page.locator('field-fox [part="context-input"]').fill(text);
}

async function assertApplied(page: Page) {
  for (const [name, value] of Object.entries(PRODUCT_SAMPLE.values)) {
    await expect(page.locator('#' + name)).toHaveValue(value as string);
  }
  await expect(page.locator('#weight')).toHaveValue('8.5');
  await expect(page.locator('#manual-note')).toHaveValue('NOTA-PRIVADA-NO-ENVIAR');
  await expect(page.locator('html')).toHaveAttribute('data-submits', '0');
}

for (const kind of ['text', 'image', 'document'] as const) {
  test('product ' + kind + ' crosses the real server and leaves unsupported data unchanged', async ({ page }, testInfo) => {
    const marker = 'product-' + kind + '-' + crypto.randomUUID();
    await prepareFill(page, (kind === 'text' ? PRODUCT_SAMPLE.text : 'Usa solo la fuente adjunta.') + ' ' + marker);
    if (kind !== 'text') {
      await page.locator('field-fox .ff-file-input').setInputFiles(
        join(__dirname, kind === 'image' ? 'product-card.png' : 'product-card.pdf'));
      if (kind === 'image') await expect(page.getByRole('img', { name: 'product-card.png', exact: true })).toBeVisible();
      else await expect(page.locator('field-fox [part="attachment"]')).toHaveCount(1);
    }
    const response = page.waitForResponse(res => res.url().endsWith('/api/fill') && res.request().method() === 'POST');
    await page.locator('field-fox [part="fill-button"]').click();
    const res = await response;
    expect(res.status()).toBe(200);
    const body = res.request().postDataJSON();
    expect(JSON.stringify(body.formSchema)).not.toContain('manual-note');
    expect(JSON.stringify(body)).not.toContain('NOTA-PRIVADA-NO-ENVIAR');
    if (kind === 'document') {
      expect(body.documents).toHaveLength(1);
      expect(body.documents[0].mediaType).toBe('application/pdf');
    }
    if (kind === 'image') expect(body.images).toHaveLength(1);
    await assertApplied(page);
    const upstream = await fetch('http://127.0.0.1:8793/__mock/requests').then(r => r.json());
    expect(upstream.requests.some((request: { prompt: string }) => request.prompt.includes(marker))).toBe(true);
    await page.locator('#brand').fill('Marca corregida por mí');
    await expect(page.locator('#brand')).toHaveValue('Marca corregida por mí');
    await page.screenshot({ path: testInfo.outputPath('product-' + kind + '.png'), fullPage: true });
  });
}

test('provider failure preserves the whole product and allows another attempt', async ({ page }, testInfo) => {
  await prepareFill(page, FORCE_ERROR);
  await page.locator('#product-name').fill('Producto revisado');
  const response = page.waitForResponse(res => res.url().endsWith('/api/fill') && res.request().method() === 'POST');
  await page.locator('field-fox [part="fill-button"]').click();
  expect((await response).status()).toBe(502);
  await expect(page.locator('field-fox .ff-status')).toContainText(/could not|couldn't|try again/i);
  await expect(page.locator('#product-name')).toHaveValue('Producto revisado');
  await expect(page.locator('#weight')).toHaveValue('8.5');
  await expect(page.locator('#manual-note')).toHaveValue('NOTA-PRIVADA-NO-ENVIAR');
  await expect(page.locator('#product-name')).toBeEnabled();
  await page.locator('field-fox [part="context-input"]').fill(PRODUCT_SAMPLE.text);
  await page.locator('field-fox [part="fill-button"]').click();
  await assertApplied(page);
  await page.screenshot({ path: testInfo.outputPath('product-recovered.png'), fullPage: true });
});
