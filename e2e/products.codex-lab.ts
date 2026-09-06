// Fixed inputs chosen before inference. Answer key is never loaded here.
import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const corpus = resolve('../evidence/V1P/products-v1-r2/operator');
const evidence = resolve(process.env.FIELDFOX_CODEX_EVIDENCE ?? '../evidence/CODEX-IA');
const cases = [
  ['FP1-001-A','txt'], ['FP1-002-B','txt'],
  ['FP1-023-A','png'], ['FP1-024-B','png'],
  ['FP1-037-A','pdf'], ['FP1-040-B','pdf'],
];
test('bridge rejects requests without its private capability', async ({ request }) => {
  for (const headers of [{}, { origin: 'http://127.0.0.1:38580' }, { authorization: 'Bearer wrong' }]) {
    expect((await request.post('http://127.0.0.1:38582/v1/chat/completions', { headers, data: {} })).status()).toBe(403);
  }
  expect((await (await request.get('http://127.0.0.1:38580/health')).json()).remainingCalls).toBe(6);
});
for (const [id, extension] of cases) {
  test(id + ' real Codex ' + extension, async ({ page }) => {
    const folder = join(evidence, 'browser', id); await mkdir(folder, { recursive: true });
    const initial = JSON.parse(await readFile(join(corpus, 'initial-state.json'), 'utf8'))[id];
    const source = join(corpus, id + '.' + extension), bytes = await readFile(source);
    await page.goto('http://127.0.0.1:38580/examples/plain-html/products.html');
    await page.evaluate(() => {
      document.documentElement.dataset.submits = '0';
      document.querySelector('form')!.addEventListener('submit', event => {
        event.preventDefault();
        document.documentElement.dataset.submits = String(Number(document.documentElement.dataset.submits) + 1);
      });
    });
    for (const [key,value] of Object.entries(initial)) {
      const input = page.locator('#' + key);
      if (await input.evaluate(el => el.tagName === 'SELECT')) await input.selectOption(value as string);
      else await input.fill(value as string);
    }
    await page.locator('field-fox [part="trigger"]').click();
    await page.locator('field-fox [part="context-input"]').fill(
      extension === 'txt' ? bytes.toString('utf8') : 'Completa la ficha usando solo la fuente adjunta.');
    if (extension !== 'txt') await page.locator('field-fox .ff-file-input').setInputFiles(source);
    const started = Date.now();
    const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/fill') && r.request().method() === 'POST', { timeout: 245_000 });
    await page.locator('field-fox [part="fill-button"]').click();
    const response = await responsePromise;
    const request = response.request().postDataJSON();
    const responseText = await response.text();
    await writeFile(join(folder,'request.json'), JSON.stringify(request,null,2));
    await writeFile(join(folder,'response.json'), responseText);
    await writeFile(join(folder,'source.json'), JSON.stringify({ id, source, sha256:createHash('sha256').update(bytes).digest('hex'), initial, status:response.status(), elapsed_ms:Date.now()-started },null,2));
    expect(response.status(), responseText).toBe(200);
    await expect(page.locator('field-fox .ff-status')).toContainText('Review the form.');
    const fields = await page.locator('form input, form textarea, form select').evaluateAll(elements =>
      Object.fromEntries(elements.filter(el => el.id).map(el => [el.id,(el as HTMLInputElement).value])));
    await writeFile(join(folder,'final-state.json'),JSON.stringify(fields,null,2));
    expect(JSON.stringify(request.formSchema)).not.toContain('manual-note');
    expect(JSON.stringify(request)).not.toContain('Nota manual: conservar.');
    expect(fields['manual-note']).toBe(initial['manual-note']);
    await expect(page.locator('html')).toHaveAttribute('data-submits','0');
    await page.screenshot({path:join(folder,'chrome.png'),fullPage:true});
    await page.locator('#brand').fill('Corrección manual verificada');
    await expect(page.locator('#brand')).toHaveValue('Corrección manual verificada');
  });
}
