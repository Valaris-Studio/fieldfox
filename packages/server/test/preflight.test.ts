import { describe, expect, test } from 'vitest';
import { createApp } from '../src/app.js';

// The CORS preflight for POST /api/fill. A preflight carries no body or site
// key, so it cannot be authenticated — the actual POST's guardrails remain the
// enforcement point. Origin is validated there against the site-key allowlist,
// so reflecting the requested headers here adds no exposure (pilot-finding 6:
// host pages that patch fetch to add page-wide headers must clear the preflight).

const ORIGIN = 'https://app.example';

function preflight(
  app: ReturnType<typeof createApp>,
  opts: { origin?: string | null; requestHeaders?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers['origin'] = opts.origin ?? ORIGIN;
  if (opts.requestHeaders != null) headers['access-control-request-headers'] = opts.requestHeaders;
  headers['access-control-request-method'] = 'POST';
  return app.request('/api/fill', { method: 'OPTIONS', headers });
}

describe('CORS preflight for /api/fill', () => {
  test('reflects Access-Control-Request-Headers back in Access-Control-Allow-Headers', async () => {
    const app = createApp();
    const requested = 'content-type, x-fieldfox-key, x-custom-tracing';
    const res = await preflight(app, { requestHeaders: requested });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toBe(requested);
    // Origin still reflected and methods/vary unchanged.
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toBe('POST');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  test('a host-patched extra header (Backplane tracing) is admitted', async () => {
    const app = createApp();
    const res = await preflight(app, {
      requestHeaders: 'content-type, x-fieldfox-key, x-backplane-trace, x-backplane-tenant',
    });
    const allow = res.headers.get('access-control-allow-headers') ?? '';
    expect(allow).toContain('x-backplane-trace');
    expect(allow).toContain('x-backplane-tenant');
  });

  test('preflight WITHOUT Access-Control-Request-Headers keeps the default allowlist', async () => {
    const app = createApp();
    const res = await preflight(app, { requestHeaders: null });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type, x-fieldfox-key');
  });

  test('preflight does not allowlist-check the origin — an arbitrary origin is still reflected', async () => {
    // The preflight carries no site key to scope an origin check; the POST's
    // guardrails enforce the allowlist. This pins that the preflight reflects any
    // present origin verbatim (unchanged pre-card behavior), so header reflection
    // does not accidentally tighten origin gating.
    const app = createApp();
    const arbitrary = 'https://not-on-any-allowlist.example';
    const res = await preflight(app, { origin: arbitrary, requestHeaders: 'content-type, x-custom' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(arbitrary);
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type, x-custom');
  });

  test('preflight WITHOUT an Origin sets no CORS headers (unchanged gating)', async () => {
    const app = createApp();
    const res = await preflight(app, { origin: null, requestHeaders: 'content-type, x-anything' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
    expect(res.headers.get('access-control-allow-headers')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
  });
});
