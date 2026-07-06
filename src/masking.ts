/**
 * Pure logic for task markers, snippet resolution, and deterministic masking.
 *
 * The core idea: the model only nominates verbatim snippets to mask
 * (TaskSelection). This module locates each snippet in the real file content,
 * expands it to whole lines, and splices in the __LC_TASK_<id>_START__/END__
 * markers itself using the correct comment syntax for the file type. The model
 * never writes markers, so marker-format failures cannot occur.
 *
 * No `vscode` imports here — everything is unit-testable in plain Node.
 */

import * as path from "node:path";
import type {
  LineRange,
  ScaffoldPlan,
  ScaffoldTask,
  TaskSelection,
} from "./types";

//#region <PATH AND JSON UTILITIES>

/**
 * Validates and normalizes a user-provided relative path.
 */
export function normalizeRelativePath(p: string): string {
  const cleaned = p.replace(/\\/g, "/").trim();
  const noLead = cleaned.replace(/^\/+/, "");
  const norm = path.posix.normalize(noLead);

  if (!norm || norm === "." || norm === ".." || norm.startsWith("../")) {
    throw new Error(`Invalid relative path: ${p}`);
  }
  if (/^[A-Za-z]:/.test(norm)) {
    throw new Error(`Invalid relative path (drive letter): ${p}`);
  }
  return norm;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes optional markdown code fences from model output.
 */
export function stripCodeFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : t;
}

export function extractBalancedJsonObjectCandidates(text: string): string[] {
  const out: string[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") { continue; }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
        if (depth < 0) {
          break;
        }
      }
    }
  }
  return out;
}

export function extractLikelyJsonObject(rawText: string, requiredKeys: string[]): string {
  const stripped = stripCodeFences(rawText);

  // Fast path: already pure JSON.
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === "object") {
      return stripped;
    }
  } catch {
    // fall through
  }

  // Otherwise, scan for balanced JSON objects and prefer the LAST one that contains all required keys.
  const candidates = extractBalancedJsonObjectCandidates(stripped);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i].trim();
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        requiredKeys.every((k) => Object.prototype.hasOwnProperty.call(parsed, k))
      ) {
        return candidate;
      }
    } catch {
      // ignore and continue
    }
  }

  throw new Error("The model did not return valid JSON. Try again with a simpler prompt.");
}

//#endregion

//#region <MARKER SYNTAX>

export type MarkerCommentContext = "html" | "css" | "js" | "python" | "markdown" | "generic";

