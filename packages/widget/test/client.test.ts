import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillRequest } from '@fieldfox/shared';
import { requestFill, FillRequestError } from '../src/client.js';

// The widget imports the FillPlan TYPE only; it never runs zod. requestFill
// trusts the server (which already re-validated) but defensively guards the
// coarse shape so a malformed body surfaces as a typed error, not a crash mid-fill.

function makeRequest(): FillRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    formSchema: { fields: [] },
    contextText: 'hi',
    images: [],
  };
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('200 → parses the body into a FillPlan', async () => {
  const planBody = { fills: [{ fieldId: 'ff-0', action: 'set', value: 'Ada' }] };
  fetchSpy.mockResolvedValue(jsonResponse(planBody));

  const plan = await requestFill('/api/fill', makeRequest());

  expect(plan.fills).toHaveLength(1);
  expect(plan.fills[0].fieldId).toBe('ff-0');
});

test('POSTs JSON to the endpoint with the correct content-type', async () => {
  fetchSpy.mockResolvedValue(jsonResponse({ fills: [] }));

  await requestFill('https://api.example.com/api/fill', makeRequest());

  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe('https://api.example.com/api/fill');
  expect(init.method).toBe('POST');
  expect(init.headers['content-type']).toMatch(/application\/json/);
  const sent = JSON.parse(init.body);
  expect(sent.schemaVersion).toBe(SCHEMA_VERSION);
});

test('sends the site-key header only when a key is configured', async () => {
  fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ fills: [] })));

  await requestFill('/api/fill', makeRequest(), { siteKey: 'ffx_pk_abc123' });
  expect(fetchSpy.mock.calls[0][1].headers['x-fieldfox-key']).toBe('ffx_pk_abc123');

  fetchSpy.mockClear();
  await requestFill('/api/fill', makeRequest());
  expect(fetchSpy.mock.calls[0][1].headers['x-fieldfox-key']).toBeUndefined();
});

test('non-200 → throws a typed FillRequestError carrying the status', async () => {
  // Fresh Response per call — a Response body can only be read once.
  fetchSpy.mockImplementation(() =>
    Promise.resolve(jsonResponse({ error: 'bad origin' }, { status: 403 })),
  );

  await expect(requestFill('/api/fill', makeRequest())).rejects.toBeInstanceOf(
    FillRequestError,
  );
  await expect(requestFill('/api/fill', makeRequest())).rejects.toMatchObject({
    status: 403,
  });
});

test('a body that is not a FillPlan shape → typed error, never a silent bad plan', async () => {
  fetchSpy.mockResolvedValue(jsonResponse({ nope: true }));
  await expect(requestFill('/api/fill', makeRequest())).rejects.toBeInstanceOf(
    FillRequestError,
  );
});

test('forwards the AbortSignal so the caller can cancel', async () => {
  fetchSpy.mockResolvedValue(jsonResponse({ fills: [] }));
  const controller = new AbortController();

  await requestFill('/api/fill', makeRequest(), { signal: controller.signal });
  expect(fetchSpy.mock.calls[0][1].signal).toBe(controller.signal);
});

test('a network rejection propagates as a FillRequestError', async () => {
  fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(requestFill('/api/fill', makeRequest())).rejects.toBeInstanceOf(
    FillRequestError,
  );
});
