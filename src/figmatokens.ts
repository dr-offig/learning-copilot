/**
 * Figma design tokens → CSS custom properties.
 *
 * The input is the token report produced by walking the Figma Plugin API
 * (`figma.variables.getLocalVariableCollectionsAsync()` and friends), which —
 * unlike the MCP server's flattened `get_variable_defs` output — preserves the
 * real token graph: collections, named modes, and `VARIABLE_ALIAS` values.
 *
 * The transform is deliberately mechanical, with no model in the loop. A
 * design system is a few hundred exact strings; a model that silently drops or
 * renames one produces CSS that looks right and isn't. Everything here is a
 * pure function over the report, so the counts it emits can be checked against
 * the counts the extractor saw (see `stats` and the summary cross-check).
 *
 * The shape of the output follows the two-layer convention:
 *
 *   - Primitive tokens (collections with no aliases) become fixed literals.
 *   - Semantic tokens become `var(...)` references to primitives, emitted once
 *     for the collection's first mode and overridden per additional mode.
 *
 * This module must stay free of `vscode` imports so it can be unit-tested
 * outside VS Code.
 */

//#region <REPORT TYPES>

/** One mode's value for a variable: either a literal or a pointer at another variable. */
export type FigmaModeValue =
  | {
    mode: string;
    kind: "literal";
    /** Pre-formatted CSS value (`#F1EBFF`, `1.5rem`) or a bare number. */
    value: string | number | null;
    /** Appended to numeric values. Set by the extractor; never guessed here. */
    unit?: string;
  }
  | { mode: string; kind: "alias"; aliasTarget: string };

export type FigmaVariableReport = {
  /** Figma variable name, e.g. `Purple/100` or `Highlight on Surface`. */
  name: string;
  resolvedType?: string;
  valuesByMode: FigmaModeValue[];
};

export type FigmaCollectionReport = {
  collection: string;
  /** Mode names in Figma's order. The first is treated as the base mode. */
  modes: string[];
  variables: FigmaVariableReport[];
};

/**
 * A Figma text style. Numeric fields are emitted with a `px` unit; send a
 * string when the value is not pixels (`"120%"`, `"1.5"`, `"normal"`).
 */
export type FigmaTextStyleReport = {
  name: string;
  fontFamily?: string;
  fontWeight?: string | number;
  /** `italic` when the Figma font style says so; absent otherwise. */
  fontStyle?: string;
  fontSize?: string | number;
  lineHeight?: string | number;
  letterSpacing?: string | number;
  /** Figma's `UPPER` / `LOWER` / `TITLE` / `ORIGINAL`, or a CSS value. */
  textCase?: string;
  textDecoration?: string;
};

/**
 * A top-level artboard. Carries no CSS of its own — it exists so a breakpoint
 * can be suggested from the design's actual layout widths rather than guessed
 * at by the student.
 */
export type FigmaFrameReport = {
  name: string;
  width: number;
  height?: number;
  page?: string;
};

/**
 * One node of an artboard's structure. `bound` names the design token applied
 * to a property (`{ fills: "Surface", itemSpacing: "Space/Medium" }`), which is
 * what lets generated CSS reference the right variable rather than a raw value.
 */
export type FigmaLayoutNode = {
  /** Absent on text layers whose Figma name merely repeated their content. */
  name?: string;
  type: string;
  width?: number;
  height?: number;
  /** Auto-layout direction, absent when the frame is freely positioned. */
  layout?: string;
  gap?: number;
  /** `[top, right, bottom, left]`, omitted when all zero. */
  padding?: number[];
  justify?: string;
  align?: string;
  text?: string;
  /** Applied text style name. */
  style?: string;
  /** Property name → bound variable name. */
  bound?: Record<string, string>;
  children?: FigmaLayoutNode[];
};

export type FigmaLayoutReport = {
  page?: string;
  root: FigmaLayoutNode;
};

/**
 * What the extractor reported about its own run. The first three are
 * cross-checked against what the emitter produces; the rest explain what the
 * best-effort parts of the walk managed, so a thin result can be diagnosed
 * from the cached JSON rather than by spending another metered call.
 */
export type FigmaReportSummary = {
  aliasModeValues?: number;
  literalModeValues?: number;
  textStyles?: number;
  totalCollections?: number;
  totalVariables?: number;
  frames?: number;
  /** Why the artboard scan found nothing, if it failed outright. */
  frameError?: string;
  layouts?: number;
  /** Why the structural walk found nothing, if it failed outright. */
  layoutError?: string;
  /** Set when the node budget ran out mid-walk. */
  layoutTruncated?: boolean;
  /** Artboards shed to keep the payload inside the response limit. */
  layoutsDropped?: number;
};

export type FigmaTokenReport = {
  collections: FigmaCollectionReport[];
  textStyles?: FigmaTextStyleReport[];
  /** Advisory only; `emitTokensCss` ignores these. */
  frames?: FigmaFrameReport[];
  /** Structural outline per artboard; `emitTokensCss` ignores these too. */
  layouts?: FigmaLayoutReport[];
  summary?: FigmaReportSummary;
};

