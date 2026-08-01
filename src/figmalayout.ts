/**
 * Figma artboard structure → a readable outline.
 *
 * This replaces the vision-model pass over exported design images. A
 * screenshot has to be *interpreted*: the model guesses at hierarchy, invents
 * layer names, estimates spacing, and cannot see which design token a colour
 * came from. The structure walked out of Figma states all of that exactly, at
 * no token cost, and the outline below is the form that costs fewest tokens to
 * hand to a model afterwards.
 *
 * The output is deliberately plain text rather than JSON: it goes into a
 * student-visible design notes file as well as into a prompt, and an indented
 * outline is legible to both.
 *
 * This module must stay free of `vscode` imports so it can be unit-tested
 * outside VS Code.
 */

import type {
  FigmaCollectionReport,
  FigmaLayoutNode,
  FigmaLayoutReport,
  FigmaTokenReport,
} from "./figmatokens";

/** Types carrying no structural meaning once their box is known. */
const LEAFY_TYPES = new Set(["RECTANGLE", "IMAGE", "SLICE"]);

const ALIGNMENT_WORDS: Record<string, string> = {
  MIN: "start",
  MAX: "end",
  CENTER: "center",
  SPACE_BETWEEN: "space-between",
  BASELINE: "baseline",
};

function describeAlignment(value: string | undefined): string | null {
  if (!value) { return null; }
  return ALIGNMENT_WORDS[value] ?? value.toLowerCase();
}

/**
 * Collapses `[t, r, b, l]` the way CSS shorthand would, so `[32,32,32,32]`
 * reads as `32` rather than as four numbers a reader has to compare.
 */
function describePadding(padding: number[] | undefined): string | null {
  if (!padding || padding.length !== 4 || padding.every((p) => p === 0)) { return null; }
  const [t, r, b, l] = padding;
  if (t === r && r === b && b === l) { return `${t}`; }
  if (t === b && l === r) { return `${t} ${r}`; }
  return `${t} ${r} ${b} ${l}`;
}

/** Text short enough to serve as a node's label rather than its own line. */
const INLINE_TEXT_LIMIT = 60;

/** The facts about one node, in the order a developer would want them. */
function describeNode(node: FigmaLayoutNode): string {
  // A text layer whose Figma name just repeated its content arrives without a
  // name at all, so the content becomes the label — which reads better than
  // the name did, and is what identifies the node to a reader anyway.
  const inlineText = !node.name && node.text && node.text.length <= INLINE_TEXT_LIMIT ? node.text : null;
  const label = node.name ?? inlineText;
  const parts: string[] = [label ? `${node.type} "${label}"` : node.type];

  if (typeof node.width === "number" && typeof node.height === "number") {
    parts.push(`${node.width}×${node.height}`);
  }

  if (node.layout) {
    const layout = [`${node.layout} stack`];
    if (typeof node.gap === "number" && node.gap > 0) { layout.push(`gap ${node.gap}`); }
    const padding = describePadding(node.padding);
    if (padding) { layout.push(`padding ${padding}`); }
    const justify = describeAlignment(node.justify);
    if (justify) { layout.push(`justify ${justify}`); }
    const align = describeAlignment(node.align);
    if (align) { layout.push(`align ${align}`); }
    parts.push(layout.join(", "));
  }

  if (node.style) { parts.push(`text style "${node.style}"`); }

  // Named tokens are the point of the exercise: they tell the model which CSS
  // custom property to reach for instead of hard-coding a value.
  if (node.bound) {
    const bound = Object.entries(node.bound).map(([prop, token]) => `${prop}=${token}`);
    if (bound.length > 0) { parts.push(`tokens: ${bound.join(", ")}`); }
  }

  // Longer text goes on its own line: it is the one field with arbitrary
  // length, and inline it would push everything structural off the edge.
  const line = parts.join(" · ");
  return node.text && !inlineText ? `${line}\ntext: ${JSON.stringify(node.text)}` : line;
}

function renderNode(node: FigmaLayoutNode, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  const [head, ...rest] = describeNode(node).split("\n");
  out.push(`${indent}- ${head}`);
  for (const line of rest) { out.push(`${indent}  ${line.trim()}`); }

  if (LEAFY_TYPES.has(node.type) || !node.children) { return; }
  for (const child of node.children) { renderNode(child, depth + 1, out); }
}

export type LayoutOutlineOptions = {
  /** Heading level for each artboard's section. */
  headingLevel?: number;
};

/**
 * Renders artboard structures as a Markdown outline.
 *
 * @param layouts Structures captured from Figma.
 * @param options Heading depth for the generated sections.
 */
export function renderLayoutOutline(
  layouts: FigmaLayoutReport[] | undefined,
  options: LayoutOutlineOptions = {}
): string {
  if (!layouts || layouts.length === 0) { return ""; }
  const hashes = "#".repeat(Math.max(1, Math.min(6, options.headingLevel ?? 2)));

  const blocks = layouts.map((layout) => {
    const out: string[] = [];
    const size =
      typeof layout.root.width === "number" && typeof layout.root.height === "number"
        ? ` (${layout.root.width}×${layout.root.height})`
        : "";
    out.push(`${hashes} ${layout.root.name ?? "Artboard"}${size}`);
    if (layout.page) { out.push("", `_Figma page: ${layout.page}_`); }
    out.push("");
    for (const child of layout.root.children ?? []) { renderNode(child, 0, out); }
    if (!layout.root.children || layout.root.children.length === 0) {
      out.push("_This artboard has no visible children._");
    }
    return out.join("\n");
  });

  return blocks.join("\n\n");
}

