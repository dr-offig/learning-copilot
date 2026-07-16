import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  computeChangedRangesByPrefixSuffix,
  findNextTaskRegion,
  findTaskRegionAtPosition,
  formatRangesForPrompt,
  getRegionStartLine,
  listTaskRegions,
  normalizeRelativePath,
  type TaskRegionHit,
} from "./masking";
import { generateScaffoldPlanDeterministic, type ScaffoldFileInput } from "./scaffold";
import { CopilotCliClient, tryCreateVscodeLmClient } from "./transport";
import type {
  FocusFileWithDiff,
  LlmJsonClient,
  ScaffoldContextFile,
  ScaffoldPlan,
  ScaffoldTask,
  StudentBrief,
  WorkspaceFileContext,
  WrittenFile,
} from "./types";

let statusBar: vscode.StatusBarItem | null = null;
let menuStatusBar: vscode.StatusBarItem | null = null;
let lastTaskLinkColumn: vscode.ViewColumn | undefined;
let taskBlockDecorationType: vscode.TextEditorDecorationType | null = null;
let activeTaskBlockDecorationType: vscode.TextEditorDecorationType | null = null;
let taskMarkerDecorationType: vscode.TextEditorDecorationType | null = null;

function setBusyStatus(text: string | null) {
  if (!statusBar) { return; }
  if (!text) {
    statusBar.hide();
    return;
  }
  statusBar.text = `$(sync~spin) ${text}`;
  statusBar.tooltip = "Learning Copilot is working…";
  statusBar.show();
}

function formatElapsedMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function reportActivity(
  progress: vscode.Progress<{ message?: string; increment?: number }> | null,
  output: vscode.OutputChannel,
  startedAt: number,
  message: string,
  busyText?: string,
  increment?: number
) {
  const elapsed = formatElapsedMs(Date.now() - startedAt);
  const decorated = `${message} (${elapsed})`;
  if (progress) {
    progress.report({ message: decorated, increment });
  }
  output.appendLine(`[workflow ${elapsed}] ${message}`);
  setBusyStatus(busyText ?? message);
}

function logDuration(
  output: vscode.OutputChannel,
  label: string,
  startedAt: number,
  details?: string
) {
  const elapsed = formatElapsedMs(Date.now() - startedAt);
  output.appendLine(`[call ${elapsed}] ${label}${details ? ` - ${details}` : ""}`);
}

const proposedContent = new Map<string, string>();
const PROPOSED_SCHEME = "learning-copilot";
const SOLUTION_SCHEME = "learning-copilot-solution";
const EXTENSION_URI_ID = "dr-offig.learning-copilot";

type StudentBriefLike = {
  files: Array<{ path: string; content: string; overwrite?: boolean }>;
  notes?: string;
  studentBriefMd?: string;
  studentBrief?: StudentBrief;
};

//#region <COPILOT INSTALLATION AND CONFIG>
/**
* ============================================================================
* <COPILOT INSTALLATION AND CONFIG>
* ============================================================================
* Setting up copilot path and installation.  This is a bit complex because we want to support auto-installing the Copilot CLI for users who don't have it,
* but the installer requires admin permissions on some platforms. So we install it into the extension's storage directory and configure it to use that path,
* which avoids needing admin permissions and keeps it contained.
*/

/**
* Reads extension configuration values for Copilot CLI execution.
*/
function getConfig() {
  const cfg = vscode.workspace.getConfiguration("learningCopilot");
  return {
    copilotPath: cfg.get<string>("copilotPath", "copilot"),
    copilotArgs: cfg.get<string[]>("copilotArgs", []),
    transport: cfg.get<string>("transport", "auto"),
    modelFamily: cfg.get<string>("modelFamily", ""),
  };
}

/**
* Returns whether automatic Copilot CLI installation is enabled.
*/
function getAutoInstallEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration("learningCopilot");
  return cfg.get<boolean>("autoInstallCopilotCli", true);
}

/**
* Persists a Copilot CLI binary path to the global extension settings.
*
* @param newPath Absolute path to the Copilot CLI executable.
*/
async function setCopilotPath(newPath: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("learningCopilot");
  await cfg.update("copilotPath", newPath, vscode.ConfigurationTarget.Global);
}

async function pickAndSetCopilotPath(): Promise<string | null> {
  const pick = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Use Copilot CLI",
    filters: process.platform === "win32"
    ? { "Executables": ["exe", "cmd"] }
    : undefined,
  });
  const chosen = pick?.[0];
  if (!chosen) {
    return null;
  }

  const selectedPath = chosen.fsPath;
  const kind = await detectCopilotCliKind(selectedPath);
  if (kind === "missing") {
    throw new Error(`Selected file is not a runnable Copilot CLI: ${selectedPath}`);
  }
  if (kind === "legacy") {
    throw new Error(`Selected file is the deprecated gh-copilot CLI: ${selectedPath}`);
  }

  await setCopilotPath(selectedPath);
  return selectedPath;
}

/**
* Resolves the currently configured Copilot CLI executable path.
*/
function getConfiguredCopilotPath(): string {
  const { copilotPath } = getConfig();
  return copilotPath;
}

function getDefaultCopilotConfigDir(): string {
  return path.join(os.homedir(), ".copilot");
}

async function getInstalledCopilotStatus(): Promise<{ path: string; kind: CopilotCliKind }> {
  const configured = getConfiguredCopilotPath();
  const configuredKind = await detectCopilotCliKind(configured);
  if (configuredKind !== "missing" || configured === "copilot") {
    return { path: configured, kind: configuredKind };
  }

  const fallbackKind = await detectCopilotCliKind("copilot");
  if (fallbackKind !== "missing") {
    return { path: "copilot", kind: fallbackKind };
  }

  return { path: configured, kind: "missing" };
}

type CopilotCliKind = "missing" | "legacy" | "modern";
type CopilotAuthStatus = "authenticated" | "unauthenticated" | "unknown";

/**
* Distinguishes the current prompt-capable Copilot CLI from the deprecated
* legacy gh-copilot binary.
*/
function detectCopilotCliKind(copilotPath: string): Promise<CopilotCliKind> {
  return new Promise<CopilotCliKind>((resolve) => {
    try {
      const p = spawn(copilotPath, ["-p", "__learning_copilot_probe__"], { shell: false });
      let done = false;
      let combined = "";
      const legacyPattern = /unknown shorthand flag:\s*'p'|unknown command .* for "copilot"/i;

      const finish = (kind: CopilotCliKind) => {
        if (!done) {
          done = true;
          try {
            p.kill();
          } catch {
            // ignore
          }
          resolve(kind);
        }
      };

      const inspect = (chunk: Buffer | string) => {
        combined += chunk.toString();
        if (legacyPattern.test(combined)) {
          finish("legacy");
        }
      };

      p.stdout.on("data", inspect);
      p.stderr.on("data", inspect);
      p.on("error", () => finish("missing"));
      p.on("exit", () => finish(legacyPattern.test(combined) ? "legacy" : "modern"));

      // The modern CLI may take longer because it starts actual prompt handling.
      setTimeout(() => finish(legacyPattern.test(combined) ? "legacy" : "modern"), 1500);
    } catch {
      resolve("missing");
    }
  });
}

/**
* Best-effort authentication probe. This intentionally errs on "unknown"
* instead of prompting the user or blocking for a long-running model response.
*/
function detectCopilotAuthStatus(copilotPath: string): Promise<CopilotAuthStatus> {
  return new Promise<CopilotAuthStatus>((resolve) => {
    try {
      const p = spawn(
        copilotPath,
        ["-s", "-p", "Reply with OK only.", "--allow-all-tools"],
        { shell: false }
      );
      let done = false;
      let stdout = "";
      let stderr = "";
      const unauthPattern =
      /no authentication information found|not logged in|authentication required|run .*login/i;

      const finish = (status: CopilotAuthStatus) => {
        if (!done) {
          done = true;
          try {
            p.kill();
          } catch {
            // ignore
          }
          resolve(status);
        }
      };

      p.stdout.on("data", (d) => {
        stdout += d.toString("utf8");
      });
      p.stderr.on("data", (d) => {
        stderr += d.toString("utf8");
        if (unauthPattern.test(stderr)) {
          finish("unauthenticated");
        }
      });
      p.on("error", () => finish("unknown"));
      p.on("exit", (code) => {
        if (unauthPattern.test(stderr)) {
          finish("unauthenticated");
          return;
        }
        if (code === 0 && stdout.trim()) {
          finish("authenticated");
          return;
        }
        finish("unknown");
      });

      setTimeout(() => finish("unknown"), 5000);
    } catch {
      resolve("unknown");
    }
  });
}

/**
* Builds the extension-local Copilot config directory path.
*
* @param storageDir Extension storage directory.
*/
function getCopilotConfigDir(storageDir: string): string {
  return path.join(storageDir, "copilot-config");
}

/**
* Builds the extension-local Copilot log directory path.
*
* @param storageDir Extension storage directory.
*/
function getCopilotLogDir(storageDir: string): string {
  return path.join(storageDir, "copilot-logs");
}

/**
* Opens a terminal and starts the Copilot CLI login flow.
*/
async function startCopilotLoginInTerminal(copilotPath: string): Promise<void> {
  const wsRoot = getWorkspaceRootUri();

  const terminal = vscode.window.createTerminal({
    name: "Learning Copilot: Copilot CLI Login",
    cwd: wsRoot?.fsPath,
  });
  terminal.show(true);

  const quoted = copilotPath.includes(" ") ? `\"${copilotPath}\"` : copilotPath;
  terminal.sendText(`${quoted} login`);
}

/**
* Opens a terminal and starts the Copilot CLI logout flow using the
* interactive slash-command form supported by the Windows binary.
*/
async function startCopilotLogoutInTerminal(copilotPath: string): Promise<void> {
  const wsRoot = getWorkspaceRootUri();
  const terminal = vscode.window.createTerminal({
    name: "Learning Copilot: Copilot CLI Logout",
    cwd: wsRoot?.fsPath,
  });
  terminal.show(true);

  const quoted = copilotPath.includes(" ") ? `\"${copilotPath}\"` : copilotPath;
  terminal.sendText(`${quoted} -i "/logout"`);
}

/**
* Runs a process and streams stdout/stderr to the output channel.
*
* @param command Executable to run.
* @param args Command arguments.
* @param cwd Working directory.
* @param output Output channel for live logs.
*/
async function runCommandStreaming(
  command: string,
  args: string[],
  cwd: string,
  output: vscode.OutputChannel
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(command, args, { cwd, env: process.env, shell: false });
    p.stdout.on("data", (d) => output.append(d.toString("utf8")));
    p.stderr.on("data", (d) => output.append(d.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });
}

/**
* Installs Copilot CLI on macOS/Linux into extension-managed storage.
*
* @param storageDir Extension storage directory.
* @param output Output channel for logs.
*/
async function installCopilotCliMacLinux(storageDir: string, output: vscode.OutputChannel): Promise<string> {
  // Install into a user-writable folder we control.
  const installDir = path.join(storageDir, "copilot-cli");
  await fsp.mkdir(installDir, { recursive: true });

  // Use the official installer script, but override PREFIX.
  // This avoids needing Homebrew and avoids admin access.
  const cmd = `curl -fsSL https://gh.io/copilot-install | PREFIX="${installDir}" bash`;
  output.appendLine(`> /bin/bash -lc ${JSON.stringify(cmd)}`);

  await runCommandStreaming("/bin/bash", ["-lc", cmd], storageDir, output);

  const candidate = path.join(installDir, "bin", "copilot");
  if (!fs.existsSync(candidate)) {
    throw new Error(`Install finished but Copilot binary not found at: ${candidate}`);
  }
  return candidate;
}