//#endregion

//#region <OPTIONS>

/** Where a mode's declarations land in the cascade. */
export type ModeCondition =
  | { kind: "base" }
  | { kind: "media"; query: string }
  | { kind: "selector"; selector: string };

export type EmitCssOptions = {
  /** Prefix for literal-valued tokens. A category word is appended. */
  primitivePrefix?: string;
  /** Prefix for tokens that reference other tokens. A category word is appended. */
  semanticPrefix?: string;
  /**
   * Category word per collection name, overriding the one inferred from the
   * collection's `resolvedType` — e.g. `{ "Font Sizes and Spacing": "size" }`.
   */
  categories?: Record<string, string>;
  /** Category used when the extractor reported no `resolvedType`. */
  defaultCategory?: string;
  textStylePrefix?: string;
  /** Class prefix used when emitting text-style utility classes. */
  textStyleClassPrefix?: string;
  /**
   * Explicit mode → cascade mapping, overriding inference. Keyed by
   * `"Collection::Mode"` for one collection, or `"Mode"` for every collection.
   */
  modeConditions?: Record<string, ModeCondition>;
  textStyleOutput?: "properties" | "classes" | "both";
  indent?: string;
};

type ResolvedOptions = Required<Omit<EmitCssOptions, "modeConditions" | "categories">> &
  Pick<EmitCssOptions, "modeConditions" | "categories">;

const DEFAULTS: ResolvedOptions = {
  primitivePrefix: "--primitive-",
  semanticPrefix: "--",
  defaultCategory: "color",
  textStylePrefix: "--text-",
  textStyleClassPrefix: "text-",
  textStyleOutput: "both",
  indent: "  ",
};

/**
 * Figma's variable types mapped to the word that goes in the custom property
 * name. A colour file therefore keeps the familiar `--primitive-color-*` /
 * `--color-*` naming, while a "Font Sizes and Spacing" collection of FLOATs
 * lands under `--primitive-size-*` instead of being mislabelled a colour.
 */
const CATEGORY_BY_RESOLVED_TYPE: Record<string, string> = {
  COLOR: "color",
  FLOAT: "size",
  STRING: "string",
  BOOLEAN: "flag",
};

//#endregion

//#region <RESULT TYPES>

export type EmitStats = {
  collections: number;
  primitiveVariables: number;
  semanticVariables: number;
  /** Literal mode values seen in the report (comparable to the extractor's count). */
  literalModeValues: number;
  /** Alias mode values seen in the report (comparable to the extractor's count). */
  aliasModeValues: number;
  /** Alias mode values per mode name, aggregated across collections. */
  aliasesByMode: Record<string, number>;
  /** Declarations actually written, after dropping overrides equal to the base. */
  emittedDeclarations: number;
  textStyles: number;
};

export type EmitCssResult = {
  css: string;
  /** Recoverable problems: the CSS is still usable. */
  warnings: string[];
  /** Tokens that could not be emitted. */
  errors: string[];
  stats: EmitStats;
};

//#endregion

//#region <NAMING>

/**
 * Figma names (`Purple/100`, `on Background`, `fontSize`) → CSS identifier
 * fragments (`purple-100`, `on-background`, `font-size`).
 */
