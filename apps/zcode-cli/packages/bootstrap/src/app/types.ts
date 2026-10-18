import type { ZCodeToolExecResource, BackgroundBashOutputResult } from "@zcode/shared";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  ExecuteTurnOptions,
  ExpertWorkflowCommandResult,
  ProviderRuntimeHeadersPort,
  PresentationSurface,
  ResumeSessionResult,
  StartSavedWorkflowRunResult,
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
  TurnAttachment,
  ModelExecutionContext,
  TurnResult,
  WorkflowAgentRunner,
  WorkspaceCheckpointSummary,
  WorkspaceForkResult,
  WorkspaceGenerateTextInput,
  WorkspaceHookReviewTarget,
  WorkspaceHookPolicyProvider,
} from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeModelOption } from "@zcode/shared";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
export type { ZCodeModelOption } from "@zcode/shared";
import type { ModelProviderSourceTitle } from "../model-config.js";
import type { ZCodeInstalledPluginData } from "../plugins.js";
import type {
  AutomationPort,
  OffPeakPort,
  BackgroundTaskCancelResult,
  CollaborationMode,
  ContextSourcePort,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunSessionSummary,
  ExecutionPort,
  BrowserControlPort,
  FileSystemPort,
  GoalStatus,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  InputDelivery,
  InputHistoryEntry,
  InputHistoryKind,
  InputHistoryStorePort,
  LoggerFactory,
  McpPort,
  McpServerStatus,
  ModelSelection,
  PermissionBrokerPort,
  PluginLoadOutcome,
  PluginMetadata,
  PluginReferenceCatalog,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionGoal,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  SkillLoadOutcome,
  SkillPort,
  ToolArtifactReadResult,
  ToolArtifactStorePort,
  TodoItem,
  QueryId,
  TraceContext,
  TurnId,
  TurnSteerResult,
  TurnInputIntentMetadata,
  MessageWithParts,
  ModelUsage,
  ModelToolCall,
  SupportedLocale,
  UiLocale,
  UiThemePreference,
  WorkflowEvent,
  WorkflowRunListItem,
  ExecutionShellSelection,
} from "@zcode/contracts";
import type { NodeReplBrowserBroker } from "./node-repl-browser-broker.js";
import type { SessionTranscriptMessage } from "../session-transcript.js";
import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-controller.js";
import type { AgentTelemetryRuntimeOwner, WorkspaceHookPolicy } from "@zcode/contracts";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

export interface WorkspaceHookReviewHostContext {
  taskId: string;
  runId: string;
  workspaceLabel: string;
  remoteSessionId?: string;
}

export type RespondWorkspaceHookReviewInput = WorkspaceHookReviewTarget & {
  decision: WorkspaceHookReviewDecision;
};

export type ToggleWorkspaceHookReviewItemInput = WorkspaceHookReviewTarget & {
  reviewItemId: string;
  enabled: boolean;
};

export type RevokeWorkspaceHookTrustInput =
  | (WorkspaceHookReviewTarget & { reviewItemIds: string[] })
  | WorkspaceHookTrustRevokeTarget;

/** A new Session may adopt the Environment default selection; a restored Session may stay unbound without a default model. */
export type ZCodeAppRuntimeConfigInput = AgentRuntimeConfig;

