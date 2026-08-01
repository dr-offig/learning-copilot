/**
 * The Task Links block at the top of LEARNING_EXERCISES.md: a checklist of
 * every task, each linking to the exact line of its region.
 *
 * Link targets are workspace-relative. They used to be absolute, which meant
 * a student working in a copy of a generated project silently jumped into —
 * and edited — the original folder's files. The `LC_TASK_LINK|rel|id` marker
 * at the end of each line is the durable record of which task a line belongs
 * to; link URIs are rebuilt from it, which is also how exercises files
 * written by older versions get repaired.
 *
 * This module must stay free of `vscode` imports so it can be unit-tested
 * outside VS Code.
 */

import { getRegionStartLine, listTaskRegions, normalizeRelativePath } from "./masking";
import type { ScaffoldPlan, ScaffoldTask } from "./types";

/** Publisher-qualified extension id, used as the `vscode://` URI authority. */
const EXTENSION_URI_ID = "dr-offig.learning-copilot";

export const TASK_LINKS_START = "<!-- LC_TASK_LINKS_START -->";
export const TASK_LINKS_END = "<!-- LC_TASK_LINKS_END -->";

export type TaskJumpLink = {
  id: string;
  rel: string;
  line: number;
  uri: string;
};

/**
 * Builds the `vscode://` URI for one task link.
 *
 * @param rel Workspace-relative file path.
 * @param line 1-based line of the task region.
 */
export function buildTaskLinkUri(rel: string, line: number): string {
  const query = new URLSearchParams({ path: rel, line: String(line) }).toString();
  return `vscode://${EXTENSION_URI_ID}/openTaskLink?${query}`;
}

export function getTaskStateKey(rel: string, id: string): string {
  return `${rel}::${id}`;
}

export function getCompletedTaskKeySet(tasks: ScaffoldTask[]): Set<string> {
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

/**
 * Locates every task region in a plan's masked files and turns it into a link.
 *
 * @param plan Scaffold plan holding masked files and tasks.
 */
export function buildTaskJumpLinks(plan: ScaffoldPlan): TaskJumpLink[] {
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
    links.push({ id: task.id, rel, line, uri: buildTaskLinkUri(rel, line) });
  }

  links.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line || a.id.localeCompare(b.id));
  return links;
}

function formatTaskLinkLine(
  displayId: string,
  rel: string,
  line: number,
  id: string,
  checked: boolean
): string {
  const box = checked ? "x" : " ";
  return `- [${box}] **${displayId}**: [${rel}:${line}](${buildTaskLinkUri(rel, line)}) <!-- LC_TASK_LINK|${rel}|${id} -->`;
}

export function buildTaskLinksSection(links: TaskJumpLink[], completed: Set<string>): string {
  const lines = [
    "# Task Links",
    "",
    ...links.map((link) =>
      formatTaskLinkLine(link.id, link.rel, link.line, link.id, completed.has(getTaskStateKey(link.rel, link.id)))
    ),
    "",
  ];

  return [TASK_LINKS_START, ...lines, TASK_LINKS_END].join("\n");
}

export function prependTaskLinksSection(
  exercisesMd: string,
  links: TaskJumpLink[],
  tasks: ScaffoldTask[]
): string {
  if (links.length === 0) { return exercisesMd; }

  const block = buildTaskLinksSection(links, getCompletedTaskKeySet(tasks));
  return `${block}\n\n---\n\n${exercisesMd}`;
}

const TASK_LINK_LINE_RE =
  /^- \[[ x]\] \*\*([^*]+)\*\*: \[([^\]]+)\]\(([^)]+)\) <!-- LC_TASK_LINK\|([^|]+)\|([^>]+) -->$/gm;

/** Recovers a task link's line number from its URI, falling back to its label. */
function getTaskLinkLine(uri: string, label: string): number {
  const fromQuery = Number(new URLSearchParams(uri.split("?")[1] ?? "").get("line"));
  if (Number.isInteger(fromQuery) && fromQuery > 0) { return fromQuery; }
  const fromLabel = Number(label.match(/:(\d+)$/)?.[1]);
  return Number.isInteger(fromLabel) && fromLabel > 0 ? fromLabel : 1;
}

/**
 * Rewrites the Task Links block: ticks the checkbox of every completed task,
 * and rebuilds each link URI from its `LC_TASK_LINK` marker so links written
 * as absolute paths by older versions start pointing at the folder that is
 * actually open.
 *
 * @param content Full LEARNING_EXERCISES.md contents.
 * @param completed Keys of completed tasks.
 */
export function refreshTaskLinksSection(content: string, completed: Set<string>): string {
  return content.replace(
    TASK_LINK_LINE_RE,
    (_full, displayId, label, uri, relRaw, idRaw) => {
      const rel = String(relRaw).trim();
      const id = String(idRaw).trim();
      const line = getTaskLinkLine(String(uri), String(label));
      return formatTaskLinkLine(String(displayId), rel, line, id, completed.has(getTaskStateKey(rel, id)));
    }
  );
}

/**
 * Extracts the `rel::id` key of every task named by an exercises file's link
 * markers. Used to decide whether state found outside the workspace belongs
 * to this project.
 *
 * @param content Full LEARNING_EXERCISES.md contents.
 */
export function listMarkedTaskKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const m of content.matchAll(/<!-- LC_TASK_LINK\|([^|]+)\|([^>]+) -->/g)) {
    keys.add(getTaskStateKey(m[1].trim(), m[2].trim()));
  }
  return keys;
}
