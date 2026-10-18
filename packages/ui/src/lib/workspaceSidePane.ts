/* eslint-disable max-lines -- side pane tab state centralizes open/reuse/close/ordering rules for Browser/Git/CodeViewer/Treemapping/Whiteboard; splitting requires migrating the in-memory restore logic in lockstep. */
import { createUuid, type BrowserTabResidencyState } from "@zcode/shared";
import { inferMediaPreview, isPptxPreviewPath, type CodeViewerSource } from "@/lib/codeViewer.js";
import { normalizeCodeViewerSource } from "@/lib/codeViewerSource.js";

export interface BrowserSidePaneTab {
  id: string;
  type: "browser";
  /** Conversation ownership frozen at open; null while draft. */
  ownerTaskId?: string | null;
  /** Workspace isolation key (workspaceIdentity || workspacePath). */
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  faviconUrl?: string | null;
  initialUrl?: string | null;
  /** Popup triggered by an agent-controlled page; human-browser display persistence prefs do not apply. */
  agentOpened?: boolean;
  openedAt?: number;
  title?: string | null;
  residency?: BrowserTabResidencyState;
  residencyGeneration?: number;
}

export type BrowserSidePaneMetadata = Partial<Pick<BrowserSidePaneTab, "faviconUrl" | "title">>;

export const BROWSER_USE_OPERATION_INDICATOR_DURATION_MS = 5_000;

export interface GitSidePaneTab {
  id: "git";
  type: "git";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface CodeViewerSidePaneTab {
  id: string;
  type: "code-viewer";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source: CodeViewerSource;
  sourceKey: string | null;
}

export type TreemappingSidePaneSource =
  | { kind: "current" }
  | { kind: "message"; messageId: string; turnIndex?: number };

export interface TreemappingSidePaneTab {
  id: "treemapping";
  type: "treemapping";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source?: TreemappingSidePaneSource;
}

export interface WhiteboardSidePaneTab {
  id: string;
  type: "whiteboard";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  boardId: string;
  openedAt?: number;
  title: string;
}

export interface ModelTrajectorySidePaneTab {
  id: string;
  type: "model-trajectory";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  /** Target task/session id; model-io matches on it. */
  taskId: string;
  title?: string | null;
}

export interface DeveloperToolsSidePaneTab {
  id: "developer-tools";
  type: "developer-tools";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface TerminalSidePaneTab {
  id: string;
  type: "terminal";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  title: string;
  cwd?: string;
  remoteSessionId?: string | null;
}

/** browser-use controlled-browser view (renderer `<webview>` + main CDP). */
export interface BrowserUseSidePaneTab {
  id: string;
  type: "browser-use";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  sessionId: string;
  /** Opaque IAB tab identity assigned by main; also the webview attach key. */
  tabId: string;
  browserId?: string;
  browserGeneration?: number;
  openedAt?: number;
  title?: string | null;
  faviconUrl?: string | null;
  residency?: BrowserTabResidencyState;
  residencyGeneration?: number;
  /** UI indicator deadline for the latest agent browser-use operation. */
  browserUseOperationUntil?: number;
  /** Monotonic version of the model layout command; the target view rebuilds its ResizeObserver baseline from it. */
  browserUseResizeBaselineVersion?: number;
}

export interface OpenBackgroundBashSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  sessionId: string;
  workId: string;
  title: string;
}

export interface BackgroundBashSidePaneTab extends OpenBackgroundBashSideTabRequest {
  id: string;
  type: "bash-output";
  workspaceKey: string;
  ownerTaskId: string;
  openedAt?: number;
}

export interface SubagentSessionSidePaneTab {
  id: string;
  type: "subagent-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface SubagentDirectorySidePaneTab {
  id: string;
  type: "subagent-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
}

export interface SelectionSideChatPaneTab {
  id: string;
  type: "selection-side-chat";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  ordinal: number;
}

export interface PlanDetailSidePaneTab {
  id: string;
  type: "plan-detail";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

export interface OpenPlanDetailSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

/**
 // Detail-page tab for a workflow run.
 *
 // Identity is the **run** (`runId`), not the tool call that started it: one CreateWorkflow
 // starts exactly one run, and the run is the key shared by the engine, the journal, and
 // `cancelBackgroundWork {workId}` (`workId = taskId = runId`). `toolCallId` still travels
 // along -- the static causal graph lives in that tool-call row's display, and the detail page
 // finds the graph through it in the parent session projection.
 *
 // ## This tab deliberately has **no GC** -- do not add one
 *
 // Both natural-looking reclamation rules are wrong:
 *
 // - **Do not close it when the run is evicted by `WORKFLOW_RUNS_LIMITS.maxRuns` (8).** The
 // detail page's event log reads the **journal**, not the `workflowRuns` projection. An
 // evicted run loses only live overlay state; its event log stays **complete** -- exactly
 // why users keep this tab (reviewing how a finished run went). Auto-closing would destroy
 // the only persistent view of a finished run. Eviction merely degrades the detail page to
 // the "no longer tracked live" empty state, and the copy must say honestly: live state is
 // gone, the run itself is not.
 // - **Do not close it on parent-session edit/retry.** Run identity survives conversation
 // rewrites; at worst the tool-call row leaves the viewport -- which degrades to "no graph
 // to draw", not "this tab should disappear".
 *
 // Visibility is already narrowed by `parentSessionId` (same as plan-detail), so the tab
 // cannot leak into other conversations. The `syncSubagentSessionSidePaneTabs` reclamation
 // applies to subagent-sessions only; do not extend it here.
 */
export interface WorkflowRunSidePaneTab {
  id: string;
  type: "workflow-run";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  /** Display name frozen at open; title fallback only when the projection is absent (run evicted / cold start). */
  workflowName?: string;
  /** Landing: expand this phase, list all, or scroll the section header to top. Absent = stay put. */
  focusPhaseId?: string;
}

export interface OpenWorkflowRunSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  /** Landing: expand this phase in the detail page, list all, or scroll to the section header. Absent = stay put. */
  phaseId?: string;
  /**
   // After "configure", the panel follows the workflow: swap the tab showing this run **in
   // place** for the new run's tab -- same slot, keeping its name and ownership. With no such
   // tab (closed), do nothing: the panel does not reopen for this.
   */
  replaceRunId?: string;
}

/**
 // Workflow run directory tab for one conversation.
 *
 // Identity is the **conversation** (`parentSessionId`): one conversation has exactly one run
 // directory, so repeated clicks on the footer row idempotently focus the same tab -- isomorphic
 // to `subagent-directory`.
 *
 // This tab carries no run data: the directory page reads a journal page by `parentSessionId`
 // itself (the single source of truth for the directory). Freezing a summary into the tab would
 // make "reopen a restored tab after restart" show a stale roster -- precisely the moment this
 // tab exists for.
 */
export interface WorkflowRunDirectorySidePaneTab {
  id: string;
  type: "workflow-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
}

export interface OpenWorkflowRunDirectorySideTabRequest {
  parentSessionId: string;
}

/**
 // Transcript tab for one dwf actor instance.
 *
 // Identity is the **actor session**: one instance has one real persistent session, so
 // `actorSessionId` is the tab identity. `runId` / `siteId` / `ordinal` ride along for title,
 // search, and debugging -- they are journal keys, whereas the session id is minted by the run
 // service from `(runId, actorRef)` and must not be re-derived by the renderer.
 *
 // ## Why a **separate type**, not a variant flag on `subagent-session`
 *
 // `syncSubagentSessionSidePaneTabs` prunes subagent tabs whose `childSessionId` is missing
 // from `validChildSessionIds`, and an actor session is **never** in that set (it is not a
 // subagent's child). Reusing that type would mean: every subagent-projection update recycles
 // this tab. The fix would be teaching that pruner about the variant flag -- the same work,
 // just with the invariant hidden inside reclamation logic.
 *
 // Two more places would fight: subagent tab visibility narrows by `rootSessionId` (actor tabs
 // need `parentSessionId`, same as workflow-run), while `lastActiveSubagentTabByRootRef`
 // remembers the active tab by `rootSessionId` -- an actor tab has, and should have, no root
 // session.
 *
 // ## GC: same as `workflow-run` -- **none**, do not add it
 *
 // Actor sessions outlive the run (that is the durable-audit the persistence buys). Run
 // eviction at the 8-run cap, parent edit/retry, run settlement -- none of these should close
 // a still-readable transcript. Visibility is narrowed by `parentSessionId`, so it cannot leak
 // into other conversations.
 */
export interface WorkflowActorSessionSidePaneTab {
  id: string;
  type: "workflow-actor-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /**
   // Actor session id: the session the nested read-only SessionPane renders. **Optional** --
   // a tab opened from a not-yet-started pill has no session at open; the panel heals it by
   // looking the slot up in the live projection. Identity does not live here; it is
   // (runId, siteId, ordinal).
   */
  actorSessionId?: string;
  /** Actor site id and ordinal: with runId they form the tab identity; never used for naming. */
  siteId: string;
  ordinal: number;
  /** Name written in the script (`agent("reviewer")`); absent when static analysis cannot see the literal, title falls back to localization. */
  actorName?: string;
}

export interface OpenWorkflowActorSessionSideTabRequest {
  parentSessionId: string;
  runId: string;
  /** Session id known at open; absent for not-yet-started slots. */
  actorSessionId?: string;
  siteId: string;
  ordinal: number;
  actorName?: string;
}

export interface OpenScopedWorkflowActorSessionSideTabRequest extends OpenWorkflowActorSessionSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 // **Script transcript** tab for a workflow run: every `files.*` / `git.*` / `world.run` call
 // in the script replays as a tool card.
 *
 // Same logical tier as the actor transcript (both = "what a participant in the run did"), but
 // the workspace has no session, so this is its own type rather than an actor-tab variant: the
 // panel embeds no SessionPane and draws cards itself from two journal queries. Identity is
 // **(workspace, parent session, run)** -- one tab per run regardless of which phase opened it;
 // `focusPhaseId` is only the landing spot (scroll to that phase's first card), re-applied on
 // every open.
 *
 // GC: same as `workflow-actor-session` -- **none**. Journal rows outlive the run; this replay
 // exists for post-hoc audit. Visibility narrows by `parentSessionId`.
 */
export interface WorkflowWorkspaceSidePaneTab {
  id: string;
  type: "workflow-workspace";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  /** Tool-call id that started the run: the static graph (phase names, step labels) hangs off that row, same path as the workflow-run tab. */
  toolCallId: string;
  runId: string;
  /** Display name frozen at open; title fallback when the projection is absent. */
  workflowName?: string;
  /** Landing: scroll to this phase's first card; not-yet-reached phases land at the end. Absent = stay put. */
  focusPhaseId?: string;
}

export interface OpenWorkflowWorkspaceSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  phaseId?: string;
}

