// Shared contract between the mock provider and the specs: the deterministic
// values the mock plans for the example-host fixtures, plus the magic context
// strings that switch the mock into its error / leave-semantics modes. Keeping
// them in one module means an assertion and the mock can never drift apart.

export const CANNED = {
  fullName: 'Jane Doe',
  email: 'jane@doe.dev',
  tel: '+1 415 555 0123',
  date: '2026-08-15',
  textarea: 'Filled by the fieldfox e2e mock provider.',
  number: '42',
  // Keyed by the introspected field `name`; fallback is the first non-empty option.
  selectByName: { 'tshirt-size': 'm', role: 'engineer' },
  radioByName: { session: 'afternoon' },
  // Checkboxes whose label matches get `set true`; all others get an explicit skip.
  checkboxOnLabels: /woodworking|fully remote/i,
};

// When contextText contains this, the mock rejects the strict json_schema rung
// with HTTP 400 (forcing the server's ladder down to rung 2) and then answers
// every json_object attempt (initial + repair) with malformed JSON → server 502.
export const FORCE_ERROR = 'FORCE_ERROR';

// When contextText contains this, the mock only sets email + full-name, emits an
// explicit `skip` for textareas, and OMITS every other field — the two
// fill-or-leave shapes (explicit skip vs omission) in one plan.
export const SKIP_AND_OMIT = 'SKIP_AND_OMIT';
