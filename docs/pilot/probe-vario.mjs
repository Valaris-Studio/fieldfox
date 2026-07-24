import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
for (const path of ['/signup', '/api-signup']) {
  await page.goto(`http://localhost:5174${path}`, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.log(path, 'goto fail', String(e)));
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => ({
    title: document.title,
    bodyText: document.body.innerText.slice(0, 300).replace(/\n+/g, ' | '),
    forms: [...document.querySelectorAll('form')].map((f) => [...f.querySelectorAll('input,textarea,select')].map((el) => `${el.tagName}:${el.type}:${el.id || el.placeholder}`)),
    looseInputs: [...document.querySelectorAll('input,textarea,select')].filter((el) => !el.closest('form')).map((el) => `${el.tagName}:${el.type}:${el.id || el.placeholder}`),
    comboButtons: [...document.querySelectorAll('button[role="combobox"], [role="checkbox"]')].map((el) => `${el.tagName}:${el.id}:${el.getAttribute('role')}`),
    iframes: [...document.querySelectorAll('iframe')].map((f) => f.src.slice(0, 100)),
  }));
  console.log(`=== ${path}`, JSON.stringify(info, null, 1));
}
console.log('console errors:', JSON.stringify(errors.slice(0, 8), null, 1));
await browser.close();