export interface OpenScopedWorkflowWorkspaceSideTabRequest extends OpenWorkflowWorkspaceSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 // Full-size viewer tab for a dwf **artifact**.
 *
 // Terminology: "artifact" here is what the script publishes to the user via `artifact.*`
 // (a file / a markdown doc / a journal-projected board), **not** the engine-internal
 // `RunSettlement.artifact`, i.e. the script's top-level return value.
 *
 // Identity is **(run, artifact id)**, without version: re-publishing the same artifact is a new
 // version of the same thing, so clicking again must **focus the open tab and flip to the latest
 // version**, not stack v1/v2 side by side. `version` is therefore only the initial landing
 // (notification/hub chips carry no version; absent = latest) -- the header version stepper is
 // the real version navigation.
 *
 // ## GC: same as `workflow-run` -- **none**, do not add it
 *
 // Artifact bytes are copied into the store at publish time (publish-as-pin convention), so the
 // artifacts of a run evicted at the 8-run cap -- or of a conversation entirely rewritten by
 // edit -- remain **fully readable**: exactly why users keep this tab. Visibility is narrowed by
 // `parentSessionId`; the tab cannot leak into other conversations.
 */
export interface WorkflowArtifactSidePaneTab {
  id: string;
  type: "workflow-artifact";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /** Artifact id (compile-time literal in the script, `[A-Za-z0-9_.-]`, <= 64). */
  artifactId: string;
  /** Initial version at open; absent = latest. **Not part of tab identity** -- see the comment on the type. */
  version?: number;
  /** Display name frozen at open; title fallback when metadata is absent (cold restore / legacy CLI). */
  title?: string;
}

export interface OpenWorkflowArtifactSideTabRequest {
  parentSessionId: string;
  runId: string;
  artifactId: string;
  version?: number;
  title?: string;
  /**
   // Latest version's contentType (carried when the surface's summary has it).
   // `useAppPanels.handleOpenWorkflowArtifact` uses it to decide whether an html artifact opens
   // a browser tab directly or the artifact tab; absent always means the artifact tab.
   */
  contentType?: string;
  /**
   // Workspace-relative origin path. Only surfaces that already merged the journal (the run side
   // pane) carry it; otherwise `handleOpenWorkflowArtifact` fills it from the journal itself --
   // summaries deliberately omit it (state-frame size).
   */
  sourcePath?: string;
}

export interface OpenScopedWorkflowArtifactSideTabRequest extends OpenWorkflowArtifactSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunSideTabRequest extends OpenWorkflowRunSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunDirectorySideTabRequest extends OpenWorkflowRunDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedPlanDetailSideTabRequest extends OpenPlanDetailSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenSelectionSideChatRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  /** When the active child is confirmed gone, the host atomically replaces the corresponding old tab. */
  replacesChildSessionId?: string;
}

export interface OpenSubagentSideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface OpenSubagentDirectorySideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
}

export interface OpenScopedSubagentDirectorySideTabRequest extends OpenSubagentDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface SyncSubagentSessionTabsRequest {
  rootSessionId: string;
  parentSessionId: string;
  validChildSessionIds: readonly string[];
}

export interface OpenScopedSubagentSideTabRequest extends OpenSubagentSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type WorkspaceSidePaneTab =
  | BackgroundBashSidePaneTab
  | BrowserSidePaneTab
  | GitSidePaneTab
  | CodeViewerSidePaneTab
  | TreemappingSidePaneTab
  | WhiteboardSidePaneTab
  | ModelTrajectorySidePaneTab
  | DeveloperToolsSidePaneTab
  | TerminalSidePaneTab
  | BrowserUseSidePaneTab
  | SubagentSessionSidePaneTab
  | SubagentDirectorySidePaneTab
  | SelectionSideChatPaneTab
  | PlanDetailSidePaneTab
  | WorkflowRunSidePaneTab
  | WorkflowRunDirectorySidePaneTab
  | WorkflowActorSessionSidePaneTab
  | WorkflowWorkspaceSidePaneTab
  | WorkflowArtifactSidePaneTab;

/**
 // Browser/browser-use page and CDP lifecycles depend on `<webview>` staying connected to the
 // DOM. They must remain mounted in the background while the panel is collapsed or another
 // conversation is shown; only an explicit tab close may destroy page state.
 */
export function shouldMountSidePaneContent(
  isVisible: boolean,
  tabs: readonly WorkspaceSidePaneTab[],
): boolean {
  return (
    isVisible ||
    tabs.some(
      (tab) => tab.type === "browser" || tab.type === "browser-use" || tab.type === "bash-output",
    )
  );
}

export function shouldMountBrowserTabGuest(
  tab: BrowserSidePaneTab | BrowserUseSidePaneTab,
): boolean {
  return tab.residency !== "suspended" && tab.residency !== "suspend-pending";
}

export interface WorkspaceSidePaneState {
  tabs: WorkspaceSidePaneTab[];
  activeTabId: string;
}

