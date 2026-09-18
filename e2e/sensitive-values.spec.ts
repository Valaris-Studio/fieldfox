import { expect, test } from '@playwright/test';

const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

test('sensitive controls stay manual and their values never cross widget or provider boundaries', async ({ page }) => {
  const marker = `sensitive-values-${crypto.randomUUID()}`;
  const nestedSecret = 'synthetic-nested-card-secret';
  const values = {
    password: 'synthetic-password-secret',
    'readonly-password': 'synthetic-readonly-secret',
    otp: 'synthetic-otp-secret',
    card: 'synthetic-card-secret',
  };
  await page.goto('http://localhost:8080/examples/plain-html/');
  await page.locator('field-fox').evaluate((widget, port) => {
    widget.setAttribute('endpoint', `http://localhost:${port}/api/fill`);
  }, SERVER_PORT);
  await page.locator('#signup-form').evaluate((form, { values, nestedSecret }) => {
    for (const [name, value] of Object.entries(values)) {
      const input = document.createElement('input');
      input.name = name;
      input.value = value;
      if (name.includes('password')) input.type = 'password';
      if (name === 'readonly-password') input.readOnly = true;
      if (name === 'otp') input.autocomplete = 'section-login ONE-TIME-CODE';
      if (name === 'card') input.autocomplete = 'section-checkout billing CC-NUMBER';
      form.append(input);
    }
    const readonlyContext = document.createElement('input');
    readonlyContext.name = 'readonly-context';
    readonlyContext.value = 'ordinary-context';
    readonlyContext.readOnly = true;
    form.append(readonlyContext);
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.className = 'ProseMirror';
    editor.textContent = 'ordinary-editor-context';
    const card = document.createElement('textarea');
    card.name = 'nested-card';
    card.autocomplete = 'cc-number';
    card.textContent = nestedSecret;
    editor.append(card);
    form.append(editor);
  }, { values, nestedSecret });

  await page.locator('field-fox [part="trigger"]').click();
  await page.locator('field-fox [part="context-input"]').fill(`Jane Doe. ${marker}`);
  const response = page.waitForResponse((res) => res.url().endsWith('/api/fill') && res.request().method() === 'POST');
  await page.locator('field-fox [part="fill-button"]').click();
  const completed = await response;
  expect(completed.status()).toBe(200);
  const posted = completed.request().postData()!;
  const fields = completed.request().postDataJSON().formSchema.fields as Array<{ name?: string; kind: string; currentValue?: string; fillable: boolean }>;
  for (const value of Object.values(values)) expect(posted).not.toContain(value);
  expect(posted).not.toContain(nestedSecret);
  expect(fields.find((field) => field.currentValue === 'ordinary-editor-context')?.fillable).toBe(false);
  expect(fields.some((field) => field.name === 'otp' || field.name === 'card')).toBe(false);
  const passwords = fields.filter((field) => field.kind === 'password');
  expect(passwords).toHaveLength(2);
  for (const field of passwords) {
    expect(field.fillable).toBe(false);
    expect(field).not.toHaveProperty('currentValue');
  }
  expect(fields.find((field) => field.name === 'readonly-context')?.currentValue).toBe('ordinary-context');

  const providerResponse = await fetch('http://127.0.0.1:8793/__mock/requests');
  const providerLog = await providerResponse.json() as { requests: Array<{ prompt: string }> };
  const requests = providerLog.requests.filter((request) => request.prompt.includes(marker));
  expect(requests).toHaveLength(1);
  for (const value of Object.values(values)) expect(requests[0].prompt).not.toContain(value);
  expect(requests[0].prompt).not.toContain(nestedSecret);
  expect(requests[0].prompt).toContain('ordinary-context');
  await expect(page.locator('field-fox .ff-status')).toContainText('Review');
  await expect(page.locator('[name="nested-card"]')).toHaveValue(nestedSecret);
  for (const [name, value] of Object.entries(values)) {
    await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
    await expect(page.locator(`[name="${name}"]`)).toBeEnabled();
  }
});
