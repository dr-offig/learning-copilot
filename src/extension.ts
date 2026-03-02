import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let lastOutput: string | null = null;

let statusBar: vscode.StatusBarItem | null = null;
let lastTaskLinkColumn: vscode.ViewColumn | undefined;

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
const EXTENSION_URI_ID = "tgifford-usc.learning-copilot";

type WrittenFile = { rel: string; fullContent: string };

type ScaffoldTask = {
  id: string;
  path: string;
  solution: string;
  hint?: string;
  explanation?: string;
};

type ScaffoldPlan = {
  maskedFiles: Array<{ path: string; content: string }>;
  tasks: ScaffoldTask[];
  exercisesMd: string;
  answerKeyMd?: string;
  notes?: string;
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

/**
 * Checks whether the given copilot executable is runnable by invoking
 * `--version`. Returns true if the process exits with code 0 within timeout.
 */
function isCopilotAvailable(copilotPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const p = spawn(copilotPath, ["--version"]);
      let done = false;
      p.on("error", () => {
        if (!done) {
          done = true;
          resolve(false);
        }
      });
      p.on("exit", (code) => {
        if (!done) {
          done = true;
          resolve(code === 0);
        }
      });
      // safety timeout
      setTimeout(() => {
        if (!done) {
          done = true;
          try {
            p.kill();
          } catch (e) {
            // ignore
          }
          resolve(false);
        }
      }, 3000);
    } catch (e) {
      resolve(false);
    }
  });
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

// Helper to find the newest file in a directory.
/**
 * Finds the most recently modified file in a directory.
 *
 * @param dir Directory to scan.
 */
async function findNewestFile(dir: string): Promise<string | null> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files: Array<{ path: string; mtimeMs: number }> = [];
    for (const e of entries) {
      if (!e.isFile()) { continue; }
      const p = path.join(dir, e.name);
      const st = await fsp.stat(p);
      files.push({ path: p, mtimeMs: st.mtimeMs });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0]?.path ?? null;
  } catch {
    return null;
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
 * Recursively lists all files in a directory and returns their absolute and relative paths.
 *
 * @param root Root directory to list.
 */
async function listFilesRecursive(root: string): Promise<Array<{ rel: string; abs: string }>> {
  const out: Array<{ rel: string; abs: string }> = [];

  async function walk(dir: string) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        out.push({ rel, abs });
      }
    }
  }

  await walk(root);
  return out;
}


/** 
 * For each artifact file, prompts the user to preview and confirm importing it into the workspace. If confirmed, saves the file content to the target location in the workspace.
 *
 * @param wsRoot Workspace root URI.
 * @param artifactFilesDir Directory containing artifact files to import.
 * @param files List of artifact files with relative and absolute paths.
 */
async function importArtifactsIntoWorkspace(
  wsRoot: vscode.Uri,
  files: Array<{ rel: string; abs: string }>
): Promise<WrittenFile[]> {
  const written: WrittenFile[] = [];
  for (const file of files) {
    let rel: string;
    try {
      rel = normalizeRelativePath(file.rel);
    } catch (e: any) {
      vscode.window.showWarningMessage(`Skipping artifact with unsafe path: ${file.rel}`);
      continue;
    }

    const content = await fsp.readFile(file.abs, "utf8");

    const targetUri = vscode.Uri.joinPath(wsRoot, ...rel.split("/"));
    const exists = await vscode.workspace.fs.stat(targetUri).then(() => true, () => false);

    const proposedKey = `artifact/${rel}`;
    proposedContent.set(proposedKey, content);
    const proposedUri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${proposedKey}`);

    const title = exists
      ? `Import Copilot artifact: ${rel} (overwrite existing?)`
      : `Import Copilot artifact: ${rel} (create?)`;

    while (true) {
      const pick = await vscode.window.showInformationMessage(
        title,
        { modal: true },
        "Preview",
        exists ? "Overwrite" : "Create",
        "Skip"
      );

      if (!pick || pick === "Skip") { break; }

      if (pick === "Preview") {
        if (exists) {
          await vscode.commands.executeCommand("vscode.diff", targetUri, proposedUri, `Artifact import: ${rel}`);
        } else {
          const emptyKey = `empty/${rel}`;
          proposedContent.set(emptyKey, "");
          const emptyUri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${emptyKey}`);
          await vscode.commands.executeCommand("vscode.diff", emptyUri, proposedUri, `Artifact import: ${rel}`);
        }
        continue;
      }

      if (pick === "Overwrite" || pick === "Create") {
        await ensureDirForFile(targetUri);
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
        written.push({ rel, fullContent: content });
        vscode.window.showInformationMessage(`${exists ? "Updated" : "Created"}: ${rel}`);
        break;
      }
    }
  }
  return written;
}

//#endregion

//#region <COPILOT EXECUTION>
/**
 * ============================================================================
 * <COPILOT EXECUTION>
 * ============================================================================
 * Process execution wrappers around Copilot CLI, including argument hygiene and
 * fallback diagnostics from generated log files.
 */


/**
 * Runs Copilot CLI for a prompt and captures stdout/stderr/exit code.
 *
 * @param copilotPath Copilot executable path.
 * @param args Base CLI args from configuration.
 * @param cwd Working directory for process execution.
 * @param prompt Prompt passed through `-p`.
 * @param configDir Copilot config directory.
 * @param logDir Copilot log directory.
 * @param output Output channel for command diagnostics.
 * @param envOverride Optional environment overrides.
 */
function runCopilotPrompt(
  copilotPath: string,
  args: string[],
  cwd: string,
  prompt: string,
  configDir: string,
  logDir: string,
  output: vscode.OutputChannel,
  envOverride?: NodeJS.ProcessEnv,
  traceLabel = "Copilot CLI call"
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  void configDir;
  void logDir;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const effectiveArgs = [...args, "-p", prompt];
    const proc = spawn(copilotPath, effectiveArgs, {
      cwd,
      env: { ...process.env, ...(envOverride ?? {}) },
      shell: false,
    });
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    
    proc.on("error", (err) => reject(err));
    proc.on("close", async (code) => {
      const exitCode = code;
      // If Copilot fails but provides no stderr/stdout, it often wrote the reason to log files.
      if ((exitCode ?? 0) !== 0 && !stdout.trim() && !stderr.trim()) {
        const newest = await findNewestFile(logDir);
        if (newest) {
          try {
            const content = await fsp.readFile(newest, "utf8");
            const lines = content.split(/\r?\n/);
            const tail = lines.slice(Math.max(0, lines.length - 80)).join("\n");
            output.appendLine("\n--- Copilot log (tail) ---");
            output.appendLine(`log file: ${newest}`);
            output.appendLine(tail);
          } catch {
            // ignore
          }
        }
      }
      logDuration(
        output,
        traceLabel,
        startedAt,
        `exit=${exitCode ?? "null"}, promptChars=${prompt.length}, stdoutChars=${stdout.length}, stderrChars=${stderr.length}`
      );
      resolve({ stdout, stderr, exitCode });
    });
    
    output.appendLine(`> ${copilotPath} ${[...args, "-p", JSON.stringify(prompt)].join(" ")}`);
  });
}

//#endregion

//#region <FILE GENERATION HELPERS>
/**
 * ============================================================================
 * <FILE GENERATION HELPERS>
 * ============================================================================
 * Validation, JSON parsing, URI preparation, and save target selection used for
 * generated output and generated-file workflows.
 */
/**
 * Returns the first workspace root URI, if available.
 */
function getWorkspaceRootUri(): vscode.Uri | null {
  const ws = vscode.workspace.workspaceFolders?.[0];
  return ws?.uri ?? null;
}

/**
 * Validates and normalizes a user-provided relative path.
 *
 * @param p Relative path candidate.
 */
function normalizeRelativePath(p: string): string {
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

/**
 * Removes optional markdown code fences from model output.
 *
 * @param s Raw string that may be wrapped in triple backticks.
 */
function stripCodeFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : t;
}

/**
 * Parses and validates the JSON file-generation plan schema.
 *
 * @param jsonText Copilot raw JSON response.
 */
function parseFilePlan(jsonText: string): { files: Array<{ path: string; content: string; overwrite?: boolean }>; notes?: string } {
  const raw = stripCodeFences(jsonText);
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("Copilot did not return valid JSON. Try again with a simpler prompt.");
  }

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

  return { files, notes: typeof obj.notes === "string" ? obj.notes : undefined };
}