export function normalizeWorkspaceSidePaneState(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  // Treemapping is currently hidden from the sidebar. Older versions may already have
  // persisted a treemapping tab in workspace-level side pane memory; filter uniformly at this
  // state boundary so the entry does not reappear after restore.
  const filteredTabs = current.tabs.filter((tab) => tab.type !== "treemapping");
  if (filteredTabs.length === 0) {
    return null;
  }

  // Selection-side-chat tabs created before multi-open introduced `ordinal` (HMR / stale
  // in-window memory) lack the field; feeding them to getNextSelectionSideChatOrdinal directly
  // yields NaN/undefined and colliding title numbers. Backfill the lowest free number per
  // parent at this state boundary, keeping existing numbers untouched.
  let migratedOrdinal = false;
  const tabs = filteredTabs.map((tab, index, allTabs) => {
    if (tab.type !== "selection-side-chat" || Number.isInteger(tab.ordinal)) {
      return tab;
    }
    // Tabs backfilled earlier in this iteration were replaced in place inside allTabs, so they naturally carry integer ordinals into the occupancy check.
    const used = new Set(
      allTabs.flatMap((candidate) =>
        candidate.type === "selection-side-chat" &&
        candidate.workspaceKey === tab.workspaceKey &&
        candidate.parentSessionId === tab.parentSessionId &&
        Number.isInteger(candidate.ordinal)
          ? [candidate.ordinal]
          : [],
      ),
    );
    let ordinal = 1;
    while (used.has(ordinal)) ordinal += 1;
    migratedOrdinal = true;
    const migrated: SelectionSideChatPaneTab = { ...tab, ordinal };
    allTabs[index] = migrated;
    return migrated;
  });

  const activeTabId =
    current.activeTabId === "" || tabs.some((tab) => tab.id === current.activeTabId)
      ? current.activeTabId
      : tabs[tabs.length - 1]!.id;
  if (
    !migratedOrdinal &&
    tabs.length === current.tabs.length &&
    activeTabId === current.activeTabId
  ) {
    return current;
  }

  return {
    tabs,
    activeTabId,
  };
}

function createBrowserSidePaneTab(options?: {
  tabId?: string;
  initialUrl?: string | null;
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  agentOpened?: boolean;
}): BrowserSidePaneTab {
  return {
    id: options?.tabId ?? `browser:${createUuid()}`,
    type: "browser",
    ...(options?.ownerTaskId !== undefined ? { ownerTaskId: options.ownerTaskId } : {}),
    ...(options?.workspaceKey !== undefined ? { workspaceKey: options.workspaceKey } : {}),
    // Human tabs never used to persist remoteSessionId, and stampSidePaneTabsOwnership only
    // backfills tabs with undefined ownerTaskId -- anything created with an ownerTaskId
    // (link/terminal URL/popup/share) permanently lacks the field under remote. The attach-side
    // renderer freezes main's owner via the workspaceRemoteSessionId fallback, but the close
    // side compares against the empty value on the tab, scope-mismatches, and the tab can never
    // be closed. Freeze at creation.
    ...(options?.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    faviconUrl: null,
    initialUrl: options?.initialUrl ?? null,
    ...(options?.agentOpened ? { agentOpened: true } : {}),
    openedAt: Date.now(),
    title: null,
  };
}

function createGitSidePaneTab(): GitSidePaneTab {
  return { id: "git", type: "git", openedAt: Date.now() };
}

function createModelTrajectorySidePaneTab(options: {
  taskId: string;
  title?: string | null;
}): ModelTrajectorySidePaneTab {
  return {
    // One tab per task, so repeated opens reuse the same trajectory.
    id: `model-trajectory:${options.taskId}`,
    type: "model-trajectory",
    openedAt: Date.now(),
    taskId: options.taskId,
    title: options.title ?? null,
  };
}

function createDeveloperToolsSidePaneTab(): DeveloperToolsSidePaneTab {
  return {
    id: "developer-tools",
    type: "developer-tools",
    openedAt: Date.now(),
  };
}

function createTerminalSidePaneTab(options: {
  title: string;
  cwd?: string;
  remoteSessionId?: string | null;
}): TerminalSidePaneTab {
  return {
    id: `terminal:${createUuid()}`,
    type: "terminal",
    openedAt: Date.now(),
    title: options.title,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
  };
}

function encodeSidePaneTabIdPart(value: string): string {
  return encodeURIComponent(value);
}

function createSubagentSessionSidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}): SubagentSessionSidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "subagent-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    subagentType: options.subagentType,
    title: options.title.trim(),
  };
}

function createSubagentDirectorySidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
}): SubagentDirectorySidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "subagent-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
  };
}

function createSelectionSideChatPaneTab(
  options: OpenSelectionSideChatRequest & {
    workspaceKey: string;
    ordinal: number;
  },
): SelectionSideChatPaneTab {
  return {
    id: [
      "selection-side-chat",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "selection-side-chat",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    ordinal: options.ordinal,
  };
}

function createPlanDetailSidePaneTab(
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): PlanDetailSidePaneTab {
  return {
    id: [
      "plan-detail",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.toolCallId),
    ].join(":"),
    type: "plan-detail",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    markdown: options.markdown,
    ...(options.planFilePath ? { planFilePath: options.planFilePath } : {}),
  };
}