/**
* Installs Copilot CLI on Windows into extension-managed storage.
*
* @param storageDir Extension storage directory.
* @param output Output channel for logs.
*/
async function installCopilotCliWindows(storageDir: string, output: vscode.OutputChannel): Promise<string> {
  const installRoot = path.join(storageDir, "copilot-cli");
  await fsp.mkdir(installRoot, { recursive: true });
  const extractDir = path.join(installRoot, "extracted");
  const installedExe = path.join(installRoot, "copilot.exe");
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.rm(installedExe, { force: true });
  await fsp.mkdir(extractDir, { recursive: true });

  const assetArch =
  process.arch === "x64" ? "x64" :
  process.arch === "arm64" ? "arm64" :
  null;
  if (!assetArch) {
    throw new Error(`Unsupported Windows architecture for Copilot CLI: ${process.arch}`);
  }

  // Use GitHub release assets directly so Windows lab machines do not need Node/npm.
  const esc = (s: string) => s.replace(/'/g, "''");
  const scriptPath = path.join(installRoot, "install-copilot.ps1");
  const ps = `
$ErrorActionPreference = "Stop"
$Base = '${esc(installRoot)}'
$ExtractDir = '${esc(extractDir)}'
$InstalledExe = '${esc(installedExe)}'
$AssetName = 'copilot-win32-${assetArch}.zip'
$rel = Invoke-RestMethod "https://api.github.com/repos/github/copilot-cli/releases/latest"
$asset = $rel.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
if (-not $asset) {
  $asset = $rel.assets | Where-Object { $_.name -match '^copilot-win32-.*\\.zip$' } | Select-Object -First 1
}
if (-not $asset) {
  $rel.assets | Select-Object name, browser_download_url | Out-String | Write-Host
  throw "Couldn't find a Windows Copilot CLI .zip asset in the latest release."
}
$zipPath = Join-Path $Base $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
Expand-Archive -LiteralPath $zipPath -DestinationPath $ExtractDir -Force
$exe = Get-ChildItem -Path $ExtractDir -Recurse -Filter 'copilot.exe' | Select-Object -First 1
if (-not $exe) {
  throw "Install finished but copilot.exe was not found in the extracted archive."
}
Copy-Item -LiteralPath $exe.FullName -Destination $InstalledExe -Force
`;
  await fsp.writeFile(scriptPath, ps, "utf8");
  output.appendLine(`> powershell -NoProfile -ExecutionPolicy Bypass -File ${JSON.stringify(scriptPath)}`);

  await runCommandStreaming(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    installRoot,
    output
  );

  if (!fs.existsSync(installedExe)) {
    throw new Error(`Install finished but Copilot binary not found at: ${installedExe}`);
  }
  return installedExe;
}

//#endregion

//#region <STORAGE AND AUTH HELPERS>
/**
* ============================================================================
* <STORAGE AND AUTH HELPERS>
* ============================================================================
* Shared helpers for extension storage and authentication/log discovery used by
* multiple command handlers.
*/

/**
* Ensures the extension global storage directory exists.
*
* @param context VS Code extension context.
*/
async function ensureStorageDir(context: vscode.ExtensionContext): Promise<string> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  return context.globalStorageUri.fsPath;
}

async function showCopilotCliDetails(context: vscode.ExtensionContext): Promise<void> {
  const storageDir = await ensureStorageDir(context);
  const configuredPath = getConfiguredCopilotPath();
  const status = await getInstalledCopilotStatus();
  const authStatus = status.kind === "modern"
  ? await detectCopilotAuthStatus(status.path)
  : "unknown";

  const lines = [
    `Configured path: ${configuredPath}`,
    `Active path: ${status.path}`,
    `CLI type: ${status.kind}`,
    `Auth status: ${authStatus}`,
    `Extension storage: ${storageDir}`,
    `Default Copilot config dir: ${getDefaultCopilotConfigDir()}`,
  ];

  const pick = await vscode.window.showInformationMessage(
    lines.join("\n"),
    { modal: true },
    "Copy Path",
    "Reveal Binary",
    "Set Path"
  );

  if (pick === "Copy Path") {
    await vscode.env.clipboard.writeText(status.path);
    vscode.window.showInformationMessage("Copied Copilot CLI path to clipboard.");
    return;
  }

  if (pick === "Reveal Binary") {
    if (!path.isAbsolute(status.path) || !fs.existsSync(status.path)) {
      vscode.window.showWarningMessage("The active Copilot CLI path is not a local file that can be revealed.");
      return;
    }
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(status.path));
    return;
  }

  if (pick === "Set Path") {
    try {
      const newPath = await pickAndSetCopilotPath();
      if (newPath) {
        vscode.window.showInformationMessage(`Copilot CLI path set to: ${newPath}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(err?.message ?? String(err));
    }
  }
}

/**
* Finds the newest "files" directory inside Copilot's session-state folders, which often contains logs and artifacts from the most recent CLI runs. This is a heuristic to find relevant log files when a CLI run fails without output.
* @param configDir
* @returns
*/
async function findNewestArtifactFilesDir(configDir: string): Promise<string | null> {
  const sessionRoot = path.join(configDir, "session-state");
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(sessionRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const dirs: Array<{ p: string; mtimeMs: number }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) { continue; }
    const p = path.join(sessionRoot, e.name);
    const st = await fsp.stat(p);
    dirs.push({ p, mtimeMs: st.mtimeMs });
  }

  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const d of dirs) {
    const filesDir = path.join(d.p, "files");
    try {
      const st = await fsp.stat(filesDir);
      if (st.isDirectory()) { return filesDir; }
    } catch {
      // keep looking
    }
  }

  return null;
}

/**
 * Directory names never worth importing or shipping to a model. Applied both
 * when importing CLI artifacts and when scanning the workspace for context.
 */
const IGNORED_DIR_NAMES = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target",
  "bin", "obj", "coverage", ".next", ".nuxt", ".svelte-kit", ".parcel-cache",
  ".turbo", ".cache", "vendor", "__pycache__", ".venv", "venv", ".tox",
  ".idea", ".vscode-test", ".pytest_cache", ".mypy_cache", ".gradle",
]);

/** Lockfiles are large and near-useless as model context. */
const IGNORED_FILE_BASENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
  "composer.lock", "gemfile.lock", "cargo.lock", "poetry.lock", "uv.lock",
  "pipfile.lock", "learning_exercises.md", "learning_brief.md",
]);

const MAX_ARTIFACT_IMPORT_FILES = 200;
const MAX_ARTIFACT_IMPORT_BYTES_PER_FILE = 2_000_000;

/**
* Recursively lists files in a directory, skipping vendored/build directories
* and capping the total count so a stray node_modules can't flood the import.
*
* @param root Root directory to list.
*/
async function listFilesRecursive(root: string): Promise<Array<{ rel: string; abs: string }>> {
  const out: Array<{ rel: string; abs: string }> = [];
  let truncated = false;

  async function walk(dir: string) {
    if (out.length >= MAX_ARTIFACT_IMPORT_FILES) {
      truncated = true;
      return;
    }
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (out.length >= MAX_ARTIFACT_IMPORT_FILES) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(e.name.toLowerCase())) { continue; }
        await walk(abs);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        out.push({ rel, abs });
      }
    }
  }

  await walk(root);
  if (truncated) {
    vscode.window.showWarningMessage(
      `Artifact listing stopped at ${MAX_ARTIFACT_IMPORT_FILES} files; remaining files were ignored.`
    );
  }
  return out;
}


/**
* For each artifact file, prompts the user to preview and confirm importing it into the workspace. If confirmed, saves the file content to the target location in the workspace.
*
* @param wsRoot Workspace root URI.
* @param files List of artifact files with relative and absolute paths.
*/
async function importArtifactsIntoWorkspace(
  wsRoot: vscode.Uri,
  files: Array<{ rel: string; abs: string }>
): Promise<WrittenFile[]> {
  if (files.length === 0) {
    return [];
  }

  const normalizedFiles: Array<{ rel: string; abs: string; exists: boolean }> = [];
  for (const file of files) {
    let rel: string;
    try {
      rel = normalizeRelativePath(file.rel);
    } catch (e: any) {
      vscode.window.showWarningMessage(`Skipping artifact with unsafe path: ${file.rel}`);
      continue;
    }

    try {
      const st = await fsp.stat(file.abs);
      if (st.size > MAX_ARTIFACT_IMPORT_BYTES_PER_FILE) {
        vscode.window.showWarningMessage(`Skipping oversized artifact (${Math.round(st.size / 1024)} KB): ${rel}`);
        continue;
      }
    } catch {
      continue;
    }

    const targetUri = vscode.Uri.joinPath(wsRoot, ...rel.split("/"));
    const exists = await vscode.workspace.fs.stat(targetUri).then(() => true, () => false);
    normalizedFiles.push({ rel, abs: file.abs, exists });
  }

  if (normalizedFiles.length === 0) {
    return [];
  }

  const overwriteCount = normalizedFiles.filter((file) => file.exists).length;
  const createCount = normalizedFiles.length - overwriteCount;
  const actionLabel = overwriteCount > 0 ? "Apply All" : "Create All";
  const pick = await vscode.window.showInformationMessage(
    `Import ${normalizedFiles.length} Copilot artifact file(s)? This will ${overwriteCount > 0 ? `overwrite ${overwriteCount} existing and create ${createCount} new` : `create ${createCount} new`} file(s).`,
    { modal: true },
    actionLabel,
    "Skip"
  );
  if (pick !== actionLabel) {
    return [];
  }

  const written: WrittenFile[] = [];
  for (const file of normalizedFiles) {
    const content = await fsp.readFile(file.abs, "utf8");
    const targetUri = vscode.Uri.joinPath(wsRoot, ...file.rel.split("/"));
    await ensureDirForFile(targetUri);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
    written.push({ rel: file.rel, fullContent: content });
    vscode.window.showInformationMessage(`${file.exists ? "Updated" : "Created"}: ${file.rel}`);
  }
  return written;
}

//#endregion

//#region <FILE GENERATION HELPERS>
/**
* ============================================================================
* <FILE GENERATION HELPERS>
* ============================================================================
* Plan coercion, URI preparation, and save target selection used for generated
* output and generated-file workflows.
*/
/**
* Returns the first workspace root URI, if available.
*/
function getWorkspaceRootUri(): vscode.Uri | null {
  const ws = vscode.workspace.workspaceFolders?.[0];
  return ws?.uri ?? null;
}

/**
* Validates the parsed JSON file-generation plan object.
*
* @param obj Parsed model response.
*/
function coerceFilePlan(obj: any): StudentBriefLike {
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.files)) {
    throw new Error("JSON must be an object with a 'files' array.");
  }

  const files = obj.files.map((f: any) => {
    if (!f || typeof f !== "object") { throw new Error("Each file entry must be an object."); }
    if (typeof f.path !== "string" || typeof f.content !== "string") {
      throw new Error("Each file entry must have string 'path' and 'content'.");
    }
    return { path: f.path, content: f.content, overwrite: Boolean(f.overwrite) };
  });

  let studentBrief: StudentBrief | undefined;
  if (obj.studentBrief && typeof obj.studentBrief === "object") {
    const raw = obj.studentBrief;
    studentBrief = {
      overviewMd: typeof raw.overviewMd === "string" ? raw.overviewMd : "",
      sections: Array.isArray(raw.sections)
      ? raw.sections
      .filter(
        (s: any) =>
          s &&
        typeof s === "object" &&
        typeof s.title === "string" &&
        typeof s.summary === "string"
      )
      .map((s: any) => ({
        title: s.title,
        summary: s.summary,
        files: Array.isArray(s.files)
        ? s.files.filter((f: any) => typeof f === "string")
        : undefined,
        visibleEffect: typeof s.visibleEffect === "string" ? s.visibleEffect : undefined,
        behavior: typeof s.behavior === "string" ? s.behavior : undefined,
        whyItMatters: typeof s.whyItMatters === "string" ? s.whyItMatters : undefined,
      }))
      : undefined,
    };
  }

  return {
    files,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
    studentBriefMd: typeof obj.studentBriefMd === "string" ? obj.studentBriefMd : undefined,
    studentBrief,
  };
}


/** * Prompts the user to preview and confirm saving generated markdown content to a file in the workspace. If confirmed, saves the content to the target location.
*
* @param wsRoot Workspace root URI.
* @param filename Proposed filename relative to workspace root.
* @param content Markdown content to save.
* @param titlePrefix Prefix for the confirmation dialog title (e.g., "Exercise" or "Answer Key").
*/
async function writeWorkspaceMarkdownWithPrompt(
  wsRoot: vscode.Uri,
  filename: string,
  content: string,
  titlePrefix: string
): Promise<void> {
  const targetUri = vscode.Uri.joinPath(wsRoot, filename);
  const exists = await vscode.workspace.fs.stat(targetUri).then(() => true, () => false);

  const title = exists
  ? `${titlePrefix}: ${filename} (overwrite existing?)`
  : `${titlePrefix}: ${filename} (create?)`;

  const pick = await vscode.window.showInformationMessage(
    title,
    { modal: true },
    exists ? "Overwrite" : "Create",
    "Skip"
  );

  if (pick === "Overwrite" || pick === "Create") {
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
    vscode.window.showInformationMessage(`${exists ? "Updated" : "Created"}: ${filename}`);
  }
}


function renderStudentBriefMarkdown(brief: StudentBrief): string {
  const lines: string[] = ["# Learning Brief", ""];

  const overview = (brief.overviewMd ?? "").trim();
  if (overview) {
    lines.push(overview, "");
  }

  if (brief.sections && brief.sections.length > 0) {
    for (const section of brief.sections) {
      lines.push(`## ${section.title}`, "");
      lines.push(section.summary, "");

      if (section.files && section.files.length > 0) {
        lines.push("**Relevant files**", "");
        for (const f of section.files) {
          lines.push(`- ${f}`);
        }
        lines.push("");
      }

      if (section.visibleEffect) {
        lines.push(`**What the student should notice:** ${section.visibleEffect}`, "");
      }
      if (section.behavior) {
        lines.push(`**Behavior:** ${section.behavior}`, "");
      }
      if (section.whyItMatters) {
        lines.push(`**Why this matters:** ${section.whyItMatters}`, "");
      }
    }
  }

  return lines.join("\n").trim() + "\n";
}


async function writeWorkspaceBrief(
  wsRoot: vscode.Uri,
  content: string,
  openAfterWrite = true
): Promise<vscode.Uri> {
  const targetUri = vscode.Uri.joinPath(wsRoot, "LEARNING_BRIEF.md");
  await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
  if (openAfterWrite) {
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
  }
  return targetUri;
}


/**
* Ensures the parent directory for a URI exists.
*
* @param uri Target file URI.
*/
async function ensureDirForFile(uri: vscode.Uri): Promise<void> {
  // Use posix because Uri paths use '/'
  const dirPath = path.posix.dirname(uri.path);
  await vscode.workspace.fs.createDirectory(uri.with({ path: dirPath }));
}


/**
* Returns a conservative exclude glob for scanning a workspace.
*/
function getWorkspaceScanExcludeGlob(): string {
  // Exclude common large/vendor/build folders and VCS metadata.
  return `**/{${[...IGNORED_DIR_NAMES].join(",")}}/**`;
}

/**
* Best-effort heuristic to decide if a file is text.
*/
function looksLikeText(buf: Uint8Array): boolean {
  // If it contains NUL, treat as binary.
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {return false;}
  }
  return true;
}

