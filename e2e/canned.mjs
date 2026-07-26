// Shared contract between the mock provider and the specs: the deterministic
// values the mock plans for the example-host fixtures, plus the magic context
// strings that switch the mock into its error / leave-semantics modes. Keeping
// them in one module means an assertion and the mock can never drift apart.

// The wire contract's current major, mirrored from packages/shared's
// SCHEMA_VERSION. Specs transpile as CJS and cannot import the workspace
// package, so this is a hand-kept copy — the widget's own drift-guard unit test
// (fill-flow.test.ts) is what actually pins the mirror against the source.
export const WIRE_SCHEMA_VERSION = 4;

export const CANNED = {
  fullName: 'Jane Doe',
  email: 'jane@doe.dev',
  tel: '+1 415 555 0123',
  date: '2026-08-15',
  // What the mock "model" EMITS for date fields — deliberately US-formatted, the
  // way real models drift. The server normalizes it to the ISO `date` above, so
  // specs asserting `date` on the input prove that normalization end to end.
  dateAsModelEmitted: '08/15/2026',
  textarea: 'Filled by the fieldfox e2e mock provider.',
  number: '42',
  // Keyed by the introspected field `name`; fallback is the first non-empty option.
  selectByName: { 'tshirt-size': 'm', role: 'engineer' },
  // Custom-widget (driver) values for the ARIA fixture. A combobox carries NO
  // options over the wire — we never open-probe at introspection — so the model
  // plans a display-name string and the driver matches it to an option by
  // accessible name at fill time. `comboboxUnmatchable` is the leave-semantics
  // probe: a plausible value that exists in no listbox, which must leave the
  // field untouched rather than force a wrong pick.
  comboboxByLabel: { region: 'Frankfurt', tier: 'Gold' },
  comboboxUnmatchable: 'Atlantis',
  // Diacritic-insensitive matching: the model writes "Sao Paulo", the option
  // reads "São Paulo".
  comboboxDiacritic: 'Sao Paulo',
  switchOnLabels: /backups/i,
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
