// INT-pilot bonus: real IMAGE fill on Vario /api-signup. A fixture "business
// card" PNG is rendered by the browser itself, then attached through the
// widget's own file input; the context textarea carries only a pointer phrase.
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import {
  injectFieldfox, snapshotFields, diffFields, screenshot, launchPage,
} from './pilot-lib.mjs';

// 1. Render the fixture image.
{
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.setContent(`
    <body style="margin:0;display:grid;place-items:center;height:100vh;background:#f4efe8;font-family:Georgia,serif">
      <div style="border:2px solid #333;padding:32px 40px;background:#fff;border-radius:8px">
        <div style="font-size:26px;font-weight:bold">Transportes Patagonia Verde Ltda</div>
        <div style="font-size:16px;margin-top:12px;color:#444">Administración de flota y cumplimiento</div>
        <div style="font-size:18px;margin-top:16px">flota@patagoniaverde.cl</div>
      </div>
    </body>`);
  await page.screenshot({ path: new URL('./vario-image-fixture.png', import.meta.url).pathname });
  await browser.close();
}

// 2. Run the image-driven fill.
const { browser, page, consoleErrors, failedRequests } = await launchPage();
const run = { page: '/api-signup (image fill)', url: 'http://localhost:5174/api-signup' };
try {
  await page.goto(run.url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator('#signup-email').waitFor({ state: 'visible', timeout: 10_000 });
  run.before = await snapshotFields(page, 'form');
  await injectFieldfox(page, { targetSelector: 'form', endpoint: 'http://localhost:8796/api/fill' });
  await page.locator('field-fox [part="trigger"]').click();
  await page.locator('field-fox [part="panel"]').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('field-fox [part="context-input"]').fill('Usa los datos de la tarjeta adjunta.');
  await page.locator('field-fox .ff-file-input').setInputFiles(
    new URL('./vario-image-fixture.png', import.meta.url).pathname,
  );
  await page.waitForTimeout(800); // thumbnail/downscale settle
  await page.locator('field-fox [part="fill-button"]').click();
  const status = page.locator('field-fox .ff-status');
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    run.statusText = ((await status.textContent().catch(() => '')) ?? '').trim();
    if (/review|filled|error|failed|refus|could not|unable|no fields/i.test(run.statusText)) break;
    await page.waitForTimeout(500);
  }
  await screenshot(page, 'vario-image-panel');
  run.after = await snapshotFields(page, 'form');
  run.diff = diffFields(run.before, run.after ?? []);
} catch (err) {
  run.fatal = String(err);
  await screenshot(page, 'vario-image-error').catch(() => {});
} finally {
  run.consoleErrors = consoleErrors.slice(0, 20);
  run.failedRequests = failedRequests.slice(0, 20);
  writeFileSync(new URL('./vario-image-results.json', import.meta.url), JSON.stringify(run, null, 2));
  await browser.close();
}
console.log(JSON.stringify({
  statusText: run.statusText,
  changed: run.diff?.filter((r) => r.changed),
  fatal: run.fatal,
  failedRequests: run.failedRequests,
}, null, 2));
