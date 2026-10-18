/* oxlint-disable eslint(max-lines) -- ZCode agent store types and default state are exported here centrally, avoiding duplicated shared structs across slices. */
/**
 * ZCode session store type definitions, interfaces, constants and default-state factories.
 *
 * Split out of zcodeSessionStore.ts; shared by the store core and submodules such as selectors / navigation.
 */
import {
  buildNativeSupplierKey,
  ZCODE_AGENT_PROVIDER,
  type ZCodeApiRetryStatus,
  type ModelSelectionGhostReason,
  type ModelSelectionResolution,
  type ZCodeWorkspaceInitStatus,
  type ZCodeTaskRuntimeStatus,
  type ZCodeProvider,
  type ZCodeTaskMeta,
  type ZCodeContextCacheUsage,
  type ZCodeConfigOption,
  type ZCodeSlashCommand,
  type ZCodePermissionRequest,
  type ZCodeElicitationRequest,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeSessionActiveTurnKind,
  type ZCodeContextUsageBreakdownItem,
  type InputId,
  type SessionCreateSource,
} from "@zcode/shared";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import type {
  AutomationsNavigationTab,
  TaskNavigationHistory,
  WorkspaceNavEntry,
} from "@/lib/taskNavigationHistory.js";
import type { MentionCategory, MentionItemData } from "@/mentions/mentionTypes.js";

// ────────────────────────────────────────────
// Interfaces
// ────────────────────────────────────────────

export interface WorkspaceInitState {
  status: ZCodeWorkspaceInitStatus;
  error: string | null;
  attempts: number;
}

export type GroupedDraftTaskPlacement = { type: "top" } | { type: "group"; groupId: string };

export interface GroupedDraftTaskState {
  draftId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  placement: GroupedDraftTaskPlacement;
  createdAt: number;
}

export interface TaskRuntimeState {
  status: ZCodeTaskRuntimeStatus;
  error: string | null;
  /** ZCode agent process provider bound to this task's current run; used for the workspace-level process-rebuild busy lock. */
  provider?: ZCodeProvider;
  /** Current model context window capacity; model status events update only this, never the real usage.used. */
  contextWindow: number | null;
  usage: TaskUsageState | null;
  apiRetry: ZCodeApiRetryStatus | null;
  /** Background-task controls explicitly reported by the agent; host runtime state, never persisted. */
  backgroundTaskControls: ZCodeBackgroundTaskControlItem[];
  /** Type of the current session active turn; separates normal generation from compact maintenance. */
  activeTurnKind?: ZCodeSessionActiveTurnKind;
  activeInputId?: InputId;
  activeInputOwnerClientId?: string;
}

export interface DraftRuntimeState {
  status: ZCodeTaskRuntimeStatus;
  error: string | null;
}

export interface TaskUsageState {
  /** Tokens used in the current context window */
  used: number;
  /** Total token capacity of the current context window */
  size: number;
  /** Cumulative cost reported by the agent */
  cost?: { amount: number; currency: string } | null;
  /** Current-turn cache hit info returned by the agent/app protocol. */
  cache?: ZCodeContextCacheUsage;
  /** Context characters estimated per source; only for the context-usage popup ratio. */
  breakdown?: ZCodeContextUsageBreakdownItem[];
}

export interface ElicitationAnswerDraft {
  selectedValues: string[];
  customAnswer: string;
}

export interface ElicitationFormDraft {
  questionIndex: number;
  drafts: Record<string, ElicitationAnswerDraft>;
}

/**
 * Store end state: TaskUiState narrows to "manual-interaction surfaces still needing remote replay" -
 * pending permission/question dialog queues, renderer-local question drafts + error banner. Writers for legacy ChatView
 * display state (plan/goal/token debug) were removed with the legacy protocol; reads are served by the v4 conversation projection.
 */
export interface TaskUiState {
  permissionRequest: ZCodePermissionRequest | null;
  pendingPermissionRequests: ZCodePermissionRequest[];
  elicitationRequest: ZCodeElicitationRequest | null;
  pendingElicitationRequests: ZCodeElicitationRequest[];
  elicitationFormDraftsByRequestId: Record<string, ElicitationFormDraft>;
  error: ZCodeUiError | null;
}

export type ModelSwitchStage =
  | "idle"
  | "settingModel"
  | "fallbackConfigOption"
  | "applyingCustomProvider"
  | "restartingRuntime"
  | "syncingSession"
  | "persistingWorkspace";

export type ConfigOptionsStatus = "idle" | "loading" | "ready" | "error";

