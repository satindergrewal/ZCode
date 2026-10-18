import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { TID_WORKFLOW_ARTIFACT_PANE } from "@zcode/shared";
import type { WorkflowRunArtifactSummary } from "@zcode/shared/zcode-protocol-v4";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
  artifactOpenAsFileName,
  canRevealArtifactInWorkspace,
  isArtifactPresetKind,
  isTextArtifactContentType,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import {
  ArtifactOpenAsFileButton,
  useCanOpenArtifactAsFile,
} from "@/app-shell/workflow-artifacts/ArtifactOpenAsFileButton.js";
import { WorkflowArtifactBody } from "@/app-shell/workflow-artifacts/WorkflowArtifactBody.js";
import { artifactPresetFieldPaths } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { useWorkflowRunArtifactBytes } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { useWorkflowRunArtifactData } from "@/hooks/useWorkflowRunArtifactData.js";
import {
  useWorkflowRunArtifacts,
  type WorkflowRunArtifactView,
} from "@/hooks/useWorkflowRunArtifacts.js";
import { joinFilePath } from "@/lib/path.js";
import type { WorkflowArtifactSidePaneTab } from "@/lib/workspaceSidePane.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme, type Theme } from "@/useTheme.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/**
 * A stable empty summary list: the artifacts key is **absent** at zero artifacts, collapsing into a fresh []
 * every frame, changing the merge-hook deps each frame and re-querying the journal per frame.
 */
const EMPTY_SUMMARIES: readonly WorkflowRunArtifactSummary[] = [];