export function getMarkerCommentContextForLine(p: string, content: string, lineIndex?: number): MarkerCommentContext {
  const ext = path.posix.extname(p.toLowerCase());
  if (ext === ".html" || ext === ".htm" || ext === ".svg") {
    if (typeof lineIndex === "number") {
      const lines = content.split(/\r?\n/);
      const prefix = lines.slice(0, lineIndex + 1).join("\n").toLowerCase();
      const lastScriptOpen = prefix.lastIndexOf("<script");
      const lastScriptClose = prefix.lastIndexOf("</script");
      if (lastScriptOpen > lastScriptClose) {
        return "js";
      }
      const lastStyleOpen = prefix.lastIndexOf("<style");
      const lastStyleClose = prefix.lastIndexOf("</style");
      if (lastStyleOpen > lastStyleClose) {
        return "css";
      }
    }
    return "html";
  }
  if (ext === ".css") {
    return "css";
  }
  if ([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"].includes(ext)) {
    return "js";
  }
  if ([".py"].includes(ext)) {
    return "python";
  }
  if ([".md"].includes(ext)) {
    return "markdown";
  }
  return "generic";
}

/**
 * Wraps arbitrary text in a standalone comment appropriate for the context.
 */
export function wrapInComment(context: MarkerCommentContext, text: string): string {
  if (context === "html" || context === "markdown") {
    return `<!-- ${text} -->`;
  }
  if (context === "css") {
    return `/* ${text} */`;
  }
  if (context === "python") {
    return `# ${text}`;
  }
  return `// ${text}`;
}

export function getExpectedMarkerLineRegexForPath(
  p: string,
  which: "START" | "END",
  content = "",
  lineIndex?: number
): RegExp {
  const tok = `__LC_TASK_[A-Za-z0-9_-]+_${which}__`;
  const context = getMarkerCommentContextForLine(p, content, lineIndex);
  if (context === "html" || context === "markdown") {
    return new RegExp(`^\\s*<!--\\s*${tok}\\s*-->\\s*$`);
  }
  if (context === "css") {
    return new RegExp(`^\\s*\\/\\*\\s*${tok}\\s*\\*\\/\\s*$`);
  }
  if (context === "js") {
    return new RegExp(`^\\s*(?:\\/\\/\\s*${tok}\\s*|\\/\\*\\s*${tok}\\s*\\*\\/)\\s*$`);
  }
  if (context === "python") {
    return new RegExp(`^\\s*#\\s*${tok}\\s*$`);
  }
  return new RegExp(`^\\s*(?:\\/\\/|#|--|;|<!--|\\/\\*)?\\s*${tok}`);
}

export function commentStyleRuleForPath(p: string, content = "", lineIndex?: number): string {
  const context = getMarkerCommentContextForLine(p, content, lineIndex);
  if (context === "html") {
    return "HTML comments only: <!-- __LC_TASK_<id>_START__ --> and <!-- __LC_TASK_<id>_END__ --> on their own lines.";
  }
  if (context === "css") {
    return "CSS comments only: /* __LC_TASK_<id>_START__ */ and /* __LC_TASK_<id>_END__ */ on their own lines.";
  }
  if (context === "js") {
    return "JS/TS comments only: // __LC_TASK_<id>_START__ and // __LC_TASK_<id>_END__ (or /* ... */) on their own lines.";
  }
  if (context === "python") {
    return "Python comments only: # __LC_TASK_<id>_START__ and # __LC_TASK_<id>_END__ on their own lines.";
  }
  if (context === "markdown") {
    return "Markdown/HTML comments preferred: <!-- __LC_TASK_<id>_START__ --> and <!-- __LC_TASK_<id>_END__ --> on their own lines.";
  }
  return "Markers must be standalone comment lines appropriate to the language/file type.";
}

//#endregion

//#region <TASK REGION PARSING>

export type TaskRegionHit = {
  id: string;
  startTokenStart: number;
  startTokenEnd: number;
  endTokenStart: number;
  endTokenEnd: number;
};

export function getTaskStartRegex(): RegExp {
  return /__LC_TASK_([A-Za-z0-9_-]+)_START__/g;
}

export function getTaskEndRegexForId(id: string): RegExp {
  return new RegExp(`__LC_TASK_${escapeRegExp(id)}_END__`, "g");
}

export function listTaskRegions(docText: string): TaskRegionHit[] {
  const hits: TaskRegionHit[] = [];
  const startRe = getTaskStartRegex();
  let m: RegExpExecArray | null;

  while ((m = startRe.exec(docText))) {
    const id = m[1];
    const startTokenStart = m.index;
    const startTokenEnd = startTokenStart + m[0].length;

    const endRe = getTaskEndRegexForId(id);
    endRe.lastIndex = startTokenEnd;
    const endM = endRe.exec(docText);
    if (!endM) { continue; } // unmatched start

    const endTokenStart = endM.index;
    const endTokenEnd = endTokenStart + endM[0].length;

    hits.push({ id, startTokenStart, startTokenEnd, endTokenStart, endTokenEnd });
  }

  hits.sort((a, b) => a.startTokenStart - b.startTokenStart);
  return hits;
}

export function findTaskRegionAtPosition(docText: string, offset: number): TaskRegionHit | null {
  const regions = listTaskRegions(docText);
  for (const r of regions) {
    if (offset >= r.startTokenStart && offset <= r.endTokenEnd) { return r; }
  }
  return null;
}

export function findNextTaskRegion(docText: string, offset: number): TaskRegionHit | null {
  const regions = listTaskRegions(docText);
  for (const r of regions) {
    if (r.startTokenStart >= offset) { return r; }
  }
  return null;
}

export function getRegionStartLine(docText: string, startTokenStart: number): number {
  return docText.slice(0, startTokenStart).split(/\r?\n/).length; // 1-based
}

export function extractRegionEditableText(content: string, r: TaskRegionHit): string {
  return content.slice(r.startTokenEnd, r.endTokenStart);
}

//#endregion

//#region <CHANGED RANGES>

// Simple prefix/suffix heuristic. Works well for typical “edit a section” changes.
// If you need multiple hunks later, we can upgrade to a real diff.
export function computeChangedRangesByPrefixSuffix(oldText: string, newText: string): LineRange[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  // No changes
  if (start > oldEnd && start > newEnd) { return []; }

  return [{ startLine: start + 1, endLine: newEnd + 1 }];
}

export function formatRangesForPrompt(ranges: LineRange[]): string {
  return ranges.length ? ranges.map(r => `L${r.startLine}-L${r.endLine}`).join(", ") : "(no changes detected)";
}

export function isLineWithinRanges(line: number, ranges: LineRange[]): boolean {
  if (!ranges.length) { return false; } // if we detect no changes, don't allow tasks
  return ranges.some(r => line >= r.startLine && line <= r.endLine);
}

//#endregion

//#region <COMPREHENSION QUESTIONS>

export function extractComprehensionQuestionIds(exercisesMd: string): string[] {
  // We require questions to be tagged like [CQ1], [CQ2], ...
  const re = /\[CQ(\d+)\]/g;
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(exercisesMd))) {
    ids.add(`CQ${m[1]}`);
  }
  return Array.from(ids).sort((a, b) => {
    const na = Number(a.replace(/^CQ/, ""));
    const nb = Number(b.replace(/^CQ/, ""));
    return na - nb;
  });
}

