import { useEffect, useMemo, useState } from "react";
import type {
  AssistantTextRow,
  ConversationRowTarget,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
  type AssistantPreviewCard,
} from "@/lib/assistantPreviewCards.js";
import { logger } from "@/logger.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationFileChangesState,
} from "@/v4/conversationRowContext.js";

interface UseAssistantPreviewCardsForAssistantTextRowParams {
  row?: AssistantTextRow;
  assistantTextRows: readonly AssistantTextRow[];
  latestAssistantTextRow?: AssistantTextRow;
  workspacePath: string;
  workspaceHomePath?: string;
  compactForRemoteControl?: boolean;
  fileChangesTarget: ConversationRowTarget | null;
  fileChangesState?: ConversationFileChangesState;
  fetchFileChanges?: (
    target: ConversationRowTarget,
    options: ConversationFileChangesRequestOptions,
  ) => Promise<V4ConversationFileChangesResult>;
}

interface LoadedChangedPaths {
  key: string;
  paths: readonly string[];
}

const EMPTY_CHANGED_FILE_PATHS: readonly string[] = [];

function joinAssistantTurnText(rows: readonly AssistantTextRow[]): string {
  return rows
    .map((row) => row.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

export function useAssistantPreviewCardsForAssistantTextRow({
  row,
  assistantTextRows,
  latestAssistantTextRow,
  workspacePath,
  workspaceHomePath,
  compactForRemoteControl,
  fileChangesTarget,
  fileChangesState,
  fetchFileChanges,
}: UseAssistantPreviewCardsForAssistantTextRowParams): AssistantPreviewCard[] {
  const turnText = useMemo(() => joinAssistantTurnText(assistantTextRows), [assistantTextRows]);
  const canBuildCards =
    row !== undefined &&
    latestAssistantTextRow?.rowId === row.rowId &&
    (row.state === "complete" || row.state === "interrupted");
  const fileReferences = useMemo(
    () =>
      canBuildCards
        ? extractAssistantFileReferences(turnText, workspacePath, {
            homePath: workspaceHomePath,
          })
        : [],
    [canBuildCards, turnText, workspaceHomePath, workspacePath],
  );
  const needsFileChanges = fileReferences.some(
    (reference) =>
      reference.kind === "markdown" ||
      (reference.kind === "html" && compactForRemoteControl !== true),
  );
  const target = useMemo<ConversationRowTarget | null>(
    () =>
      fileChangesTarget
        ? {
            rowId: fileChangesTarget.rowId,
            entityId: fileChangesTarget.entityId,
          }
        : null,
    [fileChangesTarget?.entityId, fileChangesTarget?.rowId],
  );
  const requestKey = target
    ? `${target.rowId}:${target.entityId}:${fileChangesState ?? "unknown"}`
    : "";
  const [loadedChangedPaths, setLoadedChangedPaths] = useState<LoadedChangedPaths | null>(null);

  useEffect(() => {
    if (!needsFileChanges || !fetchFileChanges || !target) return;
    // After a rewind, the header reverted state is the authoritative projection; suppress md/html immediately, no details-RPC wait.
    if (fileChangesState === "reverted") return;

    let disposed = false;
    // V4 fileChanges accepts turnHeader only; assistantText is for body copy and card anchors only.
    // Project Office/PDF synchronously under an empty gate; read turn details only once md/html actually appear.
    void fetchFileChanges(target, {
      cachePolicy: "terminal",
      fileChangesState,
    }).then(
      (result) => {
        if (disposed) return;
        setLoadedChangedPaths({
          key: requestKey,
          paths: result.state === "reverted" ? [] : result.items.map((item) => item.path),
        });
      },
      (error: unknown) => {
        if (disposed) return;
        logger.warn(
          "[AssistantPreviewCards] failed to load turn file changes; Markdown/HTML cards suppressed",
          {
            error: error instanceof Error ? error.message : String(error),
            rowId: target.rowId,
          },
        );
        setLoadedChangedPaths({ key: requestKey, paths: [] });
      },
    );

    return () => {
      disposed = true;
    };
  }, [fetchFileChanges, fileChangesState, needsFileChanges, requestKey, target]);

  const changedFilePaths =
    needsFileChanges && loadedChangedPaths?.key === requestKey
      ? loadedChangedPaths.paths
      : EMPTY_CHANGED_FILE_PATHS;

  return useMemo(
    () =>
      canBuildCards
        ? buildAssistantPreviewCardsFromReferences(turnText, workspacePath, fileReferences, {
            changedFilePaths,
            homePath: workspaceHomePath,
            suppressWebRemoteCards: compactForRemoteControl === true,
          })
        : [],
    [
      canBuildCards,
      changedFilePaths,
      compactForRemoteControl,
      fileReferences,
      turnText,
      workspaceHomePath,
      workspacePath,
    ],
  );
}