/**
 * Files that don't count as "existing project code" when deciding whether a
 * prompt should create a fresh project or modify the current one.
 */
const NON_PROJECT_BASENAMES = new Set([
  "readme", "readme.md", "readme.txt", "license", "license.md", "license.txt",
  "notice", "notice.md", "changelog", "changelog.md", "authors", "authors.md",
  "contributing.md", "code_of_conduct.md",
]);

const NON_PROJECT_EXTENSIONS = new Set([
  ".md", ".txt", ".rtf", ".pdf", ".doc", ".docx",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".mp3", ".mp4", ".mov", ".wav", ".zip", ".gz",
]);

type PromptWorkflowMode = "create" | "modify";

/**
* Decides whether a student's prompt should create a fresh project or modify
* existing code, by checking whether the workspace already contains code
* files. Docs, licenses, dotfiles, media, and Learning Copilot's own outputs
* don't count as existing code.
*/
async function detectPromptWorkflowMode(wsRoot: vscode.Uri): Promise<PromptWorkflowMode> {
  const exclude = getWorkspaceScanExcludeGlob();
  const uris = await vscode.workspace.findFiles("**/*", exclude, 500);

  for (const uri of uris) {
    if (uri.scheme !== "file") { continue; }
    const rel = path.relative(wsRoot.fsPath, uri.fsPath).replace(/\\/g, "/");
    if (rel.startsWith("..") || rel.split("/").some((seg) => seg.startsWith("."))) { continue; }
    const base = path.posix.basename(rel).toLowerCase();
    if (NON_PROJECT_BASENAMES.has(base) || IGNORED_FILE_BASENAMES.has(base)) { continue; }
    if (NON_PROJECT_EXTENSIONS.has(path.posix.extname(base))) { continue; }
    return "modify";
  }
  return "create";
}

type TaskJumpLink = {
  id: string;
  rel: string;
  line: number;
  uri: string;
};

type TaskJumpTarget = {
  path: string;
  line: number;
};

const TASK_LINKS_START = "<!-- LC_TASK_LINKS_START -->";
const TASK_LINKS_END = "<!-- LC_TASK_LINKS_END -->";

/**
* Collects a limited snapshot of workspace files to provide the model with context.
* - Excludes large/build/vendor folders and lockfiles
* - Skips very large files
* - Truncates per-file content and total payload size
*/
async function collectWorkspaceContext(wsRoot: vscode.Uri, output: vscode.OutputChannel): Promise<WorkspaceFileContext[]> {
  const startedAt = Date.now();
  const MAX_FILES = 80;
  const MAX_BYTES_PER_FILE = 40_000; // ~40KB
  const MAX_TOTAL_CHARS = 220_000;   // keep prompt reasonable

  const exclude = getWorkspaceScanExcludeGlob();
  const uris = await vscode.workspace.findFiles("**/*", exclude, MAX_FILES);

  const results: WorkspaceFileContext[] = [];
  let totalChars = 0;

  for (const uri of uris) {
    // Skip directories just in case (findFiles should return files)
    if (uri.scheme !== "file") {continue;}

    const rel = path.relative(wsRoot.fsPath, uri.fsPath).replace(/\\/g, "/");
    let safeRel: string;
    try {
      safeRel = normalizeRelativePath(rel);
    } catch {
      continue;
    }

    if (IGNORED_FILE_BASENAMES.has(path.posix.basename(safeRel).toLowerCase())) {
      continue;
    }

    // Skip common binary extensions
    const ext = path.posix.extname(safeRel.toLowerCase());
    if ([
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz", ".7z", ".rar",
      ".mp3", ".mp4", ".mov", ".wav", ".aif", ".aiff", ".flac", ".ogg", ".bin", ".exe", ".dylib", ".so", ".dll"
    ].includes(ext)) {
      continue;
    }

    let fileBytes: Uint8Array;
    try {
      fileBytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      continue;
    }

    if (fileBytes.byteLength > 600_000) {
      // Too big for prompt context
      continue;
    }

    if (!looksLikeText(fileBytes)) {
      continue;
    }

    let text = Buffer.from(fileBytes).toString("utf8");
    let truncated = false;
    if (text.length > MAX_BYTES_PER_FILE) {
      text = text.slice(0, MAX_BYTES_PER_FILE) + "\n\n/* TRUNCATED */\n";
      truncated = true;
    }

    // Enforce total cap
    if (totalChars + text.length > MAX_TOTAL_CHARS) {
      output.appendLine(`Workspace context cap reached; stopping at ${results.length} files.`);
      break;
    }

    results.push({ path: safeRel, content: text, truncated });
    totalChars += text.length;
  }

  logDuration(output, "Workspace context collection complete", startedAt, `${results.length} file(s), ${totalChars} chars`);
  return results;
}

function buildTaskJumpLinks(wsRoot: vscode.Uri, plan: ScaffoldPlan): TaskJumpLink[] {
  const maskedByRel = new Map<string, string>();
  for (const mf of plan.maskedFiles) {
    try {
      maskedByRel.set(normalizeRelativePath(mf.path), mf.content);
    } catch {
      // ignore invalid paths
    }
  }

  const links: TaskJumpLink[] = [];
  for (const task of plan.tasks) {
    let rel: string;
    try {
      rel = normalizeRelativePath(task.path);
    } catch {
      continue;
    }

    const content = maskedByRel.get(rel);
    if (!content) { continue; }

    const regions = listTaskRegions(content);
    const region = regions.find((r) => r.id === task.id);
    if (!region) { continue; }

    const line = getRegionStartLine(content, region.startTokenStart);
    const fileUri = vscode.Uri.joinPath(wsRoot, ...rel.split("/"));
    const query = new URLSearchParams({ path: fileUri.fsPath, line: String(line) }).toString();
    const uri = `vscode://${EXTENSION_URI_ID}/openTaskLink?${query}`;
    links.push({ id: task.id, rel, line, uri });
  }

  links.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line || a.id.localeCompare(b.id));
  return links;
}

function getTaskStateKey(rel: string, id: string): string {
  return `${rel}::${id}`;
}

function getCompletedTaskKeySet(tasks: ScaffoldTask[]): Set<string> {
  const out = new Set<string>();
  for (const task of tasks) {
    if (!task.completed) { continue; }
    try {
      out.add(getTaskStateKey(normalizeRelativePath(task.path), task.id));
    } catch {
      // ignore invalid paths
    }
  }
  return out;
}

function buildTaskLinksSection(links: TaskJumpLink[], completed: Set<string>): string {
  const lines = [
    "# Task Links",
    "",
    ...links.map((link) => {
      const checked = completed.has(getTaskStateKey(link.rel, link.id)) ? "x" : " ";
      return `- [${checked}] **${link.id}**: [${link.rel}:${link.line}](${link.uri}) <!-- LC_TASK_LINK|${link.rel}|${link.id} -->`;
    }),
    "",
  ];

  return [TASK_LINKS_START, ...lines, TASK_LINKS_END].join("\n");
}

function prependTaskLinksSection(exercisesMd: string, links: TaskJumpLink[], tasks: ScaffoldTask[]): string {
  if (links.length === 0) { return exercisesMd; }

  const block = buildTaskLinksSection(links, getCompletedTaskKeySet(tasks));
  return `${block}\n\n---\n\n${exercisesMd}`;
}

function refreshTaskLinksSection(content: string, completed: Set<string>): string {
  const re = /^- \[[ x]\] \*\*([^*]+)\*\*: \[[^\]]+\]\([^)]+\) <!-- LC_TASK_LINK\|([^|]+)\|([^>]+) -->$/gm;
  return content.replace(re, (_full, _displayId, rel, id) => {
    const checked = completed.has(getTaskStateKey(rel, id)) ? "x" : " ";
    return _full.replace(/^(- \[)[ x](\])/, `$1${checked}$2`);
  });
}

async function syncLearningExercisesTaskStatuses(
  context: vscode.ExtensionContext,
  wsRoot: vscode.Uri
): Promise<void> {
  const targetUri = vscode.Uri.joinPath(wsRoot, "LEARNING_EXERCISES.md");
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(targetUri);
  } catch {
    return;
  }

  const content = Buffer.from(bytes).toString("utf8");
  if (!content.includes(TASK_LINKS_START) || !content.includes(TASK_LINKS_END)) {
    return;
  }

  const updated = refreshTaskLinksSection(
    content,
    getCompletedTaskKeySet(context.globalState.get<ScaffoldTask[]>("learningCopilot.lastScaffoldTasks") ?? [])
  );
  if (updated === content) {
    return;
  }

  await vscode.workspace.fs.writeFile(targetUri, Buffer.from(updated, "utf8"));
}

async function markTasksCompleted(
  context: vscode.ExtensionContext,
  wsRoot: vscode.Uri,
  taskKeys: string[]
): Promise<void> {
  if (taskKeys.length === 0) { return; }

  const keys = new Set(taskKeys);
  const all = context.globalState.get<ScaffoldTask[]>("learningCopilot.lastScaffoldTasks") ?? [];
  const updated = all.map((task) => {
    try {
      const rel = normalizeRelativePath(task.path);
      if (keys.has(getTaskStateKey(rel, task.id))) {
        return { ...task, completed: true };
      }
    } catch {
      // ignore invalid paths
    }
    return task;
  });
  await context.globalState.update("learningCopilot.lastScaffoldTasks", updated);
  await syncLearningExercisesTaskStatuses(context, wsRoot);
}

function pickTaskLinkViewColumn(): vscode.ViewColumn {
  const visibleFileEditors = vscode.window.visibleTextEditors.filter((editor) => {
    if (!editor.viewColumn) { return false; }
    if (editor.document.uri.scheme !== "file") { return false; }
    return true;
  });
  const activeEditor = vscode.window.activeTextEditor;
  const activeColumn = activeEditor?.viewColumn;
  const activeBase = activeEditor ? path.posix.basename(activeEditor.document.uri.path).toLowerCase() : "";
  const visibleCodeEditors = visibleFileEditors.filter((editor) => {
    const base = path.posix.basename(editor.document.uri.path).toLowerCase();
    return base !== "learning_exercises.md";
  });

  if (lastTaskLinkColumn && visibleFileEditors.some((editor) => editor.viewColumn === lastTaskLinkColumn)) {
    return lastTaskLinkColumn;
  }

  // Common workflow: markdown source on the left, preview on the right.
  // In that case, reuse the source markdown column instead of creating a third pane.
  if (activeEditor?.viewColumn && activeBase === "learning_exercises.md") {
    return activeEditor.viewColumn;
  }

  const otherVisibleEditor = visibleCodeEditors.find((editor) => editor.viewColumn !== activeColumn);
  if (otherVisibleEditor?.viewColumn) {
    return otherVisibleEditor.viewColumn;
  }

  const sameColumnEditor = visibleCodeEditors.find((editor) => editor.viewColumn);
  if (sameColumnEditor?.viewColumn) {
    return sameColumnEditor.viewColumn;
  }

  const sameColumnFileEditor = visibleFileEditors.find((editor) => editor.viewColumn === activeColumn);
  if (sameColumnFileEditor?.viewColumn) {
    return sameColumnFileEditor.viewColumn;
  }

  const anyFileEditor = visibleFileEditors.find((editor) => editor.viewColumn);
  if (anyFileEditor?.viewColumn) {
    return anyFileEditor.viewColumn;
  }

  return vscode.ViewColumn.Beside;
}

//#endregion

//#region <TASK FILLING HELPERS>
/**
* ============================================================================
* <TASK FILLING HELPERS>
* ============================================================================
* Helpers for prompting the user to fill in tasks in the scaffold, and for
* applying stored solutions back into task regions.
*/

function getEditableRangeForRegion(doc: vscode.TextDocument, r: TaskRegionHit): vscode.Range {
  // We expect marker tokens to live on their own lines inside comment delimiters.
  // Replace the content *between* the marker lines, leaving comment delimiters intact.
  const startPos = doc.positionAt(r.startTokenStart);
  const endPos = doc.positionAt(r.endTokenEnd);

  const startLine = doc.lineAt(startPos.line);
  const endLine = doc.lineAt(endPos.line);

  // Insert after the end of the start marker line (including its comment close),
  // and stop before the beginning of the end marker line.
  const replaceStart = startLine.rangeIncludingLineBreak.end;
  const replaceEnd = endLine.range.start;

  // Fallback: if markers are malformed (e.g. same line), fall back to token-based region.
  if (doc.offsetAt(replaceStart) >= doc.offsetAt(replaceEnd)) {
    return new vscode.Range(doc.positionAt(r.startTokenEnd), doc.positionAt(r.endTokenStart));
  }

  return new vscode.Range(replaceStart, replaceEnd);
}

