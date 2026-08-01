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
  const wantedLayouts = WANTED_LAYOUTS;
  const includeTokens = INCLUDE_TOKENS;

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
  // id -> name lookups, built as we go so the layout walk can name the token
  // bound to a colour or a gap without spending another API call.
  const varNames = {};
  const styleNames = {};

  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
    summary.totalCollections += 1;
    const variables = [];

    for (const id of c.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (!v) { continue; }
      summary.totalVariables += 1;
      varNames[v.id] = v.name;

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
    // silently absent from the report. Skipped entirely when only layouts are
    // wanted: the variables were still read above, so the layout walk can
    // still name the token bound to each colour and gap.
    if (includeTokens) {
      collections.push({ collection: c.name, modes: c.modes.map((m) => m.name), variables });
    }
  }

  const textStyles = [];
  for (const s of await figma.getLocalTextStylesAsync()) {
    summary.textStyles += 1;
    styleNames[s.id] = s.name;
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
    if (includeTokens) { textStyles.push(style); }
  }

  // Top-level artboards, so the extension can suggest real breakpoints rather
  // than making the student guess. Strictly best-effort and capped: variables
  // are the point of this script, the payload rides back inside an error
  // message, and neither may be put at risk for advisory context.
  const frames = [];
  const artboards = [];
  try {
    // Inside use_figma the property exists but calling it throws
    // '"loadAllPagesAsync" is not a supported API', so a typeof guard is not
    // enough — and pages are already loaded here, making the call optional.
    // Letting it abort the walk is what silently produced no frames at all.
    try {
      if (typeof figma.loadAllPagesAsync === 'function') { await figma.loadAllPagesAsync(); }
    } catch (e) { /* already loaded in this context */ }
    const isArtboard = (n) => n && (n.type === 'FRAME' || n.type === 'COMPONENT') && typeof n.width === 'number';
    const add = (n, pageName) => {
      frames.push({ name: n.name, width: Math.round(n.width), height: Math.round(n.height), page: pageName });
      artboards.push({ node: n, page: pageName });
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
    // Recorded rather than swallowed: an empty frame list used to be
    // indistinguishable from a design with no artboards, and telling those
    // apart previously cost a metered diagnostic call.
    summary.frameError = (e && e.message) ? e.message : String(e);
  }
  summary.frames = frames.length;

  const layouts = [];
LAYOUT_BLOCK

  // Measured: the error channel carrying this payload is cut at about 20KB,
  // and a cut payload is worth nothing at all. Shedding whole artboards until
  // it fits means a caller always gets valid JSON plus a count of what was
  // dropped, rather than a truncated string and a wasted metered call.
  const result = { summary, collections, textStyles, frames, layouts };
  while (layouts.length > 0 && JSON.stringify(result).length > 18000) {
    layouts.pop();
    summary.layoutsDropped = (summary.layoutsDropped || 0) + 1;
    summary.layouts = layouts.length;
  }

  return result;
}

