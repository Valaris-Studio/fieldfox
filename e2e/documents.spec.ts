import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CANNED } from './canned.mjs';

// Card: accept-documents. The document-attachment flow end to end on BOTH hosts:
//   1. flag ON (plain index): a PDF attaches, the POSTed FillRequest carries
//      schemaVersion 3 + a `documents` entry, and the mocked plan applies.
//   2. flag OFF (formless): the same PDF is not accepted (friendly message) and
//      the wire body carries no documents.
//   3. flag ON: a text file's content is inlined into contextText between the
//      attachment delimiters, and `documents` stays empty.
// The example forms' selectors are the contract — fixtures are never modified.

const PLAIN_URL = 'http://localhost:8080/examples/plain-html/';
const FORMLESS_URL = 'http://localhost:8080/examples/plain-html/formless.html';

// Playwright transpiles specs to CJS, so __dirname is available while
// import.meta is NOT ("cannot use import.meta outside a module" at spec load).
const PDF_FIXTURE = join(__dirname, 'sample.pdf');
const TXT_FIXTURE = join(__dirname, 'sample.txt');

// Same port-remap shim as fill.spec.ts: the fixtures hardcode :8787 but the
// stack runs the server on 8794. Remap only that endpoint before page scripts.
const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

test.beforeEach(async ({ page }) => {
  if (SERVER_PORT === 8787) return;
  await page.addInitScript((port) => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.startsWith('http://localhost:8787/api/fill')) {
        return original(url.replace(':8787', `:${port}`), init);
      }
      return original(input as RequestInfo, init);
    };
  }, SERVER_PORT);
});

const ui = (page: Page) => ({
  trigger: page.locator('field-fox [part="trigger"]'),
  panel: page.locator('field-fox [part="panel"]'),
  contextInput: page.locator('field-fox [part="context-input"]'),
  fileInput: page.locator('field-fox .ff-file-input'),
  fillButton: page.locator('field-fox [part="fill-button"]'),
  attachments: page.locator('field-fox [part="attachment"]'),
  status: page.locator('field-fox .ff-status'),
});

// Resolves with the first /api/fill POST body (parsed). The remap shim may
// change the port, so match on the /api/fill suffix.
function firstFillBody(page: Page): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/fill')) {
        resolve(JSON.parse(req.postData() ?? '{}'));
      }
    });
  });
}

async function openPanel(page: Page): Promise<void> {
  const { trigger, panel, fillButton } = ui(page);
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(fillButton).toBeInViewport();
}

test('flag ON (plain host): a PDF attaches, rides the wire as schemaVersion 3 + documents, and the plan applies', async ({ page }) => {
  await page.goto(PLAIN_URL);
  const { fileInput, contextInput, fillButton, attachments, status } = ui(page);
  await openPanel(page);

  // Attach the PDF via the (hidden) file input; a chip appears for it.
  await fileInput.setInputFiles(PDF_FIXTURE);
  await expect(attachments).toHaveCount(1);
  await expect(attachments.first()).toContainText('sample.pdf');

  const bodyPromise = firstFillBody(page);
  await contextInput.fill('Jane Doe, jane@doe.dev, medium shirt, afternoon.');
  await fillButton.click();

  const posted = await bodyPromise;
  expect(posted.schemaVersion).toBe(3);
  const documents = posted.documents as Array<{ name: string; mediaType: string; dataUrl: string }>;
  expect(documents).toHaveLength(1);
  expect(documents[0].name).toBe('sample.pdf');
  expect(documents[0].mediaType).toBe('application/pdf');
  expect(documents[0].dataUrl.startsWith('data:application/pdf')).toBe(true);

  // The mocked plan still applies on top of the document attachment.
  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });
  await expect(page.locator('#email')).toHaveValue(CANNED.email);
});

test('flag OFF (formless host): the same PDF is not accepted and the wire carries no documents', async ({ page }) => {
  await page.goto(FORMLESS_URL);
  const { fileInput, contextInput, fillButton, attachments, status } = ui(page);
  await openPanel(page);

  await fileInput.setInputFiles(PDF_FIXTURE);
  // No chip is added, and a friendly (non-error) note explains the PDF isn't
  // accepted on this flag-off host.
  await expect(attachments).toHaveCount(0);
  await expect(status).toContainText(/only images|can't|not accepted/i);
  await expect(status).not.toHaveClass(/ff-error/);

  const bodyPromise = firstFillBody(page);
  await contextInput.fill('Org is Grupo Andino Logística, email operaciones@grupoandino.cl.');
  await fillButton.click();

  const posted = await bodyPromise;
  // A flag-off host never sends documents (empty array or the field absent).
  expect(posted.documents ?? []).toEqual([]);
  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });
});

test('flag ON (plain host): a text file inlines into contextText between the attachment delimiters; documents stays empty', async ({ page }) => {
  await page.goto(PLAIN_URL);
  const { fileInput, contextInput, fillButton, attachments } = ui(page);
  await openPanel(page);

  await fileInput.setInputFiles(TXT_FIXTURE);
  await expect(attachments).toHaveCount(1);
  await expect(attachments.first()).toContainText('sample.txt');

  const bodyPromise = firstFillBody(page);
  await contextInput.fill('Please use the attached details.');
  await fillButton.click();

  const posted = await bodyPromise;
  expect(posted.documents ?? []).toEqual([]); // text rides contextText, not the wire field
  const contextText = posted.contextText as string;
  expect(contextText).toContain('Please use the attached details.');
  expect(contextText).toContain('BEGIN ATTACHED FILE: sample.txt');
  expect(contextText).toContain('jane@doe.dev'); // decoded file content
  expect(contextText).toContain('END ATTACHED FILE: sample.txt');
});