/** * Parses and validates the JSON scaffold plan schema, which includes masked files and markdown content for exercises and answer keys.
 *
 * @param jsonText Copilot raw JSON response.
 */
function parseScaffoldPlan(jsonText: string): ScaffoldPlan {
  const raw = stripCodeFences(jsonText);
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("Copilot did not return valid JSON for scaffold plan.");
  }

  if (!obj || typeof obj !== "object") {
    throw new Error("Scaffold JSON must be an object.");
  }
  if (!Array.isArray(obj.maskedFiles)) {
    throw new Error("Scaffold JSON must include 'maskedFiles' array.");
  }
  if (typeof obj.exercisesMd !== "string") {
    throw new Error("Scaffold JSON must include 'exercisesMd' string.");
  }

  if (!Array.isArray(obj.tasks)) {
    throw new Error("Scaffold JSON must include 'tasks' array.");
  }

  const maskedFiles = obj.maskedFiles.map((f: any) => {
    if (!f || typeof f !== "object") {
      throw new Error("Each maskedFiles entry must be an object.");
    }
    if (typeof f.path !== "string" || typeof f.content !== "string") {
      throw new Error("Each maskedFiles entry must have string 'path' and 'content'.");
    }
    return { path: f.path, content: f.content };
  });

  return {
    maskedFiles,
    exercisesMd: obj.exercisesMd,
    answerKeyMd: typeof obj.answerKeyMd === "string" ? obj.answerKeyMd : undefined,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
    tasks: obj.tasks
  };
}

