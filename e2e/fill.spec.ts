import { expect, test, type Page } from '@playwright/test';
import { CANNED, FORCE_ERROR, SKIP_AND_OMIT } from './canned.mjs';

// INT-fill-flow: the north-star fill flow end to end on BOTH example hosts,
// widget → REAL fieldfox server (guardrails, two-lane prompt, degradation
// ladder, zod re-validation, cleanPlan) → mock OpenAI-compatible provider.
// The example forms' selectors are the contract — fixtures are never modified.

const PLAIN_URL = 'http://localhost:8080/examples/plain-html/';
const FORMLESS_URL = 'http://localhost:8080/examples/plain-html/formless.html';
const REACT_URL = 'http://localhost:5173/';
const MOCK_URL = 'http://127.0.0.1:8793/__mock/requests';

// Both fixtures hardcode endpoint http://localhost:8787/api/fill, but 8787 is
// occupied by an unrelated service on this machine, so the stack runs the real
// server on 8794 (scripts/e2e-env.mjs). This init script remaps ONLY the port
// of that one endpoint before any page script runs — the request still leaves
// the browser with a real Origin, real preflight, and traverses the full
// server pipeline. With FIELDFOX_E2E_SERVER_PORT=8787 it becomes a no-op.
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

// Widget UI lives in the field-fox open shadow root; Playwright CSS pierces it.
const ui = (page: Page) => ({
  trigger: page.locator('field-fox [part="trigger"]'),
  panel: page.locator('field-fox [part="panel"]'),
  contextInput: page.locator('field-fox [part="context-input"]'),
  fillButton: page.locator('field-fox [part="fill-button"]'),
  status: page.locator('field-fox .ff-status'),
});

async function openPanelAndFill(page: Page, contextText: string): Promise<void> {
  const { trigger, panel, contextInput, fillButton } = ui(page);
  await trigger.click();
  await expect(panel).toBeVisible();
  // The user must be able to reach the panel's controls. KNOWN WIDGET BUG
  // (popover.ts): the Popover-API path never positions the panel
  // (.ff-panel[popover] { inset: unset } → static position). WebKit renders it
  // at the <field-fox> element's flow position — below the fold on a tall page
  // and, being position:fixed, unreachable by scrolling. Chromium happens to
  // resolve it to (0,0). This gate fails fast on WebKit instead of timing out.
  await expect(fillButton).toBeInViewport();
  await contextInput.fill(contextText);
  await fillButton.click();
}