function getFullRegionRangeIncludingMarkerLines(doc: vscode.TextDocument, r: TaskRegionHit): vscode.Range {
  const startPos = doc.positionAt(r.startTokenStart);
  const endPos = doc.positionAt(r.endTokenEnd);

  const startLine = doc.lineAt(startPos.line);
  const endLine = doc.lineAt(endPos.line);

  // Replace from beginning of START marker line to end of END marker line.
  // Do not include the trailing line break, otherwise adjacent task blocks can
  // visually overlap on the next task's start marker line.
  const replaceStart = startLine.range.start;
  const replaceEnd = endLine.range.end;

  // Fallback if something weird happens (e.g., both tokens on same line)
  if (doc.offsetAt(replaceStart) >= doc.offsetAt(replaceEnd)) {
    return new vscode.Range(doc.positionAt(r.startTokenStart), doc.positionAt(r.endTokenEnd));
  }

  return new vscode.Range(replaceStart, replaceEnd);
}

function isTaskDecoratableDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === "file" && doc.getText().includes("__LC_TASK_");
}

function getMarkerLineRanges(doc: vscode.TextDocument, region: TaskRegionHit): {
  startLineRange: vscode.Range;
  endLineRange: vscode.Range;
} {
  const startPos = doc.positionAt(region.startTokenStart);
  const endPos = doc.positionAt(region.endTokenEnd);
  return {
    startLineRange: doc.lineAt(startPos.line).range,
    endLineRange: doc.lineAt(endPos.line).range,
  };
}

let taskAtCursorContext: boolean | null = null;

/**
* Drives the 'learningCopilot.taskAtCursor' when-clause context used by the
* editor context menu contributions in package.json.
*/
function setTaskAtCursorContext(editor: vscode.TextEditor, value: boolean): void {
  if (editor !== vscode.window.activeTextEditor) { return; }
  if (taskAtCursorContext === value) { return; }
  taskAtCursorContext = value;
  void vscode.commands.executeCommand("setContext", "learningCopilot.taskAtCursor", value);
}

function refreshTaskDecorationsForEditor(editor: vscode.TextEditor): void {
  if (!taskBlockDecorationType || !activeTaskBlockDecorationType || !taskMarkerDecorationType) {
    return;
  }

  const doc = editor.document;
  if (!isTaskDecoratableDocument(doc)) {
    editor.setDecorations(taskBlockDecorationType, []);
    editor.setDecorations(activeTaskBlockDecorationType, []);
    editor.setDecorations(taskMarkerDecorationType, []);
    setTaskAtCursorContext(editor, false);
    return;
  }

  const text = doc.getText();
  const regions = listTaskRegions(text);
  if (regions.length === 0) {
    editor.setDecorations(taskBlockDecorationType, []);
    editor.setDecorations(activeTaskBlockDecorationType, []);
    editor.setDecorations(taskMarkerDecorationType, []);
    setTaskAtCursorContext(editor, false);
    return;
  }

  const activeOffset = doc.offsetAt(editor.selection.active);
  const activeRegion = findTaskRegionAtPosition(text, activeOffset);
  setTaskAtCursorContext(editor, !!activeRegion);

  const blockRanges: vscode.Range[] = [];
  const activeBlockRanges: vscode.Range[] = [];
  const markerRanges: vscode.Range[] = [];

  for (const region of regions) {
    const fullRange = getFullRegionRangeIncludingMarkerLines(doc, region);
    if (activeRegion?.id === region.id && activeRegion.startTokenStart === region.startTokenStart) {
      activeBlockRanges.push(fullRange);
    } else {
      blockRanges.push(fullRange);
    }

    const { startLineRange, endLineRange } = getMarkerLineRanges(doc, region);
    markerRanges.push(startLineRange, endLineRange);
  }

  editor.setDecorations(taskBlockDecorationType, blockRanges);
  editor.setDecorations(activeTaskBlockDecorationType, activeBlockRanges);
  editor.setDecorations(taskMarkerDecorationType, markerRanges);
}

function refreshTaskDecorationsForVisibleEditors(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    refreshTaskDecorationsForEditor(editor);
  }
}

function normalizeSolutionNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function buildReplacementForRegion(
  doc: vscode.TextDocument,
  region: TaskRegionHit,
  solution: string,
  removeMarkers: boolean
): { range: vscode.Range; replacement: string } {
  const sol = normalizeSolutionNewlines(solution);

  if (!removeMarkers) {
    const editable = getEditableRangeForRegion(doc, region);
    const replacement = sol.endsWith("\n") ? sol : sol + "\n";
    return { range: editable, replacement };
  }

  // Solutions are stored as the exact original file lines (fully indented),
  // so removing the markers is a verbatim replacement of the marker block.
  // The range excludes the END marker line's line break, so no trailing
  // newline is appended here.
  const fullRange = getFullRegionRangeIncludingMarkerLines(doc, region);
  const replacement = sol.replace(/\s+$/g, "");
  return { range: fullRange, replacement };
}

async function applySolutionForRegion(
  editor: vscode.TextEditor,
  doc: vscode.TextDocument,
  region: TaskRegionHit,
  solution: string,
  removeMarkers: boolean
): Promise<void> {
  const { range, replacement } = buildReplacementForRegion(doc, region, solution, removeMarkers);
  await editor.edit((eb) => {
    eb.replace(range, replacement);
  });
}

function getRelPathForActiveDoc(wsRoot: vscode.Uri, docUri: vscode.Uri): string {
  const rel = path.relative(wsRoot.fsPath, docUri.fsPath).replace(/\\/g, "/");
  return normalizeRelativePath(rel);
}

function getTaskById(context: vscode.ExtensionContext, rel: string, id: string): ScaffoldTask | null {
  const all = context.globalState.get<ScaffoldTask[]>("learningCopilot.lastScaffoldTasks") ?? [];
  for (const b of all) {
    try {
      if (normalizeRelativePath(b.path) === rel && b.id === id && !b.completed) { return b; }
    } catch {}
  }
  return null;
}

async function restoreAllTasksInWorkspace(
  context: vscode.ExtensionContext,
  wsRoot: vscode.Uri
): Promise<{
  filesUpdated: number;
  tasksApplied: number;
  appliedTaskKeys: string[];
  missingFiles: string[];
  missingMappings: string[];
}> {
  const allTasks = context.globalState.get<ScaffoldTask[]>("learningCopilot.lastScaffoldTasks") ?? [];
  if (allTasks.length === 0) {
    return { filesUpdated: 0, tasksApplied: 0, appliedTaskKeys: [], missingFiles: [], missingMappings: [] };
  }

  const tasksByFile = new Map<string, Map<string, ScaffoldTask>>();
  for (const task of allTasks) {
    let rel: string;
    try {
      rel = normalizeRelativePath(task.path);
    } catch {
      continue;
    }
    const perFile = tasksByFile.get(rel) ?? new Map<string, ScaffoldTask>();
    perFile.set(task.id, task);
    tasksByFile.set(rel, perFile);
  }

  let filesUpdated = 0;
  let tasksApplied = 0;
  const appliedTaskKeys: string[] = [];
  const missingFiles: string[] = [];
  const missingMappings: string[] = [];

  for (const [rel, taskMap] of [...tasksByFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fileUri = vscode.Uri.joinPath(wsRoot, ...rel.split("/"));
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(fileUri);
    } catch {
      missingFiles.push(rel);
      continue;
    }

    const regions = listTaskRegions(doc.getText());
    if (regions.length === 0) { continue; }

    const missingInFile = regions
    .filter((region) => !taskMap.has(region.id))
    .map((region) => region.id);
    if (missingInFile.length > 0) {
      missingMappings.push(`${rel}: ${missingInFile.join(", ")}`);
      continue;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const region of [...regions].reverse()) {
      const task = taskMap.get(region.id)!;
      const insert = task.solution.endsWith("\n") ? task.solution : task.solution + "\n";
      const { range, replacement } = buildReplacementForRegion(doc, region, insert, true);
      edit.replace(doc.uri, range, replacement);
      appliedTaskKeys.push(getTaskStateKey(rel, region.id));
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error(`Failed to apply edits for ${rel}.`);
    }

    await doc.save();
    filesUpdated++;
    tasksApplied += regions.length;
  }

  return { filesUpdated, tasksApplied, appliedTaskKeys, missingFiles, missingMappings };
}

//#endregion

//#region <SCAFFOLD WORKFLOW HELPERS>
/**
* ============================================================================
* <SCAFFOLD WORKFLOW HELPERS>
* ============================================================================
* The shared workflow used by both generation commands: resolve a model
* transport, apply a file plan, run the deterministic scaffold pipeline, and
* persist its outputs.
*/

/**
* Saves a snapshot of the solution files to a timestamped folder in extension storage, and returns the root path of the saved snapshot.
* @param storageDir Extension storage directory.
* @param written List of files with relative paths and full content to save as the solution snapshot.
* @return The root path of the saved solution snapshot.
*/
async function saveSolutionSnapshot(storageDir: string, written: WrittenFile[]): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(storageDir, "solutions", `solution-${ts}`);
  await fsp.mkdir(root, { recursive: true });

  for (const f of written) {
    const rel = normalizeRelativePath(f.rel);
    const abs = path.join(root, ...rel.split("/"));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, f.fullContent, "utf8");
  }

  return root;
}

function buildScaffoldContextFromWorkspaceSnapshot(
  wsSnapshot: WorkspaceFileContext[],
  changed: WrittenFile[],
  output: vscode.OutputChannel
): ScaffoldContextFile[] {
  // Start with the collected workspace snapshot, then overwrite entries for changed files
  // with the newly-written content so context matches what is on disk after modifications.
  const map = new Map<string, string>();

  for (const f of wsSnapshot) {
    try {
      const rel = normalizeRelativePath(f.path);
      map.set(rel, f.content);
    } catch {
      // ignore
    }
  }

  for (const w of changed) {
    try {
      const rel = normalizeRelativePath(w.rel);
      map.set(rel, w.fullContent);
    } catch {
      // ignore
    }
  }

  const outArr: ScaffoldContextFile[] = [];
  for (const [pathRel, content] of map.entries()) {
    outArr.push({ path: pathRel, content });
  }

  // Keep stable order for determinism
  outArr.sort((a, b) => a.path.localeCompare(b.path));

  output.appendLine(`Scaffold context prepared: ${outArr.length} file(s) total (includes updated changed files).`);
  return outArr;
}

function selectFocusedTaskContext(
  focusFiles: FocusFileWithDiff[],
  contextFiles: ScaffoldContextFile[],
  output: vscode.OutputChannel
): ScaffoldContextFile[] {
  const MAX_CONTEXT_FILES = 12;
  const MAX_TOTAL_CHARS = 60_000;
  const focusRels = new Set(focusFiles.map((f) => normalizeRelativePath(f.rel)));
  const focusDirs = new Set(focusFiles.map((f) => path.posix.dirname(normalizeRelativePath(f.rel))));

  const isPriorityConfig = (rel: string) => {
    const base = path.posix.basename(rel).toLowerCase();
    return [
      "package.json",
      "tsconfig.json",
      "jsconfig.json",
      "vite.config.js",
      "vite.config.ts",
      "webpack.config.js",
      "webpack.config.ts",
      "next.config.js",
      "next.config.mjs",
      "README.md",
    ].includes(base);
  };

  const scored = contextFiles
  .filter((f) => !focusRels.has(normalizeRelativePath(f.path)))
  .map((f) => {
    const rel = normalizeRelativePath(f.path);
    const dir = path.posix.dirname(rel);
    let score = 0;
    if (isPriorityConfig(rel)) { score += 100; }
    if (focusDirs.has(dir)) { score += 40; }
    for (const focusDir of focusDirs) {
      if (focusDir !== "." && dir.startsWith(focusDir + "/")) {
        score += 20;
        break;
      }
    }
    return { ...f, rel, score };
  })
  .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));

  const selected: ScaffoldContextFile[] = [];
  let totalChars = 0;
  for (const file of scored) {
    if (selected.length >= MAX_CONTEXT_FILES) { break; }
    if (totalChars + file.content.length > MAX_TOTAL_CHARS) { continue; }
    selected.push({ path: file.rel, content: file.content });
    totalChars += file.content.length;
  }

  output.appendLine(
    `Focused task context reduced from ${contextFiles.length} file(s) to ${selected.length} file(s) (${totalChars} chars).`
  );
  return selected;
}

type LlmRuntime = {
  client: LlmJsonClient;
  storageDir: string;
  configDir: string;
};