// --- Scaffold marker/comment style validation helpers ---
function commentStyleRuleForPath(p: string): string {
  const ext = path.posix.extname(p.toLowerCase());
  if (ext === ".html" || ext === ".htm" || ext === ".svg") {
    return "HTML comments only: <!-- __LC_TASK_<id>_START__ --> and <!-- __LC_TASK_<id>_END__ --> on their own lines.";
  }
  if (ext === ".css") {
    return "CSS comments only: /* __LC_TASK_<id>_START__ */ and /* __LC_TASK_<id>_END__ */ on their own lines.";
  }
  if ([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"].includes(ext)) {
    return "JS/TS comments only: // __LC_TASK_<id>_START__ and // __LC_TASK_<id>_END__ (or /* ... */) on their own lines.";
  }
  if ([".py"].includes(ext)) {
    return "Python comments only: # __LC_TASK_<id>_START__ and # __LC_TASK_<id>_END__ on their own lines.";
  }
  if ([".md"].includes(ext)) {
    return "Markdown/HTML comments preferred: <!-- __LC_TASK_<id>_START__ --> and <!-- __LC_TASK_<id>_END__ --> on their own lines.";
  }
  // Fallback: allow //, /* */, or #
  return "Markers must be standalone comment lines appropriate to the language/file type.";
}

function getExpectedMarkerLineRegexForPath(p: string, which: "START" | "END"): RegExp {
  const ext = path.posix.extname(p.toLowerCase());
  const tok = `__LC_TASK_[A-Za-z0-9_-]+_${which}__`;
  if (ext === ".html" || ext === ".htm" || ext === ".svg" || ext === ".md") {
    return new RegExp(`^\\s*<!--\\s*${tok}\\s*-->\\s*$`);
  }
  if (ext === ".css") {
    return new RegExp(`^\\s*\\/\\*\\s*${tok}\\s*\\*\\/\\s*$`);
  }
  if ([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"].includes(ext)) {
    return new RegExp(`^\\s*(?:\\/\\/\\s*${tok}\\s*|\\/\\*\\s*${tok}\\s*\\*\\/)\\s*$`);
  }
  if (ext === ".py") {
    return new RegExp(`^\\s*#\\s*${tok}\\s*$`);
  }
  // permissive fallback
  return new RegExp(`^\\s*(?:\\/\\/|#|--|;|<!--|\\/\\*)?\\s*${tok}`);
}

type ScaffoldValidationIssue = {
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

function extractRegionsForFile(content: string): TaskRegionHit[] {
  return listTaskRegions(content);
}

function extractRegionEditableText(content: string, r: TaskRegionHit): string {
  return content.slice(r.startTokenEnd, r.endTokenStart);
}

function extractComprehensionQuestionIds(exercisesMd: string): string[] {
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

function answerKeyHasAnswerFor(questionId: string, answerKeyMd: string): boolean {
  // Accept either an explicit tag line or a heading/bullet containing the tag.
  const re = new RegExp(`\\[${escapeRegExp(questionId)}\\]`, "i");
  return re.test(answerKeyMd);
}

function validateScaffoldPlan(plan: ScaffoldPlan): ScaffoldValidationIssue[] {
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
    const regions = extractRegionsForFile(mf.content);
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

    const regions = extractRegionsForFile(mf.content);
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

    const startLineRe = getExpectedMarkerLineRegexForPath(rel, "START");
    const endLineRe = getExpectedMarkerLineRegexForPath(rel, "END");
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

      if (!startLineRe.test(startLine) || !endLineRe.test(endLine)) {
        issues.push({
          kind: "badCommentStyle",
          file: rel,
          id: r.id,
          detail: `Marker comment style mismatch in ${rel} for ${r.id}. Expected: ${commentStyleRuleForPath(rel)} Found START line='${startLine.trim()}', END line='${endLine.trim()}'.`,
        });
      }

      if (task) {
        const currentEditable = extractRegionEditableText(mf.content, r);
        const normA = currentEditable.replace(/\s+/g, " ").trim();
        const normB = (task.solution ?? "").replace(/\s+/g, " ").trim();
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

function formatScaffoldIssuesForPrompt(issues: ScaffoldValidationIssue[]): string {
  return issues
    .slice(0, 12)
    .map((i, idx) => {
      const where = [i.file, i.id].filter(Boolean).join(" :: ");
      return `${idx + 1}. [${i.kind}] ${where} — ${i.detail}`;
    })
    .join("\n");
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

  const proposedKey = `proposed/${filename}`;
  proposedContent.set(proposedKey, content);
  const proposedUri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${proposedKey}`);

  const title = exists
    ? `${titlePrefix}: ${filename} (overwrite existing?)`
    : `${titlePrefix}: ${filename} (create?)`;

  while (true) {
    const pick = await vscode.window.showInformationMessage(
      title,
      { modal: true },
      "Preview",
      exists ? "Overwrite" : "Create",
      "Skip"
    );

    if (!pick || pick === "Skip") { return; }

    if (pick === "Preview") {
      if (exists) {
        await vscode.commands.executeCommand("vscode.diff", targetUri, proposedUri, `${titlePrefix}: ${filename}`);
      } else {
        const emptyKey = `empty/${filename}`;
        proposedContent.set(emptyKey, "");
        const emptyUri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${emptyKey}`);
        await vscode.commands.executeCommand("vscode.diff", emptyUri, proposedUri, `${titlePrefix}: ${filename}`);
      }
      continue;
    }

    if (pick === "Overwrite" || pick === "Create") {
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
      vscode.window.showInformationMessage(`${exists ? "Updated" : "Created"}: ${filename}`);
      return;
    }
  }
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
 * Chooses where to save generated markdown output.
 *
 * @param context VS Code extension context.
 */
async function pickSaveUri(context: vscode.ExtensionContext): Promise<vscode.Uri> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws) {
    // Try workspace root first (if it’s writable in the environment)
    const defaultName = "exercise.md";
    const wsUri = vscode.Uri.joinPath(ws.uri, defaultName);
    
    // We can’t reliably pre-test writability across all FS providers,
    // so we offer Save Dialog with workspace default.
    const picked = await vscode.window.showSaveDialog({
      defaultUri: wsUri,
      filters: { Markdown: ["md"] },
      saveLabel: "Save exercise",
    });
    if (picked) { return picked; }
  }
  
  // Fallback to extension storage (always writable in user profile)
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  return vscode.Uri.joinPath(context.globalStorageUri, "exercise.md");
}

/**
 * Returns a conservative exclude glob for scanning a workspace.
 */
function getWorkspaceScanExcludeGlob(): string {
  // Exclude common large/vendor/build folders and VCS metadata.
  return "**/{node_modules,.git,.svn,.hg,dist,build,out,target,bin,obj,coverage,.next,.nuxt,.svelte-kit,.parcel-cache,.turbo,.cache,vendor}/**";
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

type WorkspaceFileContext = { path: string; content: string; truncated?: boolean };

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

/**
 * Collects a limited snapshot of workspace files to provide Copilot with context.
 * - Excludes large/build/vendor folders
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

    if (path.posix.basename(safeRel).toLowerCase() === "learning_exercises.md") {
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

function prependTaskLinksSection(exercisesMd: string, links: TaskJumpLink[]): string {
  if (links.length === 0) { return exercisesMd; }

  const lines = [
    "# Task Links",
    "",
    ...links.map((link) => `- **${link.id}**: [${link.rel}:${link.line}](${link.uri})`),
    "",
    "---",
    "",
  ];

  return lines.join("\n") + exercisesMd;
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
 * generating follow-up explanations and answer keys based on the filled-in
 * content.
 */
type TaskRegionHit = {
  id: string;
  startTokenStart: number;
  startTokenEnd: number;
  endTokenStart: number;
  endTokenEnd: number;
};

function getTaskStartRegex(): RegExp {
  return /__LC_TASK_([A-Za-z0-9_-]+)_START__/g;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTaskEndRegexForId(id: string): RegExp {
  return new RegExp(`__LC_TASK_${escapeRegExp(id)}_END__`, "g");
}

function listTaskRegions(docText: string): TaskRegionHit[] {
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
    if (!endM) {continue;} // unmatched start

    const endTokenStart = endM.index;
    const endTokenEnd = endTokenStart + endM[0].length;

    hits.push({ id, startTokenStart, startTokenEnd, endTokenStart, endTokenEnd });
  }

  hits.sort((a, b) => a.startTokenStart - b.startTokenStart);
  return hits;
}

function findTaskRegionAtPosition(docText: string, offset: number): TaskRegionHit | null {
  const regions = listTaskRegions(docText);
  for (const r of regions) {
    if (offset >= r.startTokenStart && offset <= r.endTokenEnd) {return r;}
  }
  return null;
}

function findNextTaskRegion(docText: string, offset: number): TaskRegionHit | null {
  const regions = listTaskRegions(docText);
  for (const r of regions) {
    if (r.startTokenStart >= offset) {return r;}
  }
  return null;
}

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

function getIndentationForLine(doc: vscode.TextDocument, line: number): string {
  const text = doc.lineAt(line).text;
  const m = text.match(/^\s*/);
  return m ? m[0] : "";
}

function getFullRegionRangeIncludingMarkerLines(doc: vscode.TextDocument, r: TaskRegionHit): vscode.Range {
  const startPos = doc.positionAt(r.startTokenStart);
  const endPos = doc.positionAt(r.endTokenEnd);

  const startLine = doc.lineAt(startPos.line);
  const endLine = doc.lineAt(endPos.line);

  // Replace from beginning of START marker line to end of END marker line (including newline if present)
  const replaceStart = startLine.range.start;
  const replaceEnd = endLine.rangeIncludingLineBreak.end;

  // Fallback if something weird happens (e.g., both tokens on same line)
  if (doc.offsetAt(replaceStart) >= doc.offsetAt(replaceEnd)) {
    return new vscode.Range(doc.positionAt(r.startTokenStart), doc.positionAt(r.endTokenEnd));
  }

  return new vscode.Range(replaceStart, replaceEnd);
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

  const startPos = doc.positionAt(region.startTokenStart);
  const indent = getIndentationForLine(doc, startPos.line);
  const fullRange = getFullRegionRangeIncludingMarkerLines(doc, region);

  let replacement = sol;
  if (replacement.includes("\n")) {
    const lines = replacement.split("\n");
    replacement = lines.map((ln, idx) => (idx === 0 ? ln : indent + ln)).join("\n");
  }

  replacement = replacement.replace(/\s*$/g, "") + "\n";
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
      if (normalizeRelativePath(b.path) === rel && b.id === id) { return b; }
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
  missingFiles: string[];
  missingMappings: string[];
}> {
  const allTasks = context.globalState.get<ScaffoldTask[]>("learningCopilot.lastScaffoldTasks") ?? [];
  if (allTasks.length === 0) {
    return { filesUpdated: 0, tasksApplied: 0, missingFiles: [], missingMappings: [] };
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
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error(`Failed to apply edits for ${rel}.`);
    }

    await doc.save();
    filesUpdated++;
    tasksApplied += regions.length;
  }

  return { filesUpdated, tasksApplied, missingFiles, missingMappings };
}


//#region <EXTENSION LIFECYCLE AND COMMANDS>
/**
 * ============================================================================
 * <EXTENSION LIFECYCLE AND COMMANDS>
 * ============================================================================
 * Registers extension commands and command-specific workflows.
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

type ScaffoldContextFile = { path: string; content: string };

type LineRange = { startLine: number; endLine: number }; // 1-based inclusive

type FocusFileWithDiff = {
  rel: string;
  fullContent: string;
  oldContent: string;
  changedRanges: LineRange[];
};

// Simple prefix/suffix heuristic. Works well for typical “edit a section” changes.
// If you need multiple hunks later, we can upgrade to a real diff.
function computeChangedRangesByPrefixSuffix(oldText: string, newText: string): LineRange[] {
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
  if (start > oldEnd && start > newEnd) {return [];}

  return [{ startLine: start + 1, endLine: newEnd + 1 }];
}

function formatRangesForPrompt(ranges: LineRange[]): string {
  return ranges.length ? ranges.map(r => `L${r.startLine}-L${r.endLine}`).join(", ") : "(no changes detected)";
}

function getRegionStartLine(docText: string, startTokenStart: number): number {
  return docText.slice(0, startTokenStart).split(/\r?\n/).length; // 1-based
}

function isLineWithinRanges(line: number, ranges: LineRange[]): boolean {
  if (!ranges.length) {return false;} // if we detect no changes, don't allow tasks
  return ranges.some(r => line >= r.startLine && line <= r.endLine);
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
      "package-lock.json",
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

async function generateLearningScaffold(
  written: WrittenFile[],
  storageDir: string,
  copilotPath: string,
  copilotArgs: string[],
  configDir: string,
  logDir: string,
  output: vscode.OutputChannel,
  envOverride?: NodeJS.ProcessEnv
): Promise<ScaffoldPlan> {
  
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Learning Copilot: Step 1 of 3 - Generate learning tasks",
      cancellable: false,
    },
    async (progress) => {
      let hb: NodeJS.Timeout | undefined;
      let hbTick = 0;
      const startedAt = Date.now();
      try {
        reportActivity(progress, output, startedAt, "Step 1/3: Preparing learning task prompt…", "Step 1/3: Preparing prompt");

        // Ensure the user can see logs during long scaffold runs.
        output.show(true);

        // Heartbeat: keep progress UI visibly updating during long waits.
        hbTick = 0;
        hb = setInterval(() => {
          hbTick++;
          if (hbTick % 3 === 0) {
            reportActivity(progress, output, startedAt, "Step 1/3: Still generating learning tasks…", "Step 1/3: Generating tasks", 1);
          } else {
            progress.report({ increment: 1 });
          }
        }, 5000);

  
        // keep prompt size reasonable
        const MAX_CHARS_PER_FILE = 12000;
        const filePayload = written.map((f) => ({
          path: f.rel,
          content:
            f.fullContent.length > MAX_CHARS_PER_FILE
              ? f.fullContent.slice(0, MAX_CHARS_PER_FILE) + "\n\n/* TRUNCATED */\n"
              : f.fullContent,
        }));
        output.appendLine(`Task generation payload: ${filePayload.length} file(s), ${JSON.stringify(filePayload).length} chars.`);

        const scaffoldPrompt =
          "Return JSON only. No prose. No markdown, unless the entire response is a single ```json fenced block. " +
          "You are a teaching assistant. Given a COMPLETE working solution for a small programming project, create a LEARNING SCAFFOLD. " +
          "Output schema: " +
          "{\"maskedFiles\":[{\"path\":string,\"content\":string}]," +
          "\"tasks\":[{\"id\":string,\"path\":string,\"solution\":string,\"hint\":string?,\"explanation\":string?}]," +
          "\"exercisesMd\":string," +
          "\"answerKeyMd\":string?," +
          "\"notes\":string?}. " +
          "STRICT RULES: " +
          "(1) maskedFiles must include ONLY files listed in the input (same paths). " +
          "(2) Replace about 5–15% of IMPORTANT logic with task REGIONS that remain identifiable after the student edits. " +
          "Each task region MUST be wrapped by two exact tokens: __LC_TASK_<id>_START__ and __LC_TASK_<id>_END__. " +
          "The student-editable placeholder content must appear BETWEEN these two tokens. " +
          "Markers MUST appear on their own lines as standalone comments containing only the token (plus comment delimiters). Do not place marker tokens inline with code. " +
          "Do NOT use generic TODO comments. Do NOT invent alternate marker names; use the exact __LC_TASK_<id>_START__/END format. " +
          "(3) Every task region MUST have a corresponding entry in the 'tasks' array. The 'id' must exactly match the wrapper token suffix (e.g. validateInput). " +
          "(4) The 'path' field in each task must match the file where the region appears. " +
          "(5) The 'solution' field must contain ONLY the exact code that replaces the placeholder content BETWEEN the START and END tokens. " +
          "Do NOT include the wrapper tokens in solution. Do NOT include markdown fences. Do NOT include explanation inside the solution. Code only. " +
          // ---- INSERTED rules (5b) and (5c) here ----
          "(5b) COMMENT STYLE: The START/END marker lines must use the correct comment syntax for each file type: " +
          "HTML (.html/.htm/.svg): <!-- __LC_TASK_<id>_START__ --> and <!-- __LC_TASK_<id>_END__ -->. " +
          "CSS (.css): /* __LC_TASK_<id>_START__ */ and /* __LC_TASK_<id>_END__ */. " +
          "JS/TS (.js/.ts/.jsx/.tsx/.mjs/.cjs): // __LC_TASK_<id>_START__ and // __LC_TASK_<id>_END__ (or /* ... */). " +
          "Python (.py): # __LC_TASK_<id>_START__ and # __LC_TASK_<id>_END__. " +
          "Each marker MUST be on its own line and contain ONLY the token (plus comment delimiters). " +
          "(5c) The placeholder content BETWEEN START and END MUST be incomplete/incorrect compared to solution (i.e., not equal to the solution). The scaffold must require student edits to become fully working. " +
          // ---- end inserted ----
          "(6) 'hint' should guide the student without revealing the solution. " +
          "(7) 'explanation' should briefly explain what the solution does and why it is correct. " +
          "(8) exercisesMd must reference the entire project, explicitly refer to task IDs, and include a section titled 'Comprehension Questions'. " +
          "In that section, include at least 5 questions, EACH tagged with a stable identifier like [CQ1], [CQ2], ... (include the tag literally in the question line). " +
          "(9) answerKeyMd must be an INSTRUCTOR KEY that includes: (a) each task with its id, path, solution, and explanation; and (b) a section titled 'Comprehension Answers' that answers EVERY comprehension question. " +
          "Each answer MUST repeat the same tag, e.g. '[CQ1] ...answer...'. " +
          "(10) Do NOT remove import statements, package declarations, or file-level boilerplate unless pedagogically critical." +
          "Input files (JSON array): " +
          JSON.stringify(filePayload);

        reportActivity(progress, output, startedAt, "Step 1/3: Asking Copilot to generate learning tasks…", "Step 1/3: Waiting for Copilot");

        const res = await runCopilotPrompt(
          copilotPath,
          copilotArgs,
          storageDir,
          scaffoldPrompt,
          configDir,
          logDir,
          output,
          envOverride,
          "Learning task generation"
        );

        const stderr = res.stderr.trim();
        const stdout = res.stdout.trim();

        if (res.exitCode !== 0) {
          throw new Error(stderr || `Copilot scaffold generation failed (exit ${res.exitCode}).`);
        }
        if (!stdout) {
          throw new Error("Copilot scaffold generation returned empty stdout.");
        }

        reportActivity(progress, output, startedAt, "Step 2/3: Parsing learning task response…", "Step 2/3: Parsing response");
        const parsed = parseScaffoldPlan(stdout);
        
        reportActivity(progress, output, startedAt, "Step 2/3: Validating learning task output…", "Step 2/3: Validating output");
        const issues = validateScaffoldPlan(parsed);
  
        if (issues.length > 0) {
          reportActivity(progress, output, startedAt, `Step 3/3: Repairing learning task output (${issues.length} issue${issues.length === 1 ? "" : "s"})…`, "Step 3/3: Repairing output");
          output.appendLine("\n--- Scaffold validation issues detected; attempting one repair pass ---");
          output.appendLine(formatScaffoldIssuesForPrompt(issues));

          // Ask Copilot to repair only the scaffold output (maskedFiles/tasks/exercises/answerKey) given the same input files.
          const repairPrompt =
            "Return JSON only. No prose. No markdown, unless the entire response is a single ```json fenced block. " +
            "You previously produced an invalid learning scaffold. Fix it. " +
            "Output schema MUST remain: {\"maskedFiles\":[{\"path\":string,\"content\":string}],\"tasks\":[{\"id\":string,\"path\":string,\"solution\":string,\"hint\":string?,\"explanation\":string?}],\"exercisesMd\":string,\"answerKeyMd\":string?,\"notes\":string?}. " +
            "Fix ALL of these validation issues:\n" +
            formatScaffoldIssuesForPrompt(issues) +
            "\n\nRules to follow: " +
            "- Use correct per-file comment syntax for marker lines (HTML uses <!-- -->, CSS uses /* */, JS uses // or /* */, etc.). " +
            "- Markers must be on their own lines and contain only the token + comment delimiters. " +
            "- Placeholder between markers must NOT equal the solution; it must be incomplete so the student must edit. " +
            "- maskedFiles may only include input paths. " +
            "- exercisesMd must include comprehension questions tagged [CQ1].. and answerKeyMd must include a 'Comprehension Answers' section with matching tags. " +
            "Input files (JSON array): " +
            JSON.stringify(filePayload);
          
          reportActivity(progress, output, startedAt, "Step 3/3: Asking Copilot for a repair pass…", "Step 3/3: Waiting for repair");
          const repairRes = await runCopilotPrompt(
            copilotPath,
            copilotArgs,
            storageDir,
            repairPrompt,
            configDir,
            logDir,
            output,
            envOverride,
            "Learning task repair"
          );

          const repairStdout = repairRes.stdout.trim();
          if (repairRes.exitCode !== 0) {
            throw new Error(repairRes.stderr.trim() || `Copilot scaffold repair failed (exit ${repairRes.exitCode}).`);
          }
          if (!repairStdout) {
            throw new Error("Copilot scaffold repair returned empty stdout.");
          }

          const repaired = parseScaffoldPlan(repairStdout);
          reportActivity(progress, output, startedAt, "Step 3/3: Validating repaired learning task output…", "Step 3/3: Validating repair");
          const issues2 = validateScaffoldPlan(repaired);
          if (issues2.length > 0) {
            output.appendLine("\n--- Scaffold repair still has issues (returning repaired output anyway). ---");
            output.appendLine(formatScaffoldIssuesForPrompt(issues2));
            setBusyStatus(null);
            return repaired;
          }

          setBusyStatus(null);
          output.appendLine(`[workflow ${formatElapsedMs(Date.now() - startedAt)}] Learning task repair succeeded.`);
          output.appendLine("\n--- Scaffold repair succeeded. ---");
          return repaired;
        }
        setBusyStatus(null);
        output.appendLine(`[workflow ${formatElapsedMs(Date.now() - startedAt)}] Learning task generation complete.`);
        return parsed;
      } catch (err) {
        setBusyStatus(null);
        throw err;
      } finally {
        try { if (hb) { clearInterval(hb); } } catch {}
        setBusyStatus(null);
      }
    }
  );      
}

