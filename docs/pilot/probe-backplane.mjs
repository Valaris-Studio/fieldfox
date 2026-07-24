import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.route('http://localhost:5173/api/**', (route) =>
  route.continue({ headers: { ...route.request().headers(), 'X-Goog-Authenticated-User-Email': 'accounts.google.com:dev@valaris.dev' } }));
await page.goto('http://localhost:5173/adpublic-chile/boards/4dfa537d-7941-4394-836e-54a4342d50b3/kanban', { waitUntil: 'networkidle', timeout: 45000 });
await page.getByRole('button', { name: 'Add card' }).first().click({ timeout: 15000 });
await page.locator('form:has(input[placeholder="Card title"])').waitFor({ state: 'visible', timeout: 10000 });
const probe = await page.evaluate(() => {
  const forms = [...document.querySelectorAll('form')].map((f, i) => ({
    i, controls: [...f.querySelectorAll('input, textarea, select')].map((el) => `${el.tagName}:${el.type}:${el.id || el.placeholder || ''}`),
  }));
  const dlgInputs = [...document.querySelectorAll('input, textarea, select')]
    .filter((el) => el.closest('.fixed.inset-0'))
    .map((el) => `${el.tagName}:${el.type}:${el.id || el.placeholder || ''} inForm=${!!el.closest('form')}`);
  return { formCount: forms.length, forms, dlgInputs };
});
console.log(JSON.stringify(probe, null, 2));
await browser.close();