export interface ZCodeAppOptions {
  sessionId?: SessionId;
  resume?: boolean;
  version?: string;
  traceContext?: TraceContext;
  runtimeConfig?: ZCodeAppRuntimeConfigInput;
  /**
   * In stdio-protocol mode the agent process is spawned by the Electron host, so the model service needs to see the electron origin.
   * Plain CLI omits it and keeps the cli default.
   */
  sourceTitle?: ModelProviderSourceTitle;
  eventStore?: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  inputHistoryStore?: InputHistoryStorePort;
  modelAdapter?: AiSdkModelAdapter;
  /** Registry owned by the worker process; the App only borrows it and never releases it. */
  providerRegistry: ProviderRegistryModelSource;
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  /** Environment default selection for new Sessions; participates in init only absent an explicit runtime modelSelection. */
  configuredDefaultModelSelection?: ModelSelection;
  modelIoFullRetentionEnabled?: boolean;
  /** A same-process embedded host may inject a full borrowed process-level Owner; Endpoint configuration must not override it. */
  telemetryOwner?: AgentTelemetryRuntimeOwner;
  /**
   * Provider runtime headers port: the main runtime reports its session on each call; child runtimes always take
   * derived instances from the parent runtime.
   */
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  loggerFactory?: LoggerFactory;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  executionPort?: ExecutionPort;
  /** Resource-telemetry side channel; injected by the protocol host, shared by main-task and workflow execution adapters. */
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  /** browser-use control port; when injected, node_repl's agent.browsers.* becomes available. Absent means unavailable. */
  browserControlPort?: BrowserControlPort;
  /** Process-level node_repl Browser broker injectable by the protocol host; absent, the app builds and owns one. */
  nodeReplBrowserBroker?: NodeReplBrowserBroker;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  artifactStore?: ToolArtifactStorePort;
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  /** The host provides a per-app lease; the produced port is owned by the app. */
  mcpPortFactory?: (input: { workingDirectory?: string }) => McpPort;
  permissionBroker?: PermissionBrokerPort;
  eventSink?: SessionEventSink;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  uiDetectedLocale?: string | null;
  uiLocale?: UiLocale;
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  /** Resolved once at the first real user execution or cold-resume fallback, then cached for the app lifetime. */
  resolveInitialBashShellSelection?: () => Promise<ExecutionShellSelection | undefined>;
  /** Trusted embedder policy; workspace/project files cannot populate this field. */
  workspaceHookPolicy?: WorkspaceHookPolicy;
  /** Protocol Host-owned provider shared by session Runtime and no-session Settings pretrust. */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** Rollout gate; false keeps project Hooks hard-blocked and does not read Trust records. */
  workspaceHookTrustEnabled?: boolean;
  /** Presence means this owner Host supports the dedicated Workspace Hook review route. */
  workspaceHookReviewHost?: WorkspaceHookReviewHostContext;
}

export interface SubmitPromptOptionsBase {
  traceContext?: TraceContext;
  abortSignal?: AbortSignal;
  inputId?: string;
  queryId?: QueryId;
  intent?: TurnInputIntentMetadata;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** Internal admission observation: only says the runtime sink saw TurnStarted, not that the projection applied. */
  onTurnStartedObserved?: (event: SessionEvent) => void;
  /** Removed from the provider tool list for the current turn only; never permanently alters the session runtime. */
  toolDisallowlist?: readonly string[];
  /** The App read-only mirrors provider-only IAB environment state; it never enters the UI transcript. */
  browserAmbientContext?: ExecuteTurnOptions["browserAmbientContext"];
  /** Single-execution constraint of the standard Selection; never enters Session Selection or persistence. */
  modelExecution?: ModelExecutionContext;
}

export type SubmitPromptOptions = SubmitPromptOptionsBase &
  import("@zcode/contracts").TurnBackgroundAttribution;

export type PrepareUserExecutionBoundary = (
  options?: Pick<SubmitPromptOptions, "abortSignal" | "traceContext">,
) => Promise<void>;

export interface SteerTurnOptions {
  inputId?: string;
  queryId?: QueryId;
  expectedTurnId?: TurnId;
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
  /** Delivery semantics: queue = start a new turn on consume; guide = inline into the current turn. Default queue. */
  delivery?: "guide" | "queue";
  intent?: TurnInputIntentMetadata;
  attachments?: TurnAttachment[];
  /** Tool names hidden from the provider while queued/guide input is being consumed. */
  toolDisallowlist?: readonly string[];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  traceContext?: TraceContext;
}

export type SendInputOptions = SubmitPromptOptions & {
  inputId?: string;
  /** Presentation flags fixed by the trusted consume entry; never alters raw user content or scheduling semantics. */
  inputPresentation?: ExecuteTurnOptions["inputPresentation"];
  delivery?: InputDelivery;
  /** sendText's product-level guide/queue intent; busy-or-not remains Core admission's call. */
  queueDelivery?: "guide" | "queue";
  requireIdle?: boolean;
  expectedTurnId?: TurnId;
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
};

export interface UserPromptInput {
  text: string;
  attachments?: TurnAttachment[];
}

