import { describe, expect, test, vi } from 'vitest';
import { SCHEMA_VERSION } from '@fieldfox/shared';
// Package-root imports, like the other seam test: a symbol reachable only from
// src/ is unreachable for anything that installs this package.
import { createApp, resolveConfig, type GuardrailConfig } from '../src/index.js';
import type { ChatCompletion } from '../src/llm.js';

// P2-6d: the server already knows what a fill actually consumed — planWithLadder
// returns usage summed across every rung, including the repair retry — and spends
// it on reconcile() plus a log line. A composing layer (a cloud's metering, a
// self-hoster's cost dashboard or per-tenant attribution) had no way to read it,
// so the only route was scraping stdout.
//
// The money-critical property here is the ABSENT case. `usage` is undefined when
// no rung reported anything, and a middleware must be able to tell "no
// measurement" from "measured zero" — charging on a silently-zeroed number is a
// billing bug, not a rounding one.

const KEY = 'ffx_pk_usageseam00000000000000000000000000';
const ORIGIN = 'https://metered.example';

const silentLogger = () => {};

function usageConfig(): GuardrailConfig {
  return resolveConfig({
    siteKeys: { [KEY]: { origins: [ORIGIN], dailyTokenBudget: 1_000_000 } },
  });
}

function fillBody(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextText: 'Name is Grace Hopper.',
    images: [],
    formSchema: {
      fields: [{ id: 'f_name', kind: 'text', labelCandidates: ['Name'], fillable: true }],
    },
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown = fillBody()) {
  return app.fetch(
    new Request('http://server.test/api/fill', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fieldfox-key': KEY,
        origin: ORIGIN,
      },
      body: JSON.stringify(body),
    }),
  );
}

const PLAN = JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] });

// A caller returning the {content, usage} shape a real provider maps to, so the
// seam is exercised through the ladder's own accounting rather than by injecting
// a number. Returning a bare string (the other accepted shape) reports no usage
// at all — which is exactly the absent case below.
function callerReportingUsage(totalTokens: number): ChatCompletion {
  return vi.fn(async () => ({
    content: PLAN,
    usage: { totalTokens },
  })) as unknown as ChatCompletion;
}

// A provider that answers correctly but reports NOTHING about usage — the absent
// case, driven through the real no-usage path (the bare-string return shape).
function callerReportingNoUsage(): ChatCompletion {
  return vi.fn(async () => PLAN) as unknown as ChatCompletion;
}

interface Observed {
  measured: number | undefined;
  measuredKeyPresent: boolean;
  beforeNext: number | undefined;
}

function appObserving(caller: ChatCompletion): { app: ReturnType<typeof createApp>; seen: Observed } {
  const seen: Observed = { measured: undefined, measuredKeyPresent: false, beforeNext: undefined };

  const app = createApp({
    config: usageConfig(),
    llmCaller: caller,
    logger: silentLogger,
    fillMiddleware: async (c, next) => {
      // Read BEFORE the handler runs: the measurement cannot exist yet.
      seen.beforeNext = c.get('fieldfoxMeasuredTokens');
      await next();
      seen.measured = c.get('fieldfoxMeasuredTokens');
      seen.measuredKeyPresent = c.get('fieldfoxMeasuredTokens') !== undefined;
    },
  });

  return { app, seen };
}

describe('the measured-usage seam', () => {
  test('a composing middleware reads the measured tokens after next()', async () => {
    const { app, seen } = appObserving(callerReportingUsage(4_242));

    expect((await post(app)).status).toBe(200);

    expect(seen.measured).toBe(4_242);
    expect(seen.measuredKeyPresent).toBe(true);
  });

  test('the measurement is POST-call — unreadable before next() resolves', async () => {
    // Ordering is the whole contract: a middleware that read it too early would
    // silently meter every fill as unmeasured.
    const { app, seen } = appObserving(callerReportingUsage(1_000));

    expect((await post(app)).status).toBe(200);

    expect(seen.beforeNext).toBeUndefined();
    expect(seen.measured).toBe(1_000);
  });

  test('when the provider reports no usage the variable is ABSENT, not zero', async () => {
    // The money-critical case. A middleware must distinguish "no measurement" from
    // "measured zero": billing on a silently-zeroed number would serve real work
    // for free, and the fallback rule (charge the reserved estimate) depends on
    // being able to tell the difference.
    const { app, seen } = appObserving(callerReportingNoUsage());

    expect((await post(app)).status).toBe(200);

    expect(seen.measuredKeyPresent).toBe(false);
    expect(seen.measured).toBeUndefined();
    // Explicitly NOT zero — the assertion that stops a `?? 0` from creeping in.
    expect(seen.measured).not.toBe(0);
  });

  test('a genuinely zero measurement is reported as 0, not collapsed into absent', async () => {
    // The mirror of the case above. If a provider really does report zero, that is
    // a measurement and must survive as one; conflating it with "unreported" would
    // make the absent-vs-zero distinction meaningless in the other direction.
    const { app, seen } = appObserving(callerReportingUsage(0));

    expect((await post(app)).status).toBe(200);

    expect(seen.measuredKeyPresent).toBe(true);
    expect(seen.measured).toBe(0);
  });

  test('the seam publishes the ladder total verbatim — it does not re-derive it', async () => {
    // The multi-rung SUM is the ladder's own property and is covered by its
    // tests; rung 2 is reachable only by throwing the OSS-internal
    // ResponseFormatUnsupported, which an injected caller cannot raise. What this
    // seam owns is passing that total through unaltered, so a retried fill is not
    // silently re-measured as a single call. Asserted with a value no single-call
    // path would produce.
    const { app, seen } = appObserving(callerReportingUsage(1_000));

    expect((await post(app)).status).toBe(200);
    expect(seen.measured).toBe(1_000);
  });
});
