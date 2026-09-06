import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { FORCE_TRANSPORT_ERROR } from './canned.mjs';
import { PRODUCT_SAMPLE } from './product-sample.mjs';

test('truncated provider response preserves the product and a manual retry recovers', async ({ page }, testInfo) => {
  const marker = 'transport-' + crypto.randomUUID();
  const api = 'http://127.0.0.1:38481/api/fill';
  await page.goto('http://127.0.0.1:38480/examples/plain-html/products.html');
  await page.locator('field-fox').evaluate((widget, endpoint) => widget.setAttribute('endpoint', endpoint), api);
  const prior = {
    'product-name': 'Previous product', sku: 'PRE-001', brand: 'Previous brand',
    description: 'Previous description', material: 'wood', weight: '8.5',
    width: '42', depth: '21', height: '63', 'manual-note': 'PRIVATE-SYNTHETIC-NOTE',
  };
  for (const [id, value] of Object.entries(prior)) {
    if (id === 'material') await page.locator('#' + id).selectOption(value);
    else await page.locator('#' + id).fill(value);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.submits = '0';
    document.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      document.documentElement.dataset.submits = String(Number(document.documentElement.dataset.submits) + 1);
    });
  });
  await page.locator('field-fox [part="trigger"]').click();
  await page.locator('field-fox [part="context-input"]').fill(FORCE_TRANSPORT_ERROR + ' ' + marker);
  await page.locator('field-fox .ff-file-input').setInputFiles(join(__dirname, 'product-card.pdf'));
  await expect(page.locator('field-fox [part="attachment"]')).toHaveCount(1);
  const failedResponse = page.waitForResponse(response => response.url() === api && response.request().method() === 'POST');
  await page.locator('field-fox [part="fill-button"]').click();
  await expect(page.locator('#product-name')).toBeDisabled();
  const failed = await failedResponse;
  expect(failed.status()).toBe(502);
  const failure = await failed.json();
  expect(failure.error).toBe('upstream_error');
  const sent = failed.request().postDataJSON();
  expect(sent.documents).toHaveLength(1);
  expect(JSON.stringify(sent)).not.toContain(prior['manual-note']);
  await expect(page.locator('field-fox .ff-status')).toHaveText('Could not fill the form. Please try again.');
  for (const [id, value] of Object.entries(prior)) {
    await expect(page.locator('#' + id)).toHaveValue(value);
    await expect(page.locator('#' + id)).toBeEnabled();
  }
  await expect(page.locator('html')).toHaveAttribute('data-submits', '0');
  const failedCalls = await fetch('http://127.0.0.1:38482/__mock/requests').then(r => r.json());
  const attempt = failedCalls.requests.filter((request: { prompt: string }) => request.prompt.includes(marker));
  expect(attempt).toHaveLength(1);
  expect(attempt[0]).toMatchObject({ responseFormat: 'json_schema', fault: 'truncated-http-body', transportClosed: true });
  await page.screenshot({ path: testInfo.outputPath('transport-failure.png'), fullPage: true });

  await page.locator('#brand').fill('Manual correction after the error');
  await expect(page.locator('#brand')).toHaveValue('Manual correction after the error');
  await page.locator('field-fox [part="context-input"]').fill(PRODUCT_SAMPLE.text + ' recovery-' + marker);
  const recoveredResponse = page.waitForResponse(response => response.url() === api && response.request().method() === 'POST');
  await page.locator('field-fox [part="fill-button"]').click();
  const recovered = await recoveredResponse;
  expect(recovered.status()).toBe(200);
  for (const [id, value] of Object.entries(PRODUCT_SAMPLE.values)) {
    await expect(page.locator('#' + id)).toHaveValue(value as string);
  }
  await expect(page.locator('#weight')).toHaveValue(prior.weight);
  await expect(page.locator('#manual-note')).toHaveValue(prior['manual-note']);
  await expect(page.locator('field-fox .ff-status')).toContainText('Review the form.');
  await expect(page.locator('html')).toHaveAttribute('data-submits', '0');
  const allCalls = await fetch('http://127.0.0.1:38482/__mock/requests').then(r => r.json());
  const requests = allCalls.requests.filter((request: { prompt: string }) => request.prompt.includes(marker));
  expect(requests).toHaveLength(2);
  expect(requests[1].completedAt).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('transport-recovered.png'), fullPage: true });
  await writeFile(testInfo.outputPath('transport-result.json'), JSON.stringify({
    scenario: 'provider TCP closes after 200 headers and a partial JSON body',
    failedStatus: failed.status(), failure, recoveredStatus: recovered.status(),
    preservedFieldsAfterFailure: Object.keys(prior), providerCalls: requests.map(
      ({ prompt, ...metadata }: { prompt: string; [key: string]: unknown }) => metadata),
    submitCount: 0, modelQualityMeasured: false, billableProviderCalls: 0,
  }, null, 2) + '\n');
});
