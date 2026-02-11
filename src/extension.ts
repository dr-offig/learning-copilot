import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as https from "node:https";
import * as path from "node:path";

let lastOutput: string | null = null;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("learningCopilot");
  return {
    copilotPath: cfg.get<string>("copilotPath", "copilot"),
    copilotArgs: cfg.get<string[]>("copilotArgs", []),
  };
}

function getAutoInstallEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration("learningCopilot");
  return cfg.get<boolean>("autoInstallCopilotCli", true);
}

async function setCopilotPath(newPath: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("learningCopilot");
  await cfg.update("copilotPath", newPath, vscode.ConfigurationTarget.Global);
}

function getConfiguredCopilotPath(): string {
  const { copilotPath } = getConfig();
  return copilotPath;
}

function getCopilotConfigDir(storageDir: string): string {
  return path.join(storageDir, "copilot-config");
}

function getCopilotLogDir(storageDir: string): string {
  return path.join(storageDir, "copilot-logs");
}

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

async function ensureStorageDir(context: vscode.ExtensionContext): Promise<string> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  return context.globalStorageUri.fsPath;
}

// Helper to get a GitHub access token from VS Code's built-in authentication.
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
async function findNewestFile(dir: string): Promise<string | null> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files: Array<{ path: string; mtimeMs: number }> = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
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

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Learning Copilot");
  context.subscriptions.push(output);
  
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
}

export function deactivate() {}