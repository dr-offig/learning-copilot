/**
 * Reaching Figma from the extension, without going through chat.
 *
 * The Figma MCP server is registered in VS Code (user or workspace
 * `mcp.json`), which means its tools appear in `vscode.lm.tools` and can be
 * called directly with `vscode.lm.invokeTool`. No model is involved: we know
 * exactly which tool we want and exactly what to send it, so this is an
 * ordinary async function call that happens to run code inside Figma. Nothing
 * is spent on Copilot requests, and the student is never handed off to chat.
 *
 * VS Code owns the MCP server lifecycle and its OAuth, which also sidesteps
 * Figma gating remote-MCP OAuth to approved clients — VS Code is one, a
 * hand-rolled client in this extension would not be.
 */

import * as vscode from "vscode";

import { DELIVERY_MODES, buildExtractorScript, readExtractorResult } from "./figmascript";
import type { DeliveryMode } from "./figmascript";
import type { FigmaTokenReport } from "./figmatokens";

/**
 * VS Code namespaces MCP tools (`mcp_figma_use_figma`), and the prefix depends
 * on what the server is called in the user's config, so the tool is matched by
 * suffix rather than by an exact name.
 */
const USE_FIGMA_SUFFIX = "use_figma";

/** Input keys the extractor call may need, filtered against the tool's schema. */
/**
 * Shown in VS Code's confirmation dialog alongside the script, so it says what
 * the call is for and that nothing in the design is modified.
 */
const CALL_DESCRIPTION =
  "Learning Copilot: read this file's variables, modes and text styles so they can be written out as CSS. Read-only — nothing in the design is changed.";
const FIGMA_SKILL = "resource:figma-use";

export type FigmaToolLookup =
  | { ok: true; tool: vscode.LanguageModelToolInformation }
  | { ok: false; reason: string };

/**
 * Every language model tool VS Code currently exposes. Worth logging when the
 * lookup fails: "no Figma tools" and "the MCP server never started" look
 * identical from the outside, and the tool list tells them apart.
 */
export function listAvailableToolNames(): string[] {
  return (vscode.lm?.tools ?? []).map((t) => t.name).sort();
}

/**
 * Finds the `use_figma` tool among the language model tools VS Code currently
 * exposes. Absent means the Figma MCP server is not configured, not started,
 * or not signed in.
 */
export function findUseFigmaTool(): FigmaToolLookup {
  const tools: readonly vscode.LanguageModelToolInformation[] = vscode.lm?.tools ?? [];
  const matches = tools.filter((t) => t.name === USE_FIGMA_SUFFIX || t.name.endsWith(`_${USE_FIGMA_SUFFIX}`));

  if (matches.length === 0) {
    const figmaish = tools.filter((t) => t.name.toLowerCase().includes("figma"));
    return {
      ok: false,
      reason: figmaish.length > 0
        ? `The Figma MCP server is available but does not expose '${USE_FIGMA_SUFFIX}'. Tools found: ${figmaish.map((t) => t.name).join(", ")}.`
        : "No Figma MCP tools are available. Add the Figma MCP server to VS Code, then sign in when prompted.",
    };
  }
  // Deterministic when a workspace and a user config both register one.
  return { ok: true, tool: [...matches].sort((a, b) => a.name.localeCompare(b.name))[0] };
}

/** Property names the tool declares, or null when it publishes no schema. */
function declaredProperties(tool: vscode.LanguageModelToolInformation): Set<string> | null {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
  if (!schema?.properties || typeof schema.properties !== "object") { return null; }
  return new Set(Object.keys(schema.properties));
}

/**
 * Builds the tool input, keeping only keys the tool actually declares so that
 * a change to Figma's schema degrades to a missing extra rather than a
 * validation failure.
 */
function buildToolInput(
  tool: vscode.LanguageModelToolInformation,
  fileKey: string,
  code: string
): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    fileKey,
    code,
    description: CALL_DESCRIPTION,
    skillNames: FIGMA_SKILL,
  };
  const declared = declaredProperties(tool);
  if (!declared) { return candidate; }

  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (declared.has(key)) { input[key] = value; }
  }
  // fileKey and code are the payload; if the schema names neither, send
  // everything and let the tool complain rather than silently sending nothing.
  return "code" in input ? input : candidate;
}