export type PromptInput = string | UserPromptInput;

export type SendInputResult =
  | {
      /** Core finished admission; completion exists only for lifecycle cleanup, not as an ACK wait boundary. */
      completion: Promise<TurnResult>;
      kind: "started_turn";
      turnId: TurnId;
    }
  | TurnSteerResult;

export interface ResumeOptions {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** Call-level materialized result of one cold resume; never enters the app-lifetime cache. Refresh from the return value after compact repairs. */
  persistedMessages?: MessageWithParts[];
}

export interface ZCodePluginSetResult {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
}

export interface ZCodePluginUninstallResult {
  // null means the plugin id is currently not installed (idempotent no-op); callers surface not-installed from it.
  removed: ZCodeInstalledPluginData | null;
}

export interface SetLocaleResult {
  configPath: string;
  locale: SupportedLocale;
  previousLocale: SupportedLocale;
  requestedLocale: UiLocale;
  traceId: TraceContext["traceId"];
}

export interface ZCodeApp {
  readonly sessionId: SessionId;
  readonly traceId: string;
  readonly runtime: AgentRuntime;
  respondWorkspaceHookReview(
    input: RespondWorkspaceHookReviewInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  toggleWorkspaceHookReviewItem(
    input: ToggleWorkspaceHookReviewItemInput,
  ): Promise<WorkspaceHookReviewCommandResult & { request?: unknown }>;
  revokeWorkspaceHookTrust(
    input: RevokeWorkspaceHookTrustInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  /** Soft gate: open the review flow on demand; a no-op-safe when nothing is pending. */
  requestWorkspaceHookReview(input: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  /**
   * After the trust store persists, this session coordinator's
   * in-memory mirror does not refresh by itself (per-session, loaded once at creation). After Settings succeeds with a
   * task-less pretrust grant, the server calls this per workspace to reload the file into the
   * coordinator and re-emit admission state, else trusted hooks keep being refused and the banner never updates.
   */
  reloadWorkspaceHookTrust(): Promise<void>;
  close?(): Promise<void>;
  getMode(): CollaborationMode;
  getModel(): string;
  /** The current-only protocol snapshot reads the exact current Registry model, avoiding an enumeration of the whole catalog. */
  getCurrentModelOption?(): ZCodeModelOption | undefined;
  /** Read-only Registry metadata; requires neither complete options nor a bound execution model. */
  getModelOption?(selection: ModelSelection): ZCodeModelOption | undefined;
  getLocale(): SupportedLocale;
  getTheme(): UiThemePreference;
  getDefaultThoughtLevel(): string | undefined;
  getThoughtLevel(): string | undefined;
  loadSessionTranscript(): Promise<SessionTranscriptMessage[]>;
  readSubagents(input?: {
    endedCursor?: string;
    endedLimit?: number;
  }): Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;
  readSubagentTranscript(
    childSessionId: string,
  ): Promise<import("./subagent-observation.js").SubagentTranscriptSnapshot>;
  readTodos(): Promise<TodoItem[]>;
  readTarget(): Promise<SessionGoal | null>;
  setCustomSessionTitle(input: { title: string; traceContext?: TraceContext }): Promise<void>;
  readToolResultArtifact(uri: string): Promise<ToolArtifactReadResult>;
  /** After the chunk transaction commits, atomically register the full binary into the session artifact store. */
  writePromptAttachment(input: {
    fileName: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
  /** Sent image/video previews: read the artifact or real path inside the runtime that owns the session. */
  readPromptAttachment(input: {
    ref: string;
    mime: string;
    maxBytes: number;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** The Share picker reads only userInput attachment metadata; never the full content. */
  statPromptAttachment?(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** Desktop local sent videos: resolve an artifact-first local playback source; else keep chunked reads. */
  resolvePromptAttachmentPreviewSource(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ kind: "local_path"; path: string; mediaType: string } | { kind: "chunked" }>;
  setTarget(input: {
    objective: string;
    /** The raw goal command the user submitted; target still stores only the objective and the chat line renders this text. */
    displayText?: string;
    status?: GoalStatus;
    tokenBudget?: number | null;
    intent?: TurnInputIntentMetadata;
  }): Promise<SessionGoal>;
  updateTargetStatus(status: GoalStatus): Promise<SessionGoal | null>;
  clearTarget(): Promise<boolean>;
  continueActiveTarget(options?: SubmitPromptOptions): Promise<TurnResult | null>;
  recordInputHistory(
    input: PromptInput,
    kind?: InputHistoryKind,
  ): Promise<InputHistoryEntry | null>;
  recallPreviousInputHistory(skip?: number): Promise<InputHistoryEntry | null>;
  listModels(): ZCodeModelOption[];
  listThoughtLevels(): string[];
  listPlugins(): Promise<PluginLoadOutcome>;
  setPluginEnabled(plugin: string, enabled: boolean): Promise<ZCodePluginSetResult>;
  uninstallPlugin(plugin: string): Promise<ZCodePluginUninstallResult>;
  /**
   * The Session-frozen plugin identity catalog.
   * Built once from the resolveStartupPlugins result at App creation, read-only afterwards;
   * `plugins/referenceCatalog` with a sessionId treats this as the session authority.
   */
  getPluginReferenceCatalog(): PluginReferenceCatalog;
  /** The current Session's AgentRuntime skill discovery snapshot; rediscovered after cold resume rebuilds the runtime. */
  getSkillCatalog(): Promise<SkillLoadOutcome>;
  listMcpServers(): Promise<Record<string, McpServerStatus>>;
  connectMcpServer(name: string): Promise<McpServerStatus>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask?(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  /**
   * Workflow run event-log pagination (details-page audit view). Optional capability: without a dwf journal the run service
   * is not constructed at all and the method is absent, so the gateway answers a structured unsupported-capability error
   * instead of an empty page - no-events and this-session-lacks-the-capability are different things.
   *
   * cursor = journal sequence (monotonically assigned by `appendEvent`), the same scale as
   * workflowRuns[].lastEventSequence; an out-of-range cursor yields an empty page, not an error.
   */
  listDynamicWorkflowRunEvents?(input: {
    runId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * Resume a dwf run. Optional capability; absence conditions as
   * {@link listDynamicWorkflowRunEvents}. Beyond port.resume, the success path must also **re-arm tracking**
   * (runtime.trackResumedDynamicWorkflowRun): without it the resumed run cannot be cancelled, the completion
   * notification is lost, and the reaping guard treats the session as idle. Failure returns a structured reason
   * (no throw) - all five reasons are expected caller branches.
   */
  resumeWorkflowRun?(input: {
    workId: string;
    name?: string;
  }): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * Hub-side launch of a saved workflow. The GUI creates an
   * empty session in the target project and sends it `startSavedWorkflow`: the agent resolves the saved source, validates
   * args, and compiles; on success a controlOnly launch turn records the user's real action into the session and
   * `port.submit` starts the run (no model round, no `CreateWorkflow` dialog - clicking in the hub IS the consent).
   * Optional capability; absence as {@link resumeWorkflowRun} (no dwf port, not registered; the gateway answers
   * unsupported-capability). Failure returns a structured `reason` (no throw) - six reasons, all expected caller
   * branches, with `message` carrying human-readable diagnostics for inline display in the args dialog; stages 1-2
   * fail **before any persistence** (no run, message, event, or task), letting the GUI `deleteSession` the empty shell
   * so the transcript shows only genuinely started runs.
  startSavedWorkflow?(input: {
    name: string;
    scope?: "project" | "global";
    args?: Record<string, unknown>;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * GUI Configure changes a run's subagent model and concurrency cap: revise the same script into a new run, no model
   * round, no confirmation dialog. Optional capability: not registered when the port is absent or lacks `amend` /
   * `getScript` (gateway answers unsupported-capability). Failure returns a structured `reason` - each occurs before
   * anything is stopped or created.
  amendWorkflowRunSettings?(
    input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
  ): Promise<AmendWorkflowRunSettingsResult>;
  /**
   * Workflow run enumeration (post-restart discovery). Optional capability, absence as
   * {@link listDynamicWorkflowRunEvents}; without the enumeration-narrow query the journal answers an empty list
   * (the honest answer - in-memory journals never outlive the process). `resumable` comes precomputed by the resume
   * gate's very predicate.
  listDynamicWorkflowRuns?(input: { limit?: number }): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * Workflow run cold replay: runs owned by this session outside `excludeRunIds`
   * replay from the journal as progress-event payloads, and cold materialization feeds them to the same reducer as
   * memory events - the `workflowRuns` projection therefore matches across restarts. Optional capability; absence as
   * {@link listDynamicWorkflowRuns}.
  replayDynamicWorkflowRuns?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * **User-facing artifact** read side for workflow runs. The three capabilities
   * register and vanish together: three slices of one journal read surface; partial presence would only leave the UI
   * a side panel with cards that do not open. Absence as {@link listDynamicWorkflowRunEvents}, plus all three
   * optional port members must exist.
   *
   * Terminology: artifact here is what the script published to the **user** via `artifact.*`, not the engine's
   * same-named name for the script top-level return value.
   *
   * Unknown runId returns `undefined` (the gateway normalizes to not found); a partial run returns an empty array.
   */
  listDynamicWorkflowRunArtifacts?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * Pagination of `report` items fed to a preset dashboard (cursor = journal sequence, strictly greater).
   * `limit` is clamped by the gateway before arriving; this side honors it **exactly** - callers pass limit+1 to probe
   * hasMore.
   * Absence as {@link listDynamicWorkflowRunArtifacts}.
  listDynamicWorkflowRunArtifactItems?(input: {
    runId: string;
    artifactId: string;
    afterSequence?: number;
    limit: number;
  }): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  /**
   * Read **all** bytes of one artifact version; chunking belongs to the gateway (512 KiB chunks max). Authorization
   * lives in the port implementation: the run must belong to this session and the journal must hold a completed
   * `(artifactId, version)` row; only then is the **row's** uri used to read from the store - a caller-supplied id
   * never becomes a path directly.
   * Missing version / preset dashboard (no bytes) / missing store all return `undefined`.
   * Absence as {@link listDynamicWorkflowRunArtifacts}.
  readDynamicWorkflowRunArtifact?(input: {
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * Workspace transcript of a workflow run: journal rows for
   * `files.*` / `git.*` / `world.run`; the two register and vanish together (the listing plus one node's bounded body).
   * Authorization in the port implementation (the run must belong to this session); not-your-run / unknown run return
   * `undefined`. Absence as {@link listDynamicWorkflowRunArtifacts}.
   */
  listDynamicWorkflowRunWorkspaceNodes?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  readDynamicWorkflowRunNodeResult?(input: {
    runId: string;
    siteId: string;
    ordinal: number;
    maxBytes: number;
  }): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
  disconnectMcpServer(name: string): Promise<McpServerStatus | undefined>;
  listCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkFromCheckpoint(options?: {
    targetCheckpointId?: string;
    targetMessageId?: string;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<{
    text: string;
    selection: WorkspaceGenerateTextInput["selection"];
    finishReason: string;
    usage?: ModelUsage;
    toolCalls?: ModelToolCall[];
  }>;
  testModelConnectivity(
    input: { selection: ModelSelection },
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
  expertWorkflowStatus(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  workflowStatus?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  validateWorkflowScript?(input: { scriptPath: string }): Promise<ExpertWorkflowCommandResult>;
  runWorkflowScript?(
    input: { args?: unknown; resumeFromRunId?: string; scriptPath: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  resumeWorkflowScript?(
    input: { runId: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  scriptWorkflowStatus?(options?: { runId?: string }): Promise<ExpertWorkflowCommandResult>;
  listScriptWorkflows?(options?: { limit?: number }): Promise<ExpertWorkflowCommandResult>;
  retryWorkflow?(options?: {
    abortSignal?: AbortSignal;
    activityId?: string;
    definitionId?: string;
    nodeId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    phase?: string;
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  listExpertWorkflows?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    limit?: number;
    workflowKind?: string;
  }): Promise<WorkflowRunListItem[]>;
  listWorkflows?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    limit?: number;
    workflowKind?: string;
  }): Promise<WorkflowRunListItem[]>;
  readExpertWorkflowEvents?(options: {
    abortSignal?: AbortSignal;
    limit?: number;
    runId: string;
  }): Promise<WorkflowEvent[]>;
  readWorkflowEvents?(options: {
    abortSignal?: AbortSignal;
    limit?: number;
    runId: string;
  }): Promise<WorkflowEvent[]>;
  resume(options?: ResumeOptions): Promise<ResumeSessionResult>;
  resumeExpertWorkflow(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  resumeWorkflow?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  sendInput(input: PromptInput, options?: SendInputOptions): Promise<SendInputResult>;
  setMode(mode: CollaborationMode): Promise<{
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceId: TraceContext["traceId"];
  }>;
  setModelIoFullRetentionEnabled?(enabled: boolean): void;
  setModel(
    modelId: string | ModelSelection,
    options?: {
      /**
       * per-turn (off-peak idle plan): true = switch the running state only - no disk model selection write,
       * no modelChange chat notification. For turn-level temporary switches (apply/restore in pairs).
       */
      transient?: boolean;
    },
  ): Promise<{
    model: string;
    previousModel: string;
    thoughtLevel?: string;
    traceId: TraceContext["traceId"];
  }>;
  setThoughtLevel(level: string): Promise<{
    previousThoughtLevel?: string;
    thoughtLevel: string;
    traceId: TraceContext["traceId"];
  }>;
  setLocale(locale: UiLocale): Promise<SetLocaleResult>;
  stopExpertWorkflow(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  stopWorkflow?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  runExpertWorkflowBackground?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  runWorkflowBackground?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  /**
   * v4 deferred queue: while busy with no steerable active turn (compact / goal verifier /
   * goal continuation boundaries), plain input must land as TurnSteerQueued instead of vanishing from the composer via
   * runtime.steerTurn(no_active_turn/turn_not_steerable).
   */
  enqueueDeferredInput?(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  steerTurn(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  /** v4 queue single-item delete: remove one queued input by pendingInputId. Returns whether it hit. */
  removeQueueItem(
    pendingInputId: string,
    options?: {
      reason?: "user_removed" | "promoted";
      reservationId?: string;
      traceContext?: TraceContext;
    },
  ): Promise<boolean>;
  /** sendQueuedNow atomic promote: after reserve, plain drain/delete must not consume the item. */
  reserveQueueItem(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  markQueueItemPromoting(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  releaseQueueItemReservation(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue single-item edit: replace a queued input's text by pendingInputId (position kept). Returns whether it hit. */
  editQueueItem(
    pendingInputId: string,
    newText: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue reorder: move pendingInputId before beforePendingInputId (null = tail). */
  reorderQueueItem(
    pendingInputId: string,
    beforePendingInputId: string | null,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 heldQueueDisposition=clearQueueAndSend: clear all queued inputs, return the dropped count. */
  clearQueueItems(options?: { traceContext?: TraceContext }): Promise<number>;
  /** v4 setAutoDrain: flip the queue autoDrain grant bit (session-level configuration). */
  setQueueAutoDrain(autoDrain: boolean, options?: { traceContext?: TraceContext }): Promise<void>;
  /** The paused queue was consumed to empty by the CLI outer layer: restore core's inline drain of later running queues. */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode: flip the followup routing mode (queue/guide, session-level configuration). */
  setFollowupMode(
    mode: "queue" | "guide",
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  runExpertWorkflow(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  runWorkflow?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  submitPrompt(prompt: PromptInput, options?: SubmitPromptOptions): Promise<TurnResult>;
}

export interface ResolveLatestSessionOptions {
  directory: string;
  env?: NodeJS.ProcessEnv;
  sessionStore?: SessionStorePort;
}

export interface RunZCodeProtocolAgentOptions {
  /** The entrypoint owns the exit deadline; bootstrap only orchestrates cancellation and cleanup, never exits the process. */
  lifecycle?: {
    readonly signal: AbortSignal;
    readonly deadlineAt: number | undefined;
    requestShutdown(error?: Error): void;
  };
  /** Desktop-internal command: run storage preparation only, then exit. */
  prepareStorageOnly?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  presentationSurface?: PresentationSurface;
  version?: string;
}

export interface ListZCodeSessionsOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  sessionStore?: SessionStorePort;
}

export type { WorkflowAgentRunner };
