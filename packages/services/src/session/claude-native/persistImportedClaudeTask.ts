import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZCodeSessionFile, ZCodeTaskMeta } from "@zcode/shared";
import { getLegacyTaskSessionSnapshotPath } from "#src/paths.js";
import {
  parseLegacyTaskSessionFile,
  type LegacyTaskSessionFile,
} from "#src/session/legacyTaskSessionFile.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

export function buildSearchableTextFromMessages(messages: ZCodeSessionFile["messages"]): string {
  const parts: string[] = [];
  let total = 0;
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    const next = total > 0 ? `\n${content}` : content;
    if (total + next.length > TASK_SEARCH_TEXT_MAX_CHARS) {
      parts.push(next.slice(0, TASK_SEARCH_TEXT_MAX_CHARS - total));
      break;
    }
    parts.push(next);
    total += next.length;
  }
  return parts.join("");
}

async function writeSessionFileAtomic(
  filePath: string,
  sessionFile: LegacyTaskSessionFile,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  const serialized = JSON.stringify(sessionFile, null, 2);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${serialized}\n`, "utf-8");
  await rename(tempPath, filePath);
}

export async function persistImportedClaudeTask(params: {
  taskIndexRepo: TaskIndexRepo;
  sessionFile: LegacyTaskSessionFile;
  /** Write only when the import target workspace equals the filter workspace, never stamping this tab's identity elsewhere. */
  workspaceIdentity?: string;
}): Promise<ZCodeTaskMeta> {
  const parsed = parseLegacyTaskSessionFile(params.sessionFile);
  const meta: LegacyTaskSessionFile["meta"] = {
    ...parsed.meta,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  };
  const indexMeta: ZCodeTaskMeta = {
    ...meta,
    // The sqlite task index mode column is NOT NULL; the imported snapshot keeps its filtered default.
    mode: meta.mode ?? "build",
  };

  await writeImportedClaudeTaskSnapshot({ sessionFile: { ...parsed, meta } });
  return params.taskIndexRepo.syncTaskMeta({
    meta: indexMeta,
    // After the user deletes/archives an imported session, the old index row keeps archived/deleted.
    // Re-import means restoring it to the lists, so explicitly clear the hidden state.
    archived: false,
    deleted: false,
    searchableText: buildSearchableTextFromMessages(parsed.messages),
  });
}

export async function writeImportedClaudeTaskSnapshot(params: {
  sessionFile: LegacyTaskSessionFile;
}): Promise<void> {
  const parsed = parseLegacyTaskSessionFile(params.sessionFile);
  const filePath = getLegacyTaskSessionSnapshotPath(
    parsed.meta.workspacePath,
    parsed.meta.taskId,
    parsed.meta.workspaceIdentity,
  );

  // After legacy ACP sunset importClaudeSessions became a stub: the jsonl is copied but no
  // ~/.zcode/v2/sessions/{hash}/{taskId}.json is written. Real ZCode sessions own continues; the legacy snapshot
  // keeps only the filtered migration backup, so Claude-side runtime state never pollutes model selection.
  await writeSessionFileAtomic(filePath, parsed);
}