function createWorkflowRunSidePaneTab(
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkflowRunSidePaneTab {
  return {
    // Structured id: one run in one workspace + session is always this tab; repeated clicks are idempotent.
    id: [
      "workflow-run",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-run",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

function createWorkflowRunDirectorySidePaneTab(
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkflowRunDirectorySidePaneTab {
  return {
    // Structured id: one run directory per conversation, so repeated footer clicks idempotently focus the same tab.
    id: [
      "workflow-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "workflow-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
  };
}

function createWorkflowActorSessionSidePaneTab(
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkflowActorSessionSidePaneTab {
  return {
    // Structured id: one slot in one workspace + conversation is always this tab; repeated clicks are idempotent.
    // Identity is (runId, siteId@ordinal), not the session id: the tab may open before the
    // session exists (unstarted pill), and opening first without and later with a session must
    // land on the same tab. runId is in the id, so same-named instances of two runs still
    // do not collide.
    id: [
      "workflow-actor-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(`${options.siteId}@${options.ordinal}`),
    ].join(":"),
    type: "workflow-actor-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    ...(options.actorSessionId ? { actorSessionId: options.actorSessionId } : {}),
    siteId: options.siteId,
    ordinal: options.ordinal,
    ...(options.actorName ? { actorName: options.actorName } : {}),
  };
}

function createWorkflowWorkspaceSidePaneTab(
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkflowWorkspaceSidePaneTab {
  return {
    // Structured id: (workspace, parent session, run). The phase is **not** in the id -- one
    // script transcript per run; opening from the plan or verify phase is the same tab, only
    // the landing differs.
    id: [
      "workflow-workspace",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-workspace",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

function createWorkflowArtifactSidePaneTab(
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkflowArtifactSidePaneTab {
  return {
    // Structured id: **no version**. v1 and v2 of one artifact are two moments of the same
    // thing; another click (notification chip / hub chip / side pane card) must focus the same
    // tab and flip to the new version, not stack two tabs.
    id: [
      "workflow-artifact",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(options.artifactId),
    ].join(":"),
    type: "workflow-artifact",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    artifactId: options.artifactId,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.title ? { title: options.title } : {}),
  };
}

function createWhiteboardSidePaneTab(options: {
  boardId: string;
  title: string;
}): WhiteboardSidePaneTab {
  return {
    id: `whiteboard:${options.boardId}`,
    type: "whiteboard",
    boardId: options.boardId,
    openedAt: Date.now(),
    title: options.title,
  };
}

function getCodeViewerTabSourceKey(source: CodeViewerSource): string | null {
  const workspaceScope = source.workspaceIdentity?.trim()
    ? source.workspaceIdentity.trim()
    : (source.workspacePath ?? "");
  const scopedKeyPrefix = workspaceScope ? `${workspaceScope}:` : "";
  // The file tree models PPTX as the generic `file` source, while reference-back opens use the
  // navigation-intent `pptx` source. The legacy key embedded source.type, splitting one
  // workspace path into two tabs. Source type is entry presentation, not file identity; narrow
  // the normalization to PPTX only, avoiding semantic creep into other preview types.
  const resourceType =
    source.type === "pptx" || (source.type === "file" && isPptxPreviewPath(source.path))
      ? "pptx"
      : source.type === "media" || (source.type === "file" && inferMediaPreview(source.path))
        ? "media"
        : source.type;

  if (
    source.type === "file" ||
    source.type === "code-review" ||
    source.type === "image" ||
    source.type === "media" ||
    source.type === "pdf" ||
    source.type === "pptx"
  ) {
    return `${scopedKeyPrefix}${resourceType}:${source.path}`;
  }

  if (source.type === "text" && source.path) {
    return `${scopedKeyPrefix}${source.type}:${source.path}`;
  }

  if (source.type === "patch") {
    // File diffs used to reuse tabs by path alone, so different patches of the same file across
    // turns overwrote each other -- "the diff panel only ever has one tab". Fold a patch content
    // hash into the key so distinct diffs coexist while repeat clicks on the same diff still
    // reuse its tab.
    return `${scopedKeyPrefix}patch:${source.path ?? source.title}:${hashCodeViewerContent(source.patch)}`;
  }

  if (source.type === "multi-file-diff") {
    return `${scopedKeyPrefix}multi-file-diff:${source.path ?? source.title}:${hashCodeViewerContent(`${source.beforeContent}\0${source.afterContent}`)}`;
  }

  return null;
}

function hashCodeViewerContent(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function createCodeViewerSidePaneTab(source: CodeViewerSource): CodeViewerSidePaneTab {
  const normalizedSource = normalizeCodeViewerSource(source);
  const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
  return {
    id: sourceKey ? `code-viewer:${sourceKey}` : `code-viewer:${createUuid()}`,
    type: "code-viewer",
    openedAt: Date.now(),
    source: normalizedSource,
    sourceKey,
  };
}

function findTabIndexById(tabs: WorkspaceSidePaneTab[], tabId: string): number {
  return tabs.findIndex((tab) => tab.id === tabId);
}

function activateSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  if (!current) {
    return {
      tabs: [tab],
      activeTabId: tab.id,
    };
  }

  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const nextTabs = [...current.tabs];
    nextTabs[existingIndex] = tab;
    return {
      tabs: nextTabs,
      activeTabId: tab.id,
    };
  }

  return {
    tabs: [...current.tabs, tab],
    activeTabId: tab.id,
  };
}

export function getActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneTab | null {
  if (!current) {
    return null;
  }

  return current.tabs.find((tab) => tab.id === current.activeTabId) ?? null;
}

/** Normalize draft-state null/undefined so the sidebar can isolate by conversation. */
export function sidePaneOwnerKey(taskId: string | null | undefined): string {
  return taskId ?? "__draft__";
}

const WORKSPACE_GLOBAL_SIDE_PANE_TAB_TYPES = new Set<WorkspaceSidePaneTab["type"]>([
  "git",
  "developer-tools",
  "treemapping",
]);

function isWorkspaceGlobalSidePaneTab(tab: WorkspaceSidePaneTab): boolean {
  return WORKSPACE_GLOBAL_SIDE_PANE_TAB_TYPES.has(tab.type);
}

interface SidePaneVisibilityScope {
  workspaceKey: string | null;
  ownerTaskId: string | null;
}

function sidePaneTabMatchesWorkspace(
  tab: WorkspaceSidePaneTab,
  activeWorkspaceKey: string | null,
): boolean {
  return tab.workspaceKey == null || tab.workspaceKey === activeWorkspaceKey;
}

/**
 // New tabs have workspace and conversation ownership frozen uniformly when committed to the
 // shared sidebar state. browser-use carries its own event-source ownership, so already-stamped
 // tabs must never be overwritten by the current UI scope.
 */
export function stampSidePaneTabsOwnership(
  state: WorkspaceSidePaneState | null,
  ownership: {
    ownerTaskId: string | null;
    workspaceKey: string | null;
    remoteSessionId?: string | null;
  },
): WorkspaceSidePaneState | null {
  if (!state) return state;
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.ownerTaskId !== undefined) return tab;
    changed = true;
    return {
      ...tab,
      ownerTaskId: ownership.ownerTaskId,
      workspaceKey: tab.workspaceKey ?? ownership.workspaceKey,
      ...((tab.type === "browser" || tab.type === "browser-use") && ownership.remoteSessionId
        ? { remoteSessionId: ownership.remoteSessionId }
        : {}),
    } as WorkspaceSidePaneTab;
  });
  return changed ? { ...state, tabs } : state;
}

function getVisibleSidePaneTabsByScope(
  tabs: WorkspaceSidePaneTab[],
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneTab[] {
  const ownerKey = sidePaneOwnerKey(scope.ownerTaskId);
  return tabs.filter((tab) => {
    if (!sidePaneTabMatchesWorkspace(tab, scope.workspaceKey)) return false;
    if (isWorkspaceGlobalSidePaneTab(tab)) return true;
    if (tab.type === "browser-use") return tab.sessionId === scope.ownerTaskId;
    if (
      tab.type === "subagent-session" ||
      tab.type === "subagent-directory" ||
      tab.type === "bash-output"
    ) {
      return tab.rootSessionId === scope.ownerTaskId;
    }
    if (
      tab.type === "selection-side-chat" ||
      tab.type === "plan-detail" ||
      tab.type === "workflow-run" ||
      tab.type === "workflow-actor-session" ||
      tab.type === "workflow-workspace" ||
      tab.type === "workflow-artifact"
    ) {
      return tab.parentSessionId === scope.ownerTaskId;
    }
    return sidePaneOwnerKey(tab.ownerTaskId) === ownerKey;
  });
}

function resolveActiveTabForOwner(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): string | null {
  if (!state) return null;
  const visibleTabs = getVisibleSidePaneTabsByScope(state.tabs, scope);
  if (visibleTabs.length === 0) return null;
  if (preferredTabId && visibleTabs.some((tab) => tab.id === preferredTabId)) {
    return preferredTabId;
  }
  if (visibleTabs.some((tab) => tab.id === state.activeTabId)) {
    return state.activeTabId;
  }
  return visibleTabs.at(-1)?.id ?? null;
}

/**
 // Resolve both the active tab and collapsed state on conversation scope switch.
 *
 // Without a preferredTabId for the target conversation, do not carry over the previous
 // conversation's collapsed state, nor blanket-override with "expand when visible tabs exist".
 // Otherwise: user collapses in A, switches to B, returns to A -- A's visible tabs would
 // auto-expand. The caller now passes the current conversation's explicit preference; only
 // without one does the default apply (visible tab -> expanded, none -> collapsed).
 */
export function resolveSidePaneScopeState(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
  collapsedPreference?: boolean,
): {
  sidePaneState: WorkspaceSidePaneState | null;
  isSidePaneCollapsed: boolean;
} {
  const activeTabId = resolveActiveTabForOwner(state, scope, preferredTabId);
  return {
    sidePaneState:
      state && state.activeTabId !== (activeTabId ?? "")
        ? { ...state, activeTabId: activeTabId ?? "" }
        : state,
    isSidePaneCollapsed: activeTabId === null ? true : (collapsedPreference ?? false),
  };
}

export function restoreSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, {
    ...tab,
    openedAt: tab.openedAt ?? Date.now(),
  });
}

function activateBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  options?: {
    tabId?: string;
    initialUrl?: string | null;
    forceNew?: boolean;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
    agentOpened?: boolean;
  },
): WorkspaceSidePaneState {
  if (!options?.forceNew && !options?.tabId && !options?.initialUrl) {
    const ownerKey = sidePaneOwnerKey(options?.ownerTaskId);
    const existingBrowserTab = current?.tabs.find(
      (tab): tab is BrowserSidePaneTab =>
        tab.type === "browser" && sidePaneOwnerKey(tab.ownerTaskId) === ownerKey,
    );
    if (existingBrowserTab) {
      return activateSidePaneTab(current, existingBrowserTab);
    }
  }

  return activateSidePaneTab(current, createBrowserSidePaneTab(options));
}

export function openBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  options?: {
    tabId?: string;
    initialUrl?: string | null;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
    activate?: boolean;
    agentOpened?: boolean;
  },
): WorkspaceSidePaneState {
  const next = activateBrowserSidePane(current, {
    ...options,
    forceNew: true,
  });
  if (options?.activate !== false) return next;
  return { ...next, activeTabId: current?.activeTabId ?? "" };
}

/**
 // Claim the browser tab for one URL within a workspace/owner.
 *
 // The caller (`useAppPanels`) must know the landing tab's id **before** it can send a
 // navigation request, so lookup and open are two steps: locate here, and
 // `openOrActivateBrowserSidePaneByUrl` lands with the same predicate. Sharing it guarantees
 // "looked-up A" and "opened B" never diverge.
 */
export function findBrowserSidePaneTabByUrl(
  current: WorkspaceSidePaneState | null,
  options: {
    initialUrl: string;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
  },
): BrowserSidePaneTab | undefined {
  const ownerKey = sidePaneOwnerKey(options.ownerTaskId);
  return current?.tabs.find(
    (tab): tab is BrowserSidePaneTab =>
      tab.type === "browser" &&
      tab.initialUrl === options.initialUrl &&
      sidePaneOwnerKey(tab.ownerTaskId) === ownerKey &&
      sidePaneTabMatchesWorkspace(tab, options.workspaceKey ?? null),
  );
}

/**
 // URL-keyed reuse: the same URL in the same workspace/session activates the existing tab.
 *
 // Two consumers: the share-handover link and direct-opening an html artifact. Both say the
 // same thing -- "take me to this address", not "open another browser". Reuse does **not**
 // modify any tab field (`initialUrl` is the key); making the webview refetch is the caller's
 // separate navigation request.
 */
export function openOrActivateBrowserSidePaneByUrl(
  current: WorkspaceSidePaneState | null,
  options: {
    initialUrl: string;
    /** Tab id to use when creating; generated when absent. Ignored when an existing tab matches. */
    tabId?: string;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
  },
): WorkspaceSidePaneState {
  const existing = findBrowserSidePaneTabByUrl(current, options);
  if (existing) return activateSidePaneTab(current, existing);
  return activateBrowserSidePane(current, {
    initialUrl: options.initialUrl,
    ...(options.tabId ? { tabId: options.tabId } : {}),
    ownerTaskId: options.ownerTaskId,
    workspaceKey: options.workspaceKey,
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
  });
}

/** Open or update a controlled browser-use tab; ready replays are idempotent per tabId. */
function openBrowserUseSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
    remoteSessionId?: string;
    title?: string;
    activate?: boolean;
  },
): WorkspaceSidePaneState {
  const id = `browser-use:${options.tabId}`;
  const existing = current?.tabs.find(
    (tab): tab is BrowserUseSidePaneTab => tab.type === "browser-use" && tab.id === id,
  );
  const remoteSessionId = options.remoteSessionId ?? existing?.remoteSessionId;
  const tab: BrowserUseSidePaneTab = {
    id,
    type: "browser-use",
    ownerTaskId: options.sessionId,
    workspaceKey: options.workspaceKey,
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: options.sessionId,
    tabId: options.tabId,
    ...(options.browserId ? { browserId: options.browserId } : {}),
    ...(options.browserGeneration !== undefined
      ? { browserGeneration: options.browserGeneration }
      : {}),
    openedAt: existing?.openedAt ?? Date.now(),
    ...((options.title ?? existing?.title)
      ? { title: options.title ?? existing?.title ?? null }
      : {}),
    ...(existing?.faviconUrl !== undefined ? { faviconUrl: existing.faviconUrl } : {}),
    ...(existing?.residency !== undefined ? { residency: existing.residency } : {}),
    ...(existing?.residencyGeneration !== undefined
      ? { residencyGeneration: existing.residencyGeneration }
      : {}),
    ...(existing?.browserUseOperationUntil !== undefined
      ? { browserUseOperationUntil: existing.browserUseOperationUntil }
      : {}),
    ...(existing?.browserUseResizeBaselineVersion !== undefined
      ? {
          browserUseResizeBaselineVersion: existing.browserUseResizeBaselineVersion,
        }
      : {}),
  };

  if (options.activate !== false) {
    return activateSidePaneTab(current, tab);
  }
  if (!current) {
    return { tabs: [tab], activeTabId: "" };
  }
  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const tabs = [...current.tabs];
    tabs[existingIndex] = tab;
    return { ...current, tabs };
  }
  return { ...current, tabs: [...current.tabs, tab] };
}

interface BrowserUseSidePaneScope {
  workspaceKey: string;
  remoteSessionId?: string;
  ownerTaskId: string | null;
}

/** ready/show events may only activate within their origin workspace + session; background events mount the guest only. */
export function applyBrowserUseSidePaneEvent(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
  },
  activeScope: BrowserUseSidePaneScope,
): { state: WorkspaceSidePaneState; shouldReveal: boolean } {
  const shouldReveal =
    options.workspaceKey === activeScope.workspaceKey &&
    (options.remoteSessionId ?? "") === (activeScope.remoteSessionId ?? "") &&
    options.sessionId === activeScope.ownerTaskId;
  return {
    state: openBrowserUseSidePane(current, {
      ...options,
      activate: shouldReveal,
    }),
    shouldReveal,
  };
}

