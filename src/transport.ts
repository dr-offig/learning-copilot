/**
 * Model transports.
 *
 * Two ways to reach a Copilot model, behind one interface:
 *
 * - VscodeLmClient: VS Code's Language Model API (`vscode.lm`). Preferred when
 *   the GitHub Copilot Chat extension is installed and signed in: no CLI
 *   install, no argv size limits, and schema-constrained output via a
 *   required tool call when the model supports it.
 *
 * - CopilotCliClient: shells out to the Copilot CLI (`copilot -p`). Kept as a
 *   fallback for machines without Copilot Chat (e.g. locked-down lab
 *   machines using the extension-managed CLI install). Prompts that exceed
 *   the platform's command-line limits are delivered via a payload file in a
 *   scratch working directory that the CLI reads with its (permission-free)
 *   read tools; write/shell tools are explicitly denied for those runs.
 */

import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { extractLikelyJsonObject } from "./masking";
import type { LlmJsonClient, LlmJsonRequest } from "./types";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

//#region <COPILOT CLI TRANSPORT>

export type CopilotCliClientOptions = {
  copilotPath: string;
  baseArgs: string[];
  /** Working directory for regular (argv) runs. */
  defaultCwd: string;
  /** Directory under which per-call payload scratch dirs are created. */
  scratchRoot: string;
  /** Directory scanned for CLI log tails when a run fails silently. */
  logDir: string;
  output: vscode.OutputChannel;
};

/**
 * Windows CreateProcess caps the whole command line at ~32K chars; Linux caps
 * a single argv element at 128KiB. Stay comfortably below both.
 */
const CLI_PROMPT_CHAR_LIMIT = process.platform === "win32" ? 24_000 : 90_000;

export class CopilotCliClient implements LlmJsonClient {
  readonly id = "copilot-cli" as const;
  readonly label: string;

  constructor(private readonly opts: CopilotCliClientOptions) {
    this.label = `Copilot CLI (${opts.copilotPath})`;
  }

  async requestJson(req: LlmJsonRequest): Promise<unknown> {
    const stdout = await this.runPrompt(req);
    const raw = extractLikelyJsonObject(stdout, req.requiredKeys);
    return JSON.parse(raw);
  }

  private ensureSilentArgs(): string[] {
    const args = this.opts.baseArgs;
    return args.includes("-s") || args.includes("--silent") ? [...args] : ["-s", ...args];
  }