export function answerKeyHasAnswerFor(questionId: string, answerKeyMd: string): boolean {
  // Accept either an explicit tag line or a heading/bullet containing the tag.
  const re = new RegExp(`\\[${escapeRegExp(questionId)}\\]`, "i");
  return re.test(answerKeyMd);
}

//#endregion

//#region <SNIPPET RESOLUTION>

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,48}$/;

/**
 * Normalizes a model-proposed task id to the marker-safe alphabet, or returns
 * null when nothing usable remains.
 */
export function sanitizeTaskId(raw: unknown): string | null {
  if (typeof raw !== "string") { return null; }
  const cleaned = raw.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");
  if (!cleaned || !TASK_ID_RE.test(cleaned)) { return null; }
  return cleaned;
}

/** Collapses all whitespace for equivalence checks (placeholder vs solution). */
export function normalizeForComparison(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Splits text into lines, tolerating either LF or CRLF input. */
function toLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Drops leading/trailing blank lines without touching inner content. */
function trimBlankEdgeLines(lines: string[]): string[] {
  let first = 0;
  let last = lines.length - 1;
  while (first <= last && lines[first].trim() === "") { first++; }
  while (last >= first && lines[last].trim() === "") { last--; }
  return lines.slice(first, last + 1);
}

export type SnippetResolution =
  | { status: "ok"; firstLine: number; lastLine: number; solutionText: string } // 0-based inclusive line indices
  | { status: "not-found" }
  | { status: "ambiguous"; count: number }
  | { status: "empty" };

/**
 * Locates a model-proposed snippet in real file content by line matching.
 *
 * Tries exact per-line equality first, then a whitespace-trimmed comparison as
 * a fallback (models sometimes normalize indentation). When several matches
 * exist, `preferRanges` (1-based, e.g. changed-line ranges) is used to
 * disambiguate; if exactly one match starts inside the ranges it wins.
 */
export function resolveSnippetInContent(
  content: string,
  snippet: string,
  preferRanges?: LineRange[]
): SnippetResolution {
  const contentLines = toLines(content);
  const snippetLines = trimBlankEdgeLines(toLines(snippet));
  if (snippetLines.length === 0) { return { status: "empty" }; }

  const findWindows = (equal: (a: string, b: string) => boolean): number[] => {
    const starts: number[] = [];
    outer:
    for (let i = 0; i + snippetLines.length <= contentLines.length; i++) {
      for (let j = 0; j < snippetLines.length; j++) {
        if (!equal(contentLines[i + j], snippetLines[j])) { continue outer; }
      }
      starts.push(i);
    }
    return starts;
  };

  let starts = findWindows((a, b) => a === b);
  if (starts.length === 0) {
    starts = findWindows((a, b) => a.trim() === b.trim());
  }
  if (starts.length === 0) { return { status: "not-found" }; }

  if (starts.length > 1 && preferRanges && preferRanges.length > 0) {
    const inRange = starts.filter((s) => isLineWithinRanges(s + 1, preferRanges));
    if (inRange.length === 1) { starts = inRange; }
  }
  if (starts.length > 1) { return { status: "ambiguous", count: starts.length }; }

  const firstLine = starts[0];
  const lastLine = firstLine + snippetLines.length - 1;
  const solutionText = contentLines.slice(firstLine, lastLine + 1).join("\n");
  return { status: "ok", firstLine, lastLine, solutionText };
}

//#endregion

//#region <DETERMINISTIC MASKING>

export type ResolvedMask = {
  id: string;
  firstLine: number; // 0-based inclusive
  lastLine: number;  // 0-based inclusive
  solutionText: string;
  placeholder: string;
  hint?: string;
  explanation?: string;
};

export type MaskFailure = { id: string; path: string; reason: string };

export type ResolveSelectionsResult = {
  masksByFile: Map<string, ResolvedMask[]>;
  failures: MaskFailure[];
};

/**
 * Resolves model task selections against real file contents, enforcing
 * uniqueness, changed-range constraints, and non-overlap. Failures are
 * reported (not thrown) so the caller can request corrections for just the
 * failed items.
 */
export function resolveTaskSelections(
  filesByRel: Map<string, string>,
  selections: TaskSelection[],
  changedRangesByRel?: Map<string, LineRange[]>
): ResolveSelectionsResult {
  const failures: MaskFailure[] = [];
  const masksByFile = new Map<string, ResolvedMask[]>();
  const seenIds = new Set<string>();

  for (const sel of selections) {
    const id = sanitizeTaskId(sel.id);
    if (!id) {
      failures.push({ id: String(sel.id ?? "?"), path: sel.path, reason: "Task id must be 1-48 chars of letters/digits/hyphen/underscore." });
      continue;
    }
    if (seenIds.has(id)) {
      failures.push({ id, path: sel.path, reason: `Duplicate task id '${id}'. Every task needs a unique id.` });
      continue;
    }

    let rel: string;
    try {
      rel = normalizeRelativePath(sel.path);
    } catch {
      failures.push({ id, path: sel.path, reason: `Invalid file path: ${sel.path}` });
      continue;
    }

    const content = filesByRel.get(rel);
    if (content === undefined) {
      failures.push({ id, path: rel, reason: `File '${rel}' is not one of the provided input files.` });
      continue;
    }

    const ranges = changedRangesByRel?.get(rel);
    const res = resolveSnippetInContent(content, sel.targetSnippet, ranges);
    if (res.status === "empty") {
      failures.push({ id, path: rel, reason: "targetSnippet is empty. Copy 2-10 consecutive lines exactly from the file." });
      continue;
    }
    if (res.status === "not-found") {
      failures.push({ id, path: rel, reason: `targetSnippet was not found in '${rel}'. Copy the lines EXACTLY as they appear in the file content provided, including indentation.` });
      continue;
    }
    if (res.status === "ambiguous") {
      failures.push({ id, path: rel, reason: `targetSnippet occurs ${res.count} times in '${rel}'. Include more surrounding lines so the snippet is unique.` });
      continue;
    }

    if (ranges && ranges.length > 0 && !isLineWithinRanges(res.firstLine + 1, ranges)) {
      failures.push({
        id,
        path: rel,
        reason: `targetSnippet starts at line ${res.firstLine + 1}, outside the changed ranges ${formatRangesForPrompt(ranges)}. Choose a snippet inside the changed ranges.`,
      });
      continue;
    }

    seenIds.add(id);
    const list = masksByFile.get(rel) ?? [];
    list.push({
      id,
      firstLine: res.firstLine,
      lastLine: res.lastLine,
      solutionText: res.solutionText,
      placeholder: typeof sel.placeholder === "string" ? sel.placeholder : "",
      hint: sel.hint,
      explanation: sel.explanation,
    });
    masksByFile.set(rel, list);
  }

  // Enforce non-overlap per file: keep the earliest region, drop later overlapping ones.
  for (const [rel, masks] of masksByFile) {
    masks.sort((a, b) => a.firstLine - b.firstLine);
    const kept: ResolvedMask[] = [];
    let lastEnd = -1;
    for (const m of masks) {
      if (m.firstLine <= lastEnd) {
        seenIds.delete(m.id);
        failures.push({ id: m.id, path: rel, reason: `Region overlaps a previous task region in '${rel}'. Choose non-overlapping snippets.` });
        continue;
      }
      kept.push(m);
      lastEnd = m.lastLine;
    }
    masksByFile.set(rel, kept);
  }

  return { masksByFile, failures };
}

function leadingWhitespace(line: string): string {
  const m = line.match(/^\s*/);
  return m ? m[0] : "";
}

function baseIndentForRegion(lines: string[], firstLine: number, lastLine: number): string {
  for (let i = firstLine; i <= lastLine && i < lines.length; i++) {
    if (lines[i].trim() !== "") { return leadingWhitespace(lines[i]); }
  }
  return "";
}

export function buildFallbackPlaceholder(context: MarkerCommentContext, id: string, indent: string): string {
  return indent + wrapInComment(context, `Task ${id}: write your implementation here (see LEARNING_EXERCISES.md)`);
}

export type ApplyMasksResult = {
  maskedContent: string;
  tasks: ScaffoldTask[];
};

/**
 * Splices marker lines and placeholders into file content for the given
 * resolved masks. Markers get the correct comment syntax for the file type
 * (including <script>/<style> islands in HTML) and inherit the indentation of
 * the masked region. Masks are applied bottom-up so line indices stay valid.
 */
export function applyMasksToContent(relPath: string, content: string, masks: ResolvedMask[]): ApplyMasksResult {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = toLines(content);

  // Comment contexts are computed against the ORIGINAL content. Bottom-up
  // application keeps every earlier line untouched, so these stay correct.
  const contexts = new Map<string, MarkerCommentContext>();
  for (const m of masks) {
    contexts.set(m.id, getMarkerCommentContextForLine(relPath, content, m.firstLine));
  }

  const ordered = [...masks].sort((a, b) => b.firstLine - a.firstLine);
  const tasks: ScaffoldTask[] = [];

  for (const mask of ordered) {
    const context = contexts.get(mask.id) ?? "generic";
    const indent = baseIndentForRegion(lines, mask.firstLine, mask.lastLine);

    let placeholderLines = trimBlankEdgeLines(toLines(mask.placeholder ?? ""));
    const placeholderText = placeholderLines.join("\n");
    if (
      placeholderLines.length === 0 ||
      normalizeForComparison(placeholderText) === normalizeForComparison(mask.solutionText)
    ) {
      placeholderLines = [buildFallbackPlaceholder(context, mask.id, indent)];
    } else if (indent && placeholderLines.every((ln) => ln === "" || !/^\s/.test(ln))) {
      // Model supplied flush-left starter code for an indented region.
      placeholderLines = placeholderLines.map((ln) => (ln === "" ? ln : indent + ln));
    }

    const startMarker = indent + wrapInComment(context, `__LC_TASK_${mask.id}_START__`);
    const endMarker = indent + wrapInComment(context, `__LC_TASK_${mask.id}_END__`);

    lines.splice(
      mask.firstLine,
      mask.lastLine - mask.firstLine + 1,
      startMarker,
      ...placeholderLines,
      endMarker
    );
  }

  // Report tasks in top-down order for stable downstream presentation.
  for (const mask of [...masks].sort((a, b) => a.firstLine - b.firstLine)) {
    tasks.push({
      id: mask.id,
      path: relPath,
      solution: mask.solutionText,
      hint: mask.hint,
      explanation: mask.explanation,
    });
  }

  return { maskedContent: lines.join(eol), tasks };
}

//#endregion

//#region <MODEL RESPONSE PARSING>

export type ParsedTaskSelections = {
  selections: TaskSelection[];
  notes?: string;
  /** Structural problems with individual entries (bad types etc.). */
  entryProblems: string[];
};

/**
 * Parses the task-selection JSON from either raw model text or an
 * already-parsed object (e.g. from a schema-constrained tool call).
 */
export function parseTaskSelectionResponse(raw: string | object): ParsedTaskSelections {
  let obj: any;
  if (typeof raw === "string") {
    obj = JSON.parse(extractLikelyJsonObject(raw, ["tasks"]));
  } else {
    obj = raw;
  }

  if (!obj || typeof obj !== "object" || !Array.isArray(obj.tasks)) {
    throw new Error("Task selection response must be an object with a 'tasks' array.");
  }

  const selections: TaskSelection[] = [];
  const entryProblems: string[] = [];

  for (const [idx, t] of (obj.tasks as any[]).entries()) {
    if (!t || typeof t !== "object") {
      entryProblems.push(`tasks[${idx}] is not an object.`);
      continue;
    }
    if (typeof t.path !== "string" || typeof t.targetSnippet !== "string") {
      entryProblems.push(`tasks[${idx}] must have string 'path' and 'targetSnippet'.`);
      continue;
    }
    selections.push({
      id: typeof t.id === "string" ? t.id : `task${idx + 1}`,
      path: t.path,
      targetSnippet: t.targetSnippet,
      placeholder: typeof t.placeholder === "string" ? t.placeholder : "",
      hint: typeof t.hint === "string" ? t.hint : undefined,
      explanation: typeof t.explanation === "string" ? t.explanation : undefined,
    });
  }

  return {
    selections,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
    entryProblems,
  };
}

export type ParsedExercises = {
  exercisesMd: string;
  comprehensionAnswersMd: string;
};

export function parseExercisesResponse(raw: string | object): ParsedExercises {
  let obj: any;
  if (typeof raw === "string") {
    obj = JSON.parse(extractLikelyJsonObject(raw, ["exercisesMd"]));
  } else {
    obj = raw;
  }

  if (!obj || typeof obj !== "object" || typeof obj.exercisesMd !== "string") {
    throw new Error("Exercises response must be an object with an 'exercisesMd' string.");
  }

  return {
    exercisesMd: obj.exercisesMd,
    comprehensionAnswersMd: typeof obj.comprehensionAnswersMd === "string" ? obj.comprehensionAnswersMd : "",
  };
}

//#endregion

//#region <ANSWER KEY ASSEMBLY>

const LANG_BY_EXT: Record<string, string> = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".tsx": "tsx",
  ".py": "python",
  ".css": "css",
  ".html": "html",
  ".htm": "html",
  ".svg": "xml",
  ".json": "json",
  ".md": "markdown",
  ".sh": "bash",
  ".yml": "yaml",
  ".yaml": "yaml",
};

