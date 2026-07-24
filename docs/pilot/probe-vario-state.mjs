// No-LLM check: does the widget's native-setter+events technique register with
// Vario's React state? Observable: the submit button's disabled flag
// (disabled = isSubmitting || !email.trim() || !orgName.trim()).
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5174/api-signup', { waitUntil: 'networkidle', timeout: 30000 });
await page.locator('#signup-email').waitFor({ state: 'visible' });
const before = await page.locator('form button[type="submit"]').isDisabled();
await page.evaluate(() => {
  const set = (sel, value) => {
    const el = document.querySelector(sel);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set('#signup-email', 'operaciones@grupoandino.cl');
  set('#signup-org', 'Grupo Andino Logística SpA');
});
await page.waitForTimeout(300);
const after = await page.locator('form button[type="submit"]').isDisabled();
console.log(JSON.stringify({ submitDisabledBefore: before, submitDisabledAfter: after }));
await browser.close();
