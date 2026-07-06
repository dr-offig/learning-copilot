/**
 * Shared types used across the extension, the scaffold pipeline, and the
 * pure masking logic. This module must stay free of `vscode` imports so that
 * the pipeline and masking code remain unit-testable outside VS Code.
 */

export type WrittenFile = { rel: string; fullContent: string };

/** 1-based inclusive line range. */
export type LineRange = { startLine: number; endLine: number };

export type ScaffoldTask = {
  id: string;
  path: string;
  solution: string;
  hint?: string;
  explanation?: string;
  completed?: boolean;
};

export type ScaffoldPlan = {
  maskedFiles: Array<{ path: string; content: string }>;
  tasks: ScaffoldTask[];
  exercisesMd: string;
  answerKeyMd?: string;
  notes?: string;
};

/**
 * A task region chosen by the model. The model only ever nominates a verbatim
 * snippet; the extension inserts markers and placeholders deterministically.
 */
export type TaskSelection = {
  id: string;
  path: string;
  targetSnippet: string;
  placeholder: string;
  hint?: string;
  explanation?: string;
};

export type StudentBriefSection = {
  title: string;
  summary: string;
  files?: string[];
  visibleEffect?: string;
  behavior?: string;
  whyItMatters?: string;
};

export type StudentBrief = {
  overviewMd: string;
  sections?: StudentBriefSection[];
};

export type ScaffoldContextFile = { path: string; content: string };

export type FocusFileWithDiff = {
  rel: string;
  fullContent: string;
  oldContent: string;
  changedRanges: LineRange[];
};

export type WorkspaceFileContext = { path: string; content: string; truncated?: boolean };

/** Minimal logging surface satisfied by vscode.OutputChannel. */
export type LineLogger = { appendLine(line: string): void };

/**
 * A single structured-output request to a language model. `instructions`
 * must stay short; anything large (file contents etc.) goes in `payload` so
 * transports can route it around size limits (argv caps, token budgets).
 */
export type LlmJsonRequest = {
  instructions: string;
  payload?: string;
  /** Keys that must exist on the result object; used by text-extraction fallbacks. */
  requiredKeys: string[];
  /** Tool/function name used by schema-constrained transports. */
  schemaName: string;
  /** JSON schema for the expected response object. */
  schema: object;
  traceLabel: string;
};

/**
 * Transport-agnostic client for JSON-producing model calls. Implemented by
 * the Copilot CLI transport and the VS Code Language Model API transport.
 */
export interface LlmJsonClient {
  readonly id: "copilot-cli" | "vscode-lm";
  readonly label: string;
  requestJson(req: LlmJsonRequest): Promise<unknown>;
}