/**
* Resolves the model transport for a command run: the VS Code Language Model
* API when available (preferred), otherwise the Copilot CLI. Shows the
* relevant error message and returns null when neither is usable.
*/
async function resolveLlmRuntime(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<LlmRuntime | null> {
  const storageDir = await ensureStorageDir(context);
  const logDir = getCopilotLogDir(storageDir);
  const configDir = getCopilotConfigDir(storageDir);
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.mkdir(configDir, { recursive: true });

  const { transport, modelFamily, copilotArgs } = getConfig();

  if (transport !== "copilotCli") {
    const lmClient = await tryCreateVscodeLmClient(modelFamily, output);
    if (lmClient) {
      return { client: lmClient, storageDir, configDir };
    }
    if (transport === "languageModelApi") {
      vscode.window.showErrorMessage(
        "Learning Copilot: no Copilot language model is available in VS Code. Install the GitHub Copilot Chat extension and sign in, or set 'learningCopilot.transport' to 'auto' or 'copilotCli'."
      );
      return null;
    }
    output.appendLine("[transport] Language Model API unavailable; falling back to the Copilot CLI.");
  }

  const status = await getInstalledCopilotStatus();
  if (status.kind === "legacy") {
    vscode.window.showErrorMessage(
      "Learning Copilot is configured to use the deprecated gh-copilot binary. Run 'Learning Copilot: Install/Setup Copilot CLI' again, then 'Login to Copilot CLI'."
    );
    return null;
  }
  if (status.kind === "missing") {
    vscode.window.showErrorMessage(
      "Copilot CLI is not installed or not found. Run 'Learning Copilot: Install/Setup Copilot CLI' first, or install the GitHub Copilot Chat extension to use the Language Model API."
    );
    return null;
  }

  return {
    client: new CopilotCliClient({
      copilotPath: status.path,
      baseArgs: copilotArgs,
      defaultCwd: storageDir,
      scratchRoot: path.join(storageDir, "prompt-payloads"),
      logDir,
      output,
    }),
    storageDir,
    configDir,
  };
}

/**
* Offers the CLI login flow when a request failed due to missing CLI auth.
* Returns true when the error was handled as an auth problem.
*/
async function maybeHandleCliAuthError(runtime: LlmRuntime, err: unknown): Promise<boolean> {
  const message = String((err as any)?.message ?? err ?? "");
  if (runtime.client.id !== "copilot-cli" || !message.toLowerCase().includes("no authentication information found")) {
    return false;
  }
  const choice = await vscode.window.showErrorMessage(
    "Copilot CLI is installed but not logged in. Open a terminal to run 'copilot login' now?",
    "Login",
    "Cancel"
  );
  if (choice === "Login") {
    await vscode.commands.executeCommand("learningCopilot.loginCopilotCli");
  }
  return true;
}

const FILE_PLAN_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["path", "content"],
      },
    },
    notes: { type: "string" },
    studentBriefMd: { type: "string" },
    studentBrief: {
      type: "object",
      properties: {
        overviewMd: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              files: { type: "array", items: { type: "string" } },
              visibleEffect: { type: "string" },
              behavior: { type: "string" },
              whyItMatters: { type: "string" },
            },
            required: ["title", "summary"],
          },
        },
      },
      required: ["overviewMd"],
    },
  },
  required: ["files", "studentBriefMd"],
} as const;

const FILE_PLAN_SCHEMA_TEXT =
  '{"files":[{"path":string,"content":string,"overwrite":boolean?}],"notes":string?,"studentBriefMd":string,"studentBrief":{"overviewMd":string,"sections":[{"title":string,"summary":string,"files":string[],"visibleEffect":string?,"behavior":string?,"whyItMatters":string?}]}}';

function buildGeneratePlanInstructions(userPrompt: string): string {
  return (
    "Return JSON only. No prose. No markdown, unless the entire response is a single ```json fenced block. " +
    `Schema: ${FILE_PLAN_SCHEMA_TEXT}. ` +
    "Also output BOTH studentBriefMd and studentBrief. studentBriefMd should be a concise learner-facing markdown brief that explains what was created, what the resulting interface/behavior should look like or do, and which files are important. studentBrief should contain the same information in structured form: overviewMd plus sections. Write both for a student who will read the brief while a later learning scaffold is being generated. " +
    "IMPORTANT: Do NOT inspect the workspace. Do NOT list directories. Do NOT search files. Do NOT run tools. Do NOT create temp files. Do NOT validate by writing files. Do NOT attempt to edit the workspace yourself. Return the JSON response directly from reasoning only. " +
    "All paths must be relative to the workspace root and must not contain '..' or start with '/'. " +
    "Prefer best practice separation of concerns. " +
    "Task: " + userPrompt
  );
}

function buildModifyPlanInstructions(userPrompt: string, activeRel: string | null): string {
  return (
    "Return JSON only. No prose. No markdown, unless the entire response is a single ```json fenced block. " +
    `Schema: ${FILE_PLAN_SCHEMA_TEXT}. ` +
    "Also output BOTH studentBriefMd and studentBrief. studentBriefMd should be a concise learner-facing markdown brief that explains what changed, why it changed, what the new interface/behavior should look like or do, and which files are important. studentBrief should contain the same information in structured form: overviewMd plus sections. Write both for a student who will attempt follow-up learning tasks without seeing the full solution. " +
    "IMPORTANT: Do NOT inspect the workspace. Do NOT list directories. Do NOT search files. Do NOT run tools. Do NOT create temp files. Do NOT validate by writing files. Do NOT attempt to edit the workspace yourself. Use only the INPUT PAYLOAD, and return the JSON response directly from reasoning only. " +
    "You are modifying an EXISTING codebase. The INPUT PAYLOAD is a JSON array of the current workspace files ({path,content}). " +
    "Only include files that need to be created or changed. Do not include unchanged files. " +
    "All paths must be relative to the workspace root and must not contain '..' or start with '/'. " +
    "If you need a new file, add it. If you modify a file, output its FULL new content. " +
    "Avoid large dependencies; prefer small, direct changes. " +
    (activeRel ? `The user's active file is: ${activeRel}. ` : "") +
    "Task: " + userPrompt
  );
}

