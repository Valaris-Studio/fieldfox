// CI gate for PLAN §0's bundle budget: the widget's eager IIFE must stay ≤35KB
// gzip (hard ceiling 75KB for eager+lazy — v1 has no lazy chunk, so the IIFE is
// also the total). A red here blocks merge; do not raise the numbers without a
// Locked Decisions change.
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const EAGER_BUDGET = 35_000;
const TOTAL_CEILING = 75_000;

const iifePath = process.argv[2] ?? 'packages/widget/dist/fieldfox.js';
const gzipBytes = gzipSync(readFileSync(iifePath)).length;

console.log(`widget IIFE gzip: ${gzipBytes} B (eager budget ${EAGER_BUDGET}, ceiling ${TOTAL_CEILING})`);

if (gzipBytes > EAGER_BUDGET) {
  console.error(`FAIL: ${iifePath} exceeds the ${EAGER_BUDGET} B eager budget (PLAN §0)`);
  process.exit(1);
}
if (gzipBytes > TOTAL_CEILING) {
  console.error(`FAIL: ${iifePath} exceeds the ${TOTAL_CEILING} B hard ceiling (PLAN §0)`);
  process.exit(1);
}
