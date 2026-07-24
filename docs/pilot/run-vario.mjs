// INT-pilot, subject 2: Vario frontend (../vario/frontend), public routes under
// the approved VITE_AUTH_MODE=dev shim. Two sub-runs:
//   A. /api-signup — a real <form> (email + org name): the success-path demo.
//   B. /signup — a form-less Card container (shadcn, no <form> element):
//      exercises target-mode fallback on containers without forms.
// Nothing is ever submitted.
import { writeFileSync } from 'node:fs';
import {
  launchPage, injectFieldfox, snapshotFields, runFill, diffFields, screenshot, probeTrigger,
} from './pilot-lib.mjs';

const ENDPOINT = 'http://localhost:8796/api/fill';
const results = { app: 'vario', runs: [] };

// --- Run A: /api-signup (real form) ---
{
  const { browser, page, consoleErrors, failedRequests } = await launchPage();
  const run = { page: '/api-signup', target: 'form', url: 'http://localhost:5174/api-signup' };
  try {
    await page.goto(run.url, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.locator('#signup-email').waitFor({ state: 'visible', timeout: 10_000 });
    run.before = await snapshotFields(page, 'form');
    await screenshot(page, 'vario-before');
    run.mount = await injectFieldfox(page, { targetSelector: 'form', endpoint: ENDPOINT });
    run.triggerProbe = await probeTrigger(page);
    const fill = await runFill(
      page,
      'Queremos dar de alta la cuenta API de mi empresa, Grupo Andino Logística SpA. ' +
        'El administrador será nuestro jefe de operaciones, su correo es operaciones@grupoandino.cl.',
    );
    run.statusText = fill.statusText;
    run.interactionLog = fill.interactionLog;
    await screenshot(page, 'vario-panel');
    run.after = await snapshotFields(page, 'form');
    run.diff = diffFields(run.before, run.after ?? []);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await screenshot(page, 'vario-after');
  } catch (err) {
    run.fatal = String(err);
    await screenshot(page, 'vario-error').catch(() => {});
  } finally {
    run.consoleErrors = consoleErrors.slice(0, 20);
    run.failedRequests = failedRequests.slice(0, 20);
    results.runs.push(run);
    await browser.close();
  }
}

// --- Run B: /signup (form-less shadcn Card: org/email inputs + radix
// combobox country + radix checkbox DPA, but NO <form> element) ---
{
  const { browser, page, consoleErrors, failedRequests } = await launchPage();
  const run = { page: '/signup', target: '.w-full.max-w-md', url: 'http://localhost:5174/signup' };
  try {
    await page.goto(run.url, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.locator('#org-name').waitFor({ state: 'visible', timeout: 10_000 });
    run.before = await snapshotFields(page, run.target);
    await screenshot(page, 'vario-signup-before');
    run.mount = await injectFieldfox(page, { targetSelector: run.target, endpoint: ENDPOINT });
    run.triggerProbe = await probeTrigger(page);
    const fill = await runFill(
      page,
      'Organización: Grupo Andino Logística SpA. Email del administrador: ' +
        'operaciones@grupoandino.cl. País: Chile. Aceptamos el DPA.',
    );
    run.statusText = fill.statusText;
    run.interactionLog = fill.interactionLog;
    await screenshot(page, 'vario-signup-panel');
    run.after = await snapshotFields(page, run.target);
    run.diff = diffFields(run.before, run.after ?? []);
    await screenshot(page, 'vario-signup-after');
  } catch (err) {
    run.fatal = String(err);
    await screenshot(page, 'vario-signup-error').catch(() => {});
  } finally {
    run.consoleErrors = consoleErrors.slice(0, 20);
    run.failedRequests = failedRequests.slice(0, 20);
    results.runs.push(run);
    await browser.close();
  }
}

writeFileSync(new URL('./vario-results.json', import.meta.url), JSON.stringify(results, null, 2));
for (const run of results.runs) {
  console.log(JSON.stringify({
    page: run.page,
    statusText: run.statusText,
    interactionLog: run.interactionLog,
    trigger: run.triggerProbe,
    changed: run.diff?.filter((r) => r.changed),
    fatal: run.fatal,
    failedRequests: run.failedRequests,
  }, null, 2));
}