/** visibility only selects shells already created by ready; late events must not recreate closed tabs. */
export function applyBrowserUseSidePaneVisibilityEvent(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
  },
  activeScope: BrowserUseSidePaneScope,
): {
  state: WorkspaceSidePaneState | null;
  shouldReveal: boolean;
  didMatch: boolean;
} {
  const target = current?.tabs.find(
    (tab): tab is BrowserUseSidePaneTab =>
      tab.type === "browser-use" &&
      tab.tabId === options.tabId &&
      tab.workspaceKey === options.workspaceKey &&
      (tab.remoteSessionId ?? "") === (options.remoteSessionId ?? "") &&
      tab.sessionId === options.sessionId &&
      (options.browserId === undefined || tab.browserId === options.browserId) &&
      (options.browserGeneration === undefined ||
        tab.browserGeneration === options.browserGeneration),
  );
  if (!target) {
    // The legacy visibility path reused ready's open helper. Once main has closed the tab, a
    // queued late visible=true would make the renderer rebuild a zombie shell with no main
    // authority, and a later close click would fail. visibility is a selection signal: it may
    // only hit shells whose scope/generation match exactly.
    return { state: current, shouldReveal: false, didMatch: false };
  }

  const shouldReveal =
    options.workspaceKey === activeScope.workspaceKey &&
    (options.remoteSessionId ?? "") === (activeScope.remoteSessionId ?? "") &&
    options.sessionId === activeScope.ownerTaskId;
  return {
    state: shouldReveal ? setActiveSidePaneTab(current, target.id) : current,
    shouldReveal,
    didMatch: true,
  };
}

