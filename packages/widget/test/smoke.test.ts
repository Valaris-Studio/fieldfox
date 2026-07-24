import { expect, test } from 'vitest';
import { WIDGET_READY } from '../src/index.js';

test('widget entry loads', () => {
  expect(WIDGET_READY).toBe(true);
});
