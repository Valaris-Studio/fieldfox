import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { introspectForms } from '../src/introspect.js';

// Builds a form fixture from an HTML string, appends it live to the document
// (introspection reads computed style + labels, which require attachment), and
// returns the outer element. Cleared between tests by the beforeEach below.
function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('plain HTML form', () => {
  test('maps kinds, label candidates, options and collapses the radio group', () => {
    const host = mount(`
      <form>
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" required />

        <label for="country">Country</label>
        <select id="country" name="country">
          <option value="">--</option>
          <optgroup label="Europe">
            <option value="de">Germany</option>
            <option value="fr">France</option>
          </optgroup>
        </select>

        <label><input type="checkbox" name="tos" /> Accept terms</label>

        <fieldset>
          <legend>Plan</legend>
          <label><input type="radio" name="plan" value="free" checked /> Free</label>
          <label><input type="radio" name="plan" value="pro" /> Pro</label>
        </fieldset>
      </form>
    `);
    const form = host.querySelector('form')!;
    const { schema } = introspectForms([form]);

    // email, select, checkbox, and ONE collapsed radio field.
    expect(schema.fields).toHaveLength(4);

    const email = schema.fields.find((f) => f.name === 'email')!;
    expect(email.kind).toBe('email');
    expect(email.required).toBe(true);
    expect(email.labelCandidates).toContain('Email address');
    expect(email.fillable).toBe(true);

    const country = schema.fields.find((f) => f.name === 'country')!;
    expect(country.kind).toBe('select');
    expect(country.options).toEqual([
      { value: '', label: '--' },
      { value: 'de', label: 'Germany', optgroup: 'Europe' },
      { value: 'fr', label: 'France', optgroup: 'Europe' },
    ]);

    const tos = schema.fields.find((f) => f.name === 'tos')!;
    expect(tos.kind).toBe('checkbox');
    expect(tos.labelCandidates).toContain('Accept terms');

    const plan = schema.fields.find((f) => f.name === 'plan')!;
    expect(plan.kind).toBe('radio');
    expect(plan.options).toEqual([
      { value: 'free', label: 'Free' },
      { value: 'pro', label: 'Pro' },
    ]);
    // The checked radio's value is the group's current value.
    expect(plan.currentValue).toBe('free');
  });
});