/** Every distinct design token referenced anywhere in the layouts. */
export function listUsedTokens(layouts: FigmaLayoutReport[] | undefined): string[] {
  const used = new Set<string>();
  const walk = (node: FigmaLayoutNode): void => {
    if (node.bound) { for (const token of Object.values(node.bound)) { used.add(token); } }
    if (node.style) { used.add(node.style); }
    for (const child of node.children ?? []) { walk(child); }
  };
  for (const layout of layouts ?? []) { walk(layout.root); }
  return [...used].sort();
}

//#region <DESIGN CONTEXT DOCUMENT>

function renderTable(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
}

/** Collections whose values differ between modes — the responsive layer. */
function findModalCollections(collections: FigmaCollectionReport[]): FigmaCollectionReport[] {
  return collections.filter(
    (c) =>
      c.modes.length > 1 &&
      c.variables.some((v) => {
        const values = c.modes.map((m) => {
          const mv = v.valuesByMode.find((x) => x.mode === m);
          if (!mv) { return ""; }
          return mv.kind === "alias" ? mv.aliasTarget : String(mv.value);
        });
        return new Set(values).size > 1;
      })
  );
}

function cellFor(collection: FigmaCollectionReport, variableName: string, mode: string): string {
  const v = collection.variables.find((x) => x.name === variableName);
  const mv = v?.valuesByMode.find((x) => x.mode === mode);
  if (!mv) { return "—"; }
  return mv.kind === "alias" ? mv.aliasTarget : `${mv.value ?? ""}${mv.unit ?? ""}`;
}

/**
 * Builds the design-context document handed to the model in place of — or
 * alongside — an analysed screenshot.
 *
 * It leads with the token tables rather than the structure on purpose. The
 * mode columns *are* the responsive design: a model that can see
 * `SectionPaddingHorizontal` is 0/16/32 across the breakpoints does not have
 * to infer responsive behaviour from a picture, and the structure below then
 * says which elements use it.
 *
 * @param report Merged token and layout report.
 */
export function buildFigmaDesignContext(report: FigmaTokenReport): string {
  const out: string[] = [
    "# Figma Design",
    "",
    "Read directly from the Figma file by Learning Copilot. Every fact here comes",
    "from the design itself rather than from looking at a picture of it, so layer",
    "names, spacing and design-token references are exact.",
    "",
  ];

  if (report.frames && report.frames.length > 0) {
    out.push("## Artboards", "");
    out.push(...renderTable(
      ["Artboard", "Width", "Height"],
      report.frames.map((f) => [f.name, `${f.width}px`, f.height ? `${f.height}px` : "—"])
    ));
    out.push("");
  }

  const modal = findModalCollections(report.collections);
  for (const c of modal) {
    // "By mode" rather than "responsive": the same mechanism carries
    // breakpoints and light/dark, and calling a colour-scheme collection
    // responsive would mislead.
    out.push(`## Tokens by mode — ${c.collection}`, "");
    out.push(
      `These vary across ${c.modes.map((m) => `**${m}**`).join(" / ")}. This is how the`,
      "designer said the design should change; prefer these over inventing values.",
      ""
    );
    out.push(...renderTable(
      ["Token", ...c.modes],
      c.variables.map((v) => [v.name, ...c.modes.map((m) => cellFor(c, v.name, m))])
    ));
    out.push("");
  }

  const flat = report.collections.filter((c) => !modal.includes(c));
  for (const c of flat) {
    if (c.variables.length === 0) { continue; }
    out.push(`## Tokens — ${c.collection}`, "");
    out.push(...renderTable(
      ["Token", ...c.modes],
      c.variables.map((v) => [v.name, ...c.modes.map((m) => cellFor(c, v.name, m))])
    ));
    out.push("");
  }

  if (report.textStyles && report.textStyles.length > 0) {
    out.push("## Text styles", "");
    out.push(...renderTable(
      ["Style", "Family", "Weight", "Size", "Line height", "Case"],
      report.textStyles.map((s) => [
        s.name,
        String(s.fontFamily ?? ""),
        String(s.fontWeight ?? ""),
        String(s.fontSize ?? ""),
        String(s.lineHeight ?? ""),
        String(s.textCase ?? ""),
      ])
    ));
    out.push("");
  }

  if (report.layouts && report.layouts.length > 0) {
    out.push("## Page structure", "");
    out.push(
      "Indentation is nesting. `tokens:` names the design variable bound to that",
      "property — generated CSS should reference that variable rather than repeat a",
      "literal value.",
      ""
    );
    out.push(renderLayoutOutline(report.layouts, { headingLevel: 3 }), "");

    const used = listUsedTokens(report.layouts);
    if (used.length > 0) {
      out.push(
        `## Tokens used in this page`,
        "",
        `${used.length} across ${countLayoutNodes(report.layouts)} layers:`,
        "",
        used.map((t) => `\`${t}\``).join(", "),
        ""
      );
    }
  }

  return out.join("\n");
}

//#endregion

/** Total nodes captured, for reporting how much of the design was described. */
export function countLayoutNodes(layouts: FigmaLayoutReport[] | undefined): number {
  let n = 0;
  const walk = (node: FigmaLayoutNode): void => {
    n++;
    for (const child of node.children ?? []) { walk(child); }
  };
  for (const layout of layouts ?? []) { walk(layout.root); }
  return n;
}