/** Concatenates the text parts of a tool result. */
function flattenToolResult(result: vscode.LanguageModelToolResult): string {
  const chunks: string[] = [];
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      chunks.push(part.value);
    } else if (typeof part === "string") {
      chunks.push(part);
    } else if (part && typeof (part as any).value === "string") {
      chunks.push((part as any).value);
    }
  }
  return chunks.join("\n");
}

export type FigmaExtraction = {
  report: FigmaTokenReport;
  /** The delivery mode that worked; worth persisting to skip the probe next time. */
  deliveryMode: DeliveryMode;
  /** True when the probe had to fall back, i.e. the caller should save the mode. */
  learned: boolean;
};

export type ExtractFigmaTokensArgs = {
  fileKey: string;
  /** Delivery mode learned on a previous run; tried first when known. */
  knownDeliveryMode?: DeliveryMode;
  output: vscode.OutputChannel;
  token?: vscode.CancellationToken;
  report?: (message: string) => void;
};

function truncate(text: string, max = 600): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Runs the token extractor inside Figma and returns the parsed report.
 *
 * `use_figma` discards a script's return value, so the payload comes back as a
 * deliberate exception (see `DELIVERY_MODES`). That is measured, not
 * documented, so the other variant is still tried if the first yields nothing
 * — costing at most one extra call, once ever, since the caller persists
 * `deliveryMode` and passes it back as `knownDeliveryMode`. Keeping it to one
 * call matters twice over: Figma meters MCP reads against the plan of the team
 * owning the file, and each call also costs the student a confirmation prompt.
 *
 * @param args File key, learned delivery mode, and progress plumbing.
 * @throws If the tool is unavailable or every delivery mode fails.
 */
export async function extractFigmaTokens(args: ExtractFigmaTokensArgs): Promise<FigmaExtraction> {
  const { fileKey, knownDeliveryMode, output, token } = args;

  const lookup = findUseFigmaTool();
  if (!lookup.ok) { throw new Error(lookup.reason); }
  const tool = lookup.tool;
  output.appendLine(`[figma] Using tool '${tool.name}' for file ${fileKey}`);

  // A known-good mode is tried alone: probing again would spend a call to
  // re-learn something already settled.
  const order: DeliveryMode[] = knownDeliveryMode ? [knownDeliveryMode] : [...DELIVERY_MODES];
  const failures: string[] = [];

  for (const mode of order) {
    args.report?.(
      order.length > 1 && mode !== order[0]
        ? `Retrying extraction (${mode} delivery)…`
        : "Extracting variables and text styles from Figma…"
    );

    const input = buildToolInput(tool, fileKey, buildExtractorScript(mode));
    let text: string;
    try {
      const result = await vscode.lm.invokeTool(
        tool.name,
        { input, toolInvocationToken: undefined },
        token
      );
      text = flattenToolResult(result);
    } catch (e: any) {
      // The tool itself refused (permission, rate limit, cancelled). Another
      // delivery mode cannot help, and retrying would spend a second call.
      throw new Error(`Figma rejected the request: ${e?.message ?? String(e)}`);
    }

    output.appendLine(`[figma] ${mode} delivery returned ${text.length} chars`);
    const read = readExtractorResult(text);
    if (read.ok) {
      return { report: read.report, deliveryMode: mode, learned: mode !== knownDeliveryMode };
    }

    failures.push(`${mode}: ${read.reason}`);
    output.appendLine(`[figma] ${mode} delivery yielded no report (${read.reason}). Result was: ${truncate(text)}`);

    // A payload that arrived but would not parse is a data problem; switching
    // delivery mode would only waste another call.
    if (!read.reason.includes("No token report found")) { break; }
  }

  throw new Error(
    `Could not read a token report from Figma. ${failures.join("; ")}. ` +
    "See the Learning Copilot output channel for the raw response."
  );
}

/**
 * Pulls the file key out of a Figma URL, or returns a bare key unchanged.
 * Accepts `/design/<key>/…`, `/file/<key>/…`, `/proto/<key>/…`.
 *
 * @param input A Figma URL or a raw file key.
 */
export function parseFigmaFileKey(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) { return null; }

  const fromUrl = /figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/.exec(trimmed);
  if (fromUrl) { return fromUrl[1]; }

  // Figma keys are opaque alphanumeric strings; reject anything URL-ish that
  // did not match above rather than sending a doomed request.
  if (/^[A-Za-z0-9]{10,}$/.test(trimmed)) { return trimmed; }
  return null;
}
