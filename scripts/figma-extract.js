/**
 * Prints the Figma Plugin API token extractor for pasting into Copilot Chat.
 *
 *   npm run figma:script            # the returning variant (the clean path)
 *   npm run figma:script -- throw   # the variant that throws its payload
 *
 * The script itself lives in src/figmascript.ts, which is also what the
 * extension ships — one source of truth, so the copy you paste by hand and the
 * copy the extension runs cannot drift apart.
 *
 * To use the output: ask Copilot Chat (agent mode) to pass it verbatim as the
 * `code` argument to `use_figma`, save the reply to report.json, then run
 * `npm run figma:css -- report.json`.
 */
const { buildExtractorScript, DELIVERY_MODES } = require('../out/figmascript.js');

const mode = process.argv[2] || 'return';
if (!DELIVERY_MODES.includes(mode)) {
  console.error(`usage: npm run figma:script -- [${DELIVERY_MODES.join('|')}]`);
  process.exit(2);
}

process.stdout.write(buildExtractorScript(mode));
