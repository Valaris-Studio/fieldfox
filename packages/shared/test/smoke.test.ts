import { expect, test } from 'vitest';
import { SCHEMA_VERSION } from '../src/index.js';

test('schema version pinned', () => {
  expect(SCHEMA_VERSION).toBe(1);
});
