import { expect, test, describe } from 'vitest';
import {
  SCHEMA_VERSION,
  FormField,
  FillRequest,
  FillPlan,
  ModelFillPlan,
  fillPlanJsonSchema,
} from '../src/index.js';

const textField = {
  id: 'f1',
  kind: 'email' as const,
  labelCandidates: ['Email address', 'email'],
  name: 'email',
  autocomplete: 'email',
  required: true,
  fillable: true,
};

const hintedField = {
  id: 'f2',
  kind: 'date' as const,
  labelCandidates: ['Date of birth'],
  fillable: true,
  authorHints: { hint: 'DOB of the primary applicant', format: 'DD.MM.YYYY', example: '01.02.1990' },
};

const selectField = {
  id: 'f3',
  kind: 'select' as const,
  labelCandidates: ['Country'],
  options: [
    { value: 'cl', label: 'Chile' },
    { value: 'de', label: 'Germany' },
  ],
  fillable: true,
};

describe('field fixtures round-trip', () => {
  test('plain field parses', () => {
    expect(FormField.parse(textField)).toMatchObject({ id: 'f1', kind: 'email', fillable: true });
  });

  test('field carrying authorHints parses and preserves the hints', () => {
    const parsed = FormField.parse(hintedField);
    expect(parsed.authorHints).toEqual({
      hint: 'DOB of the primary applicant',
      format: 'DD.MM.YYYY',
      example: '01.02.1990',
    });
  });

  test('select field enumerates options', () => {
    expect(FormField.parse(selectField).options).toHaveLength(2);
  });

  test('hint values over 500 chars are rejected', () => {
    const tooLong = { ...hintedField, authorHints: { hint: 'x'.repeat(501) } };
    expect(() => FormField.parse(tooLong)).toThrow();
  });
});

describe('FillRequest', () => {
  test('valid request round-trips and defaults images to []', () => {
    const req = FillRequest.parse({
      schemaVersion: SCHEMA_VERSION,
      formSchema: { fields: [textField, hintedField, selectField] },
      contextText: 'My email is a@b.com, born 1 Feb 1990, I live in Chile.',
    });
    expect(req.images).toEqual([]);
    expect(req.formSchema.fields).toHaveLength(3);
  });

  test('a wrong schemaVersion is rejected', () => {
    expect(() =>
      FillRequest.parse({ schemaVersion: 999, formSchema: { fields: [] }, contextText: '' }),
    ).toThrow();
  });

  test('images must be data URLs', () => {
    expect(() =>
      FillRequest.parse({
        schemaVersion: SCHEMA_VERSION,
        formSchema: { fields: [] },
        contextText: '',
        images: [{ dataUrl: 'https://evil.example/x.png' }],
      }),
    ).toThrow();
  });
});

describe('FillPlan', () => {
  test('a fill plan with set + skip actions parses', () => {
    const plan = FillPlan.parse({
      fills: [
        { fieldId: 'f1', action: 'set', value: 'a@b.com', confidence: 0.9 },
        { fieldId: 'f3', action: 'set', value: 'cl' },
        { fieldId: 'f2', action: 'skip', value: null, reason: 'ambiguous' },
      ],
    });
    expect(plan.fills).toHaveLength(3);
  });

  test('multi-value (multi-select) values are allowed', () => {
    const plan = FillPlan.parse({ fills: [{ fieldId: 'f3', action: 'set', value: ['cl', 'de'] }] });
    expect(plan.fills[0].value).toEqual(['cl', 'de']);
  });

  test('confidence out of [0,1] is rejected', () => {
    expect(() =>
      FillPlan.parse({ fills: [{ fieldId: 'f1', action: 'set', value: 'x', confidence: 2 }] }),
    ).toThrow();
  });
});

describe('fillPlanJsonSchema (strict-subset invariants, RESEARCH §3)', () => {
  const schema = fillPlanJsonSchema();

  function everyObject(node: unknown, visit: (o: Record<string, unknown>) => void): void {
    if (Array.isArray(node)) {
      for (const n of node) everyObject(n, visit);
    } else if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (o.type === 'object' || o.properties) visit(o);
      for (const v of Object.values(o)) everyObject(v, visit);
    }
  }

  test('root is an object', () => {
    expect(schema.type).toBe('object');
  });

  test('every object sets additionalProperties:false', () => {
    everyObject(schema, (o) => expect(o.additionalProperties).toBe(false));
  });

  test('every object lists all its properties in required', () => {
    everyObject(schema, (o) => {
      const props = Object.keys((o.properties as Record<string, unknown>) ?? {});
      const required = (o.required as string[]) ?? [];
      expect([...required].sort()).toEqual([...props].sort());
    });
  });

  test('no unsupported strict-mode keywords appear anywhere', () => {
    const banned = /"(minLength|maxLength|pattern|format|minimum|maximum|minItems|maxItems)"/;
    expect(banned.test(JSON.stringify(schema))).toBe(false);
  });

  test('the model plan validates real model-shaped output', () => {
    expect(ModelFillPlan.parse({ fills: [{ fieldId: 'f1', action: 'set', value: 'a@b.com' }] }).fills).toHaveLength(1);
  });
});