export function toKebabCase(name: string): string {
  return name
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1-$2")
    // A digit followed by a capital is only a word boundary when a lowercase
    // letter follows, which separates `Heading1Size` (→ `heading1-size`) from
    // the size names design systems use, `2X Large` and `3XL` (→ `2x-large`,
    // `3xl`), where the capital belongs to the preceding digit.
    .replace(/(\p{N})(\p{Lu})(?=\p{Ll})/gu, "$1-$2")
    // Keep any Unicode letter or digit: CSS identifiers allow them, and
    // stripping to ASCII would mangle `Röd/100` into `r-d-100` and collapse
    // a non-Latin name to nothing at all.
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

//#endregion

//#region <PARSING>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseModeValue(raw: unknown, where: string): FigmaModeValue {
  if (!isRecord(raw) || typeof raw.mode !== "string") {
    throw new Error(`${where}: every mode value needs a 'mode' name.`);
  }
  const mode = raw.mode;
  if (raw.kind === "alias") {
    if (typeof raw.aliasTarget !== "string" || !raw.aliasTarget.trim()) {
      throw new Error(`${where}: alias value for mode '${mode}' has no aliasTarget.`);
    }
    return { mode, kind: "alias", aliasTarget: raw.aliasTarget };
  }
  const value = raw.value;
  if (value !== null && typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${where}: literal value for mode '${mode}' must be a string, number, or null.`);
  }
  return {
    mode,
    kind: "literal",
    value: value ?? null,
    ...(typeof raw.unit === "string" ? { unit: raw.unit } : {}),
  };
}

/**
 * Validates an untrusted token report (it arrives as JSON parsed out of an MCP
 * tool result) and narrows it to `FigmaTokenReport`.
 *
 * @param raw Parsed JSON from the extractor.
 * @throws If the report is not shaped like a token report at all.
 */
export function parseFigmaTokenReport(raw: unknown): FigmaTokenReport {
  if (!isRecord(raw) || !Array.isArray(raw.collections)) {
    throw new Error("Token report has no 'collections' array.");
  }

  const collections: FigmaCollectionReport[] = raw.collections.map((c, ci) => {
    const where = `collections[${ci}]`;
    if (!isRecord(c) || typeof c.collection !== "string") {
      throw new Error(`${where}: missing 'collection' name.`);
    }
    if (!Array.isArray(c.modes) || c.modes.some((m) => typeof m !== "string")) {
      throw new Error(`${where}: 'modes' must be an array of mode names.`);
    }
    if (!Array.isArray(c.variables)) {
      throw new Error(`${where}: 'variables' must be an array.`);
    }
    return {
      collection: c.collection,
      modes: c.modes as string[],
      variables: c.variables.map((v, vi) => {
        const vWhere = `${where}.variables[${vi}]`;
        if (!isRecord(v) || typeof v.name !== "string") {
          throw new Error(`${vWhere}: missing variable 'name'.`);
        }
        if (!Array.isArray(v.valuesByMode)) {
          throw new Error(`${vWhere}: missing 'valuesByMode'.`);
        }
        return {
          name: v.name,
          ...(typeof v.resolvedType === "string" ? { resolvedType: v.resolvedType } : {}),
          valuesByMode: v.valuesByMode.map((mv) => parseModeValue(mv, vWhere)),
        };
      }),
    };
  });

  const textStyles: FigmaTextStyleReport[] = Array.isArray(raw.textStyles)
    ? raw.textStyles.filter(isRecord).filter((s) => typeof s.name === "string").map((s) => s as FigmaTextStyleReport)
    : [];

  // Frames are best-effort context, so anything malformed is dropped rather
  // than failing an import whose variables are perfectly good.
  const frames: FigmaFrameReport[] = Array.isArray(raw.frames)
    ? raw.frames
      .filter(isRecord)
      .filter((f) => typeof f.name === "string" && typeof f.width === "number" && Number.isFinite(f.width))
      .map((f) => ({
        name: f.name as string,
        width: f.width as number,
        ...(typeof f.height === "number" && Number.isFinite(f.height) ? { height: f.height } : {}),
        ...(typeof f.page === "string" ? { page: f.page } : {}),
      }))
    : [];

  const layouts: FigmaLayoutReport[] = Array.isArray(raw.layouts)
    ? raw.layouts
      .filter(isRecord)
      .filter((l) => isRecord(l.root) && typeof (l.root as any).name === "string")
      .map((l) => ({
        ...(typeof l.page === "string" ? { page: l.page } : {}),
        root: l.root as FigmaLayoutNode,
      }))
    : [];

  return {
    collections,
    ...(textStyles.length > 0 ? { textStyles } : {}),
    ...(frames.length > 0 ? { frames } : {}),
    ...(layouts.length > 0 ? { layouts } : {}),
    ...(isRecord(raw.summary) ? { summary: raw.summary as FigmaReportSummary } : {}),
  };
}

/**
 * Narrowest width treated as a possible viewport. Below this a frame is some
 * other kind of artwork, and the case that matters is icons: component
 * libraries routinely contain 24px icons named `Phone`, `Tablet` and
 * `Desktop`, and several variants of one will outnumber the single real
 * layout frame it shares a name with.
 */
const MIN_LAYOUT_WIDTH = 240;

/**
 * Finds the artboards a Figma mode may have been designed at, so a breakpoint
 * can be offered from the design instead of guessed. Matches every word of the
 * mode name against the frame's words, so a `Tablet` mode finds `Tablet`,
 * `Tablet — Home` or `Home / Tablet` but never `Desktop`.
 *
 * Returns one representative per distinct width, best first: most frequent
 * wins, then narrowest. Frequency because a layout usually has one artboard
 * per page while an annotation has one; narrowest because these become
 * `max-width` breakpoints for a non-default mode, so the real layout is the
 * narrow one and a too-narrow breakpoint merely under-applies while a
 * too-wide one swallows the desktop layout.
 *
 * Several widths coming back means the design is genuinely ambiguous — a spec
 * or annotation frame carrying the mode's name beside the real layout — and
 * the caller should offer the choice rather than pick.
 *
 * @param frames Frames captured alongside the variables.
 * @param mode Figma mode name.
 */
export function findFrameCandidatesForMode(
  frames: FigmaFrameReport[] | undefined,
  mode: string
): FigmaFrameReport[] {
  const modeWords = toKebabCase(mode).split("-").filter(Boolean);
  if (modeWords.length === 0 || !frames || frames.length === 0) { return []; }

  const matches = frames.filter((f) => {
    if (f.width < MIN_LAYOUT_WIDTH) { return false; }
    const words = new Set(toKebabCase(f.name).split("-").filter(Boolean));
    return modeWords.every((w) => words.has(w));
  });

  const byWidth = new Map<number, FigmaFrameReport[]>();
  for (const f of matches) {
    const group = byWidth.get(f.width);
    if (group) { group.push(f); } else { byWidth.set(f.width, [f]); }
  }

  return [...byWidth.values()]
    .sort((a, b) => b.length - a.length || a[0].width - b[0].width)
    .map((group) => group[0]);
}

//#endregion

//#region <EMITTER>

type CollectionRole = "primitive" | "semantic";

/**
 * A collection is semantic when anything in it points at another token. This
 * is derived from the data rather than from collection names, which vary
 * between design systems ("Semantic Colours", "Tokens", "Theme", …).
 */
function classifyCollection(collection: FigmaCollectionReport): CollectionRole {
  const hasAlias = collection.variables.some((v) => v.valuesByMode.some((mv) => mv.kind === "alias"));
  return hasAlias ? "semantic" : "primitive";
}

/**
 * The category word for a collection: an explicit override, else the most
 * common `resolvedType` among its variables, else the default. Extractors that
 * omit `resolvedType` fall back to the default, which keeps colour-only
 * reports naming their properties exactly as before.
 */
function categoryForCollection(collection: FigmaCollectionReport, opts: ResolvedOptions): string {
  const override = opts.categories?.[collection.collection];
  if (override) { return override; }

  const counts = new Map<string, number>();
  for (const v of collection.variables) {
    if (!v.resolvedType) { continue; }
    const category = CATEGORY_BY_RESOLVED_TYPE[v.resolvedType] ?? toKebabCase(v.resolvedType);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [category, count] of counts) {
    if (count > bestCount) { best = category; bestCount = count; }
  }
  return best ?? opts.defaultCategory;
}

/**
 * Maps a non-base mode onto a cascade context. Only the light/dark convention
 * can be inferred safely; anything else (breakpoints, brands, densities) gets
 * a `data-mode` attribute hook and a warning, so the caller can offer the
 * student a real choice instead of this module inventing a media query.
 */
function inferModeCondition(mode: string): ModeCondition {
  const k = toKebabCase(mode);
  if (k === "dark") { return { kind: "media", query: "(prefers-color-scheme: dark)" }; }
  if (k === "light") { return { kind: "media", query: "(prefers-color-scheme: light)" }; }
  return { kind: "selector", selector: `:root[data-mode="${k}"]` };
}

function conditionKey(condition: ModeCondition): string {
  switch (condition.kind) {
    case "base": return "base";
    case "media": return `media:${condition.query}`;
    case "selector": return `selector:${condition.selector}`;
  }
}

type Declaration = { prop: string; value: string; group?: string };
type Bucket = { condition: ModeCondition; decls: Declaration[]; rank: number };

/** Width in px for a `(max-width: …)` / `(min-width: …)` query, if it has one. */
function mediaWidthBound(query: string): { kind: "max" | "min"; px: number } | null {
  const m = /\((max|min)-width:\s*([0-9.]+)(px|rem|em)\)/.exec(query);
  if (!m) { return null; }
  const scale = m[3] === "px" ? 1 : 16;
  return { kind: m[1] as "max" | "min", px: parseFloat(m[2]) * scale };
}

/**
 * Overlapping width queries have equal specificity, so the last one in the
 * file wins. `max-width` blocks must therefore run widest → narrowest and
 * `min-width` blocks narrowest → widest; the reverse silently applies tablet
 * values on a phone. Ordering comes from the caller's `modeConditions`, so
 * this only reports the mistake rather than reordering behind their back.
 */
function checkCascadeOrder(buckets: Bucket[], warnings: string[]): void {
  for (const kind of ["max", "min"] as const) {
    const bounds = buckets
      .map((b) => (b.condition.kind === "media" ? { q: b.condition.query, b: mediaWidthBound(b.condition.query) } : null))
      .filter((x): x is { q: string; b: { kind: "max" | "min"; px: number } } => !!x && !!x.b && x.b.kind === kind);

    for (let i = 1; i < bounds.length; i++) {
      const prev = bounds[i - 1];
      const cur = bounds[i];
      const wrong = kind === "max" ? cur.b.px > prev.b.px : cur.b.px < prev.b.px;
      if (wrong) {
        warnings.push(
          `'${cur.q}' is emitted after '${prev.q}', so it overrides it on overlapping screens. ` +
          `List ${kind === "max" ? "wider max-width" : "narrower min-width"} modes first in modeConditions.`
        );
      }
    }
  }
}

/**
 * Rejects values that would escape their declaration. A Figma STRING variable
 * holding `red; } body { display:none` would otherwise close the `:root` rule
 * and inject a new one, taking the whole stylesheet with it. Quoted content is
 * fine — only unquoted structural characters can break out.
 */
function isSafeCssValue(value: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ";" || ch === "{" || ch === "}") { return false; }
    if (ch === "/" && value[i + 1] === "*") { return false; }
  }
  return quote === null;   // an unterminated quote would swallow what follows
}

const VAR_REF_RE = /var\(\s*(--[^),\s]+)/g;

/**
 * Custom properties that reference each other in a loop are invalid at
 * computed-value time: every property in the cycle resolves to nothing, so the
 * page renders unstyled with no error anywhere. Cheap to detect, near
 * impossible for a student to diagnose unaided.
 */
function findAliasCycles(buckets: Bucket[]): string[][] {
  const edges = new Map<string, Set<string>>();
  for (const bucket of buckets) {
    for (const d of bucket.decls) {
      let refs = edges.get(d.prop);
      if (!refs) { refs = new Set(); edges.set(d.prop, refs); }
      for (const m of d.value.matchAll(VAR_REF_RE)) { refs.add(m[1]); }
    }
  }

  const cycles: string[][] = [];
  const reported = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];

  const visit = (node: string): void => {
    const s = state.get(node);
    if (s === "done") { return; }
    if (s === "open") {
      const cycle = stack.slice(stack.indexOf(node));
      const key = [...cycle].sort().join(">");
      if (!reported.has(key)) { reported.add(key); cycles.push(cycle); }
      return;
    }
    state.set(node, "open");
    stack.push(node);
    for (const next of edges.get(node) ?? []) { visit(next); }
    stack.pop();
    state.set(node, "done");
  };

  for (const node of edges.keys()) { visit(node); }
  return cycles;
}

function formatLiteral(mv: Extract<FigmaModeValue, { kind: "literal" }>): string | null {
  if (mv.value === null) { return null; }
  if (typeof mv.value === "number") { return `${formatNumber(mv.value)}${mv.unit ?? ""}`; }
  const trimmed = mv.value.trim();
  return trimmed === "" ? null : trimmed;
}

const TEXT_CASE_TO_TRANSFORM: Record<string, string> = {
  UPPER: "uppercase",
  LOWER: "lowercase",
  TITLE: "capitalize",
  ORIGINAL: "none",
};

const FONT_WEIGHTS: Record<string, number> = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
  normal: 400, regular: 400, book: 400, medium: 500, semibold: 600,
  demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};

/** Longest first, so `semibold` and `extrabold` win over `bold`. */
const FONT_WEIGHT_NAMES = Object.keys(FONT_WEIGHTS).sort((a, b) => b.length - a.length);

/**
 * Figma reports weights as font style names — `Regular`, `SemiBold`, and
 * decorated ones like `9pt Regular` — none of which are valid CSS weights.
 * An unrecognised name is passed through rather than dropped: an unusable
 * value that shows up in devtools beats one that vanishes silently.
 */
function normalizeFontWeight(weight: string | number): string | number {
  if (typeof weight === "number") { return weight; }
  const key = weight.toLowerCase().replace(/italic|oblique/g, "").replace(/[^a-z]/g, "");
  if (FONT_WEIGHTS[key] !== undefined) { return FONT_WEIGHTS[key]; }
  for (const name of FONT_WEIGHT_NAMES) {
    if (key.includes(name)) { return FONT_WEIGHTS[name]; }
  }
  return weight;
}

/** Figma emits float noise (`1.2000000476837158`); 4dp is ample for CSS. */
function formatNumber(n: number): string {
  return String(Math.round(n * 1e4) / 1e4);
}

function formatTextStyleValue(value: string | number, unit: string): string {
  return typeof value === "number" ? `${formatNumber(value)}${unit}` : value.trim();
}

/**
 * `Playfair Display` is legal unquoted, but a family whose name starts with a
 * digit or carries punctuation is not. Quoting every multi-word family costs
 * nothing and removes the class of problem.
 */
function formatFontFamily(family: string): string {
  const trimmed = family.trim();
  if (/^["']/.test(trimmed) || /^[a-zA-Z-][a-zA-Z0-9_-]*$/.test(trimmed)) { return trimmed; }
  return `"${trimmed.replace(/"/g, '\\"')}"`;
}