  private async runPrompt(req: LlmJsonRequest): Promise<string> {
    const inlinePrompt = req.payload
      ? `${req.instructions}\n\nINPUT PAYLOAD:\n${req.payload}`
      : req.instructions;

    if (inlinePrompt.length <= CLI_PROMPT_CHAR_LIMIT) {
      return await this.spawnCopilot(this.ensureSilentArgs(), inlinePrompt, this.opts.defaultCwd, req.traceLabel);
    }

    // Payload-file mode: the CLI reads files in its cwd without needing tool
    // approval, so large payloads are handed over on disk instead of argv.
    const filePrompt =
      `${req.instructions}\n\n` +
      "The INPUT PAYLOAD is too large to include here. Read the file ./payload.json in the current working directory and treat its entire contents as the INPUT PAYLOAD. " +
      "Do not modify any files, do not run shell commands, and do not read anything other than ./payload.json.";
    if (filePrompt.length > CLI_PROMPT_CHAR_LIMIT) {
      throw new Error(`Prompt instructions are too long for the Copilot CLI on this platform (${filePrompt.length} chars).`);
    }

    const scratchDir = path.join(this.opts.scratchRoot, `payload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(scratchDir, { recursive: true });
    try {
      await fsp.writeFile(path.join(scratchDir, "payload.json"), req.payload ?? "", "utf8");
      this.opts.output.appendLine(
        `[transport] Prompt payload (${(req.payload ?? "").length} chars) exceeds argv limit; delivering via ${scratchDir}/payload.json`
      );
      const args = [...this.ensureSilentArgs(), "--deny-tool=write", "--deny-tool=shell"];
      return await this.spawnCopilot(args, filePrompt, scratchDir, req.traceLabel);
    } finally {
      fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
    }
  }

  private spawnCopilot(args: string[], prompt: string, cwd: string, traceLabel: string): Promise<string> {
    const { copilotPath, output, logDir } = this.opts;
    return new Promise<string>((resolve, reject) => {
      const startedAt = Date.now();
      const effectiveArgs = [...args, "-p", prompt];
      const proc = spawn(copilotPath, effectiveArgs, { cwd, env: process.env, shell: false });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => (stdout += d.toString("utf8")));
      proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));

      proc.on("error", (err) => reject(err));
      proc.on("close", async (code) => {
        const exitCode = code ?? 0;
        if (exitCode !== 0 && !stdout.trim() && !stderr.trim()) {
          // Copilot sometimes fails silently but writes the reason to its logs.
          await this.appendNewestLogTail(logDir);
        }
        output.appendLine(
          `[call ${formatElapsed(Date.now() - startedAt)}] ${traceLabel} - exit=${code ?? "null"}, promptChars=${prompt.length}, stdoutChars=${stdout.length}, stderrChars=${stderr.length}`
        );
        if (exitCode !== 0) {
          reject(new Error(stderr.trim() || `Copilot CLI failed (exit ${code}).`));
          return;
        }
        if (!stdout.trim()) {
          reject(new Error(stderr.trim() || "Copilot CLI returned empty output."));
          return;
        }
        resolve(stdout);
      });

      const promptPreview = prompt.length > 400 ? `${prompt.slice(0, 400)}… [${prompt.length} chars]` : prompt;
      output.appendLine(`> ${copilotPath} ${args.join(" ")} -p ${JSON.stringify(promptPreview)}`);
    });
  }

  private async appendNewestLogTail(logDir: string): Promise<void> {
    try {
      const entries = await fsp.readdir(logDir, { withFileTypes: true });
      let newest: { p: string; mtimeMs: number } | null = null;
      for (const e of entries) {
        if (!e.isFile()) { continue; }
        const p = path.join(logDir, e.name);
        const st = await fsp.stat(p);
        if (!newest || st.mtimeMs > newest.mtimeMs) {
          newest = { p, mtimeMs: st.mtimeMs };
        }
      }
      if (!newest) { return; }
      const content = await fsp.readFile(newest.p, "utf8");
      const lines = content.split(/\r?\n/);
      const tail = lines.slice(Math.max(0, lines.length - 80)).join("\n");
      this.opts.output.appendLine("\n--- Copilot log (tail) ---");
      this.opts.output.appendLine(`log file: ${newest.p}`);
      this.opts.output.appendLine(tail);
    } catch {
      // ignore
    }
  }
}

//#endregion

//#region <VS CODE LANGUAGE MODEL API TRANSPORT>

export class VscodeLmClient implements LlmJsonClient {
  readonly id = "vscode-lm" as const;
  readonly label: string;

  constructor(
    private readonly model: vscode.LanguageModelChat,
    private readonly output: vscode.OutputChannel
  ) {
    this.label = `Language Model API (${model.vendor}/${model.family} '${model.name}')`;
  }

  async requestJson(req: LlmJsonRequest): Promise<unknown> {
    const messages = [vscode.LanguageModelChatMessage.User(req.instructions)];
    if (req.payload) {
      messages.push(vscode.LanguageModelChatMessage.User(`INPUT PAYLOAD:\n${req.payload}`));
    }
    const justification =
      "Learning Copilot turns generated code into learning exercises for the student.";

    // Preferred: force a tool call so the response is schema-constrained.
    try {
      const result = await this.sendConstrained(messages, req, justification);
      if (result !== undefined) {
        return result;
      }
      this.output.appendLine(`[transport] ${req.traceLabel}: model returned no tool call; falling back to free text.`);
    } catch (err: any) {
      this.output.appendLine(
        `[transport] ${req.traceLabel}: constrained mode unavailable (${err?.message ?? String(err)}); falling back to free text.`
      );
    }

    const text = await this.sendPlain(messages, req, justification);
    const raw = extractLikelyJsonObject(text, req.requiredKeys);
    return JSON.parse(raw);
  }

  private async sendConstrained(
    messages: vscode.LanguageModelChatMessage[],
    req: LlmJsonRequest,
    justification: string
  ): Promise<unknown | undefined> {
    const startedAt = Date.now();
    const response = await this.model.sendRequest(messages, {
      justification,
      tools: [
        {
          name: req.schemaName,
          description: "Report the result. Always call this tool exactly once with the complete result.",
          inputSchema: req.schema,
        },
      ],
      toolMode: vscode.LanguageModelChatToolMode.Required,
    });

    let toolInput: unknown;
    let textFallback = "";
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelToolCallPart && part.name === req.schemaName) {
        toolInput = part.input;
      } else if (part instanceof vscode.LanguageModelTextPart) {
        textFallback += part.value;
      }
    }
    this.output.appendLine(
      `[call ${formatElapsed(Date.now() - startedAt)}] ${req.traceLabel} - via ${this.label} (constrained), toolCall=${toolInput !== undefined}`
    );
    if (toolInput !== undefined) {
      return toolInput;
    }
    if (textFallback.trim()) {
      const raw = extractLikelyJsonObject(textFallback, req.requiredKeys);
      return JSON.parse(raw);
    }
    return undefined;
  }

  private async sendPlain(
    messages: vscode.LanguageModelChatMessage[],
    req: LlmJsonRequest,
    justification: string
  ): Promise<string> {
    const startedAt = Date.now();
    const response = await this.model.sendRequest(messages, { justification });
    let text = "";
    for await (const chunk of response.text) {
      text += chunk;
    }
    this.output.appendLine(
      `[call ${formatElapsed(Date.now() - startedAt)}] ${req.traceLabel} - via ${this.label} (text), chars=${text.length}`
    );
    return text;
  }
}

/**
 * Attempts to create a Language Model API client. Returns null when the API
 * or a Copilot model is unavailable (e.g. Copilot Chat not installed or not
 * signed in), letting the caller fall back to the CLI transport.
 */
export async function tryCreateVscodeLmClient(
  preferredFamily: string,
  output: vscode.OutputChannel
): Promise<VscodeLmClient | null> {
  const lm: typeof vscode.lm | undefined = (vscode as any).lm;
  if (!lm?.selectChatModels) {
    return null;
  }

  try {
    let models = await lm.selectChatModels({ vendor: "copilot", ...(preferredFamily ? { family: preferredFamily } : {}) });
    if (models.length === 0 && preferredFamily) {
      output.appendLine(`[transport] No Copilot model with family '${preferredFamily}'; trying any Copilot model.`);
      models = await lm.selectChatModels({ vendor: "copilot" });
    }
    if (models.length === 0) {
      return null;
    }
    // Prefer the largest context window when the user hasn't pinned a family.
    const model = [...models].sort((a, b) => b.maxInputTokens - a.maxInputTokens)[0];
    output.appendLine(
      `[transport] Using Language Model API: ${model.vendor}/${model.family} '${model.name}' (maxInputTokens=${model.maxInputTokens}).`
    );
    return new VscodeLmClient(model, output);
  } catch (err: any) {
    output.appendLine(`[transport] Language Model API unavailable: ${err?.message ?? String(err)}`);
    return null;
  }
}

//#endregion
