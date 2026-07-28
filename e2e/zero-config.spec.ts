import { expect, test, type Page } from '@playwright/test';
import { CANNED } from './canned.mjs';

// CLOUD-1 acceptance: the north-star snippet. A fixture carrying NO endpoint and
// NO site key performs a real fill — widget → hosted default → server free lane
// (CLOUD-0, keyless, attributed by Origin) → mock provider.
//
// The widget's hosted default is a real https:// URL that does not exist in
// test. Rather than weaken the default to something local (which would prove
// nothing about the shipped constant), we redirect exactly that URL to the local
// server. The page still runs the true production code path: same absolute
// default, same keyless request, same server pipeline.

const ZERO_CONFIG_URL = 'http://localhost:8080/examples/plain-html/zero-config.html';
const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);

// Mirrors the DEFAULT build's HOSTED_FILL_ENDPOINT (P0-2: the value is injected
// from FIELDFOX_HOSTED_ENDPOINT at build time, so a bundle built with that
// variable set will not match this — e2e builds the default). Hard-coded because
// specs transpile as CJS and cannot import the workspace package; the first
// assertion below fails loudly if the shipped default ever moves.
const HOSTED_FILL_ENDPOINT = 'https://api.fieldfox.dev/api/fill';

// Headers the bare snippet actually put on the wire, captured by the route
// handler so the spec asserts the free-lane shape rather than trusting it.
let sentHeaders: Record<string, string> = {};

test.beforeEach(async ({ page }) => {
  sentHeaders = {};
  // `route.continue({url})` cannot cross protocols (https → http), so the
  // request is proxied here and the response fulfilled verbatim. The page still
  // executes the real code path: the widget resolves and fetches the shipped
  // absolute default, unaware anything intercepted it.
  await page.route(HOSTED_FILL_ENDPOINT, async (route) => {
    const request = route.request();
    sentHeaders = await request.allHeaders();
    const upstream = await fetch(`http://localhost:${SERVER_PORT}/api/fill`, {
      method: request.method(),
      // Forward the page's Origin: the free lane attributes by it, and a request
      // without one is refused (CLOUD-0). This proves Origin attribution works.
      headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' },
      body: request.postData() ?? undefined,
    });
    await route.fulfill({
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
      body: await upstream.text(),
    });
  });
});

const ui = (page: Page) => ({
  trigger: page.locator('field-fox [part="trigger"]'),
  panel: page.locator('field-fox [part="panel"]'),
  contextInput: page.locator('field-fox [part="context-input"]'),
  fillButton: page.locator('field-fox [part="fill-button"]'),
  status: page.locator('field-fox .ff-status'),
});

test('zero-config snippet: no endpoint, no site key, still fills', async ({ page }) => {
  const requestedUrls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/fill')) requestedUrls.push(r.url());
  });

  await page.goto(ZERO_CONFIG_URL);

  const { trigger, panel, contextInput, fillButton, status } = ui(page);
  await expect(trigger).toBeVisible();

  // Never-auto-submit still holds on the hosted path.
  await page.evaluate(() => {
    (window as { __ffSubmits?: number } & Window).__ffSubmits = 0;
    document.querySelector('#newsletter-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      (window as { __ffSubmits?: number } & Window).__ffSubmits!++;
    });
  });

  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(fillButton).toBeInViewport();
  await contextInput.fill(`I am Jane Doe, jane@doe.dev, at Andes Cloud.`);
  await fillButton.click();

  await expect(status).toContainText('Review, then submit', { timeout: 15_000 });

  // The fill landed, from a page that configured nothing.
  await expect(page.locator('#full-name')).toHaveValue(CANNED.fullName);
  await expect(page.locator('#email')).toHaveValue(CANNED.email);

  // The widget targeted the HOSTED default, not the page's own origin.
  expect(requestedUrls.some((u) => u.startsWith(HOSTED_FILL_ENDPOINT))).toBe(true);
  expect(requestedUrls.some((u) => u.startsWith('http://localhost:8080/api/fill'))).toBe(false);

  // …and it went out as a free-lane request: no site key for the customer to
  // obtain. If a key header ever appeared here the server would take the paid
  // lane and 401 an anonymous visitor.
  expect(Object.keys(sentHeaders).length).toBeGreaterThan(0);
  expect(Object.keys(sentHeaders).map((h) => h.toLowerCase())).not.toContain('x-fieldfox-key');

  expect(await page.evaluate(() => (window as { __ffSubmits?: number } & Window).__ffSubmits)).toBe(0);
});
