import type { FillPlan, FillRequest } from '@fieldfox/shared';

// Card C4 — the network call to the fieldfox server's /api/fill (PLAN §1). The
// widget imports the FillPlan TYPE only and never runs zod: the server already
// re-validated the plan (PLAN §0 degradation ladder). We still defensively guard
// the coarse shape so a malformed body surfaces as a typed error the caller turns
// into showError(), rather than crashing mid-fill.

export interface RequestFillOptions {
  // Public site key (`ffx_pk_…`) sent as x-fieldfox-key; omitted when unconfigured
  // (self-hosted single-tenant servers may not require one). RESEARCH §6.
  siteKey?: string;
  signal?: AbortSignal;
}

// One typed error for every failure mode (non-200, malformed body, network drop,
// abort) so the caller has a single catch that maps to the panel's error state.
export class FillRequestError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FillRequestError';
    this.status = status;
  }
}

export async function requestFill(
  endpoint: string,
  request: FillRequest,
  opts: RequestFillOptions = {},
): Promise<FillPlan> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.siteKey) headers['x-fieldfox-key'] = opts.siteKey;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: opts.signal,
    });
  } catch (cause) {
    // Network failure or an abort — fetch rejects for both.
    throw new FillRequestError('Could not reach the fill server.', undefined, { cause });
  }

  if (!response.ok) {
    throw new FillRequestError(
      `Fill request failed (${response.status}).`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new FillRequestError('The server returned an unreadable response.', response.status, {
      cause,
    });
  }

  if (!isFillPlanShape(body)) {
    throw new FillRequestError('The server returned an unexpected fill plan.', response.status);
  }
  return body;
}

// Coarse structural guard — NOT full validation (that is the server's zod job).
// Enough to reject an error page or a truncated body before we start mutating the
// live form.
function isFillPlanShape(body: unknown): body is FillPlan {
  if (typeof body !== 'object' || body === null) return false;
  const fills = (body as { fills?: unknown }).fills;
  if (!Array.isArray(fills)) return false;
  return fills.every(
    (f) =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as { fieldId?: unknown }).fieldId === 'string' &&
      typeof (f as { action?: unknown }).action === 'string',
  );
}
