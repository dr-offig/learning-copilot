/**
 * Dev CLI for the token emitter, so the Figma → CSS transform can be exercised
 * without the extension host or any MCP plumbing.
 *
 *   npm run compile-tests           # build out/figmatokens.js first
 *   npm run figma:css -- report.json [tokens.css]
 *
 * `report.json` is whatever the extractor printed. It may be wrapped in an
 * `Error: {...}` line or a markdown fence — the outermost JSON object is
 * picked out either way.
 *
 * Writes the CSS to the second argument (default `tokens.css`), and prints
 * stats, warnings and errors to stderr. Exits non-zero if any token failed.
 */
const fs = require('node:fs');
const path = require('node:path');

const { emitTokensCss, parseFigmaTokenReport } = require('../out/figmatokens.js');
const { readExtractorResult, SENTINEL } = require('../out/figmascript.js');

const [, , inputPath, outputPath = 'tokens.css'] = process.argv;
if (!inputPath) {
  console.error('usage: npm run figma:css -- <report.json> [tokens.css]');
  process.exit(2);
}

/** Pulls the outermost JSON object out of surrounding log noise. */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('No JSON object found in the input.');
  }
  return text.slice(start, end + 1);
}

const raw = fs.readFileSync(path.resolve(inputPath), 'utf8');

// Scripts built by src/figmascript.ts mark their payload, which survives a
// stack trace or agent commentary around it. Reports captured before that
// (or hand-trimmed) fall back to picking out the outermost JSON object.
let report;
if (raw.includes(SENTINEL)) {
  const result = readExtractorResult(raw);
  if (!result.ok) {
    console.error(`Could not read the token report: ${result.reason}`);
    process.exit(1);
  }
  report = result.report;
} else {
  report = parseFigmaTokenReport(JSON.parse(extractJsonObject(raw)));
}

// Mode names outside the light/dark convention need an explicit mapping;
// the extension will ask the student, but here they can be pinned by hand.
//
// Order matters. Overlapping media queries have equal specificity, so the
// last matching block wins: list max-width modes widest first, so the
// narrower one still overrides it on a small screen. The emitter warns if
// this order is wrong.
const modeConditions = {
  Tablet: { kind: 'media', query: '(max-width: 64rem)' },
  Phone: { kind: 'media', query: '(max-width: 40rem)' },
};

const result = emitTokensCss(report, { modeConditions });

fs.writeFileSync(path.resolve(outputPath), result.css, 'utf8');

console.error(`Wrote ${outputPath}`);
console.error('\nstats:');
for (const [k, v] of Object.entries(result.stats)) {
  console.error(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
}
if (result.warnings.length) {
  console.error('\nwarnings:');
  for (const w of result.warnings) { console.error(`  - ${w}`); }
}
if (result.errors.length) {
  console.error('\nerrors:');
  for (const e of result.errors) { console.error(`  - ${e}`); }
}
process.exit(result.errors.length > 0 ? 1 : 0);