/**
 * Reorders each collection's modes so the chosen base mode comes first, which
 * is the one the emitter puts in `:root`. Figma's own mode order is arbitrary,
 * so which mode is "the default" is a decision the caller has to supply.
 *
 * @param report Token report to reorder.
 * @param baseModes Chosen base mode per collection name.
 */
export function applyBaseModes(report: FigmaTokenReport, baseModes: Record<string, string>): FigmaTokenReport {
  return {
    ...report,
    collections: report.collections.map((c) => {
      const base = baseModes[c.collection];
      if (!base || !c.modes.includes(base) || c.modes[0] === base) { return c; }
      return { ...c, modes: [base, ...c.modes.filter((m) => m !== base)] };
    }),
  };
}

/**
 * Sorts mode conditions into a cascade-safe order — widest `max-width` first,
 * narrowest `min-width` first — since `emitTokensCss` emits override blocks in
 * the key order it is given. It warns when the order is wrong; running the
 * conditions through here first means that warning never has to fire.
 *
 * Conditions without a width bound keep their relative order.
 *
 * @param conditions Mode conditions keyed as the emitter expects.
 */
export function orderModeConditions(conditions: Record<string, ModeCondition>): Record<string, ModeCondition> {
  const boundOf = (c: ModeCondition) => (c.kind === "media" ? mediaWidthBound(c.query) : null);

  const sorted = Object.entries(conditions)
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const wa = boundOf(a.entry[1]);
      const wb = boundOf(b.entry[1]);
      if (!wa || !wb || wa.kind !== wb.kind) { return a.i - b.i; }
      return (wa.kind === "max" ? wb.px - wa.px : wa.px - wb.px) || a.i - b.i;
    })
    .map((x) => x.entry);

  return Object.fromEntries(sorted);
}