async function generateLearningScaffoldFocused(
  focusFiles: FocusFileWithDiff[],
  contextFiles: ScaffoldContextFile[],
  storageDir: string,
  copilotPath: string,
  copilotArgs: string[],
  configDir: string,
  logDir: string,
  output: vscode.OutputChannel,
  envOverride?: NodeJS.ProcessEnv
): Promise<ScaffoldPlan> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Learning Copilot: Step 4 of 5 - Generate learning tasks",
      cancellable: false,
    },
    async (progress) => {
      let hb: NodeJS.Timeout | undefined;
      let hbTick = 0;
      const startedAt = Date.now();
      try {
        reportActivity(progress, output, startedAt, "Step 4/5: Preparing focused learning task prompt…", "Step 4/5: Preparing prompt");

        // Ensure the user can see logs during long scaffold runs.
        output.show(true);

        // Heartbeat: keep progress UI visibly updating during long waits.
        hbTick = 0;
        hb = setInterval(() => {
          hbTick++;
          if (hbTick % 3 === 0) {
            reportActivity(progress, output, startedAt, "Step 4/5: Still generating focused learning tasks…", "Step 4/5: Generating tasks", 1);
          } else {
            progress.report({ increment: 1 });
          }
        }, 5000);

        const MAX_CHARS_PER_FILE = 12000;

        const focusPayload = focusFiles.map((f) => ({
          path: f.rel,
          changedRanges: f.changedRanges,
          changedRangesHuman: formatRangesForPrompt(f.changedRanges),
          content:
            f.fullContent.length > MAX_CHARS_PER_FILE
              ? f.fullContent.slice(0, MAX_CHARS_PER_FILE) + "\n\n/* TRUNCATED */\n"
              : f.fullContent,
          oldContent:
            f.oldContent.length > MAX_CHARS_PER_FILE
              ? f.oldContent.slice(0, MAX_CHARS_PER_FILE) + "\n\n/* TRUNCATED */\n"
              : f.oldContent,
        }));

        const contextPayload = contextFiles.map((f) => ({
          path: f.path,
          content:
            f.content.length > MAX_CHARS_PER_FILE
              ? f.content.slice(0, MAX_CHARS_PER_FILE) + "\n\n/* TRUNCATED */\n"
              : f.content,
        }));
        output.appendLine(
          `Focused task payload: ${focusPayload.length} changed file(s), ${contextPayload.length} context file(s), ${JSON.stringify(focusPayload).length + JSON.stringify(contextPayload).length} chars.`
        );

        const scaffoldPrompt =
          "Return JSON only. No prose. No markdown, unless the entire response is a single ```json fenced block. " +
          "You are a teaching assistant. Create a LEARNING SCAFFOLD focused ONLY on the NEW or MODIFIED functionality. " +
          "You will be given (A) focusFiles: the files that were created/changed, and (B) contextFiles: the broader workspace for reference. " +
          "Output schema: " +
          "{\"maskedFiles\":[{\"path\":string,\"content\":string}]," +
          "\"tasks\":[{\"id\":string,\"path\":string,\"solution\":string,\"hint\":string?,\"explanation\":string?}]," +
          "\"exercisesMd\":string,\"answerKeyMd\":string?,\"notes\":string?}. " +
          "STRICT RULES: " +
          "(1) maskedFiles MUST include ONLY files listed in focusFiles (same paths). Do NOT include other files in maskedFiles. " +
          "(2) Tasks MUST appear ONLY in focusFiles. Do NOT add tasks to other files. " +
          "(3) CRITICAL: Each focus file includes 'changedRanges' (line ranges in the NEW content). You MUST place task regions ONLY within these changedRanges. Do NOT place tasks outside changedRanges. " +
          "(4) Replace about 5–15% of IMPORTANT logic related to the new/modified functionality with task REGIONS that remain identifiable after the student edits. " +
          "Each task region MUST be wrapped by two exact tokens: __LC_TASK_<id>_START__ and __LC_TASK_<id>_END__. " +
          "The student-editable placeholder content must appear BETWEEN these two tokens. " +
          "Markers MUST appear on their own lines as standalone comments containing only the token (plus comment delimiters). Do not place marker tokens inline with code. " +
          "(5) Every task region MUST have a corresponding entry in the 'tasks' array. " +
          "(6) 'solution' must be ONLY the replacement code between markers (no tokens). " +
          "(7) COMMENT STYLE for marker lines must match file type (HTML uses <!-- -->, CSS uses /* */, JS uses // or /* */, Python uses #). " +
          "(8) Placeholder between markers MUST be incomplete/incorrect compared to solution. " +
          "(9) exercisesMd must focus on the new/modified functionality, reference task IDs, and include a section titled 'Comprehension Questions'. " +
          "In that section, include at least 5 questions, EACH tagged with a stable identifier like [CQ1], [CQ2], ... (include the tag literally in the question line). " +
          "(10) answerKeyMd must include: (a) each task (id/path/solution/explanation) and (b) a section titled 'Comprehension Answers' that answers EVERY comprehension question. " +
          "Each answer MUST repeat the same tag, e.g. '[CQ1] ...answer...'. " +
          "(11) IMPORTANT: If changedRanges is empty for a file, do not place tasks in that file. " +
          "Focus files (JSON array): " +
          JSON.stringify(focusPayload) +
          "\n\nContext files (JSON array): " +
          JSON.stringify(contextPayload);

        reportActivity(progress, output, startedAt, "Step 4/5: Asking Copilot to generate focused learning tasks…", "Step 4/5: Waiting for Copilot");

        const res = await runCopilotPrompt(
          copilotPath,
          copilotArgs,
          storageDir,
          scaffoldPrompt,
          configDir,
          logDir,
          output,
          envOverride,
          "Focused learning task generation"
        );

        const stderr = res.stderr.trim();
        const stdout = res.stdout.trim();

        if (res.exitCode !== 0) {
          setBusyStatus(null);
          throw new Error(stderr || `Copilot scaffold generation failed (exit ${res.exitCode}).`);
        }
        if (!stdout) {
          setBusyStatus(null);
          throw new Error("Copilot scaffold generation returned empty stdout.");
        }

        reportActivity(progress, output, startedAt, "Step 4/5: Parsing focused learning task response…", "Step 4/5: Parsing response");
        const parsed = parseScaffoldPlan(stdout);
        reportActivity(progress, output, startedAt, "Step 4/5: Validating focused learning task output…", "Step 4/5: Validating output");
        const issues = validateScaffoldPlan(parsed);

        // Additional focused validation: task regions must start within changedRanges.
        const byRel = new Map<string, FocusFileWithDiff>();
        for (const f of focusFiles) { byRel.set(normalizeRelativePath(f.rel), f); }

        for (const mf of parsed.maskedFiles) {
          let rel: string;
          try { rel = normalizeRelativePath(mf.path); } catch { continue; }

          const meta = byRel.get(rel);
          if (!meta) {continue;}

          const regions = listTaskRegions(mf.content);
          for (const r of regions) {
            const startLine = getRegionStartLine(mf.content, r.startTokenStart);
            if (!isLineWithinRanges(startLine, meta.changedRanges)) {
              issues.push({
                kind: "taskAlreadySolved" as any, // reuse an issue kind to force repair
                file: rel,
                id: r.id,
                detail: `Task ${r.id} starts at line ${startLine} in ${rel}, OUTSIDE changedRanges ${formatRangesForPrompt(meta.changedRanges)}. Move tasks inside changedRanges only.`,
              });
            }
          }
        }

        if (issues.length > 0) {
          reportActivity(progress, output, startedAt, `Step 4/5: Repairing focused learning tasks (${issues.length} issue${issues.length === 1 ? "" : "s"})…`, "Step 4/5: Repairing output");
          output.appendLine("\n--- Focused scaffold validation issues detected; attempting one repair pass ---");
          output.appendLine(formatScaffoldIssuesForPrompt(issues));

          const repairPrompt =
            "Return JSON only. No prose. No markdown, unless the entire response is a single ```json fenced block. " +
            "You previously produced an invalid focused learning scaffold. Fix it. " +
            "Output schema MUST remain: {\"maskedFiles\":[{\"path\":string,\"content\":string}],\"tasks\":[{\"id\":string,\"path\":string,\"solution\":string,\"hint\":string?,\"explanation\":string?}],\"exercisesMd\":string,\"answerKeyMd\":string?,\"notes\":string?}. " +
            "Fix ALL of these validation issues:\n" +
            formatScaffoldIssuesForPrompt(issues) +
            "\n\nRules: maskedFiles/tasks must stay restricted to focusFiles. Use correct marker comment style. Placeholder must differ from solution. " +
            "- exercisesMd must include comprehension questions tagged [CQ1].. and answerKeyMd must include a 'Comprehension Answers' section with matching tags. " +
            "Focus files (JSON array): " +
            JSON.stringify(focusPayload) +
            "\n\nContext files (JSON array): " +
            JSON.stringify(contextPayload);

          reportActivity(progress, output, startedAt, "Step 4/5: Asking Copilot for a focused repair pass…", "Step 4/5: Waiting for repair");
          const repairRes = await runCopilotPrompt(
            copilotPath,
            copilotArgs,
            storageDir,
            repairPrompt,
            configDir,
            logDir,
            output,
            envOverride,
            "Focused learning task repair"
          );

          const repairStdout = repairRes.stdout.trim();
          if (repairRes.exitCode !== 0) {
            setBusyStatus(null);
            throw new Error(repairRes.stderr.trim() || `Copilot scaffold repair failed (exit ${repairRes.exitCode}).`);
          }
          if (!repairStdout) {
            setBusyStatus(null);
            throw new Error("Copilot scaffold repair returned empty stdout.");
          }

          const repaired = parseScaffoldPlan(repairStdout);
          reportActivity(progress, output, startedAt, "Step 4/5: Validating repaired focused learning tasks…", "Step 4/5: Validating repair");
          const issues2 = validateScaffoldPlan(repaired);
          if (issues2.length > 0) {
            output.appendLine("\n--- Focused scaffold repair still has issues (returning repaired output anyway). ---");
            output.appendLine(formatScaffoldIssuesForPrompt(issues2));
            setBusyStatus(null);
            return repaired;
          }

          setBusyStatus(null);
          output.appendLine(`[workflow ${formatElapsedMs(Date.now() - startedAt)}] Focused learning task repair succeeded.`);
          output.appendLine("\n--- Focused scaffold repair succeeded. ---");
          return repaired;
        }
        setBusyStatus(null);
        output.appendLine(`[workflow ${formatElapsedMs(Date.now() - startedAt)}] Focused learning task generation complete.`);
        return parsed;
      } finally {
        try { if (hb) { clearInterval(hb); } } catch {}
        setBusyStatus(null);
      }
    }
  );
}