function codeFenceLangForPath(p: string): string {
  return LANG_BY_EXT[path.posix.extname(p.toLowerCase())] ?? "";
}

/**
 * Builds the instructor answer key deterministically from data the extension
 * already holds; only the comprehension answers section comes from the model.
 */
export function assembleAnswerKeyMd(tasks: ScaffoldTask[], comprehensionAnswersMd: string): string {
  const lines: string[] = ["# Instructor Answer Key", ""];

  lines.push("## Tasks", "");
  for (const task of tasks) {
    lines.push(`### Task \`${task.id}\` — \`${task.path}\``, "");
    lines.push("**Solution:**", "");
    lines.push("```" + codeFenceLangForPath(task.path));
    lines.push(task.solution.replace(/\s+$/, ""));
    lines.push("```", "");
    if (task.hint) {
      lines.push(`**Hint:** ${task.hint}`, "");
    }
    if (task.explanation) {
      lines.push(`**Explanation:** ${task.explanation}`, "");
    }
  }

  const answers = comprehensionAnswersMd.trim();
  if (/^#{1,6}\s/m.test(answers) && /comprehension answers/i.test(answers)) {
    lines.push(answers, "");
  } else {
    lines.push("## Comprehension Answers", "");
    lines.push(answers || "_(No comprehension answers were generated.)_", "");
  }

  return lines.join("\n");
}

