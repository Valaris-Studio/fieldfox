import { describe, expect, test } from 'vitest';
import { SCHEMA_VERSION, type FillRequest } from '@fieldfox/shared';
import { buildPrompt } from '../src/prompt.js';

function baseRequest(overrides: Partial<FillRequest> = {}): FillRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextText: 'My name is Ada Lovelace and I was born 1815-12-10.',
    images: [],
    formSchema: {
      fields: [
        {
          id: 'f_name',
          kind: 'text',
          labelCandidates: ['Full name'],
          placeholder: 'Jane Doe',
          fillable: true,
          authorHints: { hint: 'Legal name as on ID', format: 'First Last' },
        },
        {
          id: 'f_country',
          kind: 'select',
          labelCandidates: ['Country'],
          options: [
            { value: 'gb', label: 'United Kingdom' },
            { value: 'us', label: 'United States' },
          ],
          fillable: true,
        },
      ],
    },
    ...overrides,
  } as FillRequest;
}

function userText(messages: ReturnType<typeof buildPrompt>): string {
  const user = messages.find((m) => m.role === 'user')!;
  if (typeof user.content === 'string') return user.content;
  return user.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

describe('buildPrompt two-lane segregation', () => {
  test('system message declares page content is metadata, not instructions', () => {
    const [system] = buildPrompt(baseRequest());
    expect(system.role).toBe('system');
    expect(String(system.content)).toMatch(/METADATA/i);
    expect(String(system.content)).toMatch(/never.*instructions/i);
  });

  test('author hints ride a separate TRUSTED block from untrusted page content', () => {
    const text = userText(buildPrompt(baseRequest()));

    const authorIdx = text.indexOf('SITE-AUTHOR INSTRUCTIONS (TRUSTED)');
    const untrustedIdx = text.indexOf('UNTRUSTED PAGE CONTENT');
    expect(authorIdx).toBeGreaterThanOrEqual(0);
    expect(untrustedIdx).toBeGreaterThanOrEqual(0);

    // The trusted hint text sits inside the author lane, before the untrusted block.
    const hintIdx = text.indexOf('Legal name as on ID');
    expect(hintIdx).toBeGreaterThan(authorIdx);
    expect(hintIdx).toBeLessThan(untrustedIdx);
  });

  test('user-provided context lives inside the untrusted block', () => {
    const text = userText(buildPrompt(baseRequest()));
    const untrustedIdx = text.indexOf('UNTRUSTED PAGE CONTENT');
    const contextIdx = text.indexOf('Ada Lovelace');
    expect(contextIdx).toBeGreaterThan(untrustedIdx);
  });

  test('field schema (ids + options) is present', () => {
    const text = userText(buildPrompt(baseRequest()));
    expect(text).toContain('f_name');
    expect(text).toContain('f_country');
    expect(text).toContain('United Kingdom');
  });

  test('images are appended as image_url content parts', () => {
    const req = baseRequest({ images: [{ dataUrl: 'data:image/png;base64,AAAA' }] });
    const messages = buildPrompt(req);
    const user = messages.find((m) => m.role === 'user')!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
  });

  test('PDF documents become file content parts in the untrusted user message', () => {
    const req = baseRequest({
      documents: [{ name: 'resume.pdf', mediaType: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBER' }],
    });
    const user = buildPrompt(req).find((m) => m.role === 'user')!;
    const parts = user.content as Array<{ type: string; file?: { filename: string; file_data: string } }>;
    const filePart = parts.find((p) => p.type === 'file');
    expect(filePart).toBeDefined();
    // OpenAI-compatible chat-completions file part shape.
    expect(filePart!.file!.filename).toBe('resume.pdf');
    expect(filePart!.file!.file_data).toBe('data:application/pdf;base64,JVBER');
  });

  test('file parts follow the image parts (documents after images)', () => {
    const req = baseRequest({
      images: [{ dataUrl: 'data:image/png;base64,AAAA' }],
      documents: [{ name: 'a.pdf', mediaType: 'application/pdf', dataUrl: 'data:application/pdf;base64,BBBB' }],
    });
    const user = buildPrompt(req).find((m) => m.role === 'user')!;
    const parts = user.content as Array<{ type: string }>;
    const imageIdx = parts.findIndex((p) => p.type === 'image_url');
    const fileIdx = parts.findIndex((p) => p.type === 'file');
    expect(imageIdx).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeGreaterThan(imageIdx);
  });

  test('rung-2 inlineSchema puts literal "JSON" in the system prompt', () => {
    const [system] = buildPrompt(baseRequest(), { inlineSchema: { type: 'object' } });
    expect(String(system.content)).toContain('JSON');
  });
});

// G3: form-level `formContext` is trusted site-author free text about the whole
// form. It rides the SAME trusted lane as per-field data-ff-* hints, in its own
// clearly delimited block, and must sit before the untrusted page-content block.
const FORM_CONTEXT = 'This is the enterprise checkout; prefer business email over personal.';

describe('buildPrompt trusted-lane formContext', () => {
  test('formContext appears inside the trusted author lane, before untrusted content', () => {
    const text = userText(buildPrompt(baseRequest({ formContext: FORM_CONTEXT })));

    const authorIdx = text.indexOf('SITE-AUTHOR INSTRUCTIONS (TRUSTED)');
    const authorEndIdx = text.indexOf('END SITE-AUTHOR INSTRUCTIONS');
    const untrustedIdx = text.indexOf('UNTRUSTED PAGE CONTENT');
    const contextIdx = text.indexOf(FORM_CONTEXT);

    expect(authorIdx).toBeGreaterThanOrEqual(0);
    // formContext sits within the trusted block ...
    expect(contextIdx).toBeGreaterThan(authorIdx);
    expect(contextIdx).toBeLessThan(authorEndIdx);
    // ... and strictly before the untrusted page-content block.
    expect(contextIdx).toBeLessThan(untrustedIdx);
  });

  test('formContext has its own delimited sub-block distinct from per-field hints', () => {
    const text = userText(buildPrompt(baseRequest({ formContext: FORM_CONTEXT })));
    // A dedicated FORM CONTEXT label separates whole-form guidance from the
    // per-field hint block, so the two trusted signals stay distinguishable.
    const formContextLabelIdx = text.indexOf('FORM CONTEXT');
    expect(formContextLabelIdx).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(FORM_CONTEXT)).toBeGreaterThan(formContextLabelIdx);
    // The per-field trusted hint from baseRequest is still present too.
    expect(text).toContain('Legal name as on ID');
  });

  test('absent formContext leaves no empty FORM CONTEXT block', () => {
    const text = userText(buildPrompt(baseRequest()));
    expect(text).not.toContain('FORM CONTEXT');
  });
});
