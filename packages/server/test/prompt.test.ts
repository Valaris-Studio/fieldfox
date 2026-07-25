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

  test('rung-2 inlineSchema puts literal "JSON" in the system prompt', () => {
    const [system] = buildPrompt(baseRequest(), { inlineSchema: { type: 'object' } });
    expect(String(system.content)).toContain('JSON');
  });
});