const __lcPayload = SENTINEL_LITERAL + JSON.stringify(await extractFigmaTokens());
`.trim();

/**
 * The structural walk of each artboard, spliced in only when asked for.
 *
 * Kept optional because it is by far the largest thing the script can produce,
 * and the payload rides back inside an error message: a token import that
 * works today must not start truncating because it now drags a layout tree
 * along with it.
 *
 * Reuses the `varNames` and `styleNames` maps built during the token walk, so
 * every colour and gap is reported as the token bound to it rather than as a
 * raw value. That is what lets generated CSS reference the right variable
 * instead of inventing a hex.
 */
const LAYOUT_WALK = `  try {
    let budget = 400;
    const SKIP = { VECTOR: 1, ELLIPSE: 1, LINE: 1, STAR: 1, POLYGON: 1, BOOLEAN_OPERATION: 1, SLICE: 1 };

    const boundNames = (n) => {
      const bv = n.boundVariables;
      if (!bv) { return undefined; }
      const out = {};
      for (const key of Object.keys(bv)) {
        const entry = Array.isArray(bv[key]) ? bv[key][0] : bv[key];
        const name = entry && entry.id ? varNames[entry.id] : null;
        if (name) { out[key] = name; }
      }
      return Object.keys(out).length ? out : undefined;
    };

    const describe = (n, depth) => {
      if (budget <= 0 || depth > 8) { return null; }
      if (n.visible === false || SKIP[n.type]) { return null; }
      budget -= 1;

      const d = { name: String(n.name).slice(0, 60), type: n.type };
      if (typeof n.width === 'number') { d.width = Math.round(n.width); }
      if (typeof n.height === 'number') { d.height = Math.round(n.height); }

      if (n.layoutMode === 'HORIZONTAL' || n.layoutMode === 'VERTICAL') {
        d.layout = n.layoutMode.toLowerCase();
        if (n.itemSpacing) { d.gap = Math.round(n.itemSpacing); }
        const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((p) => Math.round(p || 0));
        if (pad.some((p) => p > 0)) { d.padding = pad; }
        if (n.primaryAxisAlignItems && n.primaryAxisAlignItems !== 'MIN') { d.justify = n.primaryAxisAlignItems; }
        if (n.counterAxisAlignItems && n.counterAxisAlignItems !== 'MIN') { d.align = n.counterAxisAlignItems; }
      }

      if (n.type === 'TEXT' && typeof n.characters === 'string') {
        d.text = n.characters.replace(/\\s+/g, ' ').trim().slice(0, 120);
        // Figma names a text layer after its own content, so the name is a
        // prefix of the text. Repeating it cost ~9% of the payload.
        if (d.text.indexOf(d.name) === 0) { delete d.name; }
        // A text node's box is derived from its style and its container.
        delete d.width;
        delete d.height;
      }
      if (typeof n.textStyleId === 'string' && styleNames[n.textStyleId]) { d.style = styleNames[n.textStyleId]; }

      const bound = boundNames(n);
      if (bound) { d.bound = bound; }

      // An instance is a reuse of a component: the component's name carries
      // the meaning, and its internals would repeat for every instance.
      if (n.type === 'INSTANCE') { return d; }

      if (Array.isArray(n.children) && n.children.length > 0) {
        const kids = [];
        for (const c of n.children) {
          const child = describe(c, depth + 1);
          if (child) { kids.push(child); }
          if (budget <= 0) { break; }
        }
        if (kids.length) {
          d.children = kids;
          // A container's height is whatever its contents come to; only a
          // leaf (an image placeholder, a spacer) has a height worth stating.
          delete d.height;
        }
      }
      return d;
    };

    for (const a of artboards) {
      if (wantedLayouts && wantedLayouts.indexOf(a.node.name) < 0) { continue; }
      const root = describe(a.node, 0);
      if (root) { layouts.push({ page: a.page, root: root }); }
      if (budget <= 0) { summary.layoutTruncated = true; break; }
    }
  } catch (e) {
    layouts.length = 0;
    summary.layoutError = (e && e.message) ? e.message : String(e);
  }
  summary.layouts = layouts.length;`;

export type ExtractorOptions = {
  /** Capture a structural outline of each artboard as well as the tokens. */
  includeLayouts?: boolean;
  /**
   * Include the full variable and text-style detail. Turn this off when the
   * tokens are already cached and only layouts are wanted: at ~12.7KB it eats
   * most of the ~20KB the payload channel allows, leaving no room for a
   * layout tree. The variables are still read either way — the layout walk
   * needs their names to report which token is bound where.
   */
  includeTokens?: boolean;
  /**
   * Artboards to walk, by name. Omit for all of them. Three breakpoints of
   * one page mostly repeat each other, and the responsive differences are
   * already captured in the variable modes, so one is usually enough.
   */
  layoutNames?: string[];
};

/**
 * Builds the extractor for one delivery mode.
 *
 * @param deliver `"return"` hands the payload back as the script's value;
 *   `"throw"` raises it as an Error, which every client surfaces verbatim.
 * @param options What to capture, and how much of it.
 */
export function buildExtractorScript(deliver: DeliveryMode, options: ExtractorOptions = {}): string {
  const wanted = options.layoutNames && options.layoutNames.length > 0
    ? JSON.stringify(options.layoutNames)
    : "null";

  const body = EXTRACTOR_BODY
    .replace("LAYOUT_BLOCK", options.includeLayouts ? LAYOUT_WALK : "")
    .replace("WANTED_LAYOUTS", wanted)
    .replace("INCLUDE_TOKENS", options.includeTokens === false ? "false" : "true")
    .replace("SENTINEL_LITERAL", JSON.stringify(SENTINEL));
  const tail = deliver === "throw"
    ? "// Deliberate — see the header. This is how the results get back.\nthrow new Error(__lcPayload);"
    : "__lcPayload;";
  return `${EXTRACTOR_HEADER}\n\n${body}\n${tail}\n`;
}

/**
 * Marks probe output. Distinct from `SENTINEL` so a probe result can never be
 * mistaken for a token report by `readExtractorResult`.
 */
export const PROBE_SENTINEL = "LC_FIGMA_PROBE_V1:";

/**
 * Builds a diagnostic script that reports what the Plugin API actually offers
 * inside `use_figma`.
 *
 * The extractor's frame walk comes back empty — `summary.frames: 0` proves the
 * code ran and kept nothing — but its `try/catch` swallows the reason, and
 * every richer use of the Plugin API (a structural outline of the layouts,
 * for instance) depends on the same traversal. This answers the question for
 * one metered call.
 *
 * Deliberately tiny and deliberately noisy about failure: each step is caught
 * separately and its error message recorded, so one restricted call cannot
 * hide the rest. Output is capped so the payload cannot itself truncate.
 */
export function buildProbeScript(): string {
  return `/* ---------------------------------------------------------------------------
 * Learning Copilot — Figma API probe (diagnostic)
 *
 * WHAT THIS DOES: reports which parts of the Figma Plugin API are reachable
 * here, and how many pages and top-level layers this file has.
 *
 * IT DOES NOT CHANGE YOUR DESIGN, and it reads no content — only names,
 * types and counts.
 *
 * IT ENDS BY THROWING AN ERROR ON PURPOSE: Figma discards return values, so
 * results come back as error text. Seeing that error means it worked.
 * ------------------------------------------------------------------------ */

