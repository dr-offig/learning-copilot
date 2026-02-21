import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as https from "node:https";
import * as path from "node:path";

let lastOutput: string | null = null;

const proposedContent = new Map<string, string>();
const PROPOSED_SCHEME = "learning-copilot";
const SOLUTION_SCHEME = "learning-copilot-solution";

type WrittenFile = { rel: string; fullContent: string };

type ScaffoldPlan = {
  maskedFiles: Array<{ path: string; content: string }>;
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

/**
 * Resolves the currently configured Copilot CLI executable path.
 */
function getConfiguredCopilotPath(): string {
  const { copilotPath } = getConfig();
  return copilotPath;
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
 * Opens a terminal and starts Copilot CLI, then triggers `/login`.
 *
 * @param storageDir Extension storage directory.
 */
async function startCopilotLoginInTerminal(storageDir: string): Promise<void> {
  const copilotPath = getConfiguredCopilotPath();
  const configDir = getCopilotConfigDir(storageDir);
  const logDir = getCopilotLogDir(storageDir);
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });

  const terminal = vscode.window.createTerminal({
    name: "Learning Copilot: Copilot CLI",
  });
  terminal.show(true);

  const quoted = copilotPath.includes(" ") ? `\"${copilotPath}\"` : copilotPath;
  const cmd = `${quoted} --config-dir "${configDir}" --log-dir "${logDir}" --log-level debug`;
  terminal.sendText(cmd);
  setTimeout(() => {
    terminal.sendText("/login");
  }, 700);
}

type GithubRelease = {
  assets: Array<{ name: string; browser_download_url: string }>;
};

/**
 * Fetches JSON from HTTPS and parses it into the requested type.
 *
 * @param url URL that returns JSON.
 */
function httpsJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https
    .get(url, { headers: { "User-Agent": "learning-copilot" } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d.toString("utf8")));
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          resolve(JSON.parse(data) as T);
        } catch (e) {
          reject(e);
        }
      });
    })
    .on("error", reject);
  });
}

/**
 * Downloads a URL to a local file, following HTTP redirects.
 *
 * @param url Source URL.
 * @param filePath Destination file path.
 */
function downloadToFile(url: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "learning-copilot" } }, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(res.headers.location, filePath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        const code = res.statusCode ?? "unknown";
        res.resume();
        reject(new Error(`Download failed (${code}) for ${url}`));
        return;
      }
      const file = fs.createWriteStream(filePath);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", (err) => reject(err));
    });
    request.on("error", reject);
  });
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
  
  // Find latest release
  const rel = await httpsJson<GithubRelease>("https://api.github.com/repos/github/gh-copilot/releases/latest");
  const asset = rel.assets.find((a) => /windows/i.test(a.name) && /\.zip$/i.test(a.name));
  if (!asset) {
    throw new Error("Could not find a Windows .zip release asset for Copilot CLI.");
  }
  
  const zipPath = path.join(installRoot, asset.name);
  output.appendLine(`Downloading: ${asset.name}`);
  await downloadToFile(asset.browser_download_url, zipPath);
  
  const extractDir = path.join(installRoot, "extracted");
  await fsp.mkdir(extractDir, { recursive: true });
  
  // Use built-in PowerShell to expand the archive (works on locked-down Windows).
  const esc = (s: string) => s.replace(/'/g, "''");
  const ps = `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(extractDir)}' -Force`;
  output.appendLine(`> powershell -NoProfile -ExecutionPolicy Bypass -Command ${JSON.stringify(ps)}`);
  
  await runCommandStreaming(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
    installRoot,
    output
  );
  
  // Find copilot.exe
  const stack: string[] = [extractDir];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      }
      if (e.isFile() && e.name.toLowerCase() === "copilot.exe") {
        return full;
      }
    }
  }
  
  throw new Error("Install finished but copilot.exe was not found in the extracted folder.");
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

// Helper to get a GitHub access token from VS Code's built-in authentication.
/**
 * Requests a GitHub token from VS Code authentication.
 */