const WorkflowArtifactContent = memo(function WorkflowArtifactContent({
  tab,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  tab: WorkflowArtifactSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");

  // Subscribe to the **parent session** projection (as PlanDetail / WorkflowRun detail do): fresh artifact metadata is part of the parent
  // session projection, not a local cache of this pane.
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  const run = useMemo(
    () => state.snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [state.snapshot?.workflowRuns, tab.runId],
  );
  // Run absent from the live projection (cold restore / evicted by the 8-run cap) => whole inventory from the journal; present with zero artifacts => empty array.
  const live = run === undefined ? undefined : (run.artifacts ?? EMPTY_SUMMARIES);
  const {
    artifacts,
    loading: metadataLoading,
    unavailable,
  } = useWorkflowRunArtifacts({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(live === undefined ? {} : { live }),
  });

  const artifact = useMemo(
    () => artifacts.find((candidate) => candidate.id === tab.artifactId),
    [artifacts, tab.artifactId],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-artifact-source={live === undefined ? "journal" : "live"}
      data-testid={TID_WORKFLOW_ARTIFACT_PANE}
      data-workflow-artifact-id={tab.artifactId}
      data-workflow-run-id={tab.runId}
    >
      {artifact === undefined ? (
        // Keep the three states apart: still reading / this session cannot read artifact details (old CLI) / finished but the id is missing
        // (the run journal was pruned, or the chip points at a nonexistent artifact). Merging them into one reading
        // message would leave the last case stuck on the loading copy forever.
        <div className="flex h-full items-center justify-center p-6 text-center">
          <p
            className="text-ui-base text-foreground-subtle"
            data-testid="workflow-artifact-placeholder"
          >
            {intl.formatMessage({
              id: metadataLoading
                ? "chat.toolCall.workflow.run.artifacts.loading"
                : unavailable
                  ? "chat.toolCall.workflow.run.artifacts.unavailable"
                  : "chat.toolCall.workflow.run.artifacts.missing",
            })}
          </p>
        </div>
      ) : (
        <WorkflowArtifactView
          artifact={artifact}
          metadataLoading={metadataLoading}
          tab={tab}
          theme={theme}
          {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          {...(onRevealFileInTree === undefined ? {} : { onRevealFileInTree })}
        />
      )}
    </div>
  );
});

/**
 * Header + body. Mounted only once the artifact is known to exist, so the bytes and entries hooks can be called unconditionally
 * (the artifact-absent frame never renders this component, keeping the hook count constant).
 */
function WorkflowArtifactView({
  artifact,
  metadataLoading,
  tab,
  theme,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  artifact: WorkflowRunArtifactView;
  /** Metadata (incl. the preset board spec) still loading; the body uses this to separate not-yet from truly-empty. */
  metadataLoading: boolean;
  tab: WorkflowArtifactSidePaneTab;
  theme: Theme;
  onOpenBrowserUrl?: (url: string) => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const preset = isArtifactPresetKind(artifact.kind);

  // Where the version stepper lives. The tab version is only the at-open initial value (chips never carry a version;
  // absent means latest); the user pages afterwards. Reset to latest when the artifact changes (the same tab never does, but the component may be reused)
  // or the latest version advances: a new version landing while history is open, then jumping, would be jarring, so reset only on id change.
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(tab.version);
  useEffect(() => {
    setSelectedVersion(tab.version);
  }, [artifact.id, tab.version]);

  const availableVersions = useMemo(() => {
    if (artifact.versions !== undefined && artifact.versions.length > 0) {
      return artifact.versions.map((entry) => entry.version);
    }
    // When the journal is unreadable (old CLI / read failure) only the latest version is viewable; never fabricate 1..n from version,
    // or the stepper points at versions whose bytes cannot be fetched.
    return [artifact.version];
  }, [artifact.version, artifact.versions]);

  const version =
    selectedVersion !== undefined && availableVersions.includes(selectedVersion)
      ? selectedVersion
      : artifact.version;
  const versionIndex = availableVersions.indexOf(version);
  const isLatestVersion = version === artifact.version;

  const bytesState = useWorkflowRunArtifactBytes({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    artifactId: artifact.id,
    version,
    enabled: !preset,
  });
  // Boards fetch only the fields the spec names; skip fetching until the spec arrives and renders, the body has no chart before then.
  const fields = useMemo(
    () =>
      isArtifactPresetKind(artifact.kind)
        ? artifactPresetFieldPaths(artifact.kind, artifact.spec)
        : undefined,
    [artifact.kind, artifact.spec],
  );
  const dataState = useWorkflowRunArtifactData({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    artifactId: artifact.id,
    itemCount: artifact.itemCount,
    enabled: fields !== undefined,
    ...(fields === undefined ? {} : { fields }),
  });

  // "Show in workspace" and the html artifact "Open in browser" share this path: only the workspace-relative sourcePath
  // joined with workspacePath is a location that really exists on this machine; remote workspaces and provenance-less artifacts get neither.
  const sourcePath = artifact.sourcePath;
  const localSourcePath =
    sourcePath !== undefined &&
    canRevealArtifactInWorkspace({
      sourcePath,
      ...(tab.workspaceIdentity === undefined ? {} : { workspaceIdentity: tab.workspaceIdentity }),
      ...(tab.remoteSessionId === undefined ? {} : { remoteSessionId: tab.remoteSessionId }),
    })
      ? joinFilePath(tab.workspacePath, sourcePath)
      : undefined;

  // One file control in the header: when open-as-file is possible, reveal-in-workspace lives in its menu; otherwise it is a standalone button.
  const canOpenAsFile = useCanOpenArtifactAsFile();
  const openAsFile = !preset && canOpenAsFile;
  const reveal =
    localSourcePath !== undefined && onRevealFileInTree !== undefined
      ? () => onRevealFileInTree(localSourcePath)
      : undefined;

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyable =
    !preset && bytesState.bytes !== null && isTextArtifactContentType(artifact.contentType);
  const handleCopy = useCallback(() => {
    if (bytesState.bytes === null) return;
    void navigator.clipboard
      ?.writeText(new TextDecoder().decode(bytesState.bytes))
      .then(() => setCopied(true))
      .catch(() => undefined);
  }, [bytesState.bytes]);

  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });

  return (
    <>
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* The same square tile as the artifact pill: the tab header is that pill, grown up. */}
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-surface-hover text-foreground-subtle">
            <ArtifactKindIcon className="size-3.5" kind={artifact.kind} />
          </span>
          <h2
            className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
            data-testid="workflow-artifact-title"
            title={title}
          >
            {title}
          </h2>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-ui-sm text-foreground-subtle">{kindLabel}</span>
          <ArtifactVersionStepper
            availableVersions={availableVersions}
            onSelect={setSelectedVersion}
            version={version}
            versionIndex={versionIndex}
          />
          <div className="ml-auto flex items-center gap-1">
            {openAsFile ? (
              <ArtifactOpenAsFileButton
                artifactId={artifact.id}
                // Hand over only this version's bytes: for one frame after a version switch they are still the old ones, and the copy is written once.
                bytes={bytesState.bytesVersion === version ? bytesState.bytes : null}
                fileName={artifactOpenAsFileName(artifact, version)}
                runId={tab.runId}
                version={version}
                {...(reveal === undefined ? {} : { onReveal: reveal })}
              />
            ) : null}
            {!openAsFile && reveal !== undefined ? (
              <Button
                data-testid="workflow-artifact-reveal"
                onClick={reveal}
                size="sm"
                type="button"
                variant="ghost"
              >
                <FolderOpenIcon aria-hidden="true" className="size-3.5" />
                {intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" })}
              </Button>
            ) : null}
            {copyable ? (
              <Button
                data-testid="workflow-artifact-copy"
                onClick={handleCopy}
                size="sm"
                type="button"
                variant="ghost"
              >
                <CopyIcon aria-hidden="true" className="size-3.5" />
                {intl.formatMessage({
                  id: copied
                    ? "chat.toolCall.workflow.run.artifacts.copied"
                    : "chat.toolCall.workflow.run.artifacts.copy",
                })}
              </Button>
            ) : null}
          </div>
        </div>
        {/* Author-written note (user language); the whole row is skipped when absent. */}
        {artifact.description === undefined ? null : (
          <p className="mt-1.5 text-ui-sm text-foreground-subtle">{artifact.description}</p>
        )}
      </header>

      <div className="min-h-0 flex-1">
        <WorkflowArtifactBody
          artifact={artifact}
          blob={bytesState.blob}
          bytes={bytesState.bytes}
          error={bytesState.error}
          isLatestVersion={isLatestVersion}
          items={dataState.items}
          loading={bytesState.loading}
          metadataLoading={metadataLoading}
          objectUrl={bytesState.objectUrl}
          resolvedTheme={resolveTheme(theme)}
          theme={theme}
          version={version}
          {...(localSourcePath === undefined ? {} : { localSourcePath })}
          {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          {...(reveal === undefined ? {} : { onReveal: reveal })}
        />
      </div>
    </>
  );
}

/**
 * The version stepper. With a single version the whole block is absent - an always-both-disabled stepper is just noise.
 *
 * Page over the **array of known versions**, not by +/- on a number: when the journal is unreadable the array holds only the latest,
 * so the stepper disappears instead of offering versions whose bytes cannot be fetched.
 */
function ArtifactVersionStepper({
  availableVersions,
  version,
  versionIndex,
  onSelect,
}: {
  availableVersions: readonly number[];
  version: number;
  versionIndex: number;
  onSelect: (version: number) => void;
}) {
  const { intl } = useZCodeIntl();
  if (availableVersions.length <= 1) {
    return (
      <span
        className="font-mono text-ui-xs text-foreground-subtlest"
        data-testid="workflow-artifact-version"
      >
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.run.artifacts.version" },
          { version: String(version) },
        )}
      </span>
    );
  }
  const previous = availableVersions[versionIndex - 1];
  const next = availableVersions[versionIndex + 1];
  return (
    <div className="flex items-center gap-0.5" data-testid="workflow-artifact-version-stepper">
      <Button
        aria-label={intl.formatMessage({
          id: "chat.toolCall.workflow.run.artifacts.previousVersion",
        })}
        data-testid="workflow-artifact-version-previous"
        disabled={previous === undefined}
        onClick={() => (previous === undefined ? undefined : onSelect(previous))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      </Button>
      <span
        className="font-mono text-ui-xs text-foreground-subtle"
        data-testid="workflow-artifact-version"
      >
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.run.artifacts.versionOf" },
          { total: String(availableVersions.length), version: String(version) },
        )}
      </span>
      <Button
        aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.nextVersion" })}
        data-testid="workflow-artifact-version-next"
        disabled={next === undefined}
        onClick={() => (next === undefined ? undefined : onSelect(next))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronRightIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * Full-size view tab for one dwf artifact.
 *
 * Terminology: artifact here is what a script delivers to the user via artifact.*, not the engine-internal
 * same-named script top-level return value.
 *
 * Three data lanes: **metadata** via useWorkflowRunArtifacts (live projection + journal merge),
 * **bytes** via useWorkflowRunArtifactBytes (chunked into a Blob), **board entries** via
 * useWorkflowRunArtifactData (an itemCount bump continues the pull). The lanes are independent,
 * so a board never reads bytes and a pdf never scans journal report rows.
 */
export const WorkflowArtifactSidePane = memo(function WorkflowArtifactSidePane({
  tab,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  tab: WorkflowArtifactSidePaneTab;
  /** The html artifact open-in-browser action. */
  onOpenBrowserUrl?: (url: string) => void;
  /** Show in workspace: reuses the existing file-tree reveal (same path as the Git pane). */
  onRevealFileInTree?: (path: string) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowArtifactContent
        tab={tab}
        {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
        {...(onRevealFileInTree === undefined ? {} : { onRevealFileInTree })}
      />
    </V4PaneConversationProvider>
  );
});