/**
* Confirms and applies a plan's files to the workspace, capturing prior
* content for changed files (used for focused scaffolds).
*/
async function applyPlanFilesToWorkspace(
  wsRoot: vscode.Uri,
  files: Array<{ path: string; content: string }>,
  noun: string
): Promise<{ writtenFiles: WrittenFile[]; oldContentByRel: Map<string, string>; cancelled: boolean }> {
  const writtenFiles: WrittenFile[] = [];
  const oldContentByRel = new Map<string, string>();

  const existsFlags = await Promise.all(
    files.map(async (f) => {
      try {
        const rel = normalizeRelativePath(f.path);
        const targetUri = vscode.Uri.joinPath(wsRoot, ...rel.split("/"));
        return await vscode.workspace.fs.stat(targetUri).then(() => 1, () => 0);
      } catch {
        return 0;
      }
    })
  );
  const overwriteCount = existsFlags.reduce((sum: number, n) => sum + n, 0);
  const createCount = files.length - overwriteCount;
  const applyLabel = overwriteCount > 0 ? "Apply All" : "Create All";
  const applyChoice = await vscode.window.showInformationMessage(
    `Apply ${files.length} ${noun}? This will ${overwriteCount > 0 ? `overwrite ${overwriteCount} existing and create ${createCount} new` : `create ${createCount} new`} file(s).`,
    { modal: true },
    applyLabel,
    "Skip"
  );
  if (applyChoice !== applyLabel) {
    return { writtenFiles, oldContentByRel, cancelled: true };
  }

  for (const f of files) {
    let rel: string;
    try {
      rel = normalizeRelativePath(f.path);
    } catch (e: any) {
      vscode.window.showErrorMessage(e?.message ?? String(e));
      continue;
    }

    const targetUri = vscode.Uri.joinPath(wsRoot, ...rel.split("/"));
    const exists = await vscode.workspace.fs.stat(targetUri).then(() => true, () => false);

    // Capture the old content before overwriting so focused scaffolds can
    // diff against it later.
    if (exists) {
      try {
        const oldBytes = await vscode.workspace.fs.readFile(targetUri);
        oldContentByRel.set(rel, Buffer.from(oldBytes).toString("utf8"));
      } catch {
        oldContentByRel.set(rel, "");
      }
    } else {
      oldContentByRel.set(rel, "");
    }

    try {
      await ensureDirForFile(targetUri);
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(f.content, "utf8"));
      writtenFiles.push({ rel, fullContent: f.content });
      vscode.window.showInformationMessage(`${exists ? "Updated" : "Created"}: ${rel}`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to write ${rel}: ${e?.message ?? String(e)}`);
    }
  }

  return { writtenFiles, oldContentByRel, cancelled: false };
}

/**
* Normalizes the plan's student brief (either representation may be missing)
* and writes LEARNING_BRIEF.md so the student can read while tasks generate.
*/
async function deriveStudentBrief(
  plan: StudentBriefLike,
  wsRoot: vscode.Uri,
  output: vscode.OutputChannel
): Promise<{ brief: StudentBrief | null; briefMd: string }> {
  let brief: StudentBrief | null = plan.studentBrief ?? null;
  let briefMd = (plan.studentBriefMd ?? "").trim();

  if (!briefMd && brief) {
    briefMd = renderStudentBriefMarkdown(brief).trim();
  }
  if (!brief && briefMd) {
    brief = { overviewMd: briefMd };
  }

  if (briefMd) {
    try {
      await writeWorkspaceBrief(wsRoot, briefMd, true);
      output.appendLine("Learner brief written to LEARNING_BRIEF.md");
    } catch (e: any) {
      output.appendLine(`Failed to write learner brief: ${e?.message ?? String(e)}`);
    }
  }

  return { brief, briefMd };
}

/**
* Builds a minimal brief when the plan didn't include one, so exercises stay
* solvable for a student who has never seen the full solution.
*/
async function ensureBriefFallback(
  briefMd: string,
  rels: string[],
  kind: "generated" | "changed",
  wsRoot: vscode.Uri
): Promise<string> {
  if (briefMd) { return briefMd; }

  const brief: StudentBrief = kind === "generated"
  ? {
    overviewMd:
      "A new set of files was generated. Read the file list below and inspect the code to understand the intended interface and behavior before attempting the learning tasks.",
    sections: [
      {
        title: "Generated files",
        summary: "These files make up the generated solution for this task.",
        files: rels,
        whyItMatters:
          "The learning scaffold will ask you to understand and complete important parts of this generated solution.",
      },
    ],
  }
  : {
    overviewMd:
      "A set of files was added or modified. Read the file list below and inspect the code to understand the new or changed behavior.",
    sections: [
      {
        title: "Changed files",
        summary: "These files contain the new or modified functionality for this task.",
        files: rels,
        whyItMatters:
          "The follow-up exercises will focus on understanding and completing the new behavior in these files.",
      },
    ],
  };

  const rendered = renderStudentBriefMarkdown(brief).trim();
  try {
    await writeWorkspaceBrief(wsRoot, rendered, false);
  } catch {
    // ignore brief fallback write failure
  }
  return rendered;
}

/**
* Runs the deterministic scaffold pipeline under a progress notification.
*/
async function runScaffoldGeneration(args: {
  client: LlmJsonClient;
  files: ScaffoldFileInput[];
  contextFiles?: ScaffoldContextFile[];
  briefMd: string;
  output: vscode.OutputChannel;
}): Promise<ScaffoldPlan> {
  const { output } = args;
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Learning Copilot: Generating learning tasks",
      cancellable: false,
    },
    async (progress) => {
      const startedAt = Date.now();
      output.show(true);
      // Heartbeat: keep progress UI visibly updating during long waits.
      const hb = setInterval(() => progress.report({ increment: 1 }), 5000);
      try {
        return await generateScaffoldPlanDeterministic({
          files: args.files,
          contextFiles: args.contextFiles,
          briefMd: args.briefMd,
          client: args.client,
          log: output,
          report: (msg) => reportActivity(progress, output, startedAt, msg, msg),
        });
      } finally {
        clearInterval(hb);
        setBusyStatus(null);
      }
    }
  );
}

/**
* Persists scaffold outputs: task state, masked files (restricted to the
* files this run wrote), exercises markdown, and the private answer key.
*/
async function persistScaffoldOutputs(args: {
  context: vscode.ExtensionContext;
  wsRoot: vscode.Uri;
  storageDir: string;
  scaffold: ScaffoldPlan;
  allowedRels: Set<string>;
  output: vscode.OutputChannel;
}): Promise<void> {
  const { context, wsRoot, storageDir, scaffold, allowedRels, output } = args;

  await context.globalState.update(
    "learningCopilot.lastScaffoldTasks",
    scaffold.tasks.map((task) => ({ ...task, completed: false }))
  );

  if (scaffold.notes) {
    output.appendLine("--- scaffold notes ---");
    output.appendLine(scaffold.notes);
  }

  const maskedToApply = scaffold.maskedFiles
  .map((mf) => {
    try {
      return { rel: normalizeRelativePath(mf.path), content: mf.content };
    } catch {
      return null;
    }
  })
  .filter((x): x is { rel: string; content: string } => !!x && allowedRels.has(x.rel));

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Learning Copilot: Applying learning tasks to ${maskedToApply.length} file(s)`,
      cancellable: false,
    },
    async () => {
      for (const mf of maskedToApply) {
        const targetUri = vscode.Uri.joinPath(wsRoot, ...mf.rel.split("/"));
        try {
          await ensureDirForFile(targetUri);
          await vscode.workspace.fs.writeFile(targetUri, Buffer.from(mf.content, "utf8"));
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to write task version of ${mf.rel}: ${e?.message ?? String(e)}`);
        }
      }
    }
  );

  if (maskedToApply.length > 0) {
    vscode.window.showInformationMessage(`Learning tasks applied to ${maskedToApply.length} file(s).`);
  }

  // Write exercises markdown into workspace
  const exercisesWithLinks = prependTaskLinksSection(
    scaffold.exercisesMd,
    buildTaskJumpLinks(wsRoot, scaffold),
    scaffold.tasks
  );
  await writeWorkspaceMarkdownWithPrompt(wsRoot, "LEARNING_EXERCISES.md", exercisesWithLinks, "Learning tasks");

  // Save instructor answer key privately
  if (scaffold.answerKeyMd) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const keyDir = path.join(storageDir, "answer-keys");
      await fsp.mkdir(keyDir, { recursive: true });
      const keyPath = path.join(keyDir, `answer-key-${ts}.md`);
      await fsp.writeFile(keyPath, scaffold.answerKeyMd, "utf8");
      await context.globalState.update("learningCopilot.lastAnswerKeyPath", keyPath);
      vscode.window.showInformationMessage(`Instructor answer key saved to extension storage: ${keyPath}`);
      vscode.window.showInformationMessage("Use 'Learning Copilot: Open Latest Answer Key' to view comprehension answers.");
    } catch (e: any) {
      output.appendLine(`Failed to save answer key: ${e?.message ?? String(e)}`);
    }
  }
}

//#endregion

//#region <MENU>
/**
* ============================================================================
* <MENU>
* ============================================================================
* The status-bar entry point: a QuickPick menu listing everything the
* extension can do, so students don't have to hunt through the command
* palette.
*/

type LearningCopilotMenuItem = vscode.QuickPickItem & {
  command?: string;
  submenu?: "copilotCliSetup";
};

async function showCopilotCliSetupMenu(): Promise<void> {
  const items: LearningCopilotMenuItem[] = [
    {
      label: "$(info) Show Copilot CLI Details",
      description: "Where the CLI is installed and whether you are logged in",
      command: "learningCopilot.showCopilotCliDetails",
    },
    {
      label: "$(cloud-download) Install/Setup Copilot CLI",
      description: "Installs into extension storage; no admin rights needed",
      command: "learningCopilot.installCopilotCli",
    },
    {
      label: "$(sign-in) Login to Copilot CLI",
      command: "learningCopilot.loginCopilotCli",
    },
    {
      label: "$(sign-out) Logout of Copilot CLI",
      command: "learningCopilot.logoutCopilotCli",
    },
    {
      label: "$(file-symlink-file) Set Copilot CLI Path",
      description: "Point at an existing copilot executable",
      command: "learningCopilot.setCopilotCliPath",
    },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: "Learning Copilot: Copilot CLI Setup (only needed when the GitHub Copilot Chat extension is unavailable)",
    placeHolder: "Select a setup action below",
  });
  if (pick?.command) {
    await vscode.commands.executeCommand(pick.command);
  }
}

async function showLearningCopilotMenu(): Promise<void> {
  const items: LearningCopilotMenuItem[] = [
    { label: "Build", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(sparkle) Create or Update Project from Prompt",
      description: "Describe what to build — code and learning tasks are generated for you",
      command: "learningCopilot.generateFromPrompt",
    },
    { label: "Learning Tasks", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(book) Open Learning Exercises",
      description: "Open LEARNING_EXERCISES.md with links to each task",
      command: "learningCopilot.openExercises",
    },
    {
      label: "$(lightbulb) Show Hint for Task at Cursor",
      command: "learningCopilot.showHintForTaskAtCursor",
    },
    {
      label: "$(pass) Mark Task at Cursor as Done",
      description: "Keeps your code and removes the task markers",
      command: "learningCopilot.markTaskDoneAtCursor",
    },
    {
      label: "$(wand) Apply Solution for Task at Cursor",
      command: "learningCopilot.applyTaskAtCursor",
    },
    {
      label: "$(arrow-down) Apply Solution for Next Task",
      command: "learningCopilot.applyNextTask",
    },
    {
      label: "$(checklist) Apply Solutions for All Tasks",
      command: "learningCopilot.applyAllTasks",
    },
    {
      label: "$(diff) Compare Active File with Solution",
      command: "learningCopilot.compareWithSolution",
    },
    { label: "Instructor", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(key) Open Latest Answer Key",
      command: "learningCopilot.openLatestAnswerKey",
    },
    { label: "Setup", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(tools) Copilot CLI Setup…",
      description: "Install, login, or configure the Copilot CLI fallback",
      submenu: "copilotCliSetup",
    },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: "Learning Copilot",
    placeHolder: "Select an action below (or type to filter the list)",
    matchOnDescription: true,
  });
  if (!pick) { return; }

  if (pick.submenu === "copilotCliSetup") {
    await showCopilotCliSetupMenu();
    return;
  }
  if (pick.command) {
    await vscode.commands.executeCommand(pick.command);
  }
}

//#endregion

//#region <EXTENSION LIFECYCLE AND COMMANDS>
/**
* ============================================================================
* <EXTENSION LIFECYCLE AND COMMANDS>
* ============================================================================
* Registers extension commands and command-specific workflows.
*/

/**
* Activates the extension and registers all commands.
*
* @param context VS Code extension context.
*/
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Learning Copilot");
  context.subscriptions.push(output);

  // Always-visible entry point: opens the Learning Copilot menu.
  menuStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  menuStatusBar.command = "learningCopilot.showMenu";
  menuStatusBar.text = "$(mortar-board) Learning Copilot";
  menuStatusBar.tooltip = "Open the Learning Copilot menu";
  menuStatusBar.show();
  context.subscriptions.push(menuStatusBar);

  // Busy indicator: only shown while a workflow is running.
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "workbench.action.output.toggleOutput";
  statusBar.text = "$(check) Learning Copilot";
  statusBar.tooltip = "Learning Copilot";
  statusBar.hide();
  context.subscriptions.push(statusBar);

  taskBlockDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("editor.wordHighlightBorder"),
    borderRadius: "4px",
    overviewRulerColor: new vscode.ThemeColor("editor.wordHighlightStrongBorder"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  activeTaskBlockDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("editor.wordHighlightStrongBorder"),
    borderRadius: "4px",
    overviewRulerColor: new vscode.ThemeColor("editor.wordHighlightStrongBorder"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  taskMarkerDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    color: new vscode.ThemeColor("editorCodeLens.foreground"),
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  });
  context.subscriptions.push(
    taskBlockDecorationType,
    activeTaskBlockDecorationType,
    taskMarkerDecorationType
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        refreshTaskDecorationsForEditor(editor);
      }
      refreshTaskDecorationsForVisibleEditors();
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      refreshTaskDecorationsForVisibleEditors();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      refreshTaskDecorationsForEditor(event.textEditor);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === event.document.uri.toString()) {
          refreshTaskDecorationsForEditor(editor);
        }
      }
    })
  );

  // Provide in-memory documents for diff previews (proposed/artifact content).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
      provideTextDocumentContent(uri: vscode.Uri): string {
        const key = uri.path.replace(/^\/+/, "");
        return proposedContent.get(key) ?? "";
      },
    })
  );

  // Provide read-only solution snapshot documents for diff views.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SOLUTION_SCHEME, {
      provideTextDocumentContent(uri: vscode.Uri): string {
        const rel = uri.path.replace(/^\/+/, "");
        const snapshotDir = context.globalState.get<string>("learningCopilot.lastSnapshotDir");
        if (!snapshotDir) {
          return "(No solution snapshot available yet. Generate code files and enable scaffold generation.)\n";
        }
        try {
          const safeRel = normalizeRelativePath(rel);
          const abs = path.join(snapshotDir, ...safeRel.split("/"));
          if (!fs.existsSync(abs)) {
            return `(Solution snapshot does not contain: ${safeRel})\n`;
          }
          return fs.readFileSync(abs, "utf8");
        } catch (e: any) {
          return `(Failed to load solution snapshot for ${rel}: ${e?.message ?? String(e)})\n`;
        }
      },
    })
  );

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri: vscode.Uri) => {
        const route = uri.path.replace(/^\/+/, "");
        if (route !== "openTaskLink") {
          return;
        }

        const params = new URLSearchParams(uri.query);
        const pathParam = params.get("path");
        const lineParam = params.get("line");
        const line = Number(lineParam ?? "1");
        if (!pathParam || !Number.isFinite(line)) {
          return;
        }

        await vscode.commands.executeCommand("learningCopilot.openTaskLink", {
          path: pathParam,
          line,
        } satisfies TaskJumpTarget);
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.openTaskLink", async (target?: TaskJumpTarget) => {
      if (!target?.path || typeof target.line !== "number") {
        return;
      }

      try {
        const uri = vscode.Uri.file(target.path);
        const doc = await vscode.workspace.openTextDocument(uri);
        const line = Math.max(0, target.line - 1);
        const pos = new vscode.Position(line, 0);
        const editor = await vscode.window.showTextDocument(doc, {
          viewColumn: pickTaskLinkViewColumn(),
          preview: true,
          preserveFocus: false,
          selection: new vscode.Range(pos, pos),
        });
        lastTaskLinkColumn = editor.viewColumn;
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open task location: ${err?.message ?? String(err)}`);
      }
    })
  );

  refreshTaskDecorationsForVisibleEditors();


  // Install Copilot CLI
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "learningCopilot.installCopilotCli",
      async () => {
        output.show(true);
        try {
          const storageDir = await ensureStorageDir(context);

          const existing = await getInstalledCopilotStatus();
          if (existing.kind === "modern") {
            const pick = await vscode.window.showInformationMessage(
              `Copilot CLI appears to be installed and runnable. Reinstall?`,
              { modal: true },
              "Reinstall"
            );
            if (!pick || pick !== "Reinstall") {
              vscode.window.showInformationMessage("Copilot CLI installation skipped.");
              return;
            }
          }
          if (existing.kind === "legacy") {
            output.appendLine(
              `Configured Copilot CLI at ${existing.path} is the deprecated gh-copilot binary and will be replaced.`
            );
          }

          const installedPath = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Installing Copilot CLI…",
              cancellable: false,
            },
            async () => {
              if (process.platform === "darwin" || process.platform === "linux") {
                return await installCopilotCliMacLinux(storageDir, output);
              }
              if (process.platform === "win32") {
                return await installCopilotCliWindows(storageDir, output);
              }
              throw new Error(`Unsupported platform: ${process.platform}`);
            }
          );

          await setCopilotPath(installedPath);
          const authStatus = await detectCopilotAuthStatus(installedPath);
          if (authStatus === "unauthenticated") {
            const pick = await vscode.window.showInformationMessage(
              `Copilot CLI installed at: ${installedPath}`,
              "Login Now",
              "Details",
              "Later"
            );
            if (pick === "Login Now") {
              await vscode.commands.executeCommand("learningCopilot.loginCopilotCli");
            } else if (pick === "Details") {
              await vscode.commands.executeCommand("learningCopilot.showCopilotCliDetails");
            }
          } else {
            const suffix = authStatus === "authenticated" ? " Already logged in." : "";
            const pick = await vscode.window.showInformationMessage(
              `Copilot CLI installed at: ${installedPath}${suffix}`,
              "Details"
            );
            if (pick === "Details") {
              await vscode.commands.executeCommand("learningCopilot.showCopilotCliDetails");
            }
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(
            `Failed to install Copilot CLI: ${err?.message ?? String(err)}`
          );
        }
      }
    )
  );

  // Login to Copilot CLI
  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.loginCopilotCli", async () => {
      try {
        const status = await getInstalledCopilotStatus();
        if (status.kind === "legacy") {
          vscode.window.showErrorMessage(
            "Learning Copilot is configured to use the deprecated gh-copilot binary. Run 'Learning Copilot: Install/Setup Copilot CLI' again first."
          );
          return;
        }
        if (status.kind === "missing") {
          vscode.window.showErrorMessage(
            "Copilot CLI is not installed or not found. Run 'Learning Copilot: Install/Setup Copilot CLI' first."
          );
          return;
        }
        await startCopilotLoginInTerminal(status.path);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to start Copilot CLI login: ${err?.message ?? String(err)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.logoutCopilotCli", async () => {
      try {
        const status = await getInstalledCopilotStatus();
        if (status.kind !== "modern") {
          vscode.window.showErrorMessage(
            "A modern Copilot CLI binary is not configured. Install or set the Copilot CLI first."
          );
          return;
        }
        await startCopilotLogoutInTerminal(status.path);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to start Copilot CLI logout: ${err?.message ?? String(err)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.showCopilotCliDetails", async () => {
      try {
        await showCopilotCliDetails(context);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to show Copilot CLI details: ${err?.message ?? String(err)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.setCopilotCliPath", async () => {
      try {
        const newPath = await pickAndSetCopilotPath();
        if (!newPath) {
          return;
        }
        const authStatus = await detectCopilotAuthStatus(newPath);
        const suffix = authStatus === "authenticated"
        ? " Already logged in."
        : authStatus === "unauthenticated"
        ? " Login is still required."
        : "";
        vscode.window.showInformationMessage(`Copilot CLI path set to: ${newPath}${suffix}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to set Copilot CLI path: ${err?.message ?? String(err)}`
        );
      }
    })
  );


  // Fresh-project workflow: generate files from a prompt, then offer a scaffold.
  async function runCreateProjectWorkflow(wsRoot: vscode.Uri, userPrompt: string): Promise<void> {
      const runtime = await resolveLlmRuntime(context, output);
      if (!runtime) { return; }

      output.show(true);
      output.appendLine(`Using transport: ${runtime.client.label}`);

      let writtenFiles: WrittenFile[] = [];
      let briefMd = "";

      let planRaw: unknown = null;
      let planError: string | null = null;
      try {
        planRaw = await runtime.client.requestJson({
          instructions: buildGeneratePlanInstructions(userPrompt),
          requiredKeys: ["files"],
          schemaName: "emit_file_plan",
          schema: FILE_PLAN_SCHEMA,
          traceLabel: "Generate code files plan",
        });
      } catch (err: any) {
        if (await maybeHandleCliAuthError(runtime, err)) { return; }
        planError = err?.message ?? String(err);
      }

      let plan: StudentBriefLike | null = null;
      if (planRaw) {
        try {
          plan = coerceFilePlan(planRaw);
        } catch (err: any) {
          planError = err?.message ?? String(err);
        }
      }

      if (plan && plan.files.length > 0) {
        if (plan.notes) {
          output.appendLine("--- notes ---");
          output.appendLine(plan.notes);
        }
        ({ briefMd } = await deriveStudentBrief(plan, wsRoot, output));

        const applied = await applyPlanFilesToWorkspace(wsRoot, plan.files, "generated file(s)");
        if (applied.cancelled) {
          vscode.window.showInformationMessage("Learning Copilot: File generation cancelled.");
          return;
        }
        writtenFiles = applied.writtenFiles;
      } else if (runtime.client.id === "copilot-cli") {
        // The CLI sometimes writes artifacts to its session dir instead of
        // returning JSON. Offer to import them.
        const filesDir = await findNewestArtifactFilesDir(runtime.configDir);
        const artifacts = filesDir ? await listFilesRecursive(filesDir) : [];
        if (artifacts.length === 0) {
          vscode.window.showErrorMessage(
            planError
            ? `Could not parse the generation plan (${planError}) and no Copilot artifacts were found.`
            : "The model did not propose any files and no Copilot artifacts were found."
          );
          return;
        }

        const names = artifacts.slice(0, 8).map((a) => a.rel).join(", ");
        const more = artifacts.length > 8 ? ` (+${artifacts.length - 8} more)` : "";
        const choice = await vscode.window.showInformationMessage(
          `Copilot produced file artifacts (${artifacts.length}): ${names}${more}. Import into the workspace?`,
          { modal: true },
          "Import"
        );
        if (choice !== "Import") {
          vscode.window.showInformationMessage("Learning Copilot: Import cancelled.");
          return;
        }

        writtenFiles = await importArtifactsIntoWorkspace(wsRoot, artifacts);
        if (writtenFiles.length > 0) {
          vscode.window.showInformationMessage("Learning Copilot: Artifact import complete.");
        }
      } else {
        vscode.window.showErrorMessage(
          planError
          ? `Could not parse the generation plan: ${planError}`
          : "The model did not propose any files."
        );
        return;
      }

      if (writtenFiles.length === 0) {
        // User skipped everything.
        return;
      }

      vscode.window.showInformationMessage("Learning Copilot: File generation complete.");

      const doScaffold = await vscode.window.showInformationMessage(
        `Generate learning tasks and exercises for ${writtenFiles.length} file(s)?`,
        { modal: true },
        "Generate",
        "Skip"
      );
      if (doScaffold !== "Generate") { return; }

      // Save full solution snapshot privately
      let snapshotDir: string | null = null;
      try {
        snapshotDir = await saveSolutionSnapshot(runtime.storageDir, writtenFiles);
        await context.globalState.update("learningCopilot.lastSnapshotDir", snapshotDir);
      } catch (e: any) {
        output.appendLine(`Failed to save solution snapshot: ${e?.message ?? String(e)}`);
      }

      output.appendLine("\n=== Generating learning scaffold ===");

      briefMd = await ensureBriefFallback(
        briefMd,
        writtenFiles.map((wf) => wf.rel),
        "generated",
        wsRoot
      );

      let scaffold: ScaffoldPlan;
      try {
        scaffold = await runScaffoldGeneration({
          client: runtime.client,
          files: writtenFiles.map((wf) => ({ rel: wf.rel, content: wf.fullContent })),
          briefMd,
          output,
        });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to generate learning tasks: ${e?.message ?? String(e)}`);
        return;
      }

      const generatedSet = new Set(writtenFiles.map((w) => normalizeRelativePath(w.rel)));
      await persistScaffoldOutputs({
        context,
        wsRoot,
        storageDir: runtime.storageDir,
        scaffold,
        allowedRels: generatedSet,
        output,
      });

      if (snapshotDir) {
        vscode.window.showInformationMessage(`Full solution snapshot saved to extension storage: ${snapshotDir}`);
      }

      vscode.window.showInformationMessage("Learning Copilot: Scaffold generation complete.");
  }

  // Compare active file with latest saved solution snapshot
  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.compareWithSolution", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Open a file to compare with the solution.");
        return;
      }

      const snapshotDir = context.globalState.get<string>("learningCopilot.lastSnapshotDir");
      if (!snapshotDir) {
        vscode.window.showWarningMessage(
          "No solution snapshot available yet. Run ‘Learning Copilot: Create or Update Project from Prompt’ and generate learning tasks first."
        );
        return;
      }

      const wsRoot = getWorkspaceRootUri();
      if (!wsRoot) {
        vscode.window.showErrorMessage("Open a folder/workspace first.");
        return;
      }

      const docPath = editor.document.uri.fsPath;
      const rootPath = wsRoot.fsPath;

      let rel = path.relative(rootPath, docPath).replace(/\\/g, "/");
      try {
        rel = normalizeRelativePath(rel);
      } catch {
        vscode.window.showErrorMessage("Active file is not within the current workspace root.");
        return;
      }

      const solutionUri = vscode.Uri.parse(`${SOLUTION_SCHEME}:/${rel}`);
      const title = `Current ↔ Solution: ${rel} (use ← to apply solution)`;

      // Left = student's current file (editable), Right = solution snapshot (read-only virtual doc)
      await vscode.commands.executeCommand("vscode.diff", editor.document.uri, solutionUri, title);
    })
  );

  // Apply task at cursor
  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.applyTaskAtCursor", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return vscode.window.showWarningMessage("Open a file first."); }

      const wsRoot = getWorkspaceRootUri();
      if (!wsRoot) { return vscode.window.showErrorMessage("Open a folder/workspace first."); }

      let rel: string;
      try { rel = getRelPathForActiveDoc(wsRoot, editor.document.uri); }
      catch { return vscode.window.showErrorMessage("Active file is not within the current workspace root."); }

      const text = editor.document.getText();
      const offset = editor.document.offsetAt(editor.selection.active);
      const hit = findTaskRegionAtPosition(text, offset);
      if (!hit) {
        return vscode.window.showWarningMessage(
          "No __LC_TASK_<id>_START__/__LC_TASK_<id>_END__ region under the cursor."
        );
      }

      const task = getTaskById(context, rel, hit.id);
      if (!task) { return vscode.window.showErrorMessage(`No stored solution mapping for task id: ${hit.id}`); }

      // Ensure the END marker stays on its own line.
      // Our replacement range ends at the start of the END marker line, so if the inserted
      // solution doesn't end with a newline, the END marker would end up on the same line.
      const insert = task.solution.endsWith("\n") ? task.solution : task.solution + "\n";

      await applySolutionForRegion(editor, editor.document, hit, insert, true);
      await markTasksCompleted(context, wsRoot, [getTaskStateKey(rel, hit.id)]);
      vscode.window.showInformationMessage(`Applied solution for task ${hit.id} (markers removed).`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.applyNextTask", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {return vscode.window.showWarningMessage("Open a file first.");}

      const wsRoot = getWorkspaceRootUri();
      if (!wsRoot) {return vscode.window.showErrorMessage("Open a folder/workspace first.");}

      let rel: string;
      try { rel = getRelPathForActiveDoc(wsRoot, editor.document.uri); }
      catch { return vscode.window.showErrorMessage("Active file is not within the current workspace root."); }

      const text = editor.document.getText();
      const offset = editor.document.offsetAt(editor.selection.active);
      const next = findNextTaskRegion(text, offset);
      if (!next) { return vscode.window.showInformationMessage("No further task regions found in this file."); }
      const task = getTaskById(context, rel, next.id);
      if (!task) {return vscode.window.showErrorMessage(`No stored solution mapping for task id: ${next.id}`);}
      const insert = task.solution.endsWith("\n") ? task.solution : task.solution + "\n";
      const insertLen = insert.length;
      const newPos = editor.document.positionAt(next.startTokenEnd + insertLen);

      await applySolutionForRegion(editor, editor.document, next, insert, true);
      await markTasksCompleted(context, wsRoot, [getTaskStateKey(rel, next.id)]);

      editor.selection = new vscode.Selection(newPos, newPos);
      editor.revealRange(new vscode.Range(newPos, newPos));

      vscode.window.showInformationMessage(`Applied next task: ${next.id}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.applyAllTasks", async () => {
      const wsRoot = getWorkspaceRootUri();
      if (!wsRoot) { return vscode.window.showErrorMessage("Open a folder/workspace first."); }

      const allTasks = context.globalState.get<ScaffoldTask[]>("learningCopilot.lastScaffoldTasks") ?? [];
      if (allTasks.length === 0) {
        return vscode.window.showInformationMessage("No learning tasks are stored yet.");
      }

      let filesUpdated = 0;
      let tasksApplied = 0;
      const missingFiles: string[] = [];
      const missingMappings: string[] = [];

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Learning Copilot: Restore solution state from all tasks",
          cancellable: false,
        },
        async () => {
          const result = await restoreAllTasksInWorkspace(context, wsRoot);
          filesUpdated = result.filesUpdated;
          tasksApplied = result.tasksApplied;
          missingFiles.push(...result.missingFiles);
          missingMappings.push(...result.missingMappings);
          await markTasksCompleted(context, wsRoot, result.appliedTaskKeys);
        }
      );

      if (missingMappings.length > 0) {
        return vscode.window.showErrorMessage(
          `Could not restore some task regions because solution mappings were missing: ${missingMappings.join(" | ")}`
        );
      }

      if (filesUpdated === 0) {
        if (missingFiles.length > 0) {
          return vscode.window.showWarningMessage(
            `No task solutions were applied. Missing file${missingFiles.length === 1 ? "" : "s"}: ${missingFiles.join(", ")}`
          );
        }
        return vscode.window.showInformationMessage("No task regions were found to apply.");
      }

      const suffix = missingFiles.length > 0
      ? ` Missing file${missingFiles.length === 1 ? "" : "s"}: ${missingFiles.join(", ")}.`
      : "";
      vscode.window.showInformationMessage(
        `Applied ${tasksApplied} task solution${tasksApplied === 1 ? "" : "s"} across ${filesUpdated} file${filesUpdated === 1 ? "" : "s"}.${suffix}`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.showHintForTaskAtCursor", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return vscode.window.showWarningMessage("Open a file first."); }

      const wsRoot = getWorkspaceRootUri();
      if (!wsRoot) { return vscode.window.showErrorMessage("Open a folder/workspace first."); }

      let rel: string;
      try { rel = getRelPathForActiveDoc(wsRoot, editor.document.uri); }
      catch { return vscode.window.showErrorMessage("Active file is not within the current workspace root."); }

      const text = editor.document.getText();
      const offset = editor.document.offsetAt(editor.selection.active);
      const hit = findTaskRegionAtPosition(text, offset);
      if (!hit) {
        return vscode.window.showWarningMessage(
          "No __LC_TASK_<id>_START__/__LC_TASK_<id>_END__ region under the cursor."
        );
      }
      const task = getTaskById(context, rel, hit.id);
      if (!task) { return vscode.window.showErrorMessage(`No stored mapping for task id: ${hit.id}`); }

      const parts: string[] = [];
      if (task.hint) { parts.push(`Hint: ${task.hint}`); }
      if (task.explanation) { parts.push(`Explanation: ${task.explanation}`); }
      if (parts.length === 0) { return vscode.window.showInformationMessage("No hint/explanation provided for this task."); }

      vscode.window.showInformationMessage(parts.join("\n\n"));
    })
  );


  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.markTaskDoneAtCursor", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {return vscode.window.showWarningMessage("Open a file first.");}

      const wsRoot = getWorkspaceRootUri();
      if (!wsRoot) {return vscode.window.showErrorMessage("Open a folder/workspace first.");}

      const doc = editor.document;

      let rel: string;
      try {
        rel = getRelPathForActiveDoc(wsRoot, doc.uri);
      } catch {
        return vscode.window.showErrorMessage("Active file is not within the current workspace root.");
      }

      const text = doc.getText();
      const offset = doc.offsetAt(editor.selection.active);
      const hit = findTaskRegionAtPosition(text, offset);
      if (!hit) {
        return vscode.window.showWarningMessage(
          "No __LC_TASK_<id>_START__/__LC_TASK_<id>_END__ region under the cursor."
        );
      }

      const confirm = await vscode.window.showInformationMessage(
        `Mark task '${hit.id}' as done? This will remove its START/END markers but keep the current content.`,
        { modal: true },
        "Mark Done"
      );
      if (confirm !== "Mark Done") {return;}

      // Helper: decide whether a line is “just a marker comment”
      const lineLooksLikeOnlyMarker = (lineText: string) => {
        const trimmed = lineText.trim();
        if (!trimmed) {return false;}
        const hasToken = trimmed.includes("__LC_TASK_") && (trimmed.includes("_START__") || trimmed.includes("_END__"));
        if (!hasToken) {return false;}

        // Remove token(s)
        let rest = trimmed.replace(/__LC_TASK_[A-Za-z0-9_-]+_(?:START|END)__/g, "");

        // Remove common comment wrappers
        rest = rest
        .replace(/^\/\/+/, "")     // //
        .replace(/^#/, "")         // #
        .replace(/^<!--/, "")      // <!--
        .replace(/-->$/, "")       // -->
        .replace(/^\/\*/, "")      // /*
        .replace(/\*\/$/, "")      // */
        .replace(/^--+/, "")       // -- (SQL)
        .replace(/^;+/, "");       // ;

        return rest.trim().length === 0;
      };

      const removeMarkerTokensFromLine = (lineText: string) =>
        lineText.replace(/__LC_TASK_[A-Za-z0-9_-]+_(?:START|END)__/g, "");

      // Compute edits from the original doc (apply in reverse order)
      const startPos = doc.positionAt(hit.startTokenStart);
      const endPos = doc.positionAt(hit.endTokenEnd);

      const startLine = doc.lineAt(startPos.line);
      const endLine = doc.lineAt(endPos.line);

      const edits: Array<{ range: vscode.Range; replacement: string }> = [];

      if (lineLooksLikeOnlyMarker(startLine.text)) {
        edits.push({ range: startLine.rangeIncludingLineBreak, replacement: "" });
      } else {
        edits.push({ range: startLine.range, replacement: removeMarkerTokensFromLine(startLine.text) });
      }

      if (lineLooksLikeOnlyMarker(endLine.text)) {
        edits.push({ range: endLine.rangeIncludingLineBreak, replacement: "" });
      } else {
        edits.push({ range: endLine.range, replacement: removeMarkerTokensFromLine(endLine.text) });
      }

      // Apply edits in reverse order so ranges don't shift
      await editor.edit((eb) => {
        edits
        .sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start))
        .forEach((e) => eb.replace(e.range, e.replacement));
      });

      await markTasksCompleted(context, wsRoot, [getTaskStateKey(rel, hit.id)]);

      vscode.window.showInformationMessage(`Marked task as done: ${hit.id}`);
    })
  );

  // Open latest instructor answer key (includes comprehension answers)
  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.openLatestAnswerKey", async () => {
      const keyPath = context.globalState.get<string>("learningCopilot.lastAnswerKeyPath");
      if (!keyPath) {
        vscode.window.showWarningMessage(
          "No instructor answer key saved yet. Generate learning tasks with an answer key first."
        );
        return;
      }
      try {
        const uri = vscode.Uri.file(keyPath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to open answer key: ${e?.message ?? String(e)}`);
      }
    })
  );

  // Existing-project workflow: modify the workspace from a prompt (using
  // workspace context), then offer a scaffold focused on the changed files.
  async function runModifyWorkspaceWorkflow(wsRoot: vscode.Uri, userPrompt: string): Promise<void> {
      output.show(true);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Learning Copilot: Modify workspace and create learning tasks",
          cancellable: false,
        },
        async (progress) => {
          const modifyStartedAt = Date.now();
          try {
            const allTasks = context.globalState.get<ScaffoldTask[]>("learningCopilot.lastScaffoldTasks") ?? [];
            const remainingTasks = allTasks.filter((task) => !task.completed);
            if (remainingTasks.length > 0) {
              const choice = await vscode.window.showWarningMessage(
                `There ${remainingTasks.length === 1 ? "is" : "are"} ${remainingTasks.length} unfinished task${remainingTasks.length === 1 ? "" : "s"}. Modifying the workspace will first apply all remaining solutions and may overwrite student work. Continue?`,
                { modal: true },
                "Continue"
              );
              if (choice !== "Continue") {
                return;
              }
            }

            reportActivity(progress, output, modifyStartedAt, "Step 1/5: Restoring solved workspace from existing tasks…", "Step 1/5: Restoring solved workspace");
            const restoreResult = await restoreAllTasksInWorkspace(context, wsRoot);
            if (restoreResult.missingMappings.length > 0) {
              vscode.window.showErrorMessage(
                `Could not restore some task regions before modifying the workspace: ${restoreResult.missingMappings.join(" | ")}`
              );
              return;
            }
            if (restoreResult.tasksApplied > 0) {
              output.appendLine(
                `Restored ${restoreResult.tasksApplied} task solution${restoreResult.tasksApplied === 1 ? "" : "s"} across ${restoreResult.filesUpdated} file${restoreResult.filesUpdated === 1 ? "" : "s"}.`
              );
            } else {
              output.appendLine("No existing task regions were found to restore before modification.");
            }
            if (restoreResult.missingFiles.length > 0) {
              output.appendLine(`Missing file${restoreResult.missingFiles.length === 1 ? "" : "s"} during restore: ${restoreResult.missingFiles.join(", ")}`);
            }

            // Gather workspace context
            reportActivity(progress, output, modifyStartedAt, "Step 2/5: Collecting workspace context…", "Step 2/5: Collecting context");
            output.appendLine("\n=== Collecting workspace context ===");
            const ctxFiles = await collectWorkspaceContext(wsRoot, output);
            output.appendLine(`Collected ${ctxFiles.length} file(s) for context.`);

            // Also include active file hint (if any)
            const active = vscode.window.activeTextEditor?.document?.uri;
            let activeRel: string | null = null;
            if (active && active.scheme === "file") {
              try {
                activeRel = getRelPathForActiveDoc(wsRoot, active);
              } catch {
                activeRel = null;
              }
            }

            const runtime = await resolveLlmRuntime(context, output);
            if (!runtime) { return; }
            output.appendLine(`Using transport: ${runtime.client.label}`);

            reportActivity(progress, output, modifyStartedAt, "Step 3/5: Asking the model to plan workspace changes…", "Step 3/5: Planning changes");
            let planRaw: unknown;
            try {
              planRaw = await runtime.client.requestJson({
                instructions: buildModifyPlanInstructions(userPrompt, activeRel),
                payload: JSON.stringify(ctxFiles),
                requiredKeys: ["files"],
                schemaName: "emit_file_plan",
                schema: FILE_PLAN_SCHEMA,
                traceLabel: "Modify workspace plan",
              });
            } catch (err: any) {
              if (await maybeHandleCliAuthError(runtime, err)) { return; }
              vscode.window.showErrorMessage(`Workspace planning failed: ${err?.message ?? String(err)}`);
              return;
            }

            let plan: StudentBriefLike;
            try {
              plan = coerceFilePlan(planRaw);
            } catch (e: any) {
              vscode.window.showErrorMessage(e?.message ?? String(e));
              return;
            }
            reportActivity(progress, output, modifyStartedAt, "Step 3/5: Workspace change plan ready for review.", "Step 3/5: Reviewing plan");

            if (plan.notes) {
              output.appendLine("--- notes ---");
              output.appendLine(plan.notes);
            }

            const derived = await deriveStudentBrief(plan, wsRoot, output);
            let briefMd = derived.briefMd;

            if (!plan.files?.length) {
              vscode.window.showInformationMessage("The model did not propose any file changes.");
              return;
            }

            const applied = await applyPlanFilesToWorkspace(wsRoot, plan.files, "workspace change(s)");
            if (applied.cancelled || applied.writtenFiles.length === 0) {
              vscode.window.showInformationMessage("No changes applied.");
              return;
            }
            const writtenFiles = applied.writtenFiles;
            const oldContentByRel = applied.oldContentByRel;

            vscode.window.showInformationMessage(`Applied ${writtenFiles.length} change(s).`);

            const doScaffold = await vscode.window.showInformationMessage(
              `Generate learning tasks and exercises for the ${writtenFiles.length} changed file(s)?`,
              { modal: true },
              "Generate",
              "Skip"
            );
            if (doScaffold !== "Generate") {
              return;
            }

            reportActivity(progress, output, modifyStartedAt, "Step 4/5: Preparing learning tasks for changed files…", "Step 4/5: Preparing tasks");
            // Save full solution snapshot of the changed files (private)
            let snapshotDir: string | null = null;
            try {
              snapshotDir = await saveSolutionSnapshot(runtime.storageDir, writtenFiles);
              await context.globalState.update("learningCopilot.lastSnapshotDir", snapshotDir);
            } catch (e: any) {
              output.appendLine(`Failed to save solution snapshot: ${e?.message ?? String(e)}`);
            }

            output.appendLine("\n=== Generating learning scaffold (focused on new/changed functionality) ===");

            // Diff each changed file against its previous content so the
            // scaffold only tasks out new/changed lines.
            const focusWithDiff: FocusFileWithDiff[] = writtenFiles.map((wf) => {
              const rel = normalizeRelativePath(wf.rel);
              const oldContent = oldContentByRel.get(rel) ?? "";
              const changedRanges = computeChangedRangesByPrefixSuffix(oldContent, wf.fullContent);
              output.appendLine(`Changed ranges for ${rel}: ${formatRangesForPrompt(changedRanges)}`);
              return { rel, fullContent: wf.fullContent, oldContent, changedRanges };
            });

            const scaffoldContext = selectFocusedTaskContext(
              focusWithDiff,
              buildScaffoldContextFromWorkspaceSnapshot(ctxFiles, writtenFiles, output),
              output
            );

            briefMd = await ensureBriefFallback(
              briefMd,
              writtenFiles.map((wf) => wf.rel),
              "changed",
              wsRoot
            );

            let scaffold: ScaffoldPlan;
            try {
              scaffold = await runScaffoldGeneration({
                client: runtime.client,
                files: focusWithDiff.map((f) => ({
                  rel: f.rel,
                  content: f.fullContent,
                  changedRanges: f.changedRanges.length > 0 ? f.changedRanges : undefined,
                })),
                contextFiles: scaffoldContext,
                briefMd,
                output,
              });
            } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to generate learning tasks: ${e?.message ?? String(e)}`);
              return;
            }

            reportActivity(progress, output, modifyStartedAt, "Step 5/5: Applying learning tasks…", "Step 5/5: Applying tasks");
            const changedSet = new Set(writtenFiles.map((w) => normalizeRelativePath(w.rel)));
            await persistScaffoldOutputs({
              context,
              wsRoot,
              storageDir: runtime.storageDir,
              scaffold,
              allowedRels: changedSet,
              output,
            });

            if (snapshotDir) {
              vscode.window.showInformationMessage(`Solution snapshot saved to extension storage: ${snapshotDir}`);
            }

            vscode.window.showInformationMessage("Learning Copilot: Workspace modification learning tasks complete.");
          } finally {
            setBusyStatus(null);
          }
        }
      );
  }

  // Single entry point for both workflows: looks at the workspace to decide
  // whether the student is starting fresh or updating existing code.
  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.generateFromPrompt", async () => {
      const wsRoot = getWorkspaceRootUri();
      if (!wsRoot) {
        vscode.window.showErrorMessage("Open a folder/workspace first.");
        return;
      }

      const mode = await detectPromptWorkflowMode(wsRoot);
      const userPrompt = await vscode.window.showInputBox(
        mode === "create"
        ? {
          title: "Learning Copilot: Describe what to build",
          prompt: "Your workspace has no code yet, so Learning Copilot will create a new project.",
          placeHolder: "e.g., Create a simple web app with a button and slider using vanilla HTML/CSS/JS.",
        }
        : {
          title: "Learning Copilot: Describe what to change or add",
          prompt: "Learning Copilot found existing code, so it will update this project.",
          placeHolder: "e.g., Add a dark mode toggle; add form validation; refactor into modules.",
        }
      );
      if (!userPrompt) { return; }

      if (mode === "create") {
        await runCreateProjectWorkflow(wsRoot, userPrompt);
      } else {
        await runModifyWorkspaceWorkflow(wsRoot, userPrompt);
      }
    })
  );

  // Back-compat aliases for the two commands the unified prompt replaced.
  for (const legacyCommand of [
    "learningCopilot.generateCodeFilesPrompt",
    "learningCopilot.modifyWorkspaceFromPrompt",
  ]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(legacyCommand, () =>
        vscode.commands.executeCommand("learningCopilot.generateFromPrompt")
      )
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.showMenu", showLearningCopilotMenu)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.openExercises", async () => {
      const wsRoot = getWorkspaceRootUri();
      if (!wsRoot) {
        vscode.window.showErrorMessage("Open a folder/workspace first.");
        return;
      }
      const target = vscode.Uri.joinPath(wsRoot, "LEARNING_EXERCISES.md");
      try {
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        vscode.window.showWarningMessage(
          "No LEARNING_EXERCISES.md in this workspace yet. Use 'Learning Copilot: Create or Update Project from Prompt' to generate learning tasks first."
        );
      }
    })
  );
}
/**
* Deactivates the extension.
*/
export function deactivate() {}
//#endregion