/**
 * Activates the extension and registers all commands.
 *
 * @param context VS Code extension context.
 */
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Learning Copilot");
  context.subscriptions.push(output);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "workbench.action.output.toggleOutput";
  statusBar.text = "$(check) Learning Copilot";
  statusBar.tooltip = "Learning Copilot";
  statusBar.hide();
  context.subscriptions.push(statusBar);

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

  // Save Last Output
  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.saveLastOutput", async () => {
      if (!lastOutput) {
        vscode.window.showWarningMessage("No output to save yet. Generate an exercise first.");
        return;
      }
      
      const uri = await pickSaveUri(context);
      const bytes = Buffer.from(lastOutput + "\n", "utf8");
      await vscode.workspace.fs.writeFile(uri, bytes);
      
      // Open the saved file
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      
      vscode.window.showInformationMessage(`Saved: ${path.basename(uri.fsPath)}`);
    })
  );

  
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


  // Generate Code Files from Prompt
  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.generateCodeFilesPrompt", async () => {
      const wsRoot = getWorkspaceRootUri();
      if (!wsRoot) {
        vscode.window.showErrorMessage("Open a folder/workspace first.");
        return;
      }

      const { copilotArgs } = getConfig();
      const storageDir = await ensureStorageDir(context);
      const logDir = getCopilotLogDir(storageDir);
      const configDir = getCopilotConfigDir(storageDir);
      await fsp.mkdir(logDir, { recursive: true });
      await fsp.mkdir(configDir, { recursive: true });

      const userPrompt = await vscode.window.showInputBox({
        title: "Learning Copilot: Generate code files",
        placeHolder: "e.g., Create a simple web app with a button and slider using vanilla HTML/CSS/JS.",
      });
      if (!userPrompt) { return; }

      const status = await getInstalledCopilotStatus();
      if (status.kind === "legacy") {
        vscode.window.showErrorMessage(
          "Learning Copilot is configured to use the deprecated gh-copilot binary. Run 'Learning Copilot: Install/Setup Copilot CLI' again, then 'Login to Copilot CLI'."
        );
        return;
      }
      if (status.kind === "missing") {
        vscode.window.showErrorMessage(
          "Copilot CLI is not installed or not found. Run 'Learning Copilot: Install/Setup Copilot CLI' first."
        );
        return;
      }
      const activeCopilotPath = status.path;

      const planPrompt =
        "Return JSON only. No prose. No markdown, unless the entire response is a single ```json fenced block. " +
        'Schema: {"files":[{"path":string,"content":string,"overwrite":boolean?}],"notes":string?}. ' +
        "All paths must be relative to the workspace root and must not contain '..' or start with '/'. " +
        "Prefer best practice separation of concerns. " +
        "Task: " + userPrompt;

      output.show(true);

      const res = await runCopilotPrompt(
        activeCopilotPath,
        copilotArgs,
        storageDir,
        planPrompt,
        configDir,
        logDir,
        output,
        undefined,
        "Generate code files plan"
      );

      const stderr = res.stderr.trim();
      const stdout = res.stdout.trim();

      const writtenFiles: WrittenFile[] = [];

      if (res.exitCode !== 0) {
        if (stderr.toLowerCase().includes("no authentication information found")) {
          const choice = await vscode.window.showErrorMessage(
            "Copilot CLI is installed but not logged in. Open a terminal to run 'copilot login' now?",
            "Login",
            "Cancel"
          );
          if (choice === "Login") {
            await vscode.commands.executeCommand("learningCopilot.loginCopilotCli");
          }
          return;
        }
        vscode.window.showErrorMessage(`Copilot CLI failed (exit ${res.exitCode}). See Output for details.`);
        if (stderr) {
          output.appendLine("--- stderr ---");
          output.appendLine(stderr);
        }
        return;
      }

      // JSON-first. If Copilot returns empty/invalid JSON, fall back to importing CLI artifacts.
      let plan: { files: Array<{ path: string; content: string; overwrite?: boolean }>; notes?: string } | null = null;
      let planParseError: string | null = null;

      if (stdout) {
        try {
          plan = parseFilePlan(stdout);
        } catch (e: any) {
          planParseError = e?.message ?? String(e);
        }
      } else {
        planParseError = "Copilot returned empty stdout.";
      }

      if (!plan || !Array.isArray(plan.files) || plan.files.length === 0) {
        // Try artifacts fallback.
        const filesDir = await findNewestArtifactFilesDir(configDir);
        if (!filesDir) {
          vscode.window.showErrorMessage(
            planParseError
              ? `Could not parse JSON plan (${planParseError}) and no Copilot artifacts were found.`
              : "No JSON plan files were returned and no Copilot artifacts were found."
          );
          if (stdout) {
            output.appendLine("--- raw stdout ---");
            output.appendLine(stdout);
          }
          return;
        }

        const artifacts = await listFilesRecursive(filesDir);
        if (!artifacts.length) {
          vscode.window.showErrorMessage(
            planParseError
              ? `Could not parse JSON plan (${planParseError}) and Copilot artifacts folder was empty.`
              : "No JSON plan files were returned and Copilot artifacts folder was empty."
          );
          if (stdout) {
            output.appendLine("--- raw stdout ---");
            output.appendLine(stdout);
          }
          return;
        }

        const names = artifacts.slice(0, 8).map((a) => a.rel).join(", ");
        const more = artifacts.length > 8 ? ` (+${artifacts.length - 8} more)` : "";
        const choice = await vscode.window.showInformationMessage(
          `Copilot produced file artifacts (${artifacts.length}): ${names}${more}. Import into the workspace?`,
          { modal: true },
          "Import",
          "Cancel"
        );
        if (choice !== "Import") {
          vscode.window.showInformationMessage("Learning Copilot: Import cancelled.");
          return;
        }

        const imported = await importArtifactsIntoWorkspace(wsRoot, artifacts);
        writtenFiles.push(...imported);
        vscode.window.showInformationMessage("Learning Copilot: Artifact import complete.");
        // Continue to scaffold step below.
      }

      if (plan?.notes) {
        output.appendLine("--- notes ---");
        output.appendLine(plan.notes);
      }

      if (plan) {
        for (const f of plan.files) {
          let rel: string;
          try {
            rel = normalizeRelativePath(f.path);
          } catch (e: any) {
            vscode.window.showErrorMessage(e?.message ?? String(e));
            continue;
          }

          const targetUri = vscode.Uri.joinPath(wsRoot, ...rel.split("/"));
          const exists = await vscode.workspace.fs.stat(targetUri).then(() => true, () => false);

          const proposedKey = `proposed/${rel}`;
          proposedContent.set(proposedKey, f.content);
          const proposedUri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${proposedKey}`);

          const title = exists ? `Write ${rel} (overwrite existing?)` : `Write ${rel} (create?)`;

          // loop to allow repeated preview
          while (true) {
            const pick = await vscode.window.showInformationMessage(
              title,
              { modal: true },
              "Preview",
              exists ? "Overwrite" : "Create",
              "Skip"
            );

            if (!pick || pick === "Skip") { break; }

            if (pick === "Preview") {
              if (exists) {
                await vscode.commands.executeCommand("vscode.diff", targetUri, proposedUri, `Learning Copilot: ${rel}`);
              } else {
                const emptyKey = `empty/${rel}`;
                proposedContent.set(emptyKey, "");
                const emptyUri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${emptyKey}`);
                await vscode.commands.executeCommand("vscode.diff", emptyUri, proposedUri, `Learning Copilot: ${rel}`);
              }
              continue;
            }

            if (pick === "Overwrite" || pick === "Create") {
              try {
                await ensureDirForFile(targetUri);
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(f.content, "utf8"));
                writtenFiles.push({ rel, fullContent: f.content });
                vscode.window.showInformationMessage(`${exists ? "Updated" : "Created"}: ${rel}`);
              } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to write ${rel}: ${e?.message ?? String(e)}`);
              }
              break;
            }
          }
        }
      }

      vscode.window.showInformationMessage("Learning Copilot: File generation complete.");

      if (writtenFiles.length === 0) {
        // User skipped everything.
        return;
      }

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
        snapshotDir = await saveSolutionSnapshot(storageDir, writtenFiles);
        await context.globalState.update("learningCopilot.lastSnapshotDir", snapshotDir);
      } catch (e: any) {
        output.appendLine(`Failed to save solution snapshot: ${e?.message ?? String(e)}`);
      }

      output.appendLine("\n=== Generating learning scaffold ===");

      let scaffold: ScaffoldPlan;
      try {
          scaffold = await generateLearningScaffold(
            writtenFiles,
            storageDir,
          activeCopilotPath,
          copilotArgs,
          configDir,
          logDir,
          output
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to generate learning tasks: ${e?.message ?? String(e)}`);
        return;
      }

      await context.globalState.update("learningCopilot.lastScaffoldTasks", scaffold.tasks);

      if (scaffold.notes) {
        output.appendLine("--- scaffold notes ---");
        output.appendLine(scaffold.notes);
      }

      // Apply masked files only to files we generated (auto-overwrite).
      const generatedSet = new Set(writtenFiles.map((w) => normalizeRelativePath(w.rel)));

      const maskedToApply = scaffold.maskedFiles
        .map((mf) => {
          try {
            return { rel: normalizeRelativePath(mf.path), content: mf.content };
          } catch {
            return null;
          }
        })
        .filter((x): x is { rel: string; content: string } => !!x && generatedSet.has(x.rel));

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Learning Copilot: Step 2 of 3 - Apply learning tasks to ${maskedToApply.length} file(s)`,
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
        buildTaskJumpLinks(wsRoot, scaffold)
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

      if (snapshotDir) {
        vscode.window.showInformationMessage(`Full solution snapshot saved to extension storage: ${snapshotDir}`);
      }

      vscode.window.showInformationMessage("Learning Copilot: Scaffold generation complete.");
    })
  );

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
          "No solution snapshot available yet. Run ‘Learning Copilot: Generate Code Files from Prompt’ and generate learning tasks first."
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

      // const range = getEditableRangeForRegion(editor.document, hit);
      
      const task = getTaskById(context, rel, hit.id);
      if (!task) { return vscode.window.showErrorMessage(`No stored solution mapping for task id: ${hit.id}`); }

      // Ensure the END marker stays on its own line.
      // Our replacement range ends at the start of the END marker line, so if the inserted
      // solution doesn't end with a newline, the END marker would end up on the same line.
      const insert = task.solution.endsWith("\n") ? task.solution : task.solution + "\n";
      // await editor.edit((eb) => eb.replace(range, insert));
      
      await applySolutionForRegion(editor, editor.document, hit, insert, true);
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
   
      //await editor.edit((eb) => eb.replace(range, insert));
      await applySolutionForRegion(editor, editor.document, next, insert, true);

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
        "Mark Done",
        "Cancel"
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

      // Optional: remove this task from stored mapping so it’s not offered anymore
      const all = context.globalState.get<ScaffoldTask[]>("learningCopilot.lastScaffoldTasks") ?? [];
      const filtered = all.filter((b) => !(normalizeRelativePath(b.path) === rel && b.id === hit.id));
      await context.globalState.update("learningCopilot.lastScaffoldTasks", filtered);

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

   // Modify / extend existing workspace from prompt (uses workspace context)
  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.modifyWorkspaceFromPrompt", async () => {
      const wsRoot = getWorkspaceRootUri();
      if (!wsRoot) {
        vscode.window.showErrorMessage("Open a folder/workspace first.");
        return;
      }

      const { copilotArgs } = getConfig();
      const storageDir = await ensureStorageDir(context);
      const logDir = getCopilotLogDir(storageDir);
      const configDir = getCopilotConfigDir(storageDir);
      await fsp.mkdir(logDir, { recursive: true });
      await fsp.mkdir(configDir, { recursive: true });

      const userPrompt = await vscode.window.showInputBox({
        title: "Learning Copilot: Modify workspace",
        placeHolder: "e.g., Add a dark mode toggle; add form validation; refactor into modules; add an API route; etc.",
      });
      if (!userPrompt) {return;}

      output.show(true);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Learning Copilot: Modify workspace and create learning tasks",
          cancellable: false,
        },
        async (progress) => {
          const modifyStartedAt = Date.now();

          reportActivity(progress, output, modifyStartedAt, "Step 1/5: Restoring solved workspace from existing tasks…", "Step 1/5: Restoring solved workspace");
          const restoreResult = await restoreAllTasksInWorkspace(context, wsRoot);
          if (restoreResult.missingMappings.length > 0) {
            vscode.window.showErrorMessage(
              `Could not restore some task regions before modifying the workspace: ${restoreResult.missingMappings.join(" | ")}`
            );
            setBusyStatus(null);
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

          const status = await getInstalledCopilotStatus();
          if (status.kind === "legacy") {
            vscode.window.showErrorMessage(
              "Learning Copilot is configured to use the deprecated gh-copilot binary. Run 'Learning Copilot: Install/Setup Copilot CLI' again, then 'Login to Copilot CLI'."
            );
            setBusyStatus(null);
            return;
          }
          if (status.kind === "missing") {
            vscode.window.showErrorMessage(
              "Copilot CLI is not installed or not found. Run 'Learning Copilot: Install/Setup Copilot CLI' first."
            );
            setBusyStatus(null);
            return;
          }
          const activeCopilotPath = status.path;

          const planPrompt =
            "Return JSON only. No prose. No markdown, unless the entire response is a single ```json fenced block. " +
            'Schema: {"files":[{"path":string,"content":string,"overwrite":boolean?}],"notes":string?}. ' +
            "You are modifying an EXISTING codebase. Use the provided workspace files as context. " +
            "Only include files that need to be created or changed. Do not include unchanged files. " +
            "All paths must be relative to the workspace root and must not contain '..' or start with '/'. " +
            "If you need a new file, add it. If you modify a file, output its FULL new content. " +
            "Avoid large dependencies; prefer small, direct changes. " +
            (activeRel ? `The user's active file is: ${activeRel}. ` : "") +
            "Workspace files (JSON array of {path,content}): " +
            JSON.stringify(ctxFiles) +
            "\n\nTask: " +
            userPrompt;

          reportActivity(progress, output, modifyStartedAt, "Step 3/5: Asking Copilot to plan workspace changes…", "Step 3/5: Planning changes");
      const res = await runCopilotPrompt(
        activeCopilotPath,
        copilotArgs,
        storageDir,
        planPrompt,
        configDir,
        logDir,
        output,
        undefined,
        "Modify workspace plan"
      );

          const stderr = res.stderr.trim();
          const stdout = res.stdout.trim();

          if (res.exitCode !== 0) {
            if (stderr.toLowerCase().includes("no authentication information found")) {
              const choice = await vscode.window.showErrorMessage(
                "Copilot CLI is installed but not logged in. Open a terminal to run 'copilot login' now?",
                "Login",
                "Cancel"
              );
              if (choice === "Login") {
                await vscode.commands.executeCommand("learningCopilot.loginCopilotCli");
              }
              setBusyStatus(null);
              return;
            }
            vscode.window.showErrorMessage(`Copilot CLI failed (exit ${res.exitCode}). See Output for details.`);
            if (stderr) {
              output.appendLine("--- stderr ---");
              output.appendLine(stderr);
            }
            setBusyStatus(null);
            return;
          }

          if (!stdout) {
            vscode.window.showErrorMessage("Copilot returned empty stdout.");
            setBusyStatus(null);
            return;
          }

          let plan: { files: Array<{ path: string; content: string; overwrite?: boolean }>; notes?: string };
          try {
            plan = parseFilePlan(stdout);
          } catch (e: any) {
            output.appendLine("--- raw stdout ---");
            output.appendLine(stdout);
            vscode.window.showErrorMessage(e?.message ?? String(e));
            setBusyStatus(null);
            return;
          }
          reportActivity(progress, output, modifyStartedAt, "Step 3/5: Workspace change plan ready for review.", "Step 3/5: Reviewing plan");
          setBusyStatus(null);

          if (plan.notes) {
            output.appendLine("--- notes ---");
            output.appendLine(plan.notes);
          }

          if (!plan.files?.length) {
            vscode.window.showInformationMessage("Copilot did not propose any file changes.");
            setBusyStatus(null);
            return;
          }

          const writtenFiles: WrittenFile[] = [];
          const oldContentByRel = new Map<string, string>();

          for (const f of plan.files) {
            let rel: string;
            try {
              rel = normalizeRelativePath(f.path);
            } catch (e: any) {
              vscode.window.showErrorMessage(e?.message ?? String(e));
              continue;
            }

            const targetUri = vscode.Uri.joinPath(wsRoot, ...rel.split("/"));
            const exists = await vscode.workspace.fs.stat(targetUri).then(() => true, () => false);

            const proposedKey = `proposed/${rel}`;
            proposedContent.set(proposedKey, f.content);
            const proposedUri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${proposedKey}`);

            const title = exists ? `Apply change: ${rel} (overwrite existing?)` : `Apply change: ${rel} (create?)`;

            while (true) {
              const pick = await vscode.window.showInformationMessage(
                title,
                { modal: true },
                "Preview",
                exists ? "Overwrite" : "Create",
                "Skip"
              );

              if (!pick || pick === "Skip") {break;}

              if (pick === "Preview") {
                if (exists) {
                  await vscode.commands.executeCommand("vscode.diff", targetUri, proposedUri, `Proposed change: ${rel}`);
                } else {
                  const emptyKey = `empty/${rel}`;
                  proposedContent.set(emptyKey, "");
                  const emptyUri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${emptyKey}`);
                  await vscode.commands.executeCommand("vscode.diff", emptyUri, proposedUri, `Proposed new file: ${rel}`);
                }
                continue;
              }

              if (pick === "Overwrite" || pick === "Create") {
                // make note of the old content before overwriting, so we can use it as context for focused scaffold generation later
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
                
                // now overwrite (or create) the file with the new content
                await ensureDirForFile(targetUri);
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(f.content, "utf8"));
                writtenFiles.push({ rel, fullContent: f.content });
                vscode.window.showInformationMessage(`${exists ? "Updated" : "Created"}: ${rel}`);
                break;
              }
            }
          }

          if (!writtenFiles.length) {
            vscode.window.showInformationMessage("No changes applied.");
            setBusyStatus(null);
            return;
          }

          vscode.window.showInformationMessage(`Applied ${writtenFiles.length} change(s).`);

          const doScaffold = await vscode.window.showInformationMessage(
            `Generate learning tasks and exercises for the ${writtenFiles.length} changed file(s)?`,
            { modal: true },
            "Generate",
            "Skip"
          );
          if (doScaffold !== "Generate") {
            setBusyStatus(null);
            return;
          }

          reportActivity(progress, output, modifyStartedAt, "Step 4/5: Preparing learning tasks for changed files…", "Step 4/5: Preparing tasks");
          // Save full solution snapshot of the changed files (private)
          let snapshotDir: string | null = null;
          try {
            snapshotDir = await saveSolutionSnapshot(storageDir, writtenFiles);
            await context.globalState.update("learningCopilot.lastSnapshotDir", snapshotDir);
          } catch (e: any) {
            output.appendLine(`Failed to save solution snapshot: ${e?.message ?? String(e)}`);
          }

          output.appendLine("\n=== Generating learning scaffold (focused on new/changed functionality) ===");

          let scaffold: ScaffoldPlan;

          // get a handle on the changed files with their old content, so we can prompt for a focused scaffold generation that only tasks out the new/changed lines instead of the entire file    
          const focusWithDiff: FocusFileWithDiff[] = writtenFiles.map((wf) => {
            const rel = normalizeRelativePath(wf.rel);
            const oldContent = oldContentByRel.get(rel) ?? "";
            return {
              rel,
              fullContent: wf.fullContent,
              oldContent,
              changedRanges: computeChangedRangesByPrefixSuffix(oldContent, wf.fullContent),
            };
          });

          const scaffoldContext = selectFocusedTaskContext(
            focusWithDiff,
            buildScaffoldContextFromWorkspaceSnapshot(ctxFiles, writtenFiles, output),
            output
          );
          
          try {
            scaffold = await generateLearningScaffoldFocused(
              focusWithDiff,
              scaffoldContext,
              storageDir,
              activeCopilotPath,
              copilotArgs,
              configDir,
              logDir,
              output
            );
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to generate learning tasks: ${e?.message ?? String(e)}`);
            setBusyStatus(null);
            return;
          }

          await context.globalState.update("learningCopilot.lastScaffoldTasks", scaffold.tasks);

          // Apply masked files only to the files we just changed (auto-overwrite)
          const changedSet = new Set(writtenFiles.map((w) => normalizeRelativePath(w.rel)));
          const maskedToApply = scaffold.maskedFiles
            .map((mf) => {
              try {
                return { rel: normalizeRelativePath(mf.path), content: mf.content };
              } catch {
                return null;
              }
            })
            .filter((x): x is { rel: string; content: string } => !!x && changedSet.has(x.rel));

          reportActivity(progress, output, modifyStartedAt, `Step 5/5: Applying learning tasks to ${maskedToApply.length} file(s)…`, "Step 5/5: Applying tasks");
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Learning Copilot: Step 5 of 5 - Apply learning tasks to ${maskedToApply.length} file(s)`,
              cancellable: false,
            },
            async () => {
              for (const mf of maskedToApply) {
                const targetUri = vscode.Uri.joinPath(wsRoot, ...mf.rel.split("/"));
                await ensureDirForFile(targetUri);
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(mf.content, "utf8"));
              }
            }
          );

          const exercisesWithLinks = prependTaskLinksSection(
            scaffold.exercisesMd,
            buildTaskJumpLinks(wsRoot, scaffold)
          );
          await writeWorkspaceMarkdownWithPrompt(wsRoot, "LEARNING_EXERCISES.md", exercisesWithLinks, "Learning tasks");

          if (scaffold.answerKeyMd) {
            try {
              const ts = new Date().toISOString().replace(/[:.]/g, "-");
              const keyDir = path.join(storageDir, "answer-keys");
              await fsp.mkdir(keyDir, { recursive: true });
              const keyPath = path.join(keyDir, `answer-key-${ts}.md`);
              await fsp.writeFile(keyPath, scaffold.answerKeyMd, "utf8");
              await context.globalState.update("learningCopilot.lastAnswerKeyPath", keyPath);
              vscode.window.showInformationMessage(`Instructor answer key saved to extension storage: ${keyPath}`);
            } catch (e: any) {
              output.appendLine(`Failed to save answer key: ${e?.message ?? String(e)}`);
            }
          }

          if (snapshotDir) {
            vscode.window.showInformationMessage(`Solution snapshot saved to extension storage: ${snapshotDir}`);
          }

          setBusyStatus(null);
          vscode.window.showInformationMessage("Learning Copilot: Workspace modification learning tasks complete.");
        }
      );
 })
  );


}
/**
 * Deactivates the extension.
 */
export function deactivate() {}
//#endregion

 