/**
 * Turns a Figma token report into a CSS stylesheet.
 *
 * @param report Token report from the Plugin API extractor.
 * @param options Naming and mode-mapping overrides.
 */
export function emitTokensCss(report: FigmaTokenReport, options: EmitCssOptions = {}): EmitCssResult {
  const opts = { ...DEFAULTS, ...options };
  const warnings: string[] = [];
  const errors: string[] = [];

  const roles = new Map<string, CollectionRole>();
  for (const c of report.collections) {
    roles.set(c.collection, classifyCollection(c));
  }

  const totalVariables = report.collections.reduce((n, c) => n + c.variables.length, 0);
  if (totalVariables === 0) {
    warnings.push(
      "No variables found. The Figma file may have no local variables, or the extraction returned nothing — " +
      "check the report before assuming the design has no tokens."
    );
  }

  // Index every variable by name so aliases resolve to the right prefix —
  // a semantic token aliasing another semantic token must reference
  // `--color-*`, not `--primitive-color-*`.
  const index = new Map<string, { prop: string; collection: string }>();
  let unnamedCount = 0;
  for (const c of report.collections) {
    const base = roles.get(c.collection) === "primitive" ? opts.primitivePrefix : opts.semanticPrefix;
    const prefix = `${base}${categoryForCollection(c, opts)}-`;
    for (const v of c.variables) {
      // A name made entirely of punctuation would yield the bare prefix,
      // which is not a valid custom property. Keep the token under a
      // positional name rather than dropping it.
      let slug = toKebabCase(v.name);
      if (!slug) {
        slug = `unnamed-${++unnamedCount}`;
        warnings.push(`Variable '${v.name}' in '${c.collection}' has no characters usable in a CSS name; emitted as ${prefix}${slug}.`);
      }
      const prop = `${prefix}${slug}`;
      const clash = index.get(v.name);
      if (clash) {
        warnings.push(`Duplicate variable name '${v.name}' in '${c.collection}' and '${clash.collection}'; the first one wins.`);
        continue;
      }
      for (const [otherName, entry] of index) {
        if (entry.prop === prop) {
          warnings.push(`'${v.name}' and '${otherName}' both map to ${prop}; rename one in Figma.`);
          break;
        }
      }
      index.set(v.name, { prop, collection: c.collection });
    }
  }

  const stats: EmitStats = {
    collections: report.collections.length,
    primitiveVariables: 0,
    semanticVariables: 0,
    literalModeValues: 0,
    aliasModeValues: 0,
    aliasesByMode: {},
    emittedDeclarations: 0,
    textStyles: 0,
  };

  // Buckets are keyed by cascade context and kept in first-seen order so the
  // output is deterministic for a given report.
  const buckets = new Map<string, Bucket>();
  buckets.set("base", { condition: { kind: "base" }, decls: [], rank: -1 });

  // Override blocks are emitted in the order their modes are declared in
  // `modeConditions`, because with overlapping media queries source order
  // decides the winner. Modes not listed there keep first-seen order.
  const declaredRank = new Map<string, number>();
  Object.values(opts.modeConditions ?? {}).forEach((condition, i) => {
    const key = conditionKey(condition);
    if (!declaredRank.has(key)) { declaredRank.set(key, i); }
  });

  const bucketFor = (condition: ModeCondition): Bucket => {
    const key = conditionKey(condition);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { condition, decls: [], rank: declaredRank.get(key) ?? Number.MAX_SAFE_INTEGER };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const resolveCondition = (collection: string, mode: string, isBase: boolean): ModeCondition => {
    if (isBase) { return { kind: "base" }; }
    const explicit = opts.modeConditions?.[`${collection}::${mode}`] ?? opts.modeConditions?.[mode];
    if (explicit) { return explicit; }
    const inferred = inferModeCondition(mode);
    if (inferred.kind === "selector") {
      warnings.push(
        `Mode '${mode}' in '${collection}' has no known CSS mapping; emitted as ${inferred.selector}. ` +
        "Pass modeConditions to map it to a media query."
      );
    }
    return inferred;
  };

  // Primitives first so the stylesheet reads top-down: fixed values, then the
  // semantic layer that references them.
  const ordered = [...report.collections].sort((a, b) => {
    const rank = (c: FigmaCollectionReport) => (roles.get(c.collection) === "primitive" ? 0 : 1);
    return rank(a) - rank(b);
  });

  for (const c of ordered) {
    const role = roles.get(c.collection)!;
    if (role === "primitive") {
      stats.primitiveVariables += c.variables.length;
    } else {
      stats.semanticVariables += c.variables.length;
    }

    const modes = c.modes.length > 0 ? c.modes : [...new Set(c.variables.flatMap((v) => v.valuesByMode.map((mv) => mv.mode)))];
    if (modes.length === 0) {
      warnings.push(`Collection '${c.collection}' declares no modes; skipped.`);
      continue;
    }

    // Values written for the base mode. A later mode whose value matches is
    // skipped: the base declaration already cascades into every context.
    const baseValues = new Map<string, string>();

    // A collection that mixes literals with aliases is perfectly workable —
    // the naming and the var() graph both come out right — so this is one
    // note per collection, not one per token.
    const mixedLiterals: string[] = [];

    modes.forEach((mode, modeIndex) => {
      const isBase = modeIndex === 0;
      const condition = resolveCondition(c.collection, mode, isBase);
      const bucket = bucketFor(condition);
      const groupLabel = isBase ? c.collection : `${c.collection} — ${mode}`;

      for (const v of c.variables) {
        const entry = index.get(v.name);
        if (!entry || entry.collection !== c.collection) { continue; }

        const mv = v.valuesByMode.find((x) => x.mode === mode);
        if (!mv) {
          warnings.push(`'${v.name}' has no value for mode '${mode}' in '${c.collection}'.`);
          continue;
        }

        let value: string | null;
        if (mv.kind === "alias") {
          stats.aliasModeValues++;
          stats.aliasesByMode[mode] = (stats.aliasesByMode[mode] ?? 0) + 1;
          const target = index.get(mv.aliasTarget);
          if (!target) {
            errors.push(`'${v.name}' (mode '${mode}') aliases '${mv.aliasTarget}', which is not in the report.`);
            continue;
          }
          value = `var(${target.prop})`;
        } else {
          stats.literalModeValues++;
          if (role === "semantic" && !mixedLiterals.includes(v.name)) {
            mixedLiterals.push(v.name);
          }
          value = formatLiteral(mv);
          if (value === null) {
            errors.push(`'${v.name}' (mode '${mode}') has an empty value.`);
            continue;
          }
        }

        if (!isSafeCssValue(value)) {
          errors.push(
            `'${v.name}' (mode '${mode}') has the value ${JSON.stringify(value)}, which would break out of the CSS rule; skipped.`
          );
          continue;
        }

        if (isBase) {
          baseValues.set(entry.prop, value);
        } else if (baseValues.get(entry.prop) === value) {
          continue;
        }

        bucket.decls.push({ prop: entry.prop, value, group: groupLabel });
        stats.emittedDeclarations++;
      }
    });

    if (mixedLiterals.length > 0) {
      const shown = mixedLiterals.slice(0, 3).map((n) => `'${n}'`).join(", ");
      const rest = mixedLiterals.length > 3 ? `, +${mixedLiterals.length - 3} more` : "";
      warnings.push(
        `'${c.collection}' mixes ${mixedLiterals.length} fixed value(s) in among its aliases (${shown}${rest}); ` +
        "those tokens will not change with the primitive layer."
      );
    }
  }

  const textStyles = report.textStyles ?? [];
  stats.textStyles = textStyles.length;

  const css = render(buckets, textStyles, opts, warnings, errors);

  crossCheckSummary(report.summary, stats, warnings);

  return { css, warnings, errors, stats };
}

/** Flags disagreement between what the extractor counted and what we emitted. */
function crossCheckSummary(summary: FigmaReportSummary | undefined, stats: EmitStats, warnings: string[]): void {
  if (!summary) { return; }
  const checks: Array<[string, number | undefined, number]> = [
    ["alias mode values", summary.aliasModeValues, stats.aliasModeValues],
    ["literal mode values", summary.literalModeValues, stats.literalModeValues],
    ["text styles", summary.textStyles, stats.textStyles],
  ];
  for (const [label, reported, seen] of checks) {
    if (typeof reported === "number" && reported !== seen) {
      warnings.push(`Report claims ${reported} ${label} but ${seen} were found; the extraction may be incomplete.`);
    }
  }
}

//#endregion

//#region <RENDERING>

function renderDeclarations(decls: Declaration[], indent: string): string[] {
  const lines: string[] = [];
  let group: string | undefined;
  for (const d of decls) {
    if (d.group && d.group !== group) {
      if (lines.length > 0) { lines.push(""); }
      lines.push(`${indent}/* ${d.group} */`);
      group = d.group;
    }
    lines.push(`${indent}${d.prop}: ${d.value};`);
  }
  return lines;
}

function renderTextStyles(
  styles: FigmaTextStyleReport[],
  opts: ResolvedOptions,
  warnings: string[],
  errors: string[]
): string[] {
  if (styles.length === 0) { return []; }

  const blocks: string[] = [];
  const propLines: string[] = [];
  const classBlocks: string[] = [];
  const wantProps = opts.textStyleOutput !== "classes";
  let unnamedStyles = 0;
  const wantClasses = opts.textStyleOutput !== "properties";

  for (const style of styles) {
    let slug = toKebabCase(style.name);
    if (!slug) {
      slug = `unnamed-${++unnamedStyles}`;
      warnings.push(`Text style '${style.name}' has no characters usable in a CSS name; emitted as ${opts.textStylePrefix}${slug}.`);
    }
    const base = `${opts.textStylePrefix}${slug}`;

    const weight = style.fontWeight === undefined ? undefined : normalizeFontWeight(style.fontWeight);
    if (typeof weight === "string") {
      warnings.push(`Text style '${style.name}' has font weight '${weight}', which is not a CSS weight; emitted as-is.`);
    }
    // Figma keeps italic in the font style name rather than as its own field.
    const fontStyle = style.fontStyle ?? (typeof style.fontWeight === "string" && /italic|oblique/i.test(style.fontWeight) ? "italic" : undefined);

    // [custom property suffix, CSS property, unit for numeric values]
    const fields: Array<[string, string, string, string | number | undefined]> = [
      ["font-family", "font-family", "", style.fontFamily ? formatFontFamily(style.fontFamily) : undefined],
      ["font-weight", "font-weight", "", weight],
      ["font-style", "font-style", "", fontStyle],
      ["font-size", "font-size", "px", style.fontSize],
      ["line-height", "line-height", "px", style.lineHeight],
      ["letter-spacing", "letter-spacing", "px", style.letterSpacing],
      ["text-transform", "text-transform", "", style.textCase ? (TEXT_CASE_TO_TRANSFORM[style.textCase] ?? style.textCase) : undefined],
      ["text-decoration", "text-decoration", "", style.textDecoration],
    ];

    const present = fields
      .filter(([, , , value]) => value !== undefined && value !== null && value !== "")
      .filter(([suffix, , unit, value]) => {
        if (isSafeCssValue(formatTextStyleValue(value!, unit))) { return true; }
        errors.push(`Text style '${style.name}' has a ${suffix} value that would break out of the CSS rule; skipped.`);
        return false;
      });
    if (present.length === 0) {
      warnings.push(`Text style '${style.name}' has no properties; skipped.`);
      continue;
    }

    if (wantProps) {
      if (propLines.length > 0) { propLines.push(""); }
      propLines.push(`${opts.indent}/* ${style.name} */`);
      for (const [suffix, , unit, value] of present) {
        propLines.push(`${opts.indent}${base}-${suffix}: ${formatTextStyleValue(value!, unit)};`);
      }
    }

    if (wantClasses) {
      const decls = present.map(([suffix, cssProp, unit, value]) =>
        wantProps
          ? `${opts.indent}${cssProp}: var(${base}-${suffix});`
          : `${opts.indent}${cssProp}: ${formatTextStyleValue(value!, unit)};`
      );
      classBlocks.push([`.${opts.textStyleClassPrefix}${slug} {`, ...decls, "}"].join("\n"));
    }
  }

  if (propLines.length > 0) {
    blocks.push(["/* Text styles */", ":root {", ...propLines, "}"].join("\n"));
  }
  if (classBlocks.length > 0) {
    blocks.push(["/* Text style utilities */", classBlocks.join("\n\n")].join("\n"));
  }
  return blocks;
}

function render(
  buckets: Map<string, Bucket>,
  textStyles: FigmaTextStyleReport[],
  opts: ResolvedOptions,
  warnings: string[],
  errors: string[]
): string {
  const blocks: string[] = [
    "/* Generated by Learning Copilot from Figma variables. Edits are overwritten on re-import. */",
  ];

  // Stable sort: declared modes in their declared order, then the rest as seen.
  const ordered = [...buckets.values()]
    .map((bucket, i) => ({ bucket, i }))
    .sort((a, b) => a.bucket.rank - b.bucket.rank || a.i - b.i)
    .map((x) => x.bucket);

  const populated = ordered.filter((b) => b.decls.length > 0);
  checkCascadeOrder(populated, warnings);
  for (const cycle of findAliasCycles(populated)) {
    errors.push(
      `Alias cycle: ${[...cycle, cycle[0]].join(" → ")}. Every property in the loop resolves to nothing in the browser; ` +
      "break the loop in Figma."
    );
  }

  for (const bucket of ordered) {
    if (bucket.decls.length === 0) { continue; }
    const { condition } = bucket;
    if (condition.kind === "media") {
      const inner = renderDeclarations(bucket.decls, opts.indent + opts.indent);
      blocks.push([`@media ${condition.query} {`, `${opts.indent}:root {`, ...inner, `${opts.indent}}`, "}"].join("\n"));
    } else {
      const selector = condition.kind === "base" ? ":root" : condition.selector;
      blocks.push([`${selector} {`, ...renderDeclarations(bucket.decls, opts.indent), "}"].join("\n"));
    }
  }

  blocks.push(...renderTextStyles(textStyles, opts, warnings, errors));
  return blocks.join("\n\n") + "\n";
}

//#endregion
