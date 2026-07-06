/**
 * The scaffold pipeline: turns a set of solution files into a learning
 * scaffold (masked files + tasks + exercises + answer key).
 *
 * The model's responsibilities are deliberately small:
 *   1. Nominate verbatim snippets to mask (with placeholder/hint/explanation).
 *   2. Write the learner-facing exercises and comprehension Q&A.
 *
 * Everything mechanical — locating snippets, inserting markers with the right
 * comment syntax, building the answer key — is done deterministically here,
 * so an entire class of marker-format failures can no longer occur. When an
 * individual snippet can't be resolved, only that item is retried.
 *
 * This module has no `vscode` dependency and is unit-testable with a fake
 * LlmJsonClient.
 */

import {
  applyMasksToContent,
  answerKeyHasAnswerFor,
  assembleAnswerKeyMd,
  extractComprehensionQuestionIds,
  formatScaffoldIssuesForPrompt,
  normalizeRelativePath,
  parseExercisesResponse,
  parseTaskSelectionResponse,
  resolveTaskSelections,
  validateScaffoldPlan,
} from "./masking";
import type {
  LineLogger,
  LineRange,
  LlmJsonClient,
  ScaffoldContextFile,
  ScaffoldPlan,
  ScaffoldTask,
  TaskSelection,
} from "./types";

export type ScaffoldFileInput = {
  rel: string;
  content: string;
  /** When present, tasks are only allowed to start within these 1-based ranges. */
  changedRanges?: LineRange[];
};

export type ScaffoldPipelineParams = {
  files: ScaffoldFileInput[];
  contextFiles?: ScaffoldContextFile[];
  briefMd: string;
  client: LlmJsonClient;
  log: LineLogger;
  report: (message: string) => void;
};

// Prompt payload budgets. Individual files are truncated (resolution still
// runs against the full content), and context is trimmed before focus files.
const MAX_CHARS_PER_FILE = 12_000;
const MAX_FOCUS_FILES = 20;
const MAX_CONTEXT_CHARS = 30_000;

const TASK_SELECTION_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Unique id, 1-48 chars, letters/digits/hyphen/underscore." },
          path: { type: "string", description: "Relative path of the file the snippet comes from." },
          targetSnippet: { type: "string", description: "2-10 consecutive lines copied exactly from the file." },
          placeholder: { type: "string", description: "Incomplete/incorrect starter code the student sees; empty for write-from-scratch." },
          hint: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["id", "path", "targetSnippet", "placeholder", "hint", "explanation"],
      },
    },
    notes: { type: "string" },
  },
  required: ["tasks"],
} as const;

const EXERCISES_SCHEMA = {
  type: "object",
  properties: {
    exercisesMd: { type: "string" },
    comprehensionAnswersMd: { type: "string" },
  },
  required: ["exercisesMd", "comprehensionAnswersMd"],
} as const;

function truncateContent(content: string): string {
  return content.length > MAX_CHARS_PER_FILE
    ? content.slice(0, MAX_CHARS_PER_FILE) + "\n\n/* TRUNCATED */\n"
    : content;
}

function buildSelectionInstructions(focused: boolean, taskCountHint: string): string {
  return [
    "You are a teaching assistant creating fill-in-the-blank learning tasks from a complete working solution.",
    "Return ONLY a single JSON object matching this schema:",
    '{"tasks":[{"id":string,"path":string,"targetSnippet":string,"placeholder":string,"hint":string,"explanation":string}],"notes":string}',
    "Rules:",
    "1. targetSnippet: copy 2-10 consecutive lines EXACTLY, character for character (including indentation and punctuation), from the 'content' of the file named by 'path' in the INPUT PAYLOAD. It must occur exactly once in that file. Never reformat, abbreviate, or re-indent it.",
    `2. Select ${taskCountHint} tasks in total, covering the most instructive logic${focused ? " of the NEW or CHANGED functionality" : ""}. Do not select import statements, boilerplate, comment-only lines, or blank regions.`,
    focused
      ? "3. Files may include 'changedRanges' (1-based line ranges within 'content'). When present, every targetSnippet for that file must start within those ranges. Files under 'contextFiles' are reference only — never select snippets from them."
      : "3. Files under 'contextFiles' (if any) are reference only — never select snippets from them.",
    "4. id: unique per task, 1-48 chars, letters/digits/hyphen/underscore only, descriptive (e.g. validate-input).",
    "5. placeholder: the incomplete or subtly wrong starter code the student will see instead of the snippet. It must NOT be equivalent to targetSnippet. Use an empty string when the student should write the code from scratch.",
    "6. hint: guides the student without revealing the solution. explanation: what the solution code does and why it is correct.",
    "The student has read studentBriefMd but has NOT seen the solution. Do not mention markers.",
    "Do not inspect the workspace or use tools other than reading the INPUT PAYLOAD; base your answer only on the payload.",
  ].join("\n");
}

