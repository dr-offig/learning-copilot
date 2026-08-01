/**
 * The Figma Plugin API token extractor, and the reader for whatever comes
 * back.
 *
 * The script here is handed to the Figma MCP server's `use_figma` tool as its
 * `code` argument and runs inside Figma. It walks the real token graph rather
 * than the flattened `get_variable_defs` output, so collections, named modes
 * and `VARIABLE_ALIAS` references all survive. Its output feeds `emitTokensCss`
 * in ./figmatokens.
 *
 * ## Why delivery is a parameter
 *
 * `use_figma` does not surface a script's return value — it answers
 * `"Code executed with no return value."` and drops it. Throwing is therefore
 * the only way to get a payload back, since error text is always returned
 * verbatim. That is measured behaviour rather than documented behaviour, so
 * the returning variant is kept and tried second: if Figma starts honouring
 * return values, the caller learns that on its next import instead of being
 * stuck with a deliberate exception forever.
 *
 * Both variants wrap the payload in `SENTINEL`, so the reader can find it
 * inside a stack trace, a markdown fence, or an agent's commentary without
 * guessing at which braces belong to the report.
 *
 * This module must stay free of `vscode` imports so it can be unit-tested
 * outside VS Code.
 */

import { parseFigmaTokenReport } from "./figmatokens";
import type { FigmaTokenReport } from "./figmatokens";

/** How the script hands its payload back. */
export type DeliveryMode = "return" | "throw";

/**
 * Delivery modes to try, in order, until one yields a payload.
 *
 * Ordered by what was measured, not by what looks tidy. Against the remote
 * Figma MCP server the returning variant comes back as literally
 * `"Code executed with no return value."` — `use_figma` discards whatever the
 * script evaluates to, so throwing is the only channel out. `return` stays as
 * a fallback in case that ever changes; putting `throw` first means the normal
 * case is one tool call and one confirmation prompt.
 */
export const DELIVERY_MODES: readonly DeliveryMode[] = ["throw", "return"];

/**
 * Marks the payload in the tool result. Versioned so an older cached script
 * and a newer reader can't silently half-match.
 */
export const SENTINEL = "LC_FIGMA_TOKENS_V1:";

/**
 * Leads the script, because VS Code's tool-confirmation dialog shows the raw
 * `code` argument and this is the first thing the student reads before
 * approving it. Three questions get answered up front: what this is, whether
 * it changes their design, and why it ends in a `throw` that would otherwise
 * look like something had gone wrong.
 */
const EXTRACTOR_HEADER = `/* ---------------------------------------------------------------------------
 * Learning Copilot — Figma token extractor
 *
 * WHAT THIS DOES: reads the variables, modes and text styles in this Figma
 * file and returns them as JSON, so they can be written out as CSS variables.
 *
 * IT DOES NOT CHANGE YOUR DESIGN. Every call below is a read.
 *
 * IT ENDS BY THROWING AN ERROR ON PURPOSE. That is not a bug: Figma discards
 * whatever this script returns, so the results are sent back as the text of a
 * deliberate error. Seeing that error means it worked.
 * ------------------------------------------------------------------------ */`;