const nonce = () => `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

type MockRequest = { at: string; model: string; responseFormat: string; prompt: string };
async function mockRequestsContaining(marker: string): Promise<MockRequest[]> {
  const res = await fetch(MOCK_URL);
  const { requests } = (await res.json()) as { requests: MockRequest[] };
  return requests.filter((r) => r.prompt.includes(marker));
}

test('plain-html host: trigger → popover → fill; shimmer in flight; decoy ignored; never auto-submits', async ({ page }) => {
  const marker = nonce();
  await page.goto(PLAIN_URL);

  // Trigger is visible, anchored at the form's top-right corner.
  const { trigger, status } = ui(page);
  await expect(trigger).toBeVisible();
  const formBox = (await page.locator('#signup-form').boundingBox())!;
  const trigBox = (await trigger.boundingBox())!;
  expect(Math.abs(trigBox.x + trigBox.width - (formBox.x + formBox.width))).toBeLessThan(40);
  expect(Math.abs(trigBox.y - formBox.y)).toBeLessThan(40);

  // Submit spy — never-auto-submit is a PLAN §0 locked row. preventDefault keeps
  // the page (and the flag) alive if the invariant were ever violated.
  await page.evaluate(() => {
    (window as { __ffSubmits?: number } & Window).__ffSubmits = 0;
    document.querySelector('#signup-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      (window as { __ffSubmits?: number } & Window).__ffSubmits!++;
    });
  });

  await openPanelAndFill(page, `I am Jane Doe (jane@doe.dev), medium shirt, afternoon session. ${marker}`);

  // In flight (the mock holds the response ~800ms): planned fields are disabled
  // under the shimmer; the data-ff-ignore decoy is never part of the request,
  // so it is never disabled.
  await expect(page.locator('#full-name')).toBeDisabled();
  await expect(page.locator('#full-name')).toHaveClass(/ff-fill-shimmer/);
  await expect(page.locator('#promo-code')).toBeEnabled();

  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });

  // Applied per the canned plan…
  await expect(page.locator('#full-name')).toHaveValue(CANNED.fullName);
  await expect(page.locator('#email')).toHaveValue(CANNED.email);
  await expect(page.locator('#phone')).toHaveValue(CANNED.tel);
  await expect(page.locator('#event-date')).toHaveValue(CANNED.date);
  await expect(page.locator('#tshirt-size')).toHaveValue('m');
  await expect(page.locator('#session-afternoon')).toBeChecked();
  await expect(page.locator('#interest-woodworking')).toBeChecked();
  // …skipped fills keep their prior state…
  await expect(page.locator('#interest-ceramics')).not.toBeChecked();
  await expect(page.locator('#interest-welding')).not.toBeChecked();
  // …and the decoy stays empty (stripped client-side by data-ff-ignore).
  await expect(page.locator('#promo-code')).toHaveValue('');

  // Fields re-enabled after completion.
  await expect(page.locator('#full-name')).toBeEnabled();
  await expect(page.locator('#full-name')).not.toHaveClass(/ff-fill-shimmer/);

  // The form was never submitted: no submit event, no GET-navigation.
  expect(await page.evaluate(() => (window as { __ffSubmits?: number } & Window).__ffSubmits)).toBe(0);
  expect(new URL(page.url()).search).toBe('');

  // Provider-side proof: the prompt described the form but never saw the
  // ignored promo field.
  const seen = await mockRequestsContaining(marker);
  expect(seen).toHaveLength(1);
  expect(seen[0].prompt).toContain('Full name');
  expect(seen[0].prompt).not.toMatch(/promo/i);

  // Asserted LAST so everything above is proven first. KNOWN WIDGET BUG
  // (introspect.ts isVisible): a field merely BELOW THE FOLD at introspection
  // time (rect.top >= innerHeight) is classified off-screen → fillable:false →
  // never planned. #notes sits at ~855px in a 720px viewport, so this fails
  // until the visibility heuristic distinguishes "scrolled below the fold"
  // from "hidden off-screen trap".
  await expect(page.locator('#notes')).toHaveValue(CANNED.textarea);
});

test('react-host: filled values are registered in react-hook-form state (React 19 framework matrix)', async ({ page }) => {
  // Surface uncaught page errors as the failure message. KNOWN WIDGET BUG
  // (element.ts): the class exposes a getter-only `endpoint` accessor, so
  // React 19's custom-element heuristic (`'endpoint' in el`) assigns the
  // PROPERTY instead of the attribute → "Cannot set property endpoint … which
  // has only a getter" → React unmounts the entire tree and the widget never
  // mounts on a React 19 host.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(REACT_URL);
  // Settles fast either way: the widget's trigger mounts, or React crashed.
  await expect
    .poll(
      async () => pageErrors.length > 0 || (await ui(page).trigger.count()) > 0,
      { timeout: 15_000 },
    )
    .toBe(true);
  expect(pageErrors, 'the React 19 host must mount <field-fox> without throwing').toEqual([]);

  await openPanelAndFill(page, 'Jane Doe, jane@doe.dev, engineer, starts 2026-08-15, remote.');

  await expect(page.locator('#name')).toBeDisabled(); // in-flight on the React host too
  await expect(ui(page).status).toContainText('Review, then submit', { timeout: 15_000 });

  // DOM-level result…
  await expect(page.locator('#name')).toHaveValue(CANNED.fullName);
  await expect(page.locator('#email')).toHaveValue(CANNED.email);
  await expect(page.locator('#role')).toHaveValue('engineer');
  await expect(page.locator('#start-date')).toHaveValue(CANNED.date);
  await expect(page.locator('#remote')).toBeChecked();
  await expect(page.locator('#bio')).toHaveValue(CANNED.textarea);

  // …but the load-bearing proof is RHF STATE, not the DOM: submitting through
  // the form's own button echoes handleSubmit's data. If the native-setter +
  // dispatched-event writes hadn't registered with react-hook-form (RESEARCH
  // §2 value-tracker bypass), this JSON would still hold the defaultValues.
  await page.locator('#profile-form button[type="submit"]').click();
  const submitted = page.locator('#submitted-json');
  await expect(submitted).toBeVisible();
  expect(JSON.parse((await submitted.textContent())!)).toEqual({
    name: CANNED.fullName,
    email: CANNED.email,
    role: 'engineer',
    startDate: CANNED.date,
    remote: true,
    bio: CANNED.textarea,
  });

  // RHF validation (required name, email pattern) passed on the filled values —
  // handleSubmit would have rendered these errors instead of submitting.
  await expect(page.locator('#name-error')).toHaveCount(0);
  await expect(page.locator('#email-error')).toHaveCount(0);
});

test('error path: ladder exhausts → 502 → popover error, fields restored and re-enabled', async ({ page }) => {
  const marker = nonce();
  await page.goto(PLAIN_URL);

  // Pre-fill one field so "restored to original" is observable, not vacuous.
  await page.locator('#full-name').fill('Original Owner');

  await openPanelAndFill(page, `${FORCE_ERROR} ${marker}`);
  await expect(page.locator('#email')).toBeDisabled(); // request in flight

  const { status, fillButton } = ui(page);
  await expect(status).toHaveText('Could not fill the form. Please try again.', { timeout: 20_000 });
  await expect(status).toHaveClass(/ff-error/);

  // Nothing was written, everything re-enabled, panel usable again.
  await expect(page.locator('#full-name')).toHaveValue('Original Owner');
  await expect(page.locator('#email')).toHaveValue('');
  await expect(page.locator('#email')).toBeEnabled();
  await expect(page.locator('#full-name')).not.toHaveClass(/ff-fill-shimmer/);
  await expect(fillButton).toBeEnabled();

  // The server really walked the ladder: strict rung rejected, then the
  // json_object attempt plus exactly one repair retry (both malformed) → 502.
  const seen = await mockRequestsContaining(marker);
  expect(seen.map((r) => r.responseFormat)).toEqual(['json_schema', 'json_object', 'json_object']);
});

test('leave semantics: explicit skip and plan omission both keep prior values', async ({ page }) => {
  await page.goto(PLAIN_URL);

  // Prior values the plan must not touch: notes gets an explicit `skip`,
  // phone is omitted from the plan entirely.
  await page.locator('#notes').fill('Keep my note');
  await page.locator('#phone').fill('+1 000 111 2222');
  // Pre-filling scrolled the page down; the trigger is pinned (position:fixed)
  // to the form's TOP-right corner, so scroll back to where a user would see it.
  await page.evaluate(() => window.scrollTo(0, 0));

  await openPanelAndFill(page, `${SKIP_AND_OMIT} fill only name and email`);
  await expect(ui(page).status).toContainText('Filled 2 fields', { timeout: 15_000 });

  await expect(page.locator('#full-name')).toHaveValue(CANNED.fullName);
  await expect(page.locator('#email')).toHaveValue(CANNED.email);
  await expect(page.locator('#notes')).toHaveValue('Keep my note'); // explicit skip
  await expect(page.locator('#phone')).toHaveValue('+1 000 111 2222'); // omission
  await expect(page.locator('#tshirt-size')).toHaveValue('');
  await expect(page.locator('#interest-woodworking')).not.toBeChecked();
});

test('form-level embedder inputs: context / form-id attributes ride the POSTed FillRequest', async ({ page }) => {
  // G2 owns the WIDGET's outbound request. `formContext` / `formId` do not reach
  // the mock provider's /__mock/requests yet — the server only routes them into
  // the trusted prompt lane in G3 — so the load-bearing proof is the raw
  // widget → server POST body, captured here at the network layer. The port may
  // be remapped by the beforeEach fetch shim, so match on the /api/fill suffix.
  const fillBody = new Promise<Record<string, unknown>>((resolve) => {
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/fill')) {
        resolve(JSON.parse(req.postData() ?? '{}'));
      }
    });
  });

  await page.goto(PLAIN_URL);
  await openPanelAndFill(page, 'Jane Doe, jane@doe.dev, medium shirt, afternoon.');

  const body = await fillBody;
  expect(body.formContext).toBe(
    'Trailhead Makers workshop signup — beginners welcome, all sessions ADA accessible',
  );
  expect(body.formId).toBe('trailhead-workshop-signup');

  // The whole flow still completes on top of the new fields.
  await expect(ui(page).status).toContainText('Review, then submit', { timeout: 15_000 });
});

test('form-less container: introspects + fills, trigger anchors to the container (pilot finding 1)', async ({ page }) => {
  // Vario /signup regression: a shadcn card with inputs but NO <form>. Before
  // the fix the trigger anchored to the empty widget host (x=-22,y=994) and fill
  // reported "No fields to fill." Now the resolved container is the root+anchor.
  await page.goto(FORMLESS_URL);

  const { trigger, status } = ui(page);
  await expect(trigger).toBeVisible();

  // Anchored at the CONTAINER's top-right corner, not the host's flow position.
  const cardBox = (await page.locator('#signup-card').boundingBox())!;
  const trigBox = (await trigger.boundingBox())!;
  expect(Math.abs(trigBox.x + trigBox.width - (cardBox.x + cardBox.width))).toBeLessThan(40);
  expect(Math.abs(trigBox.y - cardBox.y)).toBeLessThan(40);

  await openPanelAndFill(page, 'Org is Grupo Andino Logística, email operaciones@grupoandino.cl.');

  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });
  // The container's fields were introspected and filled — no "No fields to fill."
  await expect(page.locator('#work-email')).toHaveValue(CANNED.email);
  await expect(status).not.toContainText('No fields to fill');
});