async function getVsCodeGitHubToken(): Promise<string | null> {
  try {
    // This will prompt the user to sign in to GitHub in VS Code if needed.
    const session = await vscode.authentication.getSession(
      "github",
      ["read:user"],
      { createIfNone: true }
    );
    return session?.accessToken ?? null;
  } catch {
    return null;
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
  envOverride?: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    // Copilot CLI's programmatic mode can emit TUI/extra metadata unless `-s` is used.
    // In an extension host (non-TTY), that can result in *no captured output*.
    // So we force `-s` ("silent": output only Copilot's response) unless the caller already set it.
    const hasSilent = args.includes("-s") || args.includes("--silent");
    const effectiveArgs = hasSilent ? args : [...args, "-s"];

    // If caller already provided --log-level/--log-dir/--disable-mcp-server/--config-dir, don't duplicate.
    const hasAny = (flag: string) => effectiveArgs.includes(flag);
    const withLogging = [...effectiveArgs];

    if (!hasAny("--log-level")) {
      withLogging.unshift("--log-level", "debug");
    }
    if (!hasAny("--log-dir")) {
      withLogging.unshift("--log-dir", logDir);
    }
    if (!hasAny("--disable-mcp-server")) {
      withLogging.unshift("--disable-mcp-server", "github-mcp-server");
    }
    if (!hasAny("--config-dir")) {
      withLogging.unshift("--config-dir", configDir);
    }

    const proc = spawn(copilotPath, [...withLogging, "-p", prompt], {
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
      resolve({ stdout, stderr, exitCode });
    });
    
    output.appendLine(`> ${copilotPath} ${[...withLogging, "-p", JSON.stringify(prompt)].join(" ")}`);
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

//#endregion

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

async function generateLearningScaffold(
  written: WrittenFile[],
  storageDir: string,
  copilotPath: string,
  copilotArgs: string[],
  configDir: string,
  logDir: string,
  output: vscode.OutputChannel,
  envOverride: NodeJS.ProcessEnv
): Promise<ScaffoldPlan> {
  // keep prompt size reasonable
  const MAX_CHARS_PER_FILE = 12000;
  const filePayload = written.map((f) => ({
    path: f.rel,
    content:
      f.fullContent.length > MAX_CHARS_PER_FILE
        ? f.fullContent.slice(0, MAX_CHARS_PER_FILE) + "\n\n/* TRUNCATED */\n"
        : f.fullContent,
  }));

  const scaffoldPrompt =
    "Return JSON only. No prose. No markdown, unless the entire response is a single ```json fenced block. " +
    "You are a teaching assistant. Given a COMPLETE working solution for a small programming project, create a LEARNING SCAFFOLD. " +
    "Output schema: {\"maskedFiles\":[{\"path\":string,\"content\":string}],\"exercisesMd\":string,\"answerKeyMd\":string?,\"notes\":string?}. " +
    "Rules: (1) maskedFiles must include only files listed in the input (same paths). " +
    "(2) Replace about 5–15% of key code with blanks/TODOs so the project is not fully working. " +
    "Use placeholders like '/* TODO: ... */', '// TODO: ...', or '__BLANK__'. " +
    "(3) exercisesMd must reference the whole project, list specific tasks to fill blanks, and include at least 5 comprehension questions. " +
    "(4) answerKeyMd should include the removed code fragments and brief explanations. " +
    "Input files (JSON array): " +
    JSON.stringify(filePayload);

  const res = await runCopilotPrompt(
    copilotPath,
    copilotArgs,
    storageDir,
    scaffoldPrompt,
    configDir,
    logDir,
    output,
    envOverride
  );

  const stderr = res.stderr.trim();
  const stdout = res.stdout.trim();

  if (res.exitCode !== 0) {
    throw new Error(stderr || `Copilot scaffold generation failed (exit ${res.exitCode}).`);
  }
  if (!stdout) {
    throw new Error("Copilot scaffold generation returned empty stdout.");
  }

  return parseScaffoldPlan(stdout);
}

/**
 * Activates the extension and registers all commands.
 *
 * @param context VS Code extension context.
 */
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Learning Copilot");
  context.subscriptions.push(output);

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

  // Generate Exercise from Prompt  
  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.generateExercisePrompt", async () => {
      const { copilotPath, copilotArgs } = getConfig();
      const storageDir = await ensureStorageDir(context);
      const logDir = path.join(storageDir, "copilot-logs");
      const configDir = path.join(storageDir, "copilot-config");
      await fsp.mkdir(logDir, { recursive: true });
      await fsp.mkdir(configDir, { recursive: true });

      const prompt = await vscode.window.showInputBox({
        title: "Learning Copilot: Exercise prompt",
        placeHolder: "e.g., Write a short programming exercise about recursion (no solution).",
      });
      if (!prompt) {return; }
      
      output.show(true);
      
      try {
        const token = await getVsCodeGitHubToken();
        const envOverride: NodeJS.ProcessEnv = token
          ? {
              COPILOT_GITHUB_TOKEN: token,
              GH_TOKEN: token,
              GITHUB_TOKEN: token,
            }
          : {};
        const res = await runCopilotPrompt(copilotPath, copilotArgs, storageDir, prompt, configDir, logDir, output, envOverride);
        
        const stderr = res.stderr.trim();
        const stdout = res.stdout.trim();
        
        // If Copilot CLI failed, handle it here (it doesn't throw).
        if (res.exitCode !== 0) {
          if (stderr.toLowerCase().includes("no authentication information found")) {
            const choice = await vscode.window.showErrorMessage(
              "Copilot CLI is installed but not logged in. Open a terminal to run /login now?",
              "Login",
              "Cancel"
            );
            if (choice === "Login") {
              await vscode.commands.executeCommand("learningCopilot.loginCopilotCli");
            }
            return;
          }
          if (
            stderr.toLowerCase().includes("failed to list models") ||
            stderr.toLowerCase().includes("failed to fetch models") ||
            stderr.toLowerCase().includes("fetch failed")
          ) {
            vscode.window.showErrorMessage(
              "Copilot CLI could not list models. This is usually an auth/token issue or a network/proxy/TLS issue inside Copilot CLI. " +
                "If you just signed into GitHub in VS Code, try the command again. Otherwise, open the Learning Copilot output and check the log tail."
            );
            return;
          }
          
          vscode.window.showErrorMessage(`Copilot CLI failed (exit ${res.exitCode}). See Output for details.`);
          if (stderr) {
            output.appendLine("--- stderr ---");
            output.appendLine(stderr);
          }
          return;
        }
        
        if (stderr) {
          output.appendLine("--- stderr ---");
          output.appendLine(stderr);
        }
        
        output.appendLine("--- stdout ---");
        output.appendLine(stdout);
        
        lastOutput = stdout || null;
        
        if (!lastOutput) {
          vscode.window.showWarningMessage("Copilot returned no output (stdout was empty).");
        } else {
          vscode.window.showInformationMessage(
            "Exercise generated. Use “Learning Copilot: Save Last Output” to save."
          );
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const lower = msg.toLowerCase();
        if (lower.includes("no authentication information found")) {
          const choice = await vscode.window.showErrorMessage(
            "Copilot CLI is installed but not logged in. Open a terminal to run /login now?",
            "Login",
            "Cancel"
          );
          if (choice === "Login") {
            await vscode.commands.executeCommand("learningCopilot.loginCopilotCli");
          }
          return;
        }
        vscode.window.showErrorMessage(`Failed to run Copilot CLI: ${msg}`);
      }
    })
  );

  // Generate Exercise from Selection
  context.subscriptions.push(
    vscode.commands.registerCommand("learningCopilot.generateExerciseSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {return; }
      
      const selectionText = editor.document.getText(editor.selection).trim();
      if (!selectionText) {
        vscode.window.showWarningMessage("Select some code first.");
        return;
      }
      
      const { copilotPath, copilotArgs } = getConfig();
      const storageDir = await ensureStorageDir(context);
      const logDir = path.join(storageDir, "copilot-logs");
      const configDir = path.join(storageDir, "copilot-config");
      await fsp.mkdir(logDir, { recursive: true });
      await fsp.mkdir(configDir, { recursive: true });     
    
      const prompt =
      `Create a programming exercise based on the following code/context.\n` +
      `- The exercise should be solvable in 15–30 minutes.\n` +
      `- Include clear requirements and at least 3 test cases.\n` +
      `- Do NOT provide a full solution.\n\n` +
      `Context:\n` +
      "```text\n" +
      selectionText +
      "\n```\n";
      
      output.show(true);
      
      try {
        const token = await getVsCodeGitHubToken();
        const envOverride: NodeJS.ProcessEnv = token
          ? {
              COPILOT_GITHUB_TOKEN: token,
              GH_TOKEN: token,
              GITHUB_TOKEN: token,
            }
          : {};
        const res = await runCopilotPrompt(copilotPath, copilotArgs, storageDir, prompt, configDir,logDir, output, envOverride);
        const stderr = res.stderr.trim();
        const stdout = res.stdout.trim();
        
        // If Copilot CLI failed, handle it here (it doesn't throw).
        if (res.exitCode !== 0) {
          if (stderr.toLowerCase().includes("no authentication information found")) {
            const choice = await vscode.window.showErrorMessage(
              "Copilot CLI is installed but not logged in. Open a terminal to run /login now?",
              "Login",
              "Cancel"
            );
            if (choice === "Login") {
              await vscode.commands.executeCommand("learningCopilot.loginCopilotCli");
            }
            return;
          }
          if (
            stderr.toLowerCase().includes("failed to list models") ||
            stderr.toLowerCase().includes("failed to fetch models") ||
            stderr.toLowerCase().includes("fetch failed")
          ) {
            vscode.window.showErrorMessage(
              "Copilot CLI could not list models. This is usually an auth/token issue or a network/proxy/TLS issue inside Copilot CLI. " +
                "If you just signed into GitHub in VS Code, try the command again. Otherwise, open the Learning Copilot output and check the log tail."
            );
            return;
          }
          
          vscode.window.showErrorMessage(`Copilot CLI failed (exit ${res.exitCode}). See Output for details.`);
          if (stderr) {
            output.appendLine("--- stderr ---");
            output.appendLine(stderr);
          }
          return;
        }
        
        if (stderr) {
          output.appendLine("--- stderr ---");
          output.appendLine(stderr);
        }
        
        output.appendLine("--- stdout ---");
        output.appendLine(stdout);
        
        lastOutput = stdout || null;
        
        if (!lastOutput) {
          vscode.window.showWarningMessage("Copilot returned no output (stdout was empty).");
        } else {
          vscode.window.showInformationMessage("Exercise generated from selection.");
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const lower = msg.toLowerCase();
        if (lower.includes("no authentication information found")) {
          const choice = await vscode.window.showErrorMessage(
            "Copilot CLI is installed but not logged in. Open a terminal to run /login now?",
            "Login",
            "Cancel"
          );
          if (choice === "Login") {
            await vscode.commands.executeCommand("learningCopilot.loginCopilotCli");
          }
          return;
        }
        vscode.window.showErrorMessage(`Failed to run Copilot CLI: ${msg}`);
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
          vscode.window.showInformationMessage(
            `Copilot CLI installed at: ${installedPath}`
          );
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
        const storageDir = await ensureStorageDir(context);
        await startCopilotLoginInTerminal(storageDir);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to start Copilot CLI login: ${err?.message ?? String(err)}`
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

      const { copilotPath, copilotArgs } = getConfig();
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

      const planPrompt =
        "Return JSON only. No prose. No markdown, unless the entire response is a single ```json fenced block. " +
        'Schema: {"files":[{"path":string,"content":string,"overwrite":boolean?}],"notes":string?}. ' +
        "All paths must be relative to the workspace root and must not contain '..' or start with '/'. " +
        "Prefer a minimal set of files. " +
        "Task: " + userPrompt;

      output.show(true);

      const token = await getVsCodeGitHubToken();
      const envOverride: NodeJS.ProcessEnv = token
        ? { COPILOT_GITHUB_TOKEN: token, GH_TOKEN: token, GITHUB_TOKEN: token }
        : {};

      const res = await runCopilotPrompt(
        copilotPath,
        copilotArgs,
        storageDir,
        planPrompt,
        configDir,
        logDir,
        output,
        envOverride
      );

      const stderr = res.stderr.trim();
      const stdout = res.stdout.trim();

      const writtenFiles: WrittenFile[] = [];

      if (res.exitCode !== 0) {
        if (stderr.toLowerCase().includes("no authentication information found")) {
          const choice = await vscode.window.showErrorMessage(
            "Copilot CLI is installed but not logged in. Open a terminal to run /login now?",
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
        `Generate learning scaffold (blanks + exercises) for ${writtenFiles.length} file(s)?`,
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
          copilotPath,
          copilotArgs,
          configDir,
          logDir,
          output,
          envOverride
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to generate learning scaffold: ${e?.message ?? String(e)}`);
        return;
      }

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
          title: `Applying learning scaffold to ${maskedToApply.length} file(s)…`,
          cancellable: false,
        },
        async () => {
          for (const mf of maskedToApply) {
            const targetUri = vscode.Uri.joinPath(wsRoot, ...mf.rel.split("/"));
            try {
              await ensureDirForFile(targetUri);
              await vscode.workspace.fs.writeFile(targetUri, Buffer.from(mf.content, "utf8"));
            } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to write scaffolded ${mf.rel}: ${e?.message ?? String(e)}`);
            }
          }
        }
      );

      if (maskedToApply.length > 0) {
        vscode.window.showInformationMessage(`Learning scaffold applied to ${maskedToApply.length} file(s).`);
      }

      // Write exercises markdown into workspace
      await writeWorkspaceMarkdownWithPrompt(wsRoot, "LEARNING_EXERCISES.md", scaffold.exercisesMd, "Learning scaffold");

      // Save instructor answer key privately
      if (scaffold.answerKeyMd) {
        try {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const keyDir = path.join(storageDir, "answer-keys");
          await fsp.mkdir(keyDir, { recursive: true });
          const keyPath = path.join(keyDir, `answer-key-${ts}.md`);
          await fsp.writeFile(keyPath, scaffold.answerKeyMd, "utf8");
          vscode.window.showInformationMessage(`Instructor answer key saved to extension storage: ${keyPath}`);
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
          "No solution snapshot available yet. Run ‘Learning Copilot: Generate Code Files from Prompt’ and enable scaffold generation first."
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
      const title = `Solution ↔ Current: ${rel}`;

      // Left = solution, Right = student's current file
      await vscode.commands.executeCommand("vscode.diff", solutionUri, editor.document.uri, title);
    })
  );


}
/**
 * Deactivates the extension.
 */
export function deactivate() {}
//#endregion