export interface ComposerMentionPrefill {
  id: string;
  category: MentionCategory;
  label: string;
  value: string;
  markdown: string;
  description?: string;
  data?: MentionItemData;
}

export interface ComposerTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

export interface TimelineBottomRequest {
  requestId: number;
  taskId: string;
}

export interface WorkspaceZCodeUIState {
  /** Task currently active in this workspace */
  activeTaskId: string | null;
  /**
   * ZCode agent workspace initialization state.
   *
   * After the single-ZCode-Agent migration, bucketing by provider would keep several stale states no runtime updates,
   * and task/draft/remote-identity switches could read a historical provider ready/failed. State is now a single
   * workspace-level source of truth; the provider argument remains only for legacy call compatibility.
   */
  workspaceInit: WorkspaceInitState;
  /** Short-lived run state before a draft has a taskId; an existing task's state derives from taskRuntimeByTaskId. */
  draftRuntime: DraftRuntimeState;
  /** Agent draft session behind an unsent draft; not listed, promoted to a real task on first send. */
  draftSessionId: string | null;
  /**
   * Draft runtime-capability invalidation version; incremented when plugin/skill abilities change.
   * Legacy drafts close via draftSessionId; protocol-v4 drafts use this version to rebuild the pane warmup session.
   */
  draftRuntimeInvalidationVersion: number;
  composerTextInsertVersion: number;
  composerTextInsertRequest: ComposerTextInsertRequest | null;
  timelineBottomRequestVersion: number;
  timelineBottomRequest: TimelineBottomRequest | null;
  /** Draft errors must survive page switches so the notice is not unmounted together with local state */
  draftError: ZCodeUiError | null;
  /** Concurrency-guard requestId for model switches; only the latest request may land */
  modelSwitchRequestId: string | null;
  /** Whether a model switch is in progress (gates sending, toolbar loading) */
  modelSwitchPending: boolean;
  /** Model-switch phase (for fine-grained loading copy) */
  modelSwitchStage: ModelSwitchStage;
  /** Per-task runtime state, for the task list and status bar to read real task state */
  taskRuntimeByTaskId: Record<string, TaskRuntimeState>;
  /** Per-task transient UI state, so the plan panel and permission dialogs survive task switches */
  taskUiByTaskId: Record<string, TaskUiState>;
  taskConfigOptionsByTaskId: Record<string, ZCodeConfigOption[]>;
  taskConfigOptionsStatusByTaskId: Record<string, ConfigOptionsStatus>;
  /** Compat cache for task unread state; real unread state lives in task meta.unreadAt */
  taskUnreadByTaskId: Record<string, boolean>;
  /** Optimistic task-list metadata, covering the lag before a new task is persisted in the left list */
  optimisticTaskListByTaskId: Record<string, ZCodeTaskMeta>;
  /** UI-only draft anchor after New task in grouped mode; not part of the real task index. */
  groupedDraftTask: GroupedDraftTaskState | null;
  /** Entry point that started the current draft; warmup does not change the origin. */
  draftCreateSource: SessionCreateSource;
  /** Between first-send creation and the grouped sqlite order landing, the real task inherits the draft anchor local slot. */
  promotedGroupedDraftTaskByTaskId: Record<string, GroupedDraftTaskState>;
  /** ZCode agent provider selected for this workspace */
  selectedProvider: ZCodeProvider;
  /** Current provider selection key (native/custom/ghost) */
  selectedSupplierKey: string;
  /** Whether the current provider is in ghost state */
  isGhostSupplier: boolean;
  /** Where the current ghost state came from */
  supplierMismatchReason: ModelSelectionGhostReason | null;
  /** ZCode agent configOptions (model, mode, thinking level, ...) */
  configOptions: ZCodeConfigOption[] | null;
  /** configOptions load state */
  configOptionsStatus: ConfigOptionsStatus;
  /** Available slash commands */
  slashCommands: ZCodeSlashCommand[];
  /** Task-list version, bumped on every create/delete to drive TaskList refresh */
  taskListVersion: number;
  /** Cached fetched task list, avoiding flicker when components remount */
  taskListCache: ZCodeTaskMeta[] | null;
  /** Incremented on new draft; drives the input to focus after switching to the draft */
  draftFocusVersion: number;
}

export interface ZCodeSessionStoreState {
  /** Chat-related UI state, keyed by workspace */
  workspaces: Record<string, WorkspaceZCodeUIState>;
  getWorkspaceState: (workspacePath: string, workspaceIdentity?: string) => WorkspaceZCodeUIState;

