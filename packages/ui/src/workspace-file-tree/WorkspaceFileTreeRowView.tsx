/* eslint-disable max-lines -- the file tree row centralizes drag and drop, open-with actions, Git status, and context menu interactions. */
import type { EditorInfo, OpenInEditorRemoteTarget } from "@zcode/shared";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { AlertCircle, ChevronRight, LoaderCircle } from "lucide-react";
import { TID_WORKSPACE_FILE_TREE_ROW, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { logger } from "@/logger.js";
import { resolveWorkspaceFileManagerEditor } from "@/lib/workspaceEditorSelection.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import {
  dispatchWorkspaceFileAddToChat,
  dispatchWorkspaceFileDragState,
  serializeWorkspaceFileDragPayload,
  WORKSPACE_FILE_DRAG_MIME,
} from "@/lib/workspaceFileDrag.js";
import {
  getWorkspaceFileRelativePath,
  isWorkspaceFileTreeDeletedFile,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";
import {
  getWorkspaceFileGitStatusDotClassName,
  getWorkspaceFileGitStatusIndicator,
  getWorkspaceFileGitStatusIndicatorClassName,
  getWorkspaceFileGitStatusTextClassName,
  getWorkspaceFileTreeRowDisplayGitStatus,
} from "@/workspace-file-tree/statusStyles.js";
import type {
  WorkspaceFileGitStatusLabels,
  WorkspaceFileTreeContextMenuLabels,
} from "@/workspace-file-tree/types.js";
import {
  createWorkspaceFileTreeHtmlBrowserUrl,
  isWorkspaceFileTreeHtmlFile,
} from "@/workspace-file-tree/helpers.js";
import { getWorkspaceFileTreeHierarchyGuideStyle } from "@/workspace-file-tree/hierarchyGuides.js";
import { useWorkspaceFileTreeRowDragState } from "@/workspace-file-tree/useWorkspaceFileTreeRowDragState.js";
import { WorkspaceFileTreeRowName } from "@/workspace-file-tree/WorkspaceFileTreeRowName.js";

export function WorkspaceFileTreeRowView({
  layout = "absolute",
  row,
  selected,
  gitStatus,
  directoryGitStatuses,
  gitStatusLabelByStatus,
  contextMenuLabels,
  canOpenLocalFileManager,
  installedEditors,
  isRemoteWorkspaceFileTree,
  remoteTarget,
  workspacePath,
  workspaceIdentity,
  style,
  onSelect,
  onToggleDirectory,
  onOpenPreview,
  onOpenBrowserUrl,
  onKeyDown,
}: {
  layout?: "absolute" | "static";
  row: WorkspaceFileTreeRow;
  selected: boolean;
  gitStatus: WorkspaceFileGitStatus | null;
  directoryGitStatuses: WorkspaceFileGitStatus[];
  gitStatusLabelByStatus: WorkspaceFileGitStatusLabels;
  contextMenuLabels: WorkspaceFileTreeContextMenuLabels;
  canOpenLocalFileManager: boolean;
  installedEditors: EditorInfo[];
  isRemoteWorkspaceFileTree: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
  workspacePath: string;
  workspaceIdentity?: string;
  style: CSSProperties;
  onSelect: (path: string) => void;
  onToggleDirectory: (row: WorkspaceFileTreeRow) => void;
  onOpenPreview: (row: WorkspaceFileTreeRow) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => void;
}) {
  const platform = usePlatform();
  const { isDragging, setIsDragging } = useWorkspaceFileTreeRowDragState();
  const fileActions = useFileContextActions({
    canOpenLocalFileManager,
    isRemoteWorkspace: isRemoteWorkspaceFileTree,
    openFailedMessage: contextMenuLabels.openFailed,
  });
  const relativePath = getWorkspaceFileRelativePath(workspacePath, row.path);
  const isDirectory = row.type === "directory";
  const isDeletedFile = isWorkspaceFileTreeDeletedFile(row, gitStatus);
  const wslFileManagerEditor = resolveWorkspaceFileManagerEditor(installedEditors, remoteTarget);
  const rowStyle = {
    ...style,
    "--workspace-file-tree-depth": row.depth,
  } as CSSProperties;
  const hierarchyGuideStyle = getWorkspaceFileTreeHierarchyGuideStyle(row.depth);
  const fileIconSrc = isDirectory ? null : resolveFileDisplayDescriptor(row.path).fileIconSrc;
  const gitStatusLabel = gitStatus ? gitStatusLabelByStatus[gitStatus] : null;
  const gitStatusText = gitStatus ? getWorkspaceFileGitStatusIndicator(gitStatus) : null;
  const gitStatusIndicatorClassName = gitStatus
    ? getWorkspaceFileGitStatusIndicatorClassName(gitStatus)
    : null;
  const rowDisplayStatus = getWorkspaceFileTreeRowDisplayGitStatus({
    gitStatus,
    directoryGitStatuses,
  });
  const rowStatusTextClassName = getWorkspaceFileGitStatusTextClassName(rowDisplayStatus);
  // While a directory loads, the spinner already signals state; stacking the Git dot on top
  // muddles both. Hide the aggregate dot until loading finishes, then show real Git status.
  const shouldShowDirectoryGitDots = !row.loading && directoryGitStatuses.length > 0;
  const workspaceFilePayload = {
    type: row.type === "directory" ? ("directory" as const) : ("file" as const),
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    path: row.path,
    relativePath,
    name: row.name,
  };

  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    onSelect(row.path);
    if (event.detail > 1) {
      return;
    }
    if (isDirectory) {
      onToggleDirectory(row);
      return;
    }
    if (isDeletedFile) {
      // Fix: deleted rows are virtual files completed from Git status; the real file is gone.
      // Keep selection only, avoiding preview opens that would fail to read the file.
      return;
    }
    // Single click used to only select; preview needed a double click. Both files and directories
    // now keep "single click runs the primary action": directories expand, files preview.
    onOpenPreview(row);
  };
  const handleCopyAbsolutePath = async () => {
    await fileActions.copyAbsolutePath({ path: row.path });
  };
  const handleCopyRelativePath = async () => {
    await fileActions.copyRelativePath({ path: row.path, relativePath });
  };
  const handleOpenPrimary = () => {
    if (isDeletedFile) {
      return;
    }
    if (isDirectory) {
      onToggleDirectory(row);
      return;
    }
    onOpenPreview(row);
  };
  const handleOpenInEditor = async (editor: EditorInfo) => {
    if (isDeletedFile) {
      return;
    }
    // Remote trees used to disable third-party open entirely and pass only the Linux path;
    // now the sanitized remoteTarget and entry kind go to main, whose platform boundary builds the URI.
    const result = await platform.openInEditor(editor.id, row.path, {
      pathKind: isDirectory ? "directory" : "file",
      remoteTarget,
      workspaceIdentity,
    });
    if (result.success) {
      return;
    }
    logger.warn("[WorkspaceFileTree] Failed to open tree entry", {
      editorId: editor.id,
      path: row.path,
      error: result.error ?? "unknown-error",
    });
    toast(contextMenuLabels.openFailed);
  };
  const handleOpenInBrowser = () => {
    const url = createWorkspaceFileTreeHtmlBrowserUrl(row);
    if (!url) {
      return;
    }

    onOpenBrowserUrl?.(url);
  };
  const handleRevealInFileManager = async () => {
    if (wslFileManagerEditor) {
      await handleOpenInEditor(wslFileManagerEditor);
      return;
    }
    await fileActions.revealInFileManager({
      path: row.path,
      deleted: isDeletedFile,
      kind: isDirectory ? "directory" : "file",
    });
  };
  const rowElement = (
    <div
      role="treeitem"
      data-testid={testId(TID_WORKSPACE_FILE_TREE_ROW, row.path)}
      aria-expanded={isDirectory ? row.expanded : undefined}
      tabIndex={0}
      draggable={!isDeletedFile}
      className={cn(
        "group/file-tree-row relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg border pr-2 py-1 text-left text-ui-base text-foreground outline-none transition-[background-color,border-color,box-shadow]",
        isDeletedFile ? "cursor-default" : "cursor-pointer",
        "pl-[calc(var(--workspace-file-tree-depth)*0.75rem+0.5rem)]",
        selected
          ? "border-input-border-focused bg-transparent hover:bg-surface-hover"
          : "border-transparent hover:bg-surface-hover",
        "focus-visible:border-border-hover",
      )}
      title={relativePath}
      onClick={handleRowClick}
      onContextMenu={() => onSelect(row.path)}
      onKeyDown={(event) => {
        if (isDeletedFile && event.key === "Enter") {
          // Fix: keyboard Enter and mouse click are separate paths; deleted virtual rows also skip preview.
          event.preventDefault();
          onSelect(row.path);
          return;
        }
        onKeyDown(event, row);
      }}
      onDragStart={(event) => {
        if (isDeletedFile) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(
          WORKSPACE_FILE_DRAG_MIME,
          serializeWorkspaceFileDragPayload(workspaceFilePayload),
        );
        event.dataTransfer.setData(
          "text/plain",
          buildFileMentionMarkdown(relativePath, row.name, row.type),
        );
        setIsDragging(true);
        dispatchWorkspaceFileDragState(true);
      }}
      onDragEnd={() => {
        setIsDragging(false);
        dispatchWorkspaceFileDragState(false);
      }}
    >
      {/* Guide lines extend 1px past each end; 12px depth steps keep 4px between the last line and this level's icon. */}
      {hierarchyGuideStyle && !isDragging ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-y-px left-2.5"
          data-workspace-file-tree-hierarchy-guides={row.depth}
          style={hierarchyGuideStyle}
        />
      ) : null}
      {isDirectory ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-foreground-subtle">
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3 text-foreground-subtlest transition-transform",
              row.expanded && "rotate-90",
            )}
          />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {fileIconSrc ? <FileDisplayIcon src={fileIconSrc} className="shrink-0 size-4" /> : null}
        <WorkspaceFileTreeRowName
          name={row.name}
          className={cn("min-w-0 flex-1 truncate", rowStatusTextClassName)}
          slashClassName="mx-1 text-foreground-subtlest"
        />
      </span>
      {gitStatusText && gitStatusLabel ? (
        <ControlHintTooltip
          title={gitStatusLabel}
          side="right"
          align="center"
          sideOffset={4}
          triggerClassName="ml-auto"
        >
          <span
            className={cn(
              "inline-flex shrink-0 justify-center font-mono text-ui-base font-bold leading-none",
              gitStatusIndicatorClassName,
            )}
            aria-label={gitStatusLabel}
          >
            {gitStatusText}
          </span>
        </ControlHintTooltip>
      ) : null}
      {shouldShowDirectoryGitDots ? (
        <ControlHintTooltip
          title={directoryGitStatuses.map((status) => gitStatusLabelByStatus[status]).join(", ")}
          side="right"
          align="center"
          sideOffset={4}
          triggerClassName="ml-1"
        >
          <span className="flex shrink-0 items-center" aria-label="●">
            <span
              className={cn(
                "size-1.5 rounded-full",
                getWorkspaceFileGitStatusDotClassName(directoryGitStatuses[0]),
              )}
            />
          </span>
        </ControlHintTooltip>
      ) : null}
      {row.loading ? (
        <LoaderCircle className="ml-2 size-3 shrink-0 animate-spin text-foreground-subtlest" />
      ) : row.error ? (
        <AlertCircle className="ml-2 size-3 shrink-0 text-warning" />
      ) : null}
    </div>
  );
  // Plain remote paths cannot go to the native file manager, but WSL Explorer is converted to
  // UNC at the main boundary; it therefore shares availability and execution path with "Reveal in File Manager".
  const canRevealInFileManager =
    (!isDeletedFile && Boolean(wslFileManagerEditor)) ||
    fileActions.canRevealInFileManager({
      path: row.path,
      deleted: isDeletedFile,
    });
  const canOpenPrimary = !isDeletedFile;
  const canOpenInBrowser =
    !isDeletedFile &&
    !isRemoteWorkspaceFileTree &&
    Boolean(onOpenBrowserUrl) &&
    isWorkspaceFileTreeHtmlFile(row);

  return (
    <div
      className={cn(layout === "absolute" ? "absolute left-0 top-0 w-full px-1" : "w-full")}
      style={rowStyle}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowElement}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem disabled={!canOpenPrimary} onSelect={handleOpenPrimary}>
            {/* Fix: the first item reused the default external-app label, showing "Open in Finder"
                once Finder/Explorer was pinned. Reuse the row primary action instead: files open
                the preview, directories toggle expansion. */}
            {contextMenuLabels.open}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={isDeletedFile || installedEditors.length === 0}>
              {contextMenuLabels.openWith}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
              {installedEditors.map((editor) => (
                <ContextMenuItem key={editor.id} onSelect={() => void handleOpenInEditor(editor)}>
                  {editor.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {canOpenInBrowser ? (
            <ContextMenuItem onSelect={handleOpenInBrowser}>
              {contextMenuLabels.openInBrowser}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!canRevealInFileManager}
            onSelect={() => void handleRevealInFileManager()}
          >
            {contextMenuLabels.reveal}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void handleCopyAbsolutePath()}>
            {contextMenuLabels.copyAbsolutePath}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void handleCopyRelativePath()}>
            {contextMenuLabels.copyRelativePath}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => dispatchWorkspaceFileAddToChat(workspaceFilePayload)}>
            {contextMenuLabels.addToChat}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