export function applyBrowserTabResidencyEvent(
  current: WorkspaceSidePaneState | null,
  event: {
    tabId: string;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    browserId?: string;
    browserGeneration?: number;
    generation: number;
    residency: Extract<
      BrowserTabResidencyState,
      "live-visible" | "live-background" | "suspended" | "restoring"
    >;
  },
): WorkspaceSidePaneState | null {
  if (!current) return current;
  const index = current.tabs.findIndex(
    (tab) =>
      (tab.type === "browser" && tab.id === event.tabId) ||
      (tab.type === "browser-use" && tab.tabId === event.tabId),
  );
  if (index < 0) return current;
  const target = current.tabs[index] as BrowserSidePaneTab | BrowserUseSidePaneTab;
  if (event.workspaceKey !== undefined && target.workspaceKey !== event.workspaceKey)
    return current;
  if (
    Object.hasOwn(event, "remoteSessionId") &&
    (target.remoteSessionId ?? "") !== (event.remoteSessionId ?? "")
  ) {
    return current;
  }
  if (
    event.sessionId !== undefined &&
    (target.type === "browser-use"
      ? target.sessionId !== event.sessionId
      : (target.ownerTaskId ?? "unscoped") !== event.sessionId)
  ) {
    return current;
  }
  if ((target.residencyGeneration ?? 0) > event.generation) return current;
  const tabs = [...current.tabs];
  tabs[index] = {
    ...target,
    ...(target.type === "browser-use" && event.browserId ? { browserId: event.browserId } : {}),
    ...(target.type === "browser-use" && event.browserGeneration !== undefined
      ? { browserGeneration: event.browserGeneration }
      : {}),
    residency: event.residency,
    residencyGeneration: event.generation,
  };
  return { ...current, tabs };
}

export function openCodeViewerSidePane(
  current: WorkspaceSidePaneState | null,
  source: CodeViewerSource,
  ownerTaskId?: string | null,
): WorkspaceSidePaneState {
  // Repeated clicks on the same file/image in a conversation must not replace the whole side
  // pane -- content the user just read in another pane would vanish. Reuse the existing code
  // viewer tab by stable sourceKey: no pile-up of same-named tabs, and a re-open refreshes to
  // the latest source.
  const nextTab = createCodeViewerSidePaneTab(source);
  if (!current || nextTab.sourceKey === null) {
    return activateSidePaneTab(current, nextTab);
  }

  const ownerKey = sidePaneOwnerKey(ownerTaskId);
  const matchedTab = current.tabs.find(
    (tab): tab is CodeViewerSidePaneTab =>
      tab.type === "code-viewer" &&
      tab.sourceKey === nextTab.sourceKey &&
      sidePaneOwnerKey(tab.ownerTaskId) === ownerKey,
  );
  return activateSidePaneTab(
    current,
    matchedTab ? { ...matchedTab, source: nextTab.source } : nextTab,
  );
}

/**
 // Open a batch of code preview tabs atomically.
 *
 // Auto-opening generated artifacts must not call openCodeViewerSidePane per item: each commit
 // would push the side pane through intermediate states and the last item would end up active
 // by accident. Reuse the single-file sourceKey/owner rules in one batch, then activate the one
 // tab in the caller-specified order.
 */
export function openCodeViewerSidePanes(
  current: WorkspaceSidePaneState | null,
  sources: readonly CodeViewerSource[],
  ownerTaskId?: string | null,
  activeIndex = 0,
): WorkspaceSidePaneState {
  if (sources.length === 0) {
    return current ?? { tabs: [], activeTabId: "" };
  }

  let next: WorkspaceSidePaneState | null = current;
  const openedTabIds: string[] = [];
  const seenSourceKeys = new Set<string>();

  for (const source of sources) {
    const normalizedSource = normalizeCodeViewerSource(source);
    const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
    // sourceKey is the workspace-scoped stable identity; duplicate paths in one batch open once.
    if (sourceKey !== null && seenSourceKeys.has(sourceKey)) continue;
    if (sourceKey !== null) seenSourceKeys.add(sourceKey);

    next = openCodeViewerSidePane(next, normalizedSource, ownerTaskId);
    const activeTab = getActiveSidePaneTab(next);
    if (activeTab?.type === "code-viewer") {
      openedTabIds.push(activeTab.id);
    }
  }

  if (!next || openedTabIds.length === 0) {
    return next ?? { tabs: [], activeTabId: "" };
  }

  const safeIndex = Math.min(Math.max(activeIndex, 0), openedTabIds.length - 1);
  return {
    ...next,
    activeTabId: openedTabIds[safeIndex]!,
  };
}

export function activateGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createGitSidePaneTab());
}

export function openWhiteboardSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    boardId: string;
    title: string;
  },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createWhiteboardSidePaneTab(options));
}

export function openModelTrajectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    taskId: string;
    title?: string | null;
  },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createModelTrajectorySidePaneTab(options));
}

export function activateDeveloperToolsSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createDeveloperToolsSidePaneTab());
}

export function openTerminalSidePane(
  current: WorkspaceSidePaneState | null,
  options: { title: string; cwd?: string; remoteSessionId?: string | null },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createTerminalSidePaneTab(options));
}

export function openSubagentSessionSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    rootSessionId?: string;
    parentSessionId: string;
    childSessionId: string;
    subagentType: string;
    title: string;
  },
): WorkspaceSidePaneState {
  const nextTab = createSubagentSessionSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is SubagentSessionSidePaneTab =>
      tab.type === "subagent-session" && tab.id === nextTab.id,
  );
  const nextTitle = options.title.trim();
  return activateSidePaneTab(
    current,
    existing
      ? {
          ...existing,
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
          rootSessionId: options.rootSessionId ?? options.parentSessionId,
          parentSessionId: options.parentSessionId,
          subagentType: options.subagentType,
          // HMR can resurrect memory tabs built on the old shape; keep the known title when
          // the new entry has none, but never fall back to the legacy type + ordinal display.
          title: nextTitle || existing.title || "",
        }
      : nextTab,
  );
}

export function openSubagentDirectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    rootSessionId?: string;
    parentSessionId: string;
  },
): WorkspaceSidePaneState {
  const nextTab = createSubagentDirectorySidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is SubagentDirectorySidePaneTab =>
      tab.type === "subagent-directory" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

export function syncSubagentSessionSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  options: SyncSubagentSessionTabsRequest,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const validChildSessionIds = new Set(options.validChildSessionIds);
  const removedTabs = current.tabs.filter(
    (tab) =>
      tab.type === "subagent-session" &&
      tab.rootSessionId === options.rootSessionId &&
      tab.parentSessionId === options.parentSessionId &&
      !validChildSessionIds.has(tab.childSessionId),
  );
  if (removedTabs.length === 0) return current;
  const removedIds = new Set(removedTabs.map((tab) => tab.id));
  const tabs = current.tabs.filter((tab) => !removedIds.has(tab.id));
  if (tabs.length === 0) return null;
  if (!removedIds.has(current.activeTabId)) return { ...current, tabs };
  const directory = tabs.find(
    (tab) => tab.type === "subagent-directory" && tab.rootSessionId === options.rootSessionId,
  );
  if (directory) return { tabs, activeTabId: directory.id };
  const removedIndex = current.tabs.findIndex((tab) => tab.id === current.activeTabId);
  const previous = tabs[Math.max(0, Math.min(removedIndex - 1, tabs.length - 1))];
  return { tabs, activeTabId: previous?.id ?? tabs.at(-1)!.id };
}

