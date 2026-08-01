/**
 * Workspace-local persistence for scaffold state.
 *
 * Everything a generated exercise needs in order to keep working — task
 * solutions and hints, completion flags, the solution snapshot, the answer
 * key, and the design-analysis cache — lives in a `.learning-copilot/` folder
 * inside the workspace itself.
 *
 * VS Code keys both `workspaceState` and extension global storage by the
 * workspace's absolute path, so anything kept there is silently lost the
 * moment a student copies, renames, or moves the project folder. Storing
 * state next to the code means a copied folder is still a complete, working
 * exercise. Solutions are therefore reachable by a curious student; that is a
 * deliberate trade for portability, since Compare With Solution and the
 * answer key are only a menu item away regardless.
 *
 * This module must stay free of `vscode` imports so it can be unit-tested
 * outside VS Code.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { normalizeRelativePath } from "./masking";
import type { DesignAnalysisRecord, ImageRole, ScaffoldTask, WrittenFile } from "./types";

/** Folder holding all workspace-local Learning Copilot state. */
export const STATE_DIR_NAME = ".learning-copilot";

const STATE_FILE_NAME = "state.json";
const SOLUTIONS_DIR_NAME = "solutions";
const ANSWER_KEYS_DIR_NAME = "answer-keys";

/** How many timestamped answer keys to retain. */
const ANSWER_KEYS_KEEP = 5;

const STATE_VERSION = 1;

export type WorkspaceScaffoldState = {
  version: number;
  tasks: ScaffoldTask[];
  imageRoles: Record<string, ImageRole>;
  designAnalyses: Record<string, DesignAnalysisRecord>;
};

export function emptyScaffoldState(): WorkspaceScaffoldState {
  return { version: STATE_VERSION, tasks: [], imageRoles: {}, designAnalyses: {} };
}

export function getStateDir(root: string): string {
  return path.join(root, STATE_DIR_NAME);
}

export function getStateFilePath(root: string): string {
  return path.join(getStateDir(root), STATE_FILE_NAME);
}

export function getSolutionsDir(root: string): string {
  return path.join(getStateDir(root), SOLUTIONS_DIR_NAME);
}

export function getAnswerKeysDir(root: string): string {
  return path.join(getStateDir(root), ANSWER_KEYS_DIR_NAME);
}

export function hasStateFile(root: string): boolean {
  return fs.existsSync(getStateFilePath(root));
}

function isScaffoldTask(value: any): value is ScaffoldTask {
  return (
    !!value &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    typeof value.solution === "string"
  );
}

/**
 * Parses state file contents defensively. A malformed or hand-edited file
 * costs the student their stored solutions, not the ability to use the
 * extension, so anything unrecognized is dropped rather than thrown.
 *
 * @param raw Raw `state.json` contents.
 */
export function parseScaffoldState(raw: string): WorkspaceScaffoldState {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyScaffoldState();
  }
  if (!parsed || typeof parsed !== "object") { return emptyScaffoldState(); }

  const state = emptyScaffoldState();

  if (Array.isArray(parsed.tasks)) {
    state.tasks = parsed.tasks.filter(isScaffoldTask);
  }

  if (parsed.imageRoles && typeof parsed.imageRoles === "object") {
    for (const [rel, role] of Object.entries(parsed.imageRoles)) {
      if (role === "design" || role === "asset") { state.imageRoles[rel] = role; }
    }
  }

  if (parsed.designAnalyses && typeof parsed.designAnalyses === "object") {
    for (const [rel, record] of Object.entries<any>(parsed.designAnalyses)) {
      if (record && typeof record.hash === "string" && typeof record.analysisMd === "string") {
        state.designAnalyses[rel] = {
          hash: record.hash,
          analyzedAt: typeof record.analyzedAt === "string" ? record.analyzedAt : "",
          analysisMd: record.analysisMd,
        };
      }
    }
  }

  return state;
}

/**
 * Reads the workspace's state file. A missing file yields empty state.
 *
 * @param root Workspace root path.
 */
export async function readScaffoldState(root: string): Promise<WorkspaceScaffoldState> {
  try {
    return parseScaffoldState(await fsp.readFile(getStateFilePath(root), "utf8"));
  } catch {
    return emptyScaffoldState();
  }
}