//#endregion

//#region <SCAFFOLD PLAN VALIDATION>

export type ScaffoldValidationIssue = {
  kind:
  | "badCommentStyle"
  | "missingMarkers"
  | "missingTaskMapping"
  | "taskAlreadySolved"
  | "solutionNotFound"
  | "missingComprehensionAnswers";
  file?: string;
  id?: string;
  detail: string;
};

export function validateScaffoldPlan(plan: ScaffoldPlan): ScaffoldValidationIssue[] {
  const issues: ScaffoldValidationIssue[] = [];

  const tasksByFileAndId = new Map<string, Map<string, ScaffoldTask>>();
  for (const b of plan.tasks) {
    let rel: string;
    try { rel = normalizeRelativePath(b.path); }
    catch {
      issues.push({ kind: "missingTaskMapping", file: b.path, id: b.id, detail: `Task has invalid path: ${b.path}` });
      continue;
    }
    const m = tasksByFileAndId.get(rel) ?? new Map<string, ScaffoldTask>();
    m.set(b.id, b);
    tasksByFileAndId.set(rel, m);
  }

  // Build a quick index of task regions present in maskedFiles content.
  const regionsByFileAndId = new Map<string, Map<string, TaskRegionHit>>();
  for (const mf of plan.maskedFiles) {
    let rel: string;
    try {
      rel = normalizeRelativePath(mf.path);
    } catch {
      continue;
    }
    const regions = listTaskRegions(mf.content);
    const m = regionsByFileAndId.get(rel) ?? new Map<string, TaskRegionHit>();
    for (const r of regions) {
      // If duplicate IDs exist, keep the first occurrence.
      if (!m.has(r.id)) {
        m.set(r.id, r);
      }
    }
    regionsByFileAndId.set(rel, m);
  }

  // Ensure every task entry actually appears in maskedFiles as a region.
  for (const b of plan.tasks) {
    let rel: string;
    try {
      rel = normalizeRelativePath(b.path);
    } catch {
      continue;
    }
    const rm = regionsByFileAndId.get(rel);
    const hit = rm?.get(b.id);
    if (!hit) {
      issues.push({
        kind: "missingMarkers",
        file: rel,
        id: b.id,
        detail: `Task ${b.id} is listed in plan.tasks for ${rel}, but no corresponding __LC_TASK_${b.id}_START__/END markers were found in maskedFiles content for that file. Ensure the masked file includes the marker lines and placeholder between them.`,
      });
    }
  }

  for (const mf of plan.maskedFiles) {
    let rel: string;
    try { rel = normalizeRelativePath(mf.path); }
    catch {
      issues.push({ kind: "missingMarkers", file: mf.path, detail: `Masked file has invalid path: ${mf.path}` });
      continue;
    }

    const regions = listTaskRegions(mf.content);
    if (regions.length === 0) {
      // If there are tasks declared for this file, then having no regions is invalid.
      const declared = tasksByFileAndId.get(rel);
      if (declared && declared.size > 0) {
        issues.push({
          kind: "missingMarkers",
          file: rel,
          detail: `maskedFiles contains ${rel} but no task marker regions were found, even though plan.tasks declares ${declared.size} task(s) for this file. Add proper START/END marker lines and placeholder content.`,
        });
      }
      continue;
    }

    const lines = mf.content.split(/\r?\n/);

    for (const r of regions) {
      const taskMap = tasksByFileAndId.get(rel);
      const task = taskMap?.get(r.id);
      if (!task) {
        issues.push({ kind: "missingTaskMapping", file: rel, id: r.id, detail: `Region ${r.id} appears in ${rel} but no matching entry exists in plan.tasks.` });
      }

      const startLineIdx = mf.content.slice(0, r.startTokenStart).split(/\r?\n/).length - 1;
      const endLineIdx = mf.content.slice(0, r.endTokenStart).split(/\r?\n/).length - 1;
      const startLine = lines[startLineIdx] ?? "";
      const endLine = lines[endLineIdx] ?? "";
      const startLineRe = getExpectedMarkerLineRegexForPath(rel, "START", mf.content, startLineIdx);
      const endLineRe = getExpectedMarkerLineRegexForPath(rel, "END", mf.content, endLineIdx);

      if (!startLineRe.test(startLine) || !endLineRe.test(endLine)) {
        issues.push({
          kind: "badCommentStyle",
          file: rel,
          id: r.id,
          detail: `Marker comment style mismatch in ${rel} for ${r.id}. Expected: ${commentStyleRuleForPath(rel, mf.content, startLineIdx)} Found START line='${startLine.trim()}', END line='${endLine.trim()}'.`,
        });
      }

      if (task) {
        const currentEditable = extractRegionEditableText(mf.content, r);
        const normA = normalizeForComparison(currentEditable);
        const normB = normalizeForComparison(task.solution ?? "");
        if (normB.length === 0) {
          issues.push({ kind: "solutionNotFound", file: rel, id: r.id, detail: `Task ${r.id} in ${rel} has empty solution.` });
        } else if (normA === normB) {
          issues.push({ kind: "taskAlreadySolved", file: rel, id: r.id, detail: `Task ${r.id} in ${rel} still contains the full solution between markers (nothing for student to do).` });
        }
      }
    }
  }

  // Validate that answerKeyMd includes answers for comprehension questions.
  const cqIds = extractComprehensionQuestionIds(plan.exercisesMd);
  if (cqIds.length > 0) {
    const ak = (plan.answerKeyMd ?? "").trim();
    if (!ak) {
      issues.push({
        kind: "missingComprehensionAnswers",
        detail: `exercisesMd contains ${cqIds.length} comprehension question tag(s) (${cqIds.join(", ")}), but answerKeyMd is missing or empty. Provide answers for every [CQn] question.`,
      });
    } else {
      const missing = cqIds.filter((id) => !answerKeyHasAnswerFor(id, ak));
      if (missing.length > 0) {
        issues.push({
          kind: "missingComprehensionAnswers",
          detail: `answerKeyMd is missing answers for comprehension question tag(s): ${missing.join(", ")}. Include a clearly labeled answer section that repeats each tag like [CQ1] and provides its answer.`,
        });
      }
    }
  }
  return issues;
}

export function formatScaffoldIssuesForPrompt(issues: ScaffoldValidationIssue[]): string {
  return issues
    .slice(0, 12)
    .map((i, idx) => {
      const where = [i.file, i.id].filter(Boolean).join(" :: ");
      return `${idx + 1}. [${i.kind}] ${where} — ${i.detail}`;
    })
    .join("\n");
}

//#endregion