const EXTRACTOR_BODY = `
async function extractFigmaTokens() {
  function toHex(color) {
    if (!color || typeof color !== 'object') { return null; }
    const to255 = (n) => Math.round((n ?? 0) * 255);
    const hex = '#' + [to255(color.r), to255(color.g), to255(color.b)]
      .map((n) => n.toString(16).padStart(2, '0')).join('');
    const a = color.a ?? 1;
    return (a < 1 ? hex + to255(a).toString(16).padStart(2, '0') : hex).toUpperCase();
  }

  // Figma stores font sizes and spacing as unitless FLOATs; px is the unit the
  // CSS emitter should apply. Everything else is emitted as-is.
  function literalFor(resolvedType, raw) {
    if (resolvedType === 'COLOR') { return { value: toHex(raw) }; }
    if (resolvedType === 'FLOAT') { return { value: raw, unit: 'px' }; }
    if (resolvedType === 'BOOLEAN') { return { value: raw ? 'true' : 'false' }; }
    return { value: raw === null || raw === undefined ? null : String(raw) };
  }

  function lengthFor(v) {
    if (!v || typeof v !== 'object' || v.unit === 'AUTO') { return undefined; }
    if (v.unit === 'PERCENT') { return String(v.value) + '%'; }
    return v.value;
  }

  // Font weights are captured as Figma's raw style names ("Regular",
  // "9pt Regular"). Mapping them onto CSS weights is the emitter's job — this
  // script's only responsibility is to capture the file faithfully.

  const summary = {
    totalCollections: 0,
    totalVariables: 0,
    aliasModeValues: 0,
    literalModeValues: 0,
    textStyles: 0,
    frames: 0,
  };
  const collections = [];

  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
    summary.totalCollections += 1;
    const variables = [];

    for (const id of c.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (!v) { continue; }
      summary.totalVariables += 1;

      const valuesByMode = [];
      for (const m of c.modes) {
        const raw = v.valuesByMode[m.modeId];
        if (raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') {
          summary.aliasModeValues += 1;
          const target = await figma.variables.getVariableByIdAsync(raw.id);
          valuesByMode.push({ mode: m.name, kind: 'alias', aliasTarget: target ? target.name : raw.id });
        } else {
          summary.literalModeValues += 1;
          valuesByMode.push({ mode: m.name, kind: 'literal', ...literalFor(v.resolvedType, raw) });
        }
      }

      variables.push({ name: v.name, resolvedType: v.resolvedType, valuesByMode });
    }

    // Emitted even when empty, so a missing collection is visible rather than
    // silently absent from the report.
    collections.push({ collection: c.name, modes: c.modes.map((m) => m.name), variables });
  }

  const textStyles = [];
  for (const s of await figma.getLocalTextStylesAsync()) {
    summary.textStyles += 1;
    const style = {
      name: s.name,
      fontFamily: s.fontName && s.fontName.family,
      fontWeight: s.fontName && s.fontName.style,
      fontSize: s.fontSize,
      lineHeight: lengthFor(s.lineHeight),
      letterSpacing: lengthFor(s.letterSpacing),
      textCase: s.textCase,
      textDecoration: s.textDecoration,
    };
    for (const k of Object.keys(style)) {
      if (style[k] === undefined) { delete style[k]; }
    }
    textStyles.push(style);
  }

  // Top-level artboards, so the extension can suggest real breakpoints rather
  // than making the student guess. Strictly best-effort and capped: variables
  // are the point of this script, the payload rides back inside an error
  // message, and neither may be put at risk for advisory context.
  const frames = [];
  try {
    if (typeof figma.loadAllPagesAsync === 'function') { await figma.loadAllPagesAsync(); }
    const isArtboard = (n) => n && (n.type === 'FRAME' || n.type === 'COMPONENT') && typeof n.width === 'number';
    const add = (n, pageName) => {
      frames.push({ name: n.name, width: Math.round(n.width), height: Math.round(n.height), page: pageName });
    };
    for (const page of figma.root.children) {
      for (const node of page.children) {
        if (frames.length >= 200) { break; }
        if (isArtboard(node)) {
          add(node, page.name);
        } else if (node.type === 'SECTION' && Array.isArray(node.children)) {
          // Sections are containers; the artboards inside them are the layouts.
          for (const child of node.children) {
            if (frames.length >= 200) { break; }
            if (isArtboard(child)) { add(child, page.name); }
          }
        }
      }
    }
  } catch (e) {
    frames.length = 0;
  }
  summary.frames = frames.length;

  return { summary, collections, textStyles, frames };
}

const __lcPayload = SENTINEL_LITERAL + JSON.stringify(await extractFigmaTokens());
`.trim();

/**
 * Builds the extractor for one delivery mode.
 *
 * @param deliver `"return"` hands the payload back as the script's value;
 *   `"throw"` raises it as an Error, which every client surfaces verbatim.
 */
export function buildExtractorScript(deliver: DeliveryMode): string {
  const body = EXTRACTOR_BODY.replace("SENTINEL_LITERAL", JSON.stringify(SENTINEL));
  const tail = deliver === "throw"
    ? "// Deliberate — see the header. This is how the results get back.\nthrow new Error(__lcPayload);"
    : "__lcPayload;";
  return `${EXTRACTOR_HEADER}\n\n${body}\n${tail}\n`;
}

/**
 * Pulls a balanced JSON object out of `text` starting at `from`, ignoring
 * braces inside strings. Needed because the payload is usually followed by a
 * stack trace or agent commentary that plain brace counting would swallow.
 */
function readJsonObjectAt(text: string, from: number): string | null {
  const start = text.indexOf("{", from);
  if (start < 0) { return null; }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0) { return text.slice(start, i + 1); }
    }
  }
  return null;
}

export type ExtractorReadResult =
  | { ok: true; report: FigmaTokenReport }
  | { ok: false; reason: string };

/**
 * Reads a token report out of raw `use_figma` output. Handles the payload
 * arriving as a return value, inside an `Error:` line with a stack trace after
 * it, or wrapped in an agent's prose — the sentinel pins the start and brace
 * matching finds the end.
 *
 * @param text Flattened text of the tool result.
 */
export function readExtractorResult(text: string): ExtractorReadResult {
  const marker = text.lastIndexOf(SENTINEL);
  if (marker < 0) {
    return { ok: false, reason: "No token report found in the tool result." };
  }

  const json = readJsonObjectAt(text, marker + SENTINEL.length);
  if (!json) {
    // The payload rides back inside an error message, so a large design
    // system could in principle hit a length cap on Figma's side. Report the
    // size seen: it is the difference between "Figma changed" and "this file
    // is too big", and the two need different fixes.
    return {
      ok: false,
      reason:
        `The token report was cut off before its closing brace (${text.length - marker} characters received). ` +
        "The design system may be too large to return in one call.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e: any) {
    return { ok: false, reason: `The token report is not valid JSON: ${e?.message ?? String(e)}` };
  }

  try {
    return { ok: true, report: parseFigmaTokenReport(parsed) };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}