function buildExercisesInstructions(): string {
  return [
    "You are a teaching assistant writing the learner-facing exercise sheet for fill-in-the-blank tasks.",
    'Return ONLY a single JSON object: {"exercisesMd":string,"comprehensionAnswersMd":string}.',
    "The INPUT PAYLOAD contains studentBriefMd plus the task list (id, path, hint, explanation, solution). The student will see exercisesMd only.",
    "exercisesMd requirements:",
    "- Begin with a short learner-facing summary of the project or change, consistent with studentBriefMd.",
    "- A 'Tasks' section with one entry per task, in the given order, that names the task id and file and describes what to work out at that spot WITHOUT revealing or quoting the solution code.",
    "- A section titled 'Comprehension Questions' with at least 5 questions. Tag each question literally with [CQ1], [CQ2], ... on its question line.",
    "- Exercises must be solvable by a student who has read studentBriefMd but has never seen the full solution.",
    "comprehensionAnswersMd requirements:",
    "- A section titled 'Comprehension Answers' answering EVERY [CQn] question, repeating its tag, e.g. '[CQ1] ...answer...'.",
    "Never include any task's solution code in exercisesMd.",
    "Do not inspect the workspace; base your answer only on the payload.",
  ].join("\n");
}

function taskCountHintForSize(files: ScaffoldFileInput[]): string {
  const totalChars = files.reduce((sum, f) => sum + f.content.length, 0);
  if (totalChars < 2_000) { return "2-4"; }
  if (totalChars < 10_000) { return "3-6"; }
  return "4-8";
}

/** Builds a fallback exercises document when the exercises model call fails. */
function buildFallbackExercisesMd(briefMd: string, tasks: ScaffoldTask[]): string {
  const lines: string[] = ["# Learning Exercises", ""];
  if (briefMd.trim()) {
    lines.push(briefMd.trim(), "");
  }
  lines.push("## Tasks", "");
  for (const t of tasks) {
    lines.push(`### Task \`${t.id}\` — \`${t.path}\``, "");
    lines.push(t.hint ? t.hint : "Work out what belongs in this task region, then implement it.", "");
  }
  return lines.join("\n");
}

