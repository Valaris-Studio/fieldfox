import { expect, test, type Page } from '@playwright/test';
import { CANNED } from './canned.mjs';

// The COVERAGE harness (card b260cfd6). One realistic react-hook-form +
// design-system form, measured field by field, with ONE gate that outranks the
// coverage number itself: zero wrong-value fills.
//
// A low fill rate is roadmap input. A single silent wrong commit is a safety bug
// — and this project has shipped exactly that before (the "Gold"/"Gold Plus"
// containment bug, found 2026-07-26 by adversarial probe against a green suite).
// So every expectation below is written as "this exact value or nothing", never
// "something got filled".

const COVERAGE_URL = 'http://localhost:5173/coverage';
const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

test.beforeEach(async ({ page }) => {
  if (SERVER_PORT === 8787) return;
  await page.addInitScript((port) => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
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
  fillButton: page.locator('field-fox [part="fill-button"]'),
  status: page.locator('field-fox .ff-status'),
});

async function runFill(page: Page, contextText: string): Promise<void> {
  const { trigger, panel, contextInput, fillButton, status } = ui(page);
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(fillButton).toBeInViewport();
  await contextInput.fill(contextText);
  await fillButton.click();
  await expect(status).toContainText('Review, then submit', { timeout: 20_000 });
}

// The context the "model" is given. Every value here is deliberately consistent
// with what the mock plans, so a MISMATCH in an assertion means the widget wrote
// something the plan never asked for — the wrong-value case.
const CONTEXT = [
  'I am Jane Doe, jane@doe.dev.',
  'We need 42 seats starting 08/15/2026 in Frankfurt.',
  'Turn the backups pager on.',
].join(' ');

test('coverage: every field is filled correctly or left — never wrongly', async ({ page }) => {
  await page.goto(COVERAGE_URL);

  // Baseline: the custom control starts at "unset" and must stay there.
  await expect(page.locator('#coverage-custom-state')).toHaveText(
    JSON.stringify({ priority: 'unset' }),
  );

  await runFill(page, CONTEXT);

  // --- register()'d natives: filled, exact values -----------------------------
  await expect(page.locator('#cov-name')).toHaveValue(CANNED.fullName);
  await expect(page.locator('#cov-email')).toHaveValue(CANNED.email);
  await expect(page.locator('#cov-seats')).toHaveValue(CANNED.number);
  // The model emits US-formatted; the server normalizes to ISO before the widget
  // writes it. Asserting the ISO value proves that normalization end to end.
  await expect(page.locator('#cov-start')).toHaveValue(CANNED.date);
  // The mock routes a "Description"-labelled textarea to its rich-text body
  // (it is the same wire kind), so that is the value to expect here.
  await expect(page.locator('#cov-description')).toHaveValue(CANNED.editorBody);

  // --- Controller-wrapped design-system widgets ------------------------------
  // Filled through the ARIA contract; the trigger's accessible text is what the
  // user sees. The region control is the positive combobox case on this form.
  await expect(page.locator('#cov-environment')).toHaveText(CANNED.comboboxByLabel.region);
  await expect(page.locator('#cov-pager')).toHaveAttribute('data-state', 'checked');

  // The support-tier control (name="plan") is the leave probe: the mock has no
  // canned value for that name, so it plans an unmatchable one. Untouched.
  await expect(page.locator('#cov-tier')).toContainText('Select a tier');

  // --- the negative case: unsupported control, provably untouched ------------
  await expect(page.locator('#coverage-custom-state')).toHaveText(
    JSON.stringify({ priority: 'unset' }),
  );

  // --- THE GATE: values reached react-hook-form's MODEL, not just the DOM -----
  // This is the assertion that catches the failure mode this fixture exists for.
  // A driver that mutates the DOM without dispatching the events RHF listens for
  // produces a form that LOOKS filled and submits empty.
  await page.locator('#coverage-form button[type="submit"]').click();
  const submitted = page.locator('#coverage-submitted');
  await expect(submitted).toBeVisible();
  const model = JSON.parse((await submitted.textContent()) ?? '{}') as Record<string, unknown>;

  expect(model.requesterName).toBe(CANNED.fullName);
  expect(model.workEmail).toBe(CANNED.email);
  expect(model.seatCount).toBe(CANNED.number);
  expect(model.startDate).toBe(CANNED.date);
  expect(model.description).toBe(CANNED.editorBody);
  expect(model.pagerDuty).toBe(true);
  // The Controller-wrapped Select stores the option VALUE, not its label.
  expect(model.environment).toBe('eu-central-1');
  // The unmatchable one committed NOTHING — not the nearest-looking option.
  expect(model.supportTier).toBe('');
});

test("coverage: a design system's hidden mirror control is never introspected as fillable", async ({
  page,
}) => {
  // The bug this harness found. Radix Select parks a hidden native <select>
  // beside its ARIA trigger to carry form state (radix-ui#3521). It is
  // aria-hidden + tabindex=-1 + 1x1px, yet display:block / visibility:visible —
  // so a CSS-only visibility check called it fillable. ONE logical field was
  // introspected TWICE and filled twice, and the mirror's write won: the plan
  // said "Gold" and the form ended up showing "Bronze".
  //
  // Asserting on the POSTed schema rather than the rendered result, because the
  // defect is in what the widget offers the model, and a schema that never
  // contains the mirror cannot produce that contradiction at all.
  const schemas: Array<{ fields: Array<Record<string, unknown>> }> = [];
  page.on('request', (r) => {
    if (!r.url().includes('/api/fill')) return;
    try {
      schemas.push(JSON.parse(r.postData() ?? '{}').formSchema);
    } catch {
      /* a non-JSON body is not a schema; the assertions below fail loudly */
    }
  });

  await page.goto(COVERAGE_URL);
  await runFill(page, CONTEXT);

  expect(schemas).toHaveLength(1);
  const fields = schemas[0].fields;

  // Radix renders one mirror per Select; both must be present-but-not-fillable
  // (kept in the schema for model context, exactly like a password field).
  const mirrors = fields.filter((f) => f.kind === 'select');
  expect(mirrors.length).toBeGreaterThan(0);
  for (const mirror of mirrors) {
    expect(mirror.fillable).toBe(false);
  }

  // …while the ARIA triggers the user actually sees stay fillable.
  const comboboxes = fields.filter((f) => f.kind === 'combobox');
  expect(comboboxes.length).toBe(2);
  for (const combobox of comboboxes) {
    expect(combobox.fillable).toBe(true);
  }
});
