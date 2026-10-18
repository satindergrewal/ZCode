// ============================================================
// Inline drafts count as "files the model wrote" (docs/dynamic-workflow/launch.md "Script files" ->
// 「An inline draft counts as written by the model」）
// ============================================================
// Edit/Write reject files the session never read (FILE_NOT_READ): no editing bytes the model has not seen.
// An inline draft is exactly such a file -- its bytes are the `script` arg of the call that produced it.
// Without this record the NOTE-required first `Edit` fails, and the remedy (Read the whole 20k-token
// script the model just wrote) is precisely the cost the draft file exists to avoid.
//
// **Called by the inline branch only**: saved copies (metadata block unseen), new drafts inheriting a
// predecessor script (possibly from another session or pre-compaction), hub-launched and GUI-amend drafts --
// none are bytes the model wrote this time; recording them would vouch for content the model never saw.
//
// Best-effort like the draft itself: no stat, no record; the first Edit falls back to read-first.

import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import { createReadFileStateKey, normalizeReadFileStateMtimeMs } from "../read-file-state.js";
import type { ReadFileStateEntry, ToolExecutionContext } from "../types.js";

export type WorkflowDraftAuthoringTool = "CreateWorkflow" | "AmendWorkflow" | "FillWorkflowHole";

const CRLF_PATTERN = /\r\n/gu;
const LF = "\n";

export async function recordAuthoredWorkflowDraft(
  context: ToolExecutionContext,
  draft: { path: string; source: string; toolName: WorkflowDraftAuthoringTool },
): Promise<void> {
  const { fileSystemPort, readFileState } = context;
  if (readFileState === undefined || fileSystemPort === undefined) return;

  let revision: { id: string; mtimeMs?: number; sizeBytes?: number } | undefined;
  try {
    // Reads the same port as the post-Edit/Write stale check, so revision semantics align. stat happens
    // after the write: recorded mtime >= the draft's true mtime, so any later external edit advances it -> stale.
    const info = await fileSystemPort.stat(
      { path: draft.path, trace: context.traceContext },
      { signal: context.abortSignal },
    );
    revision = info.revision;
  } catch {
    return;
  }
  if (revision === undefined) return;

  const entry: ReadFileStateEntry = {
    path: draft.path,
    // Port-returned text is normalized to LF (FileSystemReadTextResult.content); the snapshot follows suit.
    content: draft.source.replace(CRLF_PATTERN, LF),
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: draft.toolName,
    revisionId: revision.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision.mtimeMs),
    sizeBytes: revision.sizeBytes ?? Buffer.byteLength(draft.source, "utf8"),
  };
  readFileState.set(createReadFileStateKey(draft.path, 1, undefined), entry);

  // Resume rebuilds read-state only from tool-part metadata (read-file-state-hydrator.ts); without this
  // record the same bug returns after session restore.
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry.readAt,
    entry,
    toolName: draft.toolName,
  });
  if (metadata !== undefined) context.recordReadFileStateMetadata?.(metadata);
}
