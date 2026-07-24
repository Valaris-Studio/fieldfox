import { expect, test } from 'vitest';
import { triggerPosition } from '../src/trigger.js';

// Layout-free unit test of the anchoring math (jsdom returns zero rects, so the
// math lives in a pure function we can feed a real rect).
test('triggerPosition pins the button to the host top-right, overhanging by offset', () => {
  const hostRect = { top: 100, left: 200, width: 300, height: 40 };
  const size = 28;
  const offset = 6;

  const pos = triggerPosition(hostRect, size, offset);

  // top edge, nudged up by offset
  expect(pos.top).toBe(100 - 6);
  // right edge (left+width) minus button width, nudged right by offset
  expect(pos.left).toBe(200 + 300 - 28 + 6);
});

test('triggerPosition handles a zero offset (button sits flush inside the corner)', () => {
  const pos = triggerPosition({ top: 0, left: 0, width: 100, height: 20 }, 28, 0);
  expect(pos).toEqual({ top: 0, left: 100 - 28 });
});
