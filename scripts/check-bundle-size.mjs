// CI gate for PLAN §0's bundle budget: the widget's eager IIFE must stay ≤35KB
// gzip (hard ceiling 75KB for eager+lazy — v1 has no lazy chunk, so the IIFE is
// also the total). A red here blocks merge; do not raise the numbers without a
// Locked Decisions change.
//
// Also the W-1 encoding gate: the bundle must be pure ASCII. The IIFE is dropped
// into host pages we do not control, and a page with no charset declaration
// decodes the script as windows-1252, so every multi-byte UTF-8 sequence becomes
// two or three characters. Inside a regex literal that is a parse error for the
// WHOLE bundle and <field-fox> is never defined, which an integrator cannot tell
// apart from an SRI mismatch. ASCII is the one encoding every host page agrees
// on, so a single byte above 0x7F fails here. Only the IIFE is gated: it lands
// on host pages verbatim, while the ESM entry is unminified (its comments keep
// the source's punctuation) and reaches a page through the consumer's bundler.
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

const offenders = nonAsciiOffenders(readFileSync(iifePath, 'utf8'));
if (offenders.length > 0) {
  console.error(
    `FAIL: ${iifePath} carries ${offenders.length} non-ASCII character(s); a host page ` +
      'without a charset declaration cannot parse it (W-1). Regex ranges must be written ' +
      'with \\u escapes in source; strings are escaped by esbuild (vite.config.ts charset):\n' +
      offenders.slice(0, 10).map((o) => `  ${o}`).join('\n'),
  );
  process.exit(1);
}
console.log(`${iifePath}: pure ASCII`);

// Every character above U+007F with its line:column and code point, so the
// offending literal can be found in the source without a hex dump.
function nonAsciiOffenders(source) {
  const offenders = [];
  source.split('\n').forEach((line, lineIndex) => {
    for (const match of line.matchAll(/[^\x00-\x7f]/gu)) {
      const codePoint = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      offenders.push(`${lineIndex + 1}:${match.index + 1} U+${codePoint} ${JSON.stringify(match[0])}`);
    }
  });
  return offenders;
}