  setActiveTaskId: (workspacePath: string, id: string | null, workspaceIdentity?: string) => void;
  promoteGroupedDraftTask: (
    workspacePath: string,
    taskId: string,
    draft: GroupedDraftTaskState,
    workspaceIdentity?: string,
  ) => void;
  clearPromotedGroupedDraftTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => void;
  setDraftSessionId: (
    workspacePath: string,
    sessionId: string | null,
    workspaceIdentity?: string,
  ) => void;
  invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => void;
  requestComposerTextInsert: (
    workspacePath: string,
    text: string,
    workspaceIdentity?: string,
    mention?: ComposerMentionPrefill,
    mode?: "replace" | "prepend-if-missing",
  ) => number;
  clearComposerTextInsertRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  requestTimelineBottom: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => number;
  clearTimelineBottomRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  startDraft: (
    workspacePath: string,
    provider?: ZCodeProvider,
    workspaceIdentity?: string,
    options?: {
      groupedDraftPlacement?: GroupedDraftTaskPlacement;
      createSource?: SessionCreateSource;
    },
  ) => void;
  clearGroupedDraftTask: (workspacePath: string, workspaceIdentity?: string) => void;
  bindRuntimeProvider: (
    workspacePath: string,
    provider: ZCodeProvider,
    workspaceIdentity?: string,
  ) => void;
  setModelSelectionResolution: (
    workspacePath: string,
    resolution: Pick<
      ModelSelectionResolution,
      "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
    >,
    workspaceIdentity?: string,
  ) => void;
  setWorkspaceInitState: (
    workspacePath: string,
    status: ZCodeWorkspaceInitStatus,
    error?: string | null,
    workspaceIdentity?: string,
  ) => void;
  setWorkspaceInitAttempts: (
    workspacePath: string,
    attempts: number,
    workspaceIdentity?: string,
  ) => void;
  setTaskState: (
    workspacePath: string,
    status: ZCodeTaskRuntimeStatus,
    error?: string | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskRuntimeState: (
    workspacePath: string,
    taskId: string,
    status: ZCodeTaskRuntimeStatus,
    error?: string | null,
    workspaceIdentity?: string,
    provider?: ZCodeProvider,
  ) => void;
  setTaskUsage: (
    workspacePath: string,
    taskId: string,
    usage: TaskUsageState | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskContextWindow: (
    workspacePath: string,
    taskId: string,
    contextWindow: number | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskApiRetryStatus: (
    workspacePath: string,
    taskId: string,
    apiRetry: ZCodeApiRetryStatus | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskPermissionRequest: (
    workspacePath: string,
    taskId: string,
    request: ZCodePermissionRequest | null,
    workspaceIdentity?: string,
  ) => void;
  removeTaskPermissionRequest: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskElicitationRequest: (
    workspacePath: string,
    taskId: string,
    request: ZCodeElicitationRequest | null,
    workspaceIdentity?: string,
  ) => void;
  removeTaskElicitationRequest: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskElicitationFormDraft: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    draft: ElicitationFormDraft,
    workspaceIdentity?: string,
  ) => void;
  removeTaskElicitationFormDraft: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskError: (
    workspacePath: string,
    taskId: string,
    error: ZCodeUiError | null,
    workspaceIdentity?: string,
  ) => void;
  setDraftError: (
    workspacePath: string,
    error: ZCodeUiError | null,
    workspaceIdentity?: string,
  ) => void;
  startModelSwitch: (
    workspacePath: string,
    requestId: string,
    stage?: ModelSwitchStage,
    workspaceIdentity?: string,
    options?: { pending?: boolean },
  ) => void;
  updateModelSwitchStage: (
    workspacePath: string,
    requestId: string,
    stage: ModelSwitchStage,
    workspaceIdentity?: string,
  ) => void;
  finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => void;
  setTaskConfigOptions: (
    workspacePath: string,
    taskId: string,
    options: ZCodeConfigOption[],
    workspaceIdentity?: string,
    status?: ConfigOptionsStatus,
  ) => void;
  initializeBackgroundTaskRuntime: (
    workspacePath: string,
    params: {
      task: ZCodeTaskMeta;
      provider: ZCodeProvider;
      activeInputId: InputId;
      workspaceIdentity?: string;
    },
  ) => void;
  upsertOptimisticTaskListItem: (
    workspacePath: string,
    task: ZCodeTaskMeta,
    workspaceIdentity?: string,
  ) => void;
  removeOptimisticTaskListItem: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => void;
  /** After a task is deleted, recycle its selection and optimistic state so the right side stops showing it */
  removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;

  setConfigOptions: (
    workspacePath: string,
    options: ZCodeConfigOption[],
    workspaceIdentity?: string,
  ) => void;
  setConfigOptionsStatus: (
    workspacePath: string,
    status: "idle" | "loading" | "ready" | "error",
    workspaceIdentity?: string,
  ) => void;
  setSlashCommands: (
    workspacePath: string,
    commands: ZCodeSlashCommand[],
    workspaceIdentity?: string,
  ) => void;
  setCurrentModeId: (
    workspacePath: string,
    modeId: string | null,
    workspaceIdentity?: string,
  ) => void;
  /** Invoked on task-list changes (create/delete); drives zcodeTaskMetaMerge to refetch the list */
  bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => void;
  /** Update the cached fetched task list */
  setTaskListCache: (
    workspacePath: string,
    tasks: ZCodeTaskMeta[],
    workspaceIdentity?: string,
  ) => void;
  /** Update a task unread hint, controlling the left-list blue dot */
  setTaskUnreadIndicator: (
    workspacePath: string,
    taskId: string,
    hasUnread: boolean,
    workspaceIdentity?: string,
  ) => void;

  /** Workspace navigation history (global, cross-workspace, covering tasks and Automations) */
  taskNavHistory: TaskNavigationHistory;
  /** Records Automations main-view or detail navigation. */
  taskNavPushAutomations: (
    workspacePath: string,
    workspaceIdentity?: string,
    automationId?: string,
    automationTab?: AutomationsNavigationTab,
  ) => void;
  /** Records plugin-market main-view navigation. */
  taskNavPushPluginStore: (workspacePath: string, workspaceIdentity?: string) => void;
  /** Back: returns the target entry, or null at the end */
  taskNavGoBack: () => WorkspaceNavEntry | null;
  /** Forward: returns the target entry, or null at the end */
  taskNavGoForward: () => WorkspaceNavEntry | null;
  /** When a task is deleted, prune its entries from the navigation history */
  removeTaskFromNavHistory: (taskId: string) => void;
}

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

export const DEFAULT_WORKSPACE_INIT_STATE: WorkspaceInitState = {
  status: "idle",
  error: null,
  attempts: 0,
};

const FALLBACK_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;

export const DEFAULT_TASK_UI_STATE: TaskUiState = {
  permissionRequest: null,
  pendingPermissionRequests: [],
  elicitationRequest: null,
  pendingElicitationRequests: [],
  elicitationFormDraftsByRequestId: {},
  error: null,
};

export const DEFAULT_TASK_RUNTIME_STATE: TaskRuntimeState = {
  status: "notReady",
  error: null,
  provider: undefined,
  contextWindow: null,
  usage: null,
  apiRetry: null,
  backgroundTaskControls: [],
  activeTurnKind: undefined,
  activeInputId: undefined,
  activeInputOwnerClientId: undefined,
};

// ────────────────────────────────────────────
// Factory functions
// ────────────────────────────────────────────

export function createDefaultWorkspaceState(
  selectedProvider: ZCodeProvider,
): WorkspaceZCodeUIState {
  return {
    activeTaskId: null,
    workspaceInit: { ...DEFAULT_WORKSPACE_INIT_STATE },
    draftRuntime: { status: "idle", error: null },
    draftSessionId: null,
    draftRuntimeInvalidationVersion: 0,
    composerTextInsertVersion: 0,
    composerTextInsertRequest: null,
    timelineBottomRequestVersion: 0,
    timelineBottomRequest: null,
    draftError: null,
    modelSwitchRequestId: null,
    modelSwitchPending: false,
    modelSwitchStage: "idle",
    taskRuntimeByTaskId: {},
    taskUiByTaskId: {},
    taskConfigOptionsByTaskId: {},
    taskConfigOptionsStatusByTaskId: {},
    taskUnreadByTaskId: {},
    optimisticTaskListByTaskId: {},
    groupedDraftTask: null,
    draftCreateSource: "session",
    promotedGroupedDraftTaskByTaskId: {},
    selectedProvider,
    selectedSupplierKey: buildNativeSupplierKey(selectedProvider),
    isGhostSupplier: false,
    supplierMismatchReason: null,
    configOptions: null,
    configOptionsStatus: "idle",
    slashCommands: [],
    taskListVersion: 0,
    taskListCache: null,
    draftFocusVersion: 0,
  };
}

const DEFAULT_WORKSPACE_STATE = createDefaultWorkspaceState(FALLBACK_PROVIDER);

export function getDefaultWorkspaceState(): WorkspaceZCodeUIState {
  // After the single-ZCode-Agent migration the default provider must converge to glm.
  // Return a stable reference so consecutive selector reads before the workspace bucket exists do not observe different snapshots.
  return DEFAULT_WORKSPACE_STATE;
}