export function openSelectionSideChatPane(
  current: WorkspaceSidePaneState | null,
  options: OpenSelectionSideChatRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const existing = current?.tabs.find(
    (tab): tab is SelectionSideChatPaneTab =>
      tab.type === "selection-side-chat" &&
      tab.workspaceKey === options.workspaceKey &&
      tab.parentSessionId === options.parentSessionId &&
      tab.childSessionId === options.childSessionId,
  );
  const ordinal =
    existing?.ordinal ??
    getNextSelectionSideChatOrdinal(
      current?.tabs ?? [],
      options.workspaceKey,
      options.parentSessionId,
    );
  const nextTab = createSelectionSideChatPaneTab({ ...options, ordinal });
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

function getNextSelectionSideChatOrdinal(
  tabs: readonly WorkspaceSidePaneTab[],
  workspaceKey: string,
  parentSessionId: string,
): number {
  const used = new Set(
    tabs.flatMap((tab) =>
      tab.type === "selection-side-chat" &&
      tab.workspaceKey === workspaceKey &&
      tab.parentSessionId === parentSessionId
        ? [tab.ordinal]
        : [],
    ),
  );
  let ordinal = 1;
  while (used.has(ordinal)) ordinal += 1;
  return ordinal;
}

export function getActiveSelectionSideChatTab(
  current: WorkspaceSidePaneState | null,
  scope: { workspaceKey: string; parentSessionId: string },
): SelectionSideChatPaneTab | null {
  const active = getActiveSidePaneTab(current);
  return active?.type === "selection-side-chat" &&
    active.workspaceKey === scope.workspaceKey &&
    active.parentSessionId === scope.parentSessionId
    ? active
    : null;
}

export function openPlanDetailSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createPlanDetailSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is PlanDetailSidePaneTab => tab.type === "plan-detail" && tab.id === nextTab.id,
  );
  // One tab per toolCall; a repeat click refreshes the fallback from the card's current body,
  // while the detail component's live body remains authoritative from the parent conversation
  // projection.
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 // Open or reuse a workflow run detail tab.
 *
 // Reuse mirrors plan-detail (structured id, idempotent) and deliberately has **no GC either**:
 // the event log reads the journal while the `workflowRuns` projection keeps only the last 8
 // runs, so an evicted run still has a fully readable event log -- exactly why users keep this
 // tab. A missing projection degrades to the detail page's empty state; the tab stays open.
 */
export function openWorkflowRunSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowRunSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowRunSidePaneTab => tab.type === "workflow-run" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  // Landing is recomputed every time (same rule as the script transcript tab): a phaseId in
  // the request lands there, otherwise delete the key explicitly; `openedAt` refreshes on each
  // open so the panel re-scrolls when the same phase is clicked again.
  const merged: WorkflowRunSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.focusPhaseId === undefined) delete merged.focusPhaseId;
  return activateSidePaneTab(current, merged);
}

/**
 // In-place replacement after "configure" is accepted: the old run's tab becomes the new run's
 // tab -- same slot, name, and ownership -- and only if it was the active tab does the new tab
 // become active. When the new run's tab is already open, close the old one and focus the
 // existing (never two). With no old tab (user closed it) return state unchanged -- replace is
 // not open; likewise when the resulting run already is the replaced one (an in-place revision
 // has no successor).
 */
export function replaceWorkflowRunSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string; replaceRunId: string },
): WorkspaceSidePaneState | null {
  if (current === null) return current;
  const nextTab = createWorkflowRunSidePaneTab(options);
  const replaceRunId = options.replaceRunId;
  const index = current.tabs.findIndex(
    (tab) =>
      tab.type === "workflow-run" &&
      tab.workspaceKey === nextTab.workspaceKey &&
      tab.parentSessionId === nextTab.parentSessionId &&
      tab.runId === replaceRunId,
  );
  const previous = current.tabs[index];
  if (index < 0 || previous?.type !== "workflow-run") return current;
  // An in-place revision (concurrency limit only, run still running) has no successor: the
  // resulting runId is the replaced one. The tab id is minted from runId alone, so without this
  // guard the "new tab already open" branch below would recognize itself, close this tab, and
  // leave an activeTabId pointing at a nonexistent tab.
  if (nextTab.id === previous.id) return current;
  const wasActive = current.activeTabId === previous.id;
  const existingIndex = findTabIndexById(current.tabs, nextTab.id);
  if (existingIndex >= 0) {
    const tabs = current.tabs.filter((_, tabIndex) => tabIndex !== index);
    return { tabs, activeTabId: wasActive ? nextTab.id : current.activeTabId };
  }
  const replaced: WorkflowRunSidePaneTab = {
    ...nextTab,
    ...(previous.ownerTaskId === undefined ? {} : { ownerTaskId: previous.ownerTaskId }),
    ...(nextTab.workflowName === undefined && previous.workflowName !== undefined
      ? { workflowName: previous.workflowName }
      : {}),
  };
  const tabs = [...current.tabs];
  tabs[index] = replaced;
  return { tabs, activeTabId: wasActive ? replaced.id : current.activeTabId };
}

/**
 // Open or reuse a conversation's run directory tab. Identity is the conversation, so repeated
 // footer clicks only focus.
 *
 // GC is likewise **absent** (same reasoning chain as workflow-run): the directory page re-reads
 // a journal page on every mount, so a restored stale tab never shows a stale roster -- there is
 // nothing to reclaim.
 */
export function openWorkflowRunDirectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowRunDirectorySidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowRunDirectorySidePaneTab =>
      tab.type === "workflow-directory" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 // Open or reuse an actor transcript tab.
 *
 // Reuse mirrors workflow-run (structured id, idempotent); GC is likewise **absent**: actor
 // sessions stay readable after the run ends -- that is what promoting them to real persistent
 // sessions bought. See the comment on the type.
 *
 // On merge, keys absent from the new request do not overwrite old values: opening first from
 // an unstarted pill (no session id) and then from a started one (with id) fills the session in;
    the reverse -- a later request without a session id -- never wipes a known session id.
 */
export function openWorkflowActorSessionSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowActorSessionSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowActorSessionSidePaneTab =>
      tab.type === "workflow-actor-session" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 // Open or reuse a run's script transcript tab.
 *
 // The landing is **recomputed every time**: clicking a script pill means "take me to that
 // phase", so a phaseId in the request lands there and its absence clears the landing (explicit
 // key delete, same treatment as version in `openWorkflowArtifactSidePane`). `openedAt`
 // refreshes on each open so the panel re-scrolls when the same phase is clicked again.
 */
export function openWorkflowWorkspaceSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowWorkspaceSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowWorkspaceSidePaneTab =>
      tab.type === "workflow-workspace" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  const merged: WorkflowWorkspaceSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.focusPhaseId === undefined) delete merged.focusPhaseId;
  return activateSidePaneTab(current, merged);
}

/**
 // Open or reuse an artifact's full-size tab.
 *
 // Reuse does **not keep the old tab's version**: clicking a chip means "show me this artifact",
 // and chips never carry a version, so an absent `version` in the merged result means back to
 // latest. Conversely, an explicit version in the request (e.g. a future deep link) is the landing.
 */
export function openWorkflowArtifactSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowArtifactSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowArtifactSidePaneTab =>
      tab.type === "workflow-artifact" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  // On merge, **drop the old tab's version**: keys absent from `...nextTab` do not overwrite,
  // which is exactly where "no version on the chip => back to latest" would be silently broken
  // (old tab stuck on v1, another click still on v1). Delete the key explicitly so absent
  // really means absent.
  const merged: WorkflowArtifactSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.version === undefined) delete merged.version;
  return activateSidePaneTab(current, merged);
}

export function isSidePaneTabVisibleForParent(
  tab: WorkspaceSidePaneTab,
  parentSessionId: string | null,
): boolean {
  if (tab.type === "browser-use") {
    return tab.sessionId === parentSessionId;
  }
  // Conversation-scoped (not workspace-global) tabs narrow by parentSessionId.
  if (
    tab.type === "selection-side-chat" ||
    tab.type === "plan-detail" ||
    tab.type === "workflow-run" ||
    tab.type === "workflow-directory" ||
    tab.type === "workflow-actor-session" ||
    tab.type === "workflow-workspace" ||
    tab.type === "workflow-artifact"
  ) {
    return tab.parentSessionId === parentSessionId;
  }
  if (
    tab.type === "subagent-session" ||
    tab.type === "subagent-directory" ||
    tab.type === "bash-output"
  ) {
    return tab.rootSessionId === parentSessionId;
  }
  return true;
}

