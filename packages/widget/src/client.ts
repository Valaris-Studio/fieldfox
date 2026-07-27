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
// `errorCode` carries the server's machine-readable `error` field (e.g.
// 'no_fillable_fields', 'schema_version_unsupported') so the caller can pick
// specific friendly copy for known refusals instead of the generic surface.
export class FillRequestError extends Error {
  readonly status?: number;
  readonly errorCode?: string;
  // The refusal body's remaining fields, verbatim and untrusted. Some refusals
  // carry data the panel renders (the free tier's `signupUrl` / `allowance`);
  // callers must validate before use — this is network input, not a contract.
  readonly details?: Record<string, unknown>;
  constructor(
    message: string,
    status?: number,
    options?: { cause?: unknown; errorCode?: string; details?: Record<string, unknown> },
  ) {
    super(message, options);
    this.name = 'FillRequestError';
    this.status = status;
    this.errorCode = options?.errorCode;
    this.details = options?.details;
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
    // Structured refuses (426 version skew, 422 no_fillable_fields, 5xx
    // fill_failed) all carry a machine-readable `error` code; surface it so the
    // caller can map known codes to specific copy. Body may not be JSON — the
    // status alone still drives the generic error path.
    const refusal = await refusalBodyOf(response);
    throw new FillRequestError(`Fill request failed (${response.status}).`, response.status, {
      errorCode: typeof refusal?.error === 'string' ? refusal.error : undefined,
      details: refusal,
    });
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

// Best-effort read of a non-200 JSON refusal body. Never throws: a non-JSON
// error page (proxy 502, HTML) just yields undefined and the caller falls back
// to the status-driven generic message. The body is read ONCE here — the stream
// cannot be consumed twice.
async function refusalBodyOf(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await response.json()) as unknown;
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
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
