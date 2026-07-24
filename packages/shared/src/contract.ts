import { z } from 'zod';

// Wire contract shared by widget and server. Single source of truth — neither
// side redefines these shapes (PLAN §0). The widget imports the inferred TYPES
// only; the zod runtime lives on the server (PLAN §0 bundle budget).

// Bump on any breaking change to the shapes below. The server rejects requests
// whose schemaVersion it cannot serve (PLAN §0, card D2).
export const SCHEMA_VERSION = 1;

const MAX_HINT = 500;

// Per-field author annotations parsed from data-ff-* attributes (RESEARCH §5).
// These are site-owner-TRUSTED input; they ride a prompt lane separate from
// semi-untrusted page-derived text. `ignore` never travels the wire — the
// widget strips ignored fields from the FormSchema before the request.
export const AuthorHints = z.object({
  hint: z.string().max(MAX_HINT).optional(),
  format: z.string().max(MAX_HINT).optional(),
  example: z.string().max(MAX_HINT).optional(),
});
export type AuthorHints = z.infer<typeof AuthorHints>;

export const FieldKind = z.enum([
  'text',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'date',
  'number',
  'email',
  'tel',
  'url',
  'password',
  'other',
]);
export type FieldKind = z.infer<typeof FieldKind>;

export const FieldOption = z.object({
  value: z.string(),
  label: z.string(),
  optgroup: z.string().optional(),
});
export type FieldOption = z.infer<typeof FieldOption>;

// Introspection emits ALL non-empty label candidates rather than collapsing to
// one string; the model disambiguates (RESEARCH §1). `fillable:false` fields
// (detected custom widgets, readonly) are described to the model but never
// planned for a value (RESEARCH §2).
export const FormField = z.object({
  id: z.string(),
  kind: FieldKind,
  labelCandidates: z.array(z.string()),
  name: z.string().optional(),
  autocomplete: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  pattern: z.string().optional(),
  maxLength: z.number().int().optional(),
  options: z.array(FieldOption).optional(),
  currentValue: z.string().optional(),
  fillable: z.boolean(),
  authorHints: AuthorHints.optional(),
});
export type FormField = z.infer<typeof FormField>;

export const FormSchema = z.object({
  fields: z.array(FormField),
});
export type FormSchema = z.infer<typeof FormSchema>;

export const RequestImage = z.object({
  dataUrl: z.string().startsWith('data:'),
});
export type RequestImage = z.infer<typeof RequestImage>;

export const FillRequest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  formSchema: FormSchema,
  contextText: z.string(),
  images: z.array(RequestImage).default([]),
  locale: z.string().optional(),
});
export type FillRequest = z.infer<typeof FillRequest>;

export const FillAction = z.enum(['set', 'skip']);
export type FillAction = z.infer<typeof FillAction>;

// One entry per field the model considered. `set` carries a value; `skip`
// leaves the field exactly as it was — omission is treated as skip too, so the
// fill-or-leave invariant holds even for a truncated plan (RESEARCH §7).
export const Fill = z.object({
  fieldId: z.string(),
  action: FillAction,
  value: z.union([z.string(), z.array(z.string()), z.null()]),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
});
export type Fill = z.infer<typeof Fill>;

export const FillPlan = z.object({
  fills: z.array(Fill),
});
export type FillPlan = z.infer<typeof FillPlan>;

// The exact object the model is constrained to emit under response_format
// json_schema strict (RESEARCH §3). Deliberately FLATTER and stricter than the
// full FillPlan: no confidence/reason, no nested unions beyond value's
// string|string[]|null, so it survives the strict-mode subset every
// OpenAI-compatible provider accepts. The server re-parses the result with the
// richer FillPlan above and drops fills for unknown field ids.
export const ModelFillPlan = z.object({
  fills: z.array(
    z.object({
      fieldId: z.string(),
      action: FillAction,
      value: z.union([z.string(), z.array(z.string()), z.null()]),
    }),
  ),
});
export type ModelFillPlan = z.infer<typeof ModelFillPlan>;

// JSON Schema for the model's structured-output constraint. draft-2020-12 with
// additionalProperties:false and every property required is the intersection
// accepted across OpenAI/Azure/Gemini-compat/vLLM/Ollama (RESEARCH §3).
export function fillPlanJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ModelFillPlan, { target: 'draft-2020-12' }) as Record<string, unknown>;
}