export async function generateScaffoldPlanDeterministic(p: ScaffoldPipelineParams): Promise<ScaffoldPlan> {
  const { client, log, report } = p;

  // ---- Prepare inputs -----------------------------------------------------
  const filesByRel = new Map<string, string>();
  const changedRangesByRel = new Map<string, LineRange[]>();
  const inputs: ScaffoldFileInput[] = [];
  for (const f of p.files) {
    let rel: string;
    try {
      rel = normalizeRelativePath(f.rel);
    } catch {
      log.appendLine(`[scaffold] Skipping file with invalid path: ${f.rel}`);
      continue;
    }
    if (filesByRel.has(rel)) { continue; }
    filesByRel.set(rel, f.content);
    if (f.changedRanges && f.changedRanges.length > 0) {
      changedRangesByRel.set(rel, f.changedRanges);
    }
    inputs.push({ rel, content: f.content, changedRanges: f.changedRanges });
  }
  if (inputs.length === 0) {
    throw new Error("No valid input files for scaffold generation.");
  }

  const focused = changedRangesByRel.size > 0;

  // Cap the number of files shown to the model; prefer files with changes.
  const ranked = [...inputs].sort((a, b) => {
    const aFocus = a.changedRanges && a.changedRanges.length > 0 ? 1 : 0;
    const bFocus = b.changedRanges && b.changedRanges.length > 0 ? 1 : 0;
    return bFocus - aFocus || a.content.length - b.content.length;
  });
  const shown = ranked.slice(0, MAX_FOCUS_FILES);
  if (shown.length < inputs.length) {
    log.appendLine(`[scaffold] Showing ${shown.length} of ${inputs.length} file(s) to the model (size cap).`);
  }

  const contextPayload: ScaffoldContextFile[] = [];
  let contextChars = 0;
  for (const cf of p.contextFiles ?? []) {
    const content = truncateContent(cf.content);
    if (contextChars + content.length > MAX_CONTEXT_CHARS) { continue; }
    contextPayload.push({ path: cf.path, content });
    contextChars += content.length;
  }

  const selectionPayload = JSON.stringify({
    studentBriefMd: p.briefMd,
    files: shown.map((f) => ({
      path: f.rel,
      ...(f.changedRanges && f.changedRanges.length > 0 ? { changedRanges: f.changedRanges } : {}),
      content: truncateContent(f.content),
    })),
    ...(contextPayload.length > 0 ? { contextFiles: contextPayload } : {}),
  });

  // ---- Call 1: task selection --------------------------------------------
  report("Choosing task regions…");
  const selectionInstructions = buildSelectionInstructions(focused, taskCountHintForSize(shown));
  const selectionRaw = await client.requestJson({
    instructions: selectionInstructions,
    payload: selectionPayload,
    requiredKeys: ["tasks"],
    schemaName: "emit_task_selection",
    schema: TASK_SELECTION_SCHEMA,
    traceLabel: "Task selection",
  });

  const parsed = parseTaskSelectionResponse(selectionRaw as object);
  for (const problem of parsed.entryProblems) {
    log.appendLine(`[scaffold] Ignored malformed task entry: ${problem}`);
  }
  log.appendLine(`[scaffold] Model nominated ${parsed.selections.length} task(s).`);

  let resolution = resolveTaskSelections(filesByRel, parsed.selections, changedRangesByRel);
  let resolvedCount = [...resolution.masksByFile.values()].reduce((n, m) => n + m.length, 0);

  // ---- Optional single repair pass, scoped to the failed items only ------
  if (resolution.failures.length > 0 && resolvedCount < 5) {
    report("Correcting task selections…");
    log.appendLine(`[scaffold] ${resolution.failures.length} selection(s) failed; requesting corrections for those only.`);
    for (const f of resolution.failures) {
      log.appendLine(`[scaffold]   - ${f.id} (${f.path}): ${f.reason}`);
    }

    const failedIds = new Set(resolution.failures.map((f) => f.id));
    const survivors = parsed.selections.filter((s) => !failedIds.has(String(s.id)));

    const repairInstructions = [
      "Some of your task selections could not be applied. Re-emit CORRECTED tasks for ONLY the failed items listed below, using the same JSON schema:",
      '{"tasks":[{"id":string,"path":string,"targetSnippet":string,"placeholder":string,"hint":string,"explanation":string}]}',
      "Failed items:",
      ...resolution.failures.map((f) => `- id '${f.id}' in '${f.path}': ${f.reason}`),
      "Remember: targetSnippet must be copied EXACTLY (character for character, including indentation) from the file content in the INPUT PAYLOAD and must occur exactly once in that file.",
      "Do not repeat tasks that were not listed as failed.",
    ].join("\n");

    try {
      const repairRaw = await client.requestJson({
        instructions: repairInstructions,
        payload: selectionPayload,
        requiredKeys: ["tasks"],
        schemaName: "emit_task_selection",
        schema: TASK_SELECTION_SCHEMA,
        traceLabel: "Task selection repair",
      });
      const repairParsed = parseTaskSelectionResponse(repairRaw as object);
      const merged: TaskSelection[] = [...survivors, ...repairParsed.selections];
      resolution = resolveTaskSelections(filesByRel, merged, changedRangesByRel);
      resolvedCount = [...resolution.masksByFile.values()].reduce((n, m) => n + m.length, 0);
      for (const f of resolution.failures) {
        log.appendLine(`[scaffold] Still unusable after repair (dropped): ${f.id} (${f.path}): ${f.reason}`);
      }
    } catch (err: any) {
      log.appendLine(`[scaffold] Repair call failed (${err?.message ?? String(err)}); continuing with ${resolvedCount} task(s).`);
    }
  } else {
    for (const f of resolution.failures) {
      log.appendLine(`[scaffold] Dropped unusable selection: ${f.id} (${f.path}): ${f.reason}`);
    }
  }

  if (resolvedCount === 0) {
    throw new Error("No usable task regions could be resolved from the model's selections. Try again, or simplify the request.");
  }

  // ---- Deterministic masking ----------------------------------------------
  report("Inserting task markers…");
  const maskedFiles: Array<{ path: string; content: string }> = [];
  const tasks: ScaffoldTask[] = [];
  for (const [rel, masks] of [...resolution.masksByFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (masks.length === 0) { continue; }
    const content = filesByRel.get(rel)!;
    const result = applyMasksToContent(rel, content, masks);
    maskedFiles.push({ path: rel, content: result.maskedContent });
    tasks.push(...result.tasks);
  }
  log.appendLine(`[scaffold] Masked ${maskedFiles.length} file(s) with ${tasks.length} task(s).`);

  // ---- Call 2: exercises + comprehension Q&A ------------------------------
  report("Writing exercises…");
  const exercisesPayload = JSON.stringify({
    studentBriefMd: p.briefMd,
    tasks: tasks.map((t) => ({
      id: t.id,
      path: t.path,
      hint: t.hint ?? "",
      explanation: t.explanation ?? "",
      solution: t.solution,
    })),
  });

  let exercisesMd = "";
  let comprehensionAnswersMd = "";
  try {
    let ex = parseExercisesResponse(await client.requestJson({
      instructions: buildExercisesInstructions(),
      payload: exercisesPayload,
      requiredKeys: ["exercisesMd"],
      schemaName: "emit_exercises",
      schema: EXERCISES_SCHEMA,
      traceLabel: "Exercises generation",
    }) as object);

    const problems = collectExerciseProblems(ex.exercisesMd, ex.comprehensionAnswersMd);
    if (problems.length > 0) {
      report("Correcting exercises…");
      log.appendLine(`[scaffold] Exercises need corrections: ${problems.join(" | ")}`);
      try {
        ex = parseExercisesResponse(await client.requestJson({
          instructions:
            buildExercisesInstructions() +
            "\n\nYour previous response had these problems — fix ALL of them and return the full corrected JSON object:\n" +
            problems.map((s) => `- ${s}`).join("\n"),
          payload: exercisesPayload,
          requiredKeys: ["exercisesMd"],
          schemaName: "emit_exercises",
          schema: EXERCISES_SCHEMA,
          traceLabel: "Exercises repair",
        }) as object);
      } catch (err: any) {
        log.appendLine(`[scaffold] Exercises repair failed (${err?.message ?? String(err)}); using previous response.`);
      }
      const remaining = collectExerciseProblems(ex.exercisesMd, ex.comprehensionAnswersMd);
      if (remaining.length > 0) {
        log.appendLine(`[scaffold] Exercises still imperfect (accepted anyway): ${remaining.join(" | ")}`);
      }
    }
    exercisesMd = ex.exercisesMd;
    comprehensionAnswersMd = ex.comprehensionAnswersMd;
  } catch (err: any) {
    log.appendLine(`[scaffold] Exercises generation failed (${err?.message ?? String(err)}); using a deterministic fallback sheet.`);
    exercisesMd = buildFallbackExercisesMd(p.briefMd, tasks);
    comprehensionAnswersMd = "";
  }

  // ---- Assemble plan -------------------------------------------------------
  const plan: ScaffoldPlan = {
    maskedFiles,
    tasks,
    exercisesMd,
    answerKeyMd: assembleAnswerKeyMd(tasks, comprehensionAnswersMd),
  };

  // Sanity check: with deterministic masking this should always be clean.
  const issues = validateScaffoldPlan(plan);
  if (issues.length > 0) {
    log.appendLine("[scaffold] Unexpected validation issues in assembled plan (continuing):");
    log.appendLine(formatScaffoldIssuesForPrompt(issues));
  }

  return plan;
}

function collectExerciseProblems(exercisesMd: string, comprehensionAnswersMd: string): string[] {
  const problems: string[] = [];
  const cqIds = extractComprehensionQuestionIds(exercisesMd);
  if (cqIds.length < 3) {
    problems.push(`exercisesMd must contain at least 5 comprehension questions tagged [CQ1], [CQ2], ... (found ${cqIds.length} tag(s)).`);
  }
  const missing = cqIds.filter((id) => !answerKeyHasAnswerFor(id, comprehensionAnswersMd));
  if (missing.length > 0) {
    problems.push(`comprehensionAnswersMd is missing answers for: ${missing.join(", ")} (repeat each tag literally with its answer).`);
  }
  return problems;
}