describe('label resolution', () => {
  test('aria-label, wrapping label, and placeholder all appear in precedence order', () => {
    const host = mount(`
      <form>
        <label>
          Wrapping label text
          <input name="x" aria-label="Aria name" placeholder="Placeholder text" />
        </label>
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    const field = schema.fields[0];

    // Precedence: aria-labelledby → aria-label → control.labels → data-ff-hint
    //             → placeholder → nearby-text → title.
    const candidates = field.labelCandidates;
    const ariaIdx = candidates.indexOf('Aria name');
    const labelIdx = candidates.indexOf('Wrapping label text');
    const placeholderIdx = candidates.indexOf('Placeholder text');

    expect(ariaIdx).toBeGreaterThanOrEqual(0);
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    expect(placeholderIdx).toBeGreaterThanOrEqual(0);
    expect(ariaIdx).toBeLessThan(labelIdx);
    expect(labelIdx).toBeLessThan(placeholderIdx);
  });

  test('aria-labelledby resolves id refs to text ahead of aria-label', () => {
    const host = mount(`
      <form>
        <span id="lbl1">First</span><span id="lbl2">Last</span>
        <input name="n" aria-labelledby="lbl1 lbl2" aria-label="fallback" />
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    expect(schema.fields[0].labelCandidates[0]).toBe('First Last');
  });
});

describe('author hints', () => {
  test('populates authorHints and never leaks data-ff-example as a value', () => {
    const host = mount(`
      <form>
        <input name="iban"
               data-ff-hint="IBAN of the receiving account"
               data-ff-format="grouped by 4"
               data-ff-example="DE89 3704 0044 0532 0130 00" />
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    const field = schema.fields[0];

    expect(field.authorHints).toEqual({
      hint: 'IBAN of the receiving account',
      format: 'grouped by 4',
      example: 'DE89 3704 0044 0532 0130 00',
    });
    // The example must not become the field's current value.
    expect(field.currentValue ?? '').not.toContain('DE89');
    // The hint DOUBLES as a label candidate (precedence rule), the example does not.
    expect(field.labelCandidates).toContain('IBAN of the receiving account');
    expect(field.labelCandidates).not.toContain('DE89 3704 0044 0532 0130 00');
  });
});

describe('data-ff-ignore', () => {
  test('a field with data-ff-ignore is excluded entirely', () => {
    const host = mount(`
      <form>
        <input name="keep" />
        <input name="secret" data-ff-ignore />
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    expect(schema.fields.map((f) => f.name)).toEqual(['keep']);
  });

  test('data-ff-ignore on a fieldset/form ancestor excludes all descendants', () => {
    const host = mount(`
      <form>
        <input name="top" />
        <fieldset data-ff-ignore>
          <input name="a" />
          <input name="b" />
        </fieldset>
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    expect(schema.fields.map((f) => f.name)).toEqual(['top']);
  });
});

describe('fillable flag', () => {
  test('password and readonly fields are present but fillable:false', () => {
    const host = mount(`
      <form>
        <input name="password" type="password" />
        <input name="ro" readonly value="locked" />
        <input name="ok" />
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);

    const pw = schema.fields.find((f) => f.name === 'password')!;
    expect(pw.kind).toBe('password');
    expect(pw.fillable).toBe(false);

    const ro = schema.fields.find((f) => f.name === 'ro')!;
    expect(ro.fillable).toBe(false);
    // readonly still surfaces its current value for model context.
    expect(ro.currentValue).toBe('locked');

    expect(schema.fields.find((f) => f.name === 'ok')!.fillable).toBe(true);
  });

  test('display:none fields are included but flagged non-fillable', () => {
    const host = mount(`
      <form>
        <input name="hidden" style="display:none" />
        <input name="shown" />
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    expect(schema.fields.find((f) => f.name === 'hidden')!.fillable).toBe(false);
    expect(schema.fields.find((f) => f.name === 'shown')!.fillable).toBe(true);
  });

  test('contenteditable is captured as fillable:false custom widget', () => {
    const host = mount(`
      <form>
        <div contenteditable="true" data-ff-hint="Bio"></div>
        <input name="ok" />
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    const editable = schema.fields.find((f) => f.kind === 'other')!;
    expect(editable).toBeTruthy();
    expect(editable.fillable).toBe(false);
    expect(editable.labelCandidates).toContain('Bio');
  });
});

describe('unknown data-ff-* suffix', () => {
  test('console.warn is fired once per unknown suffix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = mount(`
      <form>
        <input name="a" data-ff-xyz="oops" />
        <input name="b" data-ff-xyz="again" />
        <input name="c" data-ff-hint="fine" />
      </form>
    `);
    introspectForms([host.querySelector('form')!]);

    const xyzWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes('xyz'),
    );
    expect(xyzWarnings).toHaveLength(1);
  });
});

describe('skipped controls', () => {
  test('hidden/submit/button types and disabled fields are excluded', () => {
    const host = mount(`
      <form>
        <input name="real" />
        <input name="h" type="hidden" />
        <input type="submit" value="Go" />
        <button type="button">Click</button>
        <input name="dis" disabled />
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    expect(schema.fields.map((f) => f.name)).toEqual(['real']);
  });
});

describe('form-less container fallback', () => {
  test('scoped querySelectorAll enumerates controls when no form exists', () => {
    const host = mount(`
      <div id="panel">
        <input name="a" />
        <textarea name="b"></textarea>
      </div>
    `);
    const { schema } = introspectForms([host.querySelector('#panel')!]);
    expect(schema.fields.map((f) => f.kind).sort()).toEqual(['text', 'textarea']);
  });
});

describe('id → element resolver', () => {
  test('every field id resolves back to its live element', () => {
    const host = mount(`
      <form>
        <input name="a" />
        <label><input type="radio" name="g" value="1" /> One</label>
        <label><input type="radio" name="g" value="2" /> Two</label>
      </form>
    `);
    const { schema, resolve } = introspectForms([host.querySelector('form')!]);
    for (const field of schema.fields) {
      const el = resolve(field.id);
      expect(el).toBeInstanceOf(HTMLElement);
    }
    // The radio group resolves to one of its member inputs.
    const radio = schema.fields.find((f) => f.kind === 'radio')!;
    expect((resolve(radio.id) as HTMLInputElement).name).toBe('g');
  });
});

// v1.1a drivers (RESEARCH §9.6/§9.8). Introspection must DISCOVER the ARIA
// widgets a driver can operate and mark them fillable with their own kind —
// without ever opening one to harvest options (no introspection open-probe).
describe('driven ARIA widgets', () => {
  test('a role=switch outside form.elements is discovered, kinded and fillable', () => {
    const host = mount(`
      <form>
        <input name="project" />
        <span id="backups-label">Nightly backups</span>
        <div role="switch" aria-checked="false" aria-labelledby="backups-label"></div>
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    const field = schema.fields.find((f) => f.kind === 'switch');
    expect(field).toBeDefined();
    expect(field!.fillable).toBe(true);
    expect(field!.labelCandidates).toContain('Nightly backups');
  });

  test('a role=combobox is fillable and carries NO options (never open-probed)', () => {
    const host = mount(`
      <form>
        <span id="region-label">Region</span>
        <button type="button" role="combobox" aria-labelledby="region-label"
                aria-controls="lb" aria-expanded="false">Select a region</button>
      </form>
      <ul id="lb" role="listbox" hidden>
        <li role="option">Frankfurt</li>
      </ul>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    const field = schema.fields.find((f) => f.kind === 'combobox')!;
    expect(field.fillable).toBe(true);
    expect(field.options).toBeUndefined();
    // The widget must still be closed — introspection never opens anything.
    expect(host.querySelector('[role="combobox"]')!.getAttribute('aria-expanded')).toBe('false');
  });

  test('an undriven ARIA widget keeps the old hard fillable:false', () => {
    const host = mount(`
      <form>
        <span id="notes-label">Notes</span>
        <div role="textbox" aria-labelledby="notes-label"></div>
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    const field = schema.fields.find((f) => f.labelCandidates.includes('Notes'))!;
    expect(field.fillable).toBe(false);
  });

  test('a native checkbox carrying role=switch stays the native kind', () => {
    const host = mount(`
      <form>
        <label><input type="checkbox" role="switch" name="beta" /> Beta features</label>
      </form>
    `);
    const { schema } = introspectForms([host.querySelector('form')!]);
    expect(schema.fields.find((f) => f.name === 'beta')!.kind).toBe('checkbox');
  });
});