/**
 * Reads the workspace's state file synchronously, for the few call sites
 * (decorations, diff content provider) that cannot await.
 *
 * @param root Workspace root path.
 */
export function readScaffoldStateSync(root: string): WorkspaceScaffoldState {
  try {
    return parseScaffoldState(fs.readFileSync(getStateFilePath(root), "utf8"));
  } catch {
    return emptyScaffoldState();
  }
}

/**
 * Writes the state file. The write goes to a temporary file first so an
 * interrupted save can't leave behind a truncated `state.json`.
 *
 * @param root Workspace root path.
 * @param state State to persist.
 */
export async function writeScaffoldState(root: string, state: WorkspaceScaffoldState): Promise<void> {
  await fsp.mkdir(getStateDir(root), { recursive: true });
  const target = getStateFilePath(root);
  const body = JSON.stringify(
    { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() },
    null,
    2
  );
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, body, "utf8");
  await fsp.rename(tmp, target);
}

/**
 * Writes solution copies of `files` into the workspace's solutions folder,
 * merging with whatever is already there. Merging rather than replacing keeps
 * Compare With Solution working for files scaffolded by an earlier run when a
 * later run only rewrites some of them.
 *
 * @param root Workspace root path.
 * @param files Files with relative paths and full solution content.
 */
export async function writeSolutionSnapshot(root: string, files: WrittenFile[]): Promise<string> {
  const dir = getSolutionsDir(root);
  await fsp.mkdir(dir, { recursive: true });

  for (const file of files) {
    const rel = normalizeRelativePath(file.rel);
    const abs = path.join(dir, ...rel.split("/"));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, file.fullContent, "utf8");
  }

  return dir;
}

/** Whether any solution snapshot has been saved for this workspace. */
export function hasSolutionSnapshot(root: string): boolean {
  try {
    return fs.readdirSync(getSolutionsDir(root)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Reads one file from the solution snapshot. Sync because it backs a
 * `TextDocumentContentProvider`.
 *
 * @param root Workspace root path.
 * @param rel Workspace-relative path of the file.
 */
export function readSolutionFile(root: string, rel: string): string | null {
  let safeRel: string;
  try {
    safeRel = normalizeRelativePath(rel);
  } catch {
    return null;
  }
  try {
    return fs.readFileSync(path.join(getSolutionsDir(root), ...safeRel.split("/")), "utf8");
  } catch {
    return null;
  }
}

/**
 * Deletes all but the newest `keep` entries of a directory of timestamped
 * files. ISO-timestamp names sort lexicographically, so a plain sort is
 * chronological.
 *
 * @param dir Directory containing timestamped files.
 * @param keep Number of newest entries to retain.
 */
async function pruneTimestamped(dir: string, keep: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  const stale = entries.sort().slice(0, Math.max(0, entries.length - keep));
  for (const name of stale) {
    try {
      await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Saves a timestamped answer key and prunes older ones.
 *
 * @param root Workspace root path.
 * @param markdown Answer key contents.
 */
export async function writeAnswerKey(root: string, markdown: string): Promise<string> {
  const dir = getAnswerKeysDir(root);
  await fsp.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `answer-key-${ts}.md`);
  await fsp.writeFile(target, markdown, "utf8");
  await pruneTimestamped(dir, ANSWER_KEYS_KEEP);
  return target;
}

/**
 * Path of the newest answer key for this workspace, or null if none exists.
 * Resolved by scanning the folder rather than by a stored pointer, so it
 * survives the project folder being copied or moved.
 *
 * @param root Workspace root path.
 */
export function getLatestAnswerKeyPath(root: string): string | null {
  const dir = getAnswerKeysDir(root);
  try {
    const names = fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
    const latest = names[names.length - 1];
    return latest ? path.join(dir, latest) : null;
  } catch {
    return null;
  }
}

/**
 * Copies a directory tree into the workspace state folder, used to bring
 * snapshots and answer keys saved by older versions in VS Code's global
 * storage into the workspace.
 *
 * @param from Source directory.
 * @param to Destination directory.
 */
export async function copyDirInto(from: string, to: string): Promise<void> {
  await fsp.mkdir(to, { recursive: true });
  await fsp.cp(from, to, { recursive: true, force: true });
}
