/**
 * Prints the Figma Plugin API token extractor for pasting into Copilot Chat.
 *
 *   npm run figma:script             # the returning variant
 *   npm run figma:script -- throw    # the variant that throws its payload
 *   npm run figma:script -- layouts          # structural walk of every artboard
 *   npm run figma:script -- layouts Desktop  # ...just that one
 *
 * The layouts variants leave the variable detail out: at ~12.7KB it consumes
 * most of the ~20KB the payload channel allows, and the tokens are captured
 * by a separate run anyway.
 *   npm run figma:script -- probe    # diagnostic: what the Plugin API offers
 *
 * The script itself lives in src/figmascript.ts, which is also what the
 * extension ships — one source of truth, so the copy you paste by hand and the
 * copy the extension runs cannot drift apart.
 *
 * To use the output: ask Copilot Chat (agent mode) to pass it verbatim as the
 * `code` argument to `use_figma`, save the reply to report.json, then run
 * `npm run figma:css -- report.json`.
 */
const { buildExtractorScript, buildProbeScript, DELIVERY_MODES } = require('../out/figmascript.js');

const mode = process.argv[2] || 'return';

if (mode === 'probe') {
  process.stdout.write(buildProbeScript());
} else if (mode === 'layouts') {
  const names = process.argv.slice(3);
  process.stdout.write(buildExtractorScript('throw', {
    includeLayouts: true,
    includeTokens: false,
    ...(names.length > 0 ? { layoutNames: names } : {}),
  }));
} else if (DELIVERY_MODES.includes(mode)) {
  process.stdout.write(buildExtractorScript(mode));
} else {
  console.error(`usage: npm run figma:script -- [${DELIVERY_MODES.join('|')}|layouts|probe]`);
  process.exit(2);
}
