import type { FormField } from '@fieldfox/shared';

export function hasSensitiveAutocomplete(field: Pick<FormField, 'autocomplete'>): boolean {
  return (field.autocomplete ?? '').toLowerCase().split(/\s+/)
    .some((token) => token === 'one-time-code' || token.startsWith('cc-'));
}
