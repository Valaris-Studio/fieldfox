import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

// Found in production 2026-07-31: `FIELDFOX_FREE_DAILY_ALLOWANCE=50` was SET on
// the deployed service and silently ignored, because parseFreeTierEnv() never
// read it. The service accepted the variable, booted clean, and enforced nothing.
//
// Two consequences, and the second is the product one:
//   1. no per-origin fill cap (the token budget still bounded spend)
//   2. `free_allowance_exhausted` is the ONLY route to the widget's "create an
//      account" offer, so with no allowance no anonymous visitor ever saw it —
//      the entire conversion funnel was dark.
//
// These tests pin the ENV PATH specifically. The policy fields and the guardrail
// that reads them were always correct; only the wiring from environment to
// config was missing, which is exactly the kind of gap a unit test of the
// guardrail cannot see.

const FREE_ENV = [
  'FIELDFOX_FREE_MODEL',
  'FIELDFOX_FREE_RATE_LIMIT',
  'FIELDFOX_FREE_RATE_WINDOW_MS',
  'FIELDFOX_FREE_DAILY_TOKEN_BUDGET',
  'FIELDFOX_FREE_DAILY_ALLOWANCE',
  'FIELDFOX_FREE_SIGNUP_URL',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of FREE_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // The minimum that enables the lane at all.
  process.env.FIELDFOX_FREE_MODEL = 'cheap-model-v1';
  process.env.FIELDFOX_FREE_RATE_LIMIT = '60';
  process.env.FIELDFOX_FREE_RATE_WINDOW_MS = '60000';
  process.env.FIELDFOX_FREE_DAILY_TOKEN_BUDGET = '2000000';
});

afterEach(() => {
  for (const key of FREE_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('the free lane reads its full policy from the environment', () => {
  test('FIELDFOX_FREE_DAILY_ALLOWANCE reaches dailyFillAllowance — the production regression', () => {
    // This is the exact variable production had set to 50 while enforcing nothing.
    process.env.FIELDFOX_FREE_DAILY_ALLOWANCE = '2';

    expect(loadConfig().freeTier?.dailyFillAllowance).toBe(2);
  });

  test('FIELDFOX_FREE_SIGNUP_URL reaches signupUrl, so the widget can offer a way forward', () => {
    process.env.FIELDFOX_FREE_SIGNUP_URL = 'https://fieldfox.example/signup';

    expect(loadConfig().freeTier?.signupUrl).toBe('https://fieldfox.example/signup');
  });

  test('both are OPTIONAL — a self-hoster with neither still boots', () => {
    // Self-hosting must not regress: no allowance and no signup link is a valid,
    // supported deployment (the definition ranks self-hosting first-class).
    const free = loadConfig().freeTier;

    expect(free?.model).toBe('cheap-model-v1');
    expect(free?.dailyFillAllowance).toBeUndefined();
    expect(free?.signupUrl).toBeUndefined();
  });

  test('a malformed allowance fails at BOOT, not silently at request time', () => {
    // The bug being fixed is "accepted then ignored". Refusing to start is the
    // only honest answer to a value we cannot honour — reintroducing a silent
    // fallback here would recreate the exact defect.
    process.env.FIELDFOX_FREE_DAILY_ALLOWANCE = 'lots';

    expect(() => loadConfig()).toThrow();
  });

  test('a zero or negative allowance is refused rather than treated as unlimited', () => {
    // "0 free fills" and "no limit configured" are opposite intentions, and
    // coercing one into the other is how a cap silently disappears.
    for (const bad of ['0', '-5']) {
      process.env.FIELDFOX_FREE_DAILY_ALLOWANCE = bad;
      expect(() => loadConfig(), `allowance ${bad}`).toThrow();
    }
  });

  test('a non-http signup url is refused — the widget renders it as a link', () => {
    // signupUrl becomes an href in the widget. A javascript: or data: value
    // reaching that attribute is the reason this is validated at boot as well as
    // sanitised at render.
    process.env.FIELDFOX_FREE_SIGNUP_URL = 'javascript:alert(1)';

    expect(() => loadConfig()).toThrow();
  });
});
