// INT-pilot, subject 1: Backplane frontend (../internal/frontend) — Create Card
// dialog on a real board, deployed backend behind the vite proxy. The dialog is
// FILLED but never submitted: zero writes to the backend.
import { writeFileSync } from 'node:fs';
import {
  launchPage, injectFieldfox, snapshotFields, runFill, diffFields, screenshot, probeTrigger,
} from './pilot-lib.mjs';

const APP_URL = 'http://localhost:5173/adpublic-chile/boards/4dfa537d-7941-4394-836e-54a4342d50b3/kanban';
const TARGET = 'form:has(input[placeholder="Card title"])';
const ENDPOINT = 'http://localhost:8796/api/fill';
const CONTEXT_TEXT =
  'High priority bug: the login button double-submits on slow connections, ' +
  'causing duplicate POSTs. Assign to the frontend team — labels: frontend, auth. ' +
  "Due next Friday, July 31st 2026. It's still to do.";

const results = { app: 'backplane', url: APP_URL, target: TARGET };

const { browser, page, consoleErrors, failedRequests } = await launchPage();
// Dev-identity convention: the deployed backend trusts this IAP-style header
// when IAP enforcement is off (internal/backend/app/core/auth.py fallback).
// Scoped via route interception to the app's own /api requests only —
// setExtraHTTPHeaders would leak it onto the widget's cross-origin POST and
// break its CORS preflight (learned in pilot attempt 2).
await page.route('http://localhost:5173/api/**', (route) =>
  route.continue({
    headers: {
      ...route.request().headers(),
      'X-Goog-Authenticated-User-Email': 'accounts.google.com:dev@valaris.dev',
    },
  }),
);

try {
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 45_000 });
  await page.getByRole('button', { name: 'Add card' }).first().click({ timeout: 15_000 });
  await page.locator(TARGET).waitFor({ state: 'visible', timeout: 10_000 });

  results.before = await snapshotFields(page, TARGET);
  results.createButtonDisabledBefore = await page
    .locator('form:has(input[placeholder="Card title"]) button[type="submit"]').isDisabled();
  await screenshot(page, 'backplane-before');

  results.mount = await injectFieldfox(page, { targetSelector: TARGET, endpoint: ENDPOINT });
  results.triggerProbe = await probeTrigger(page);

  const fill = await runFill(page, CONTEXT_TEXT);
  results.statusText = fill.statusText;
  results.interactionLog = fill.interactionLog;
  results.dialogStillOpen = (await page.locator(TARGET).count()) > 0;

  await screenshot(page, 'backplane-panel');
  results.after = await snapshotFields(page, TARGET);
  results.diff = diffFields(results.before, results.after ?? []);
  // React-state proof without submitting: the Create button is
  // disabled={!title.trim()} — it flips to enabled only if React saw the value.
  results.createButtonDisabledAfter = await page
    .locator('form:has(input[placeholder="Card title"]) button[type="submit"]').isDisabled().catch(() => 'dialog gone');

  // Close the panel then the dialog — never submit.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await screenshot(page, 'backplane-after');
} catch (err) {
  results.fatal = String(err);
  await screenshot(page, 'backplane-error').catch(() => {});
} finally {
  results.consoleErrors = consoleErrors.slice(0, 30);
  results.failedRequests = failedRequests.slice(0, 30);
  writeFileSync(new URL('./backplane-results.json', import.meta.url), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(JSON.stringify({
  statusText: results.statusText,
  interactionLog: results.interactionLog,
  triggerProbe: results.triggerProbe,
  dialogStillOpen: results.dialogStillOpen,
  createButton: { before: results.createButtonDisabledBefore, after: results.createButtonDisabledAfter },
  changed: results.diff?.filter((r) => r.changed),
  fatal: results.fatal,
}, null, 2));