export function getVisibleSidePaneTabs(
  tabs: WorkspaceSidePaneTab[],
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneTab[];
export function getVisibleSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  parentSessionId: string | null,
): WorkspaceSidePaneTab[];
export function getVisibleSidePaneTabs(
  input: WorkspaceSidePaneTab[] | WorkspaceSidePaneState | null,
  scopeOrParent: SidePaneVisibilityScope | string | null,
): WorkspaceSidePaneTab[] {
  if (Array.isArray(input)) {
    return getVisibleSidePaneTabsByScope(input, scopeOrParent as SidePaneVisibilityScope);
  }
  const parentSessionId = scopeOrParent as string | null;
  return input?.tabs.filter((tab) => isSidePaneTabVisibleForParent(tab, parentSessionId)) ?? [];
}

function selectSidePaneTabsForParent(
  current: WorkspaceSidePaneState | null,
  parentSessionId: string | null,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const visibleTabs = getVisibleSidePaneTabs(current, parentSessionId);
  if (visibleTabs.length === 0) {
    return current.activeTabId === "" ? current : { ...current, activeTabId: "" };
  }
  const preferred = preferredTabId
    ? visibleTabs.find((tab) => tab.id === preferredTabId)
    : undefined;
  const currentActive = visibleTabs.find((tab) => tab.id === current.activeTabId);
  const nextActive =
    currentActive ??
    preferred ??
    visibleTabs.findLast(
      (tab) =>
        tab.type === "subagent-session" ||
        tab.type === "subagent-directory" ||
        tab.type === "selection-side-chat" ||
        tab.type === "plan-detail" ||
        tab.type === "workflow-run" ||
        tab.type === "workflow-actor-session" ||
        tab.type === "workflow-workspace" ||
        tab.type === "workflow-artifact",
    ) ??
    visibleTabs.at(-1);
  return nextActive && nextActive.id !== current.activeTabId
    ? { ...current, activeTabId: nextActive.id }
    : current;
}

export function closeVisibleOtherSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  parentSessionId: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const visibleTabs = getVisibleSidePaneTabs(current, parentSessionId);
  const target = visibleTabs.find((tab) => tab.id === tabId);
  if (!target) return current;
  const closingIds = new Set(visibleTabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id));
  return {
    tabs: current.tabs.filter((tab) => !closingIds.has(tab.id)),
    activeTabId: target.id,
  };
}

export function closeVisibleSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  parentSessionId: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const closingIds = new Set(getVisibleSidePaneTabs(current, parentSessionId).map((tab) => tab.id));
  const tabs = current.tabs.filter((tab) => !closingIds.has(tab.id));
  return tabs.length === 0 ? null : { tabs, activeTabId: "" };
}

export function closeSidePaneTabForParent(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  parentSessionId: string | null,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  const next = closeSidePaneTab(current, tabId);
  return selectSidePaneTabsForParent(next, parentSessionId, preferredTabId);
}

export function closeSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  const closingIndex = findTabIndexById(current.tabs, tabId);
  if (closingIndex < 0) {
    return current;
  }

  const nextTabs = current.tabs.filter((tab) => tab.id !== tabId);
  if (nextTabs.length === 0) {
    return null;
  }

  if (current.activeTabId !== tabId) {
    return {
      tabs: nextTabs,
      activeTabId: current.activeTabId,
    };
  }

  const fallbackIndex = Math.min(closingIndex, nextTabs.length - 1);
  return {
    tabs: nextTabs,
    activeTabId: nextTabs[fallbackIndex]!.id,
  };
}

export function setActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current || !current.tabs.some((tab) => tab.id === tabId)) {
    return current;
  }

  return {
    ...current,
    activeTabId: tabId,
  };
}

export function updateBrowserSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  patch: BrowserSidePaneMetadata,
): WorkspaceSidePaneState | null {
  if (!current) {
    return current;
  }

  let didUpdate = false;
  const nextTabs = current.tabs.map((tab) => {
    if (tab.id !== tabId) {
      return tab;
    }
    if (tab.type === "browser" || tab.type === "browser-use") {
      didUpdate = true;
      return { ...tab, ...patch };
    }
    return tab;
  });

  return didUpdate
    ? {
        ...current,
        tabs: nextTabs,
      }
    : current;
}

// <arg_value>/** Match running state on the full workspace/session/browser generation/tab key, preventing stale-run cross-writes. */
export function markBrowserUseSidePaneTabOperation(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    operationUntil: number;
    resetsResizeBaseline?: boolean;
  },
): WorkspaceSidePaneState | null {
  if (!current) return current;
  let didUpdate = false;
  const tabs = current.tabs.map((tab) => {
    if (
      tab.type !== "browser-use" ||
      tab.workspaceKey !== options.workspaceKey ||
      tab.sessionId !== options.sessionId ||
      (tab.browserId !== undefined && tab.browserId !== options.browserId) ||
      (tab.browserGeneration !== undefined &&
        tab.browserGeneration !== options.browserGeneration) ||
      tab.tabId !== options.tabId
    ) {
      return tab;
    }
    didUpdate = true;
    return {
      ...tab,
      browserUseOperationUntil: options.operationUntil,
      ...(options.resetsResizeBaseline
        ? {
            browserUseResizeBaselineVersion: (tab.browserUseResizeBaselineVersion ?? 0) + 1,
          }
        : {}),
    };
  });
  return didUpdate ? { ...current, tabs } : current;
}

export function reorderSidePaneTab(
  current: WorkspaceSidePaneState | null,
  activeTabId: string,
  overTabId: string,
): WorkspaceSidePaneState | null {
  if (!current || activeTabId === overTabId) {
    return current;
  }

  const activeIndex = findTabIndexById(current.tabs, activeTabId);
  const overIndex = findTabIndexById(current.tabs, overTabId);
  if (activeIndex < 0 || overIndex < 0) {
    return current;
  }

  const nextTabs = [...current.tabs];
  const [movedTab] = nextTabs.splice(activeIndex, 1);
  if (!movedTab) {
    return current;
  }

  nextTabs.splice(overIndex, 0, movedTab);
  return {
    ...current,
    tabs: nextTabs,
  };
}

export function toggleBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  ownerTaskId?: string | null,
  remoteSessionId?: string | null,
): WorkspaceSidePaneState | null {
  const ownerKey = sidePaneOwnerKey(ownerTaskId);
  const activeTab = getActiveSidePaneTab(current);
  if (activeTab?.type === "browser" && sidePaneOwnerKey(activeTab.ownerTaskId) === ownerKey) {
    return closeSidePaneTab(current, activeTab.id);
  }

  return activateBrowserSidePane(current, {
    ownerTaskId,
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
}

export function toggleGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  const activeTab = getActiveSidePaneTab(current);
  if (activeTab?.type === "git") {
    return closeSidePaneTab(current, activeTab.id);
  }

  return activateGitSidePane(current);
}

export function closeCodeViewerSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  const activeTab = getActiveSidePaneTab(current);
  return activeTab?.type === "code-viewer" ? closeSidePaneTab(current, activeTab.id) : current;
}

export function closeGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  return closeSidePaneTab(current, "git");
}

export function openBackgroundBashSidePane(
  current: WorkspaceSidePaneState | null,
  target: OpenBackgroundBashSideTabRequest,
): WorkspaceSidePaneState {
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const id =
    "bash-output:" +
    [
      workspaceKey,
      target.remoteSessionId ?? "",
      target.rootSessionId,
      target.sessionId,
      target.workId,
    ]
      .map(encodeSidePaneTabIdPart)
      .join(":");
  const existing = current?.tabs.find((tab) => tab.id === id);
  return activateSidePaneTab(
    current,
    existing ?? {
      ...target,
      id,
      type: "bash-output",
      workspaceKey,
      ownerTaskId: target.rootSessionId,
      openedAt: Date.now(),
    },
  );
}