const out = { api: {}, pages: [], errors: [] };
const msg = (e) => (e && e.message) ? e.message : String(e);

try {
  out.api = {
    editorType: figma.editorType,
    mode: figma.mode,
    hasRoot: typeof figma.root !== 'undefined',
    hasCurrentPage: typeof figma.currentPage !== 'undefined',
    hasLoadAllPages: typeof figma.loadAllPagesAsync === 'function',
    hasVariablesApi: !!(figma.variables && typeof figma.variables.getLocalVariableCollectionsAsync === 'function'),
    hasTextStylesApi: typeof figma.getLocalTextStylesAsync === 'function',
  };
} catch (e) { out.errors.push('api probe: ' + msg(e)); }

// Newer API versions load pages lazily; reaching page children without this
// throws, which is the leading suspect for the empty frame list.
try {
  if (typeof figma.loadAllPagesAsync === 'function') {
    await figma.loadAllPagesAsync();
    out.api.loadAllPagesOk = true;
  }
} catch (e) { out.errors.push('loadAllPagesAsync: ' + msg(e)); }

try {
  const pages = figma.root.children;
  out.api.pageCount = pages.length;
  for (const page of pages.slice(0, 20)) {
    const entry = { name: page.name, childCount: null, types: {}, sample: [] };
    try {
      const kids = page.children;
      entry.childCount = kids.length;
      for (const n of kids) { entry.types[n.type] = (entry.types[n.type] || 0) + 1; }
      for (const n of kids.slice(0, 5)) {
        entry.sample.push({
          name: String(n.name).slice(0, 40),
          type: n.type,
          width: typeof n.width === 'number' ? Math.round(n.width) : null,
        });
      }
    } catch (e) { entry.error = msg(e); }
    out.pages.push(entry);
  }
} catch (e) { out.errors.push('figma.root.children: ' + msg(e)); }

// Fallback route: if only the open page is reachable, a traversal is still
// possible, just scoped to whatever the student has selected.
try {
  out.currentPage = { name: figma.currentPage.name, childCount: figma.currentPage.children.length };
} catch (e) { out.errors.push('figma.currentPage: ' + msg(e)); }

throw new Error(${JSON.stringify(PROBE_SENTINEL)} + JSON.stringify(out));
`;
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
