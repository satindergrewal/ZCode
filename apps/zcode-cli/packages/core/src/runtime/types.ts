import type { RequestVerificationReason } from "@zcode/shared";
import type { GetAgentDefinitions, LoadAgentDefinitions } from "../subagent/definitions.js";
import type { RuntimeInputPresentation, TurnExecutionModelFallbackReason } from "@zcode/contracts";
/* eslint-disable max-lines -- Runtime types concentrate core/runtime's outward-facing shapes; splitting needs a dedicated migration. */
import { PermissionService, ToolScheduler } from "./deps.js";
import type {
  JsonSchema,
  AgentExecutionTelemetryPort,
  AgentTelemetryCausation,
  BackgroundResultOriginMeta,
  ContextUsageBreakdownItem,
  CoordinatorResponsePort,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  ModelRequestAuth,
  ModelRequestDependencies,
  ModelSelection,
  PluginReferenceCatalog,
  ResolvedUserInstructions,
  StableForkGoalBoundaryMetadata,
  StableForkTargetMetadata,
  WorkspaceHookBundleSnapshot,
  WorkspaceId,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CollaborationMode,
  EmbeddedSearchBackend,
  Logger,
  AttachmentStorageMetadata,
  MessageId,
  MessageVisibility,
  FilePartSource,
  ModelRequestAdmission,
  Model,
  ModelNetworkStatusEvent,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  ModelStreamRecoveryStatus,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  ModelUsageSummary,
  ModelInputMessage,
  MessageWithParts,
  PendingTurnInput,
  TurnInputIntentMetadata,
  TurnSteerResult,
  PartId,
  PermissionBrokerPort,
  PermissionUpdate,
  QueryId,
  RewindScope,
  RewindStrategy,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionTaskType,
  SessionMailboxPort,
  SessionProjection,
  SessionStorePort,
  ContextSourcePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  ModelCatalogPort,
  ExecutionPort,
  BrowserControlPort,
  ExecutionShellSelection,
  AutomationPort,
  OffPeakPort,
  TopicResourcePort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  HooksRuntimeConfig,
  SkillPort,
  McpPort,
  McpServerConfig,
  SubagentPort,
  ToolArtifactStorePort,
  ToolCallId,
  WorkflowPort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
  TraceContext,
  TraceId,
  TurnId,
  CheckpointCreatedPayload,
  RewindTargetEvaluation,
  SessionHistoryHydrationResult,
  SyntheticUserMessageSource,
  HookRunner,
  ToolExecutionResult,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  EnvInfo,
  ProjectContext,
  UserInstructionsOptions,
  AutoCompactPolicyConfig,
  ModelAnomalyGuardConfig,
  OutputStylePromptConfig,
} from "./deps.js";
import type { AgentProfile } from "../subagent/profile.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { BashTimeoutPolicy } from "../tool/bash-timeout-policy.js";
import type { PresentationSurface } from "../context/types.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

// -----------------------------------------------
// Agent Runtime
// -----------------------------------------------

export interface AgentRuntimeConfig {
  /** shared-host CUA request routing metadata; desktop is the safe default. */
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  remoteSessionId?: string;
  bashTimeoutPolicy?: BashTimeoutPolicy;
  presentationSurface?: PresentationSurface;
  /** Execution Host's output root, independent of the working repository. */
  genUiOutputRoot?: string;
  mode?: CollaborationMode;
  planEnabled?: boolean;
  modelStreaming?: "off" | "on";
  streamingToolExecution?: "off" | "readOnly";
  /** Fixed at session creation; defaults to the shared model-context budget policy. */
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  maxTurns?: number;
  permissionTimeoutMs?: number;
  compact?: AutoCompactPolicyConfig;
  targetCompletionVerification?: {
    enabled?: boolean;
    /**
     * Consecutive verifier failures (verifier error without a usable next action) tolerated
     * before the goal continuation loop stops. Each failure still gets one unverified
     * continuation turn so the mission keeps moving; the counter resets whenever the
     * verifier produces a healthy next action. Default 3.
     */
    maxFailureContinuations?: number;
    /**
     * Independent verifier passes required before the loop accepts goal completion.
     * Protects against a single false-positive "done" ending a mission early. Default 2.
     */
    requiredCompletionConfirmations?: number;
    /**
     * How long the continuation loop waits for running background tasks to drain before
     * giving up on auto-continuation. Default 7 days (missions legitimately keep background
     * work running for days; Stop and queued user input are the real interrupt paths).
     */
    backgroundDeferralTimeoutMs?: number;
  };
  /**
   * Task-list-driven autonomous continuation (mission mode): when enabled, a turn never
   * ends while the session task list has open items — the loop re-issues model-only
   * continuation turns carrying the full authoritative list. Enabled via the Desktop
   * missionContinuationEnabled setting (-> ZCODE_MISSION_CONTINUATION) or by exporting
   * that env var for standalone CLI runs.
   */
  missionContinuation?: {
    enabled?: boolean;
    /**
     * Explicit per-session override set from the UI (/mission on|off). When set, it wins
     * over the machine-wide env/setting; unset means follow the global default.
     */
    sessionOverride?: boolean;
    /**
     * Consecutive continuation turns with zero task-list progress tolerated before the
     * loop stops (anti-spin valve). Default 100; any list change resets the streak.
     */
    idleContinuationCap?: number;
  };
  midConversationSystem?: {
    mode?: "auto" | "force";
  };
  subagents?: {
    enabled?: boolean;
    // Longest silence with no child events for a foreground subagent; defaults to the model-stream idle timeout.
    inactivityTimeoutMs?: number;
    autoBackgroundMs?: number;
    backgroundBashMaxMs?: number;
    maxTurns?: number;
    outputRootDir?: string;
    profiles?: readonly AgentProfile[];
    builtInModelSelectionOverrides?: Partial<Record<"general-purpose" | "Explore", ModelSelection>>;
  };
  toolAllowlist?: readonly string[];
  toolDisallowlist?: readonly string[];
  /**
   * Defaults to main. Explore child runtimes use the explore toolset to opt into
   * Read-only exploration allowlist; whether direct Glob/Grep belong is the embedded search branch's call.
   * In main mode the allowlist is a plain intersection; explore sub-runtimes add the default read-only set.
   */
  toolset?: "main" | "explore";
  toolConcurrency?: { maxConcurrency?: number };
  runtimeFeatures?: {
    /**
     * Whether to register the node_repl (js) tool.
     * Derived by bootstrap from official-plugin enablement, never self-declared in plain plugin manifests.
     */
    nodeRepl?: boolean;
    /**
     * Whether node_repl may inject agent.browsers; also requires a host-provided browserControlPort.
     */
    browserUse?: boolean;
    /** Whether CUA broker credentials inject into the shared node_repl; not a standalone CUA MCP registration. */
    computerUse?: boolean;
    /**
     * Docs asset dir of the official browser-use plugin, derived by bootstrap from plugin metadata.rootPath;
     * not part of the plugin manifest schema.
     */
    browserDocumentationRoot?: string;
  };
  modelAnomalyGuard?: Partial<ModelAnomalyGuardConfig>;
  mcp?: {
    enabled?: boolean;
    servers?: Record<string, McpServerConfig>;
    /**
     * Process-local provenance supplied by bootstrap after resolving bundled
     * official plugins. Never derive this list from serialized MCP config.
     */
    trustedOfficialCuaServerNames?: readonly string[];
  };
  /**
   * The Session-frozen plugin identity catalog.
   * Built by bootstrap at App creation from plugin loader results; runtime reads it only,
   * resolving `plugin://` references at turn start against live inventory.
   */
  pluginReferenceCatalog?: PluginReferenceCatalog;
  hooks?: HooksRuntimeConfig;
  bashShellSelection?: ExecutionShellSelection | undefined;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  /** Fixed at root-session creation; false disables only Bash's bfs/ugrep prelude. */
  nativeSearchEnhancementsEnabled?: boolean;
  memory?: MemoryRuntimeConfig;
  /** History recovery tolerates unbound; only a complete selection mints this turn's execution Model. */
  modelSelection?: ModelSelection;
  titleGeneration?: {
    enabled?: boolean;
    modelSelection?: ModelSelection;
    timeoutMs?: number;
  };
  parentSessionId?: SessionId;
  taskType?: SessionTaskType;
  /**
   * Dynamic-workflow gradation gate (docs/dynamic-workflow/launch.md "Gray release"): decided by the Host and delivered via
   * the ZCode Protocol; the runtime only consumes. **Absent means on** (in-process embedders rely on this polarity);
   * standalone CLI TUI and headless pass true/false explicitly via --workflow-mode (default disabled, DWG-04),
   * and workflow_child inherits the parent's configuration.
   * false disables the ten workflow tools and changes no other registration policy.
   */
  dynamicWorkflowEnabled?: boolean;
  /**
   * Gradation mode `onDemand` (docs/dynamic-workflow/launch.md "On demand: activation"): the ten workflow
   * tools defer until the session's first `/workflow` (or a GUI Resume / settings / direct launch on this session's runs, or a cold restore whose record
   * already has a workflow). **Absent means register immediately**, same polarity as dynamicWorkflowEnabled; only the protocol server writes true
   * when the Host-delivered mode is onDemand. Activation state belongs to the runtime (dynamicWorkflowToolsActivated).
   */
  dynamicWorkflowToolsOnDemand?: boolean;

  // Context Builder config
  systemPrompt?: string;
  /**
   * Dynamic-workflow subagent identity input: when present, the context builder
   * takes the base + workflow-subagent-contract + persona-overlay path instead of treating the persona as a whole
   * `systemPrompt` replacement. Mutually exclusive with `systemPrompt` (the builder throws).
   */
  workflowActor?: { name?: string; persona?: string };
  /**
   * Selects the subagent-specific context builder for child runtimes. The
   * builder still receives env/date/model data through the normal runtime
   * context snapshot, but assembles provider-visible system sections with the
   * subagent prompt shape instead of the main ContextBuilder stack.
   */
  subagentContext?: {
    agentPrompt: string;
    userInstructions?: ResolvedUserInstructions;
  };
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  agentName?: string; // Default: "zcode-agent"
  workingDirectory?: string; // Required for context builder
  /**
   * The workspace path exactly as the caller passed it, for session persistence and local identity recovery.
   * File and command execution still use only the normalized workingDirectory.
   */
  workspacePath?: string;
  /** Persistence isolation only; file and command execution keep using workingDirectory. */
  workspaceIdentity?: WorkspaceId;
  envInfo?: EnvInfo; // Optional, will be auto-detected if not provided
  currentDate?: string; // YYYY-MM-DD, resolved by adapter when omitted
  userInstructions?: UserInstructionsOptions; // P1: AGENTS.md
  projectContext?: ProjectContext; // P2: auto-detected if not provided
  skillMetadataBudget?: number;
}

export interface ResumeSessionOptions {
  /** Aborts the cold-resume admission wait; never fabricates a Workspace Hook review decision. */
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  /** Invocation-level prematerialized result from the cold-resume caller; never cached, re-read from the return after repair. */
  persistedMessages?: MessageWithParts[];
  /**
   * The mode resolved for this invocation. Explicit --mode and headless's yolo default are invocation-level overrides
   * outranking the historical session mode; interactive resume without one stays undefined so history wins.
   */
  modeOverride?: CollaborationMode;
}

export interface MainTurnCacheHitAggregate {
  requestCount: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

export type BackgroundTaskNotificationSealReason = "subagent_terminal" | "subagent_cancelled";

export interface SealBackgroundTaskNotificationsInput {
  reason: BackgroundTaskNotificationSealReason;
  traceContext?: TraceContext;
}

export interface PendingModelChangeTimeline {
  createdAt: number;
  fromModel?: ModelSelection;
  fromModelLabel?: string;
  requestId: string;
  toModel: ModelSelection;
  toModelLabel: string;
}

export interface EnqueueSubagentMessageInput {
  responseId: string;
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  childToolCallId: string;
  parentToolCallId?: string;
  summary: string;
  message: string;
  traceContext: TraceContext;
}

export interface MemoryRuntimeConfig {
  cliStorageRoot?: string;
  enabled?: boolean;
  /** Whether to schedule automatic Extraction after a successful main turn; defaults to true. */
  extractionEnabled?: boolean;
  storageRoot?: string;
  use?: boolean;
  workspaceIdentity?: string;
}

export interface AgentRuntimeDeps {
  /** Read-only directory entries; must read from memory synchronously, no I/O during request gathering. */
  getAgentDefinitions?: GetAgentDefinitions;
  /** Read the new parent context once; child execution must not inherit this loader. */
  loadAgentDefinitions?: LoadAgentDefinitions;
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryCausation?: AgentTelemetryCausation;
  agentTelemetryCausationMode?: "child" | "linked_root";
  appVersion?: string;
  eventStore: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  modelFactory: RuntimeModelFactory;
  /** Optional host capability: resolve explicit intent for future executions; never mutates a frozen Model. */
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  modelIoDir?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  permissionService?: PermissionService;
  permissionBroker?: PermissionBrokerPort;
  toolScheduler?: ToolScheduler;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
  executionPort?: ExecutionPort;
  /** browser-use control port; passed through to ToolExecutionContext.browserControlPort for node_repl. */
  browserControlPort?: BrowserControlPort;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  /** Port for workflow actors to submit final results; its presence is submit_result's registration gate. */
  workflowSubmitPort?: WorkflowSubmitPort;
  /**
   * Mono-subagent typed `submit_result`: when present, the registered declaration is `{ result: <this schema> }` rather than
   * arbitrary JSON. Only the
   * provider-visible declaration and strict eligibility change; handler, permissions, and terminal semantics match the workflowSubmitPort-only case.
   * Ignored without the port — the port is the registration gate.
   */
  workflowSubmitSchema?: JsonSchema;
  /**
   * Port for workflow actors to escalate blocking questions; its presence is escalate's registration gate. Same injection and gate as workflowSubmitPort.
   */
  workflowEscalatePort?: WorkflowEscalatePort;
  /**
   * Process-level admission port for model requests: when present, every attempt
   * draws a ticket through it first, riding the call context to the adapter. dwf actor runtimes get the driver's per-actor
   * wrapper (gate-constrained); the main runtime gets the governor's observer (signals only). Absent means no gate.
   */
  modelRequestAdmission?: ModelRequestAdmission;
  workflowPort?: WorkflowPort;
  /** Workflow-run submit/observe/cancel port; present, CreateWorkflow really starts; absent, placeholder diagnostics. */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** Model-catalog port; absent, ListModels reports the missing capability and CreateWorkflow's subagent_model is denied. */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  contextSourcePort?: ContextSourcePort;
  eventSink?: SessionEventSink;
  logger?: Logger;
  traceContext?: TraceContext;
  contextBuilder?: ContextBuilder; // Optional, will be created from config
  now?: () => Date;
  isRemoteWorkspace?: () => boolean;
  memoryRoot?: string;
}

export interface RuntimeModelFactoryInput {
  selection: ModelSelection;
  /** Bound only to the Model created here; never enters the public ModelRequest or session persistence. */
  requestDependencies?: ModelRequestDependencies;
}

export type RuntimeModelFactory = (input: RuntimeModelFactoryInput) => Model;

/**
 * Provider runtime-headers port facing the protocol client.
 *
 * The input sessionId must route to a client-held session. A child's ledger identity must not
 * hit client requests directly, or the client finds no session, returns nothing, and the first model request hangs.
 * Child runtimes derive ports via deriveChildClientPorts, routing requests to the client session the parent bound.
 */
export interface ProviderRuntimeHeadersPort {
  shouldRefreshBeforeModelRequest?(input: { providerId: string; modelId: string }): boolean;
  refreshBeforeModelRequest(input: {
    accountAccess?: ZCodeProviderAccountAccess;
    expectedAccountScope?: string;
    rejectedProjectTokenFingerprint?: string;
    abortSignal?: AbortSignal;
    modelId: string;
    providerId: string;
    reason: RequestVerificationReason;
    sessionId: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  }): Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
}

export interface TurnResult {
  response: string;
  turnId: TurnId;
  traceId: TraceId;
  usage?: ModelUsageSummary;
  events: SessionEvent[];
  projection: SessionProjection;
}

/**
 * Execution-time constraints of the standard Submission Selection. It carries no Provider/Model static facts
 * and never becomes a second source for the Session Selection.
 */
export interface ModelExecutionContext {
  /** Skips automatic Project Memory Extraction for this turn only; never mutates Session Memory config. */
  memoryExtraction?: "skip";
  selectionScope: "execution";
  requestDependencies?: ModelRequestDependencies;
  subagents?: {
    foregroundModel: "submission";
    background: "deny";
  };
  /**
   * When this execution's Selection fails, fall back to the original model within the same Turn (keep committed history, swap only remaining-request
   * models) instead of failing the turn. The trigger must be declared by the initiator: `providerId` restricts matches to the execution
   * Selection's provider, `rules` match in declaration order with the first hit deciding the reason, and a default `providerErrorCode`
   * covers any failure of that provider. core never hardcodes on provider id, model name, or error text.
   * The fallback target prefers `target` (the initiator's card-time submission choice, i.e. the session's original model), then the resident Session Selection;
   * if neither resolves there is nowhere to go — fail on the real error.
   */
  selectionFallback?: {
    providerId: string;
    rules: Array<{
      reason: TurnExecutionModelFallbackReason;
      providerErrorCode?: string;
    }>;
    target?: ModelSelection;
  };
}

export interface ExecuteTurnOptionsBase {
  abortSignal?: AbortSignal;
  browserAmbientContext?: {
    tabCount: number;
    currentUrl?: string;
  };
  continueActiveTargetAfterTurn?: boolean;
  displayInput?: string;
  /**
   * From this index on, `input` is caller-appended engine text (dwf ask footer / nudge). It only enters TurnStarted and user
   * message metadata for GUI collapsing; model history and the persisted text part stay verbatim (amend-resume transcription needs it all).
   */
  epilogueStart?: number;
  inputId?: string;
  intent?: TurnInputIntentMetadata;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputPresentation?: RuntimeInputPresentation;
  inputVisibility?: MessageVisibility;
  originMeta?: BackgroundResultOriginMeta;
  /** Freezes the whole background-notification batch's causal origin; never used for display. */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  /** Set by the runtime command drain: this turn consumed subagent background results. */
  backgroundSubagentResultConsumed?: boolean;
  /** Set by the runtime command drain: this turn consumed a dynamic-workflow run notification (completion / question). */
  workflowResultConsumed?: boolean;
  recordedInputMessageId?: MessageId;
  skipInputRecord?: boolean;
  skipUserPromptSubmitHooks?: boolean;
  targetId?: string;
  /** Tools hidden from the provider for this turn only; never mutates the session runtime's persistent tool surface. */
  toolDisallowlist?: readonly string[];
  traceContext?: TraceContext;
  /** This submission's Selection, for this execution only, bindable to per-request dependencies. */
  modelExecution?: ModelExecutionContext;
}

export type ExecuteTurnOptions = ExecuteTurnOptionsBase &
  import("@zcode/contracts").TurnBackgroundAttribution;

/**
 * Args for core prompt admission. Bootstrap supplies input facts and desired delivery semantics only;
 * the start/queue choice is made atomically by the AgentRuntime owning the session state.
 */
export type PromptAdmissionOptions = ExecuteTurnOptions & {
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
  delivery?: "auto" | "start_turn" | "steer_active_turn";
  expectedTurnId?: TurnId;
  /** Product queue semantics while busy; core falls back to queue for attachments or unsteerable input. */
  queueDelivery?: "guide" | "queue";
  /** Force the FIFO; for carrying transient runtime models installable only in a future standalone turn. */
  requireQueue?: boolean;
  /** Internal callers such as queue promotion require idle admission; otherwise reject immediately. */
  requireIdle?: boolean;
};

export type PromptAdmissionReceipt =
  | {
      kind: "started";
      completion: Promise<TurnResult>;
      turnId: TurnId;
    }
  | TurnSteerResult;

export type ActiveTargetLoopTrigger = "manual" | "user-prompt" | "task-notification";

export interface ContinueActiveTargetLoopOptions {
  abortSignal?: AbortSignal;
  inputId?: string;
  intent?: TurnInputIntentMetadata;
  traceContext?: TraceContext;
  trigger: ActiveTargetLoopTrigger;
  verifyBeforeFirstContinue?: boolean;
}

export interface ActiveForegroundExecutionState {
  controller: AbortController;
  disposeParentAbort: () => void;
  foregroundExecutionId: string;
  preserveQueueAutoDrainOnCancel: boolean;
  /** Queue promotion preempts the turn without pausing an active session goal. */
  suppressGoalPauseOnCancel: boolean;
}

export interface StopActiveForegroundExecutionOptions {
  expectedForegroundExecutionId?: string;
  preserveQueueAutoDrainOnCancel?: boolean;
  reason?: string;
  suppressGoalPauseOnCancel?: boolean;
}

export type StopActiveForegroundExecutionResult =
  | { kind: "stopped"; foregroundExecutionId: string }
  | { kind: "idle" }
  | { kind: "mismatch"; activeForegroundExecutionId: string };

export type ForegroundPromotionLeaseMode = "after-current" | "idle-only";

export interface ForegroundPromotionLeaseState {
  leaseId: string;
  promotedInputId: string;
}

export type AcquireForegroundPromotionLeaseResult =
  | { kind: "acquired"; leaseId: string }
  | { kind: "busy" }
  | { kind: "conflict"; leaseId: string };

export interface ActiveTurnInfo {
  kind: ActiveTurnKind;
  /** This turn's inputId (same value as TurnStarted.inputId); the anchor for workflow-run provenance. */
  inputId?: string;
  queueLength: number;
  steerable: boolean;
  turnId: TurnId;
}

export interface WorkspaceRewindRestoredFile {
  action: "delete" | "restore";
  bytesWritten?: number;
  path: string;
}

export interface WorkspaceRewindResult {
  checkpoint?: CheckpointCreatedPayload;
  evaluation?: RewindTargetEvaluation;
  restoredFiles: WorkspaceRewindRestoredFile[];
  response: string;
  rewindId: string;
  strategy: RewindStrategy;
}

export type WorkspaceFileRewindAction = "restore" | "delete";

export type WorkspaceFileRewindUnsafeReason =
  | "checkpoint_missing"
  | "checkpoint_unreadable"
  | "external_modified"
  | "file_read_failed"
  | "unsupported_checkpoint";

export interface WorkspaceFileRewindSafeFile {
  action: WorkspaceFileRewindAction;
  operationCount: number;
  path: string;
  toolNames: string[];
}

export interface WorkspaceFileRewindUnsafeFile {
  currentHash?: string;
  expectedHash?: string;
  message?: string;
  operationCount: number;
  path: string;
  reason: WorkspaceFileRewindUnsafeReason;
  toolNames: string[];
}

export interface WorkspaceFileRewindIgnoredFile {
  operationCount: number;
  path: string;
  reason: "bash_ignored";
  toolNames: string[];
}

export interface WorkspaceFileRewindPreview {
  canApply: boolean;
  ignoredFiles: WorkspaceFileRewindIgnoredFile[];
  safeFiles: WorkspaceFileRewindSafeFile[];
  unsafeFiles: WorkspaceFileRewindUnsafeFile[];
}

export interface WorkspaceFileRewindApplyResult {
  applied: boolean;
  preview: WorkspaceFileRewindPreview;
  response: string;
}

export interface ConversationRewindResult {
  branchGeneration?: number;
  evaluation?: RewindTargetEvaluation;
  keptMessageCount: number;
  response: string;
  rewindId: string;
  strategy: RewindStrategy;
  targetMessageId: MessageId;
}

export interface WorkspaceForkResult {
  checkpoint?: CheckpointCreatedPayload;
  copiedMessageCount: number;
  forkedSessionId: SessionId;
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFiles: WorkspaceRewindRestoredFile[];
  response: string;
}

/** The target product turn's raw transcript segment, pinned by the V4 resolver. */
export type StableConversationForkTarget = StableForkTargetMetadata;

/** Explicit none, or the fork point's full goal/verifier snapshot; undefined means legacy data. */
export type StableConversationForkGoalBoundary = StableForkGoalBoundaryMetadata;

export type StableConversationForkChildMetadata = ForkChildSessionMetadata;

export interface StableConversationForkOptions {
  forkedSessionId?: SessionId;
  modelSelection?: ModelSelection;
  goalBoundary: StableConversationForkGoalBoundary;
  sourceCommandId: string;
  revisionAtDecision?: number;
  target: StableConversationForkTarget;
  traceContext?: TraceContext;
}

/** Creates a hidden side-screen child from the parent's stable persisted boundary; no goal/queue/blocking state copied. */
export interface SelectionSideChatCreateOptions {
  modelSelection?: ModelSelection;
  sourceCommandId: string;
  revisionAtDecision?: number;
  traceContext?: TraceContext;
}

export interface ConversationBeforeInputForkOptions {
  modelSelection?: ModelSelection;
  forkedSessionId?: SessionId;
  goalBoundary: StableConversationForkGoalBoundary;
  sourceCommandId: string;
  targetMessageId: MessageId;
  targetProductTurnId: string;
  targetTranscriptTurnId: string;
  initialInput: ForkCommitBundle["initialInput"];
  commandFact: ForkCommitBundle["commandFact"];
  traceContext?: TraceContext;
}

export interface WorkspaceCheckpointSummary {
  checkpointId: string;
  compactBoundaryId?: string;
  coveredByCompact?: boolean;
  createdAt: Date;
  diffRef?: string;
  fileCount?: number;
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
  preview?: string;
  scope: RewindScope;
  snapshotRef: string;
}

export interface RuntimeTurnFileChangeEntry {
  afterContent?: string;
  beforeContent: string | null;
  fallbackAdditions: number;
  fallbackDeletions: number;
  path: string;
  toolNames: Set<string>;
  writeCount: number;
}

export type RuntimeTurnFileChangeMap = Map<string, RuntimeTurnFileChangeEntry>;

export interface CompactTimelineContext {
  operationId: string;
  messageId: MessageId;
  partId: PartId;
  trigger: CompactTrigger;
  phase: CompactPhase;
  compactReason: CompactReason;
  sourceCommandId?: string;
  startedAt: number;
  preCompactTokenCount?: number;
}

export interface ResumeSessionResult extends SessionHistoryHydrationResult {
  directory: string;
  /** Current resume candidate: a bare valid model identity may appear for UI re-selection; the Runtime is not bound yet. */
  modelSelection?: ModelSelection;
  /** Whether resume wrote back compact repairs the current materialization cannot fully express. */
  persistedMessagesReloadRequired: boolean;
  readFileStateRestoredCount: number;
  readFileStateSkippedRangeReadCount: number;
  readFileStateSkippedUnreadableEditCount: number;
  traceId: TraceId;
}

export interface PermissionDecisionResult {
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  permissionUpdates?: PermissionUpdate[];
}

export interface ExecuteToolsOptions {
  automationTurn?: boolean;
  offPeakTurn?: boolean;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  /** Passed only to the Agent child this turn waits on synchronously. */
  subagentModelOverride?: import("@zcode/contracts").SubagentRunOptions["modelOverride"];
  model?: Model;
  onBatchStart?: (toolCallIds: string[]) => Promise<void>;
}

export interface ExecuteToolsResult {
  results: ToolExecutionResult[];
  events: SessionEvent[];
}

export type ActiveTurnKind = "regular" | "compact" | "rewind";

export const INLINE_TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;

export const INLINE_MEDIA_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export const MAX_IMAGE_ATTACHMENT_DIMENSION = 2000;

export interface ResolvedTurnAttachment {
  contentBlock: ModelMessageContentBlock;
  filename?: string;
  metadata: AttachmentStorageMetadata;
  mime: string;
  source?: FilePartSource;
  url: string;
}

export interface PreparedImageData {
  dataUrl: string;
  mediaType: string;
  metadata?: AttachmentStorageMetadata["image"];
}

export interface ActiveTurnSteeringState {
  kind: ActiveTurnKind;
  // When the active turn is stopped, a goal reminder must not inject into not-yet-closed tool results.
  // Deferral opens only inside the regular model/tool loop; on exit close first, then materialize pending.
  goalStateChangeReminderDeferralOpen: boolean;
  pendingGoalStateChangeReminder?: {
    text: string;
  };
  pendingInputs: PendingTurnInput[];
  steerable: boolean;
  traceContext: TraceContext;
  turnId: TurnId;
  /** This turn's inputId (same source as TurnStarted.inputId); regular turns record it at beginActiveTurn. */
  inputId?: string;
}

export interface ActiveTurnStartReservation {
  kind: ActiveTurnKind;
  traceContext: TraceContext;
  turnId: TurnId;
}

export interface DrainedPendingInputDiagnostics {
  injectedMessageIds: MessageId[];
  /** Atomic Submission config carried by the inline guide; consumed at the next model-step boundary. */
  intent?: TurnInputIntentMetadata;
  latestMessageId: MessageId | undefined;
  pendingInputIds: string[];
  queryIds?: QueryId[];
  /** Immutable entries this drain committed to canonical history, letting turn-local queries advance in lockstep. */
  runtimeEntries: readonly RuntimeMessageEntry[];
  /** Tool-hide list carried by this drain's input; it must remain in force for the next provider request. */
  toolDisallowlist?: readonly string[];
}

export interface ProviderContextUsageSnapshot {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokens?: number;
  inputTokens: number;
  messageCount: number;
  model: { providerId: Model["providerId"]; modelId: Model["modelId"] };
  outputTokens?: number;
  recordedAt: number;
  traceId: TraceId;
  turnId?: TurnId;
}

export interface RunModelTextRequestOptions {
  abortSignal?: AbortSignal;
  assistantMessageId: MessageId;
  events: SessionEvent[];
  maxOutputTokens?: number;
  latestRealUserMessageIndex?: number;
  messages: ModelInputMessage[];
  /** Canonical provenance index-aligned with messages; local usage accounting only. */
  sourceEntries?: readonly (RuntimeMessageEntry | undefined)[];
  model: Model;
  onStreamSnapshot?: (snapshot: RuntimeModelStreamSnapshot) => void;
  onStreamReasoningDelta?: (text: string) => void;
  onStreamTextDelta?: (text: string) => void;
  onStreamToolCall?: (toolCall: ModelToolCall) => void;
  onModelNetworkStatus?: (event: ModelNetworkStatusEvent) => void;
  streamRecovery?: ModelStreamRecoveryStatus;
  tools: ModelToolContract[];
  traceContext: TraceContext;
}

export interface RuntimeModelStreamSnapshot {
  reasoning: ModelReasoningContentBlock[];
  text: string;
}

export interface StreamedToolExecutionResult {
  input: Record<string, unknown>;
  ledgerRecorded?: boolean;
  partID: PartId;
  result: ToolExecutionResult;
  toolCallId: ToolCallId;
}

export interface RuntimeModelTextResult {
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  finishReason: string;
  providerMetadata?: Record<string, unknown>;
  reasoning?: ModelReasoningContentBlock[];
  text: string;
  toolCalls?: ModelToolCall[];
  usage: ModelUsage;
}

export type ParsedRewindCommand =
  | {
      action: "apply";
      targetCheckpointId?: string;
    }
  | {
      action: "fork";
      targetCheckpointId?: string;
    }
  | {
      action: "cascade-message";
      scope: RewindScope;
      targetMessageId: MessageId;
    }
  | {
      action: "message";
      scope: RewindScope;
      targetMessageId: MessageId;
    }
  | {
      action: "status";
    };

export type ContextUsageTokenMethod = "estimated" | "provider_count" | "proportional_estimate";

export type ContextUsageConfidence = "high" | "medium" | "low";

export interface ContextUsageMetric {
  chars: number;
  confidence: ContextUsageConfidence;
  tokenMethod: ContextUsageTokenMethod;
  tokenizer: string;
  tokens: number;
}

export interface ContextUsageCategory extends ContextUsageMetric {
  name: string;
  percentTokens: number;
  source:
    | "system_prompt"
    | "meta_user_context"
    | "skills"
    | "tool_prompt"
    | "system_tool_schemas"
    | "mcp_tool_schemas"
    | "messages";
}

export interface ContextUsageToolDetail extends ContextUsageMetric {
  name: string;
  readOnly?: boolean;
  serverName?: string;
  sideEffectScope?: string;
  source: "system_tool" | "mcp_tool";
}

export interface ContextUsageSkillDetail extends ContextUsageMetric {
  name: string;
  path: string;
  scope: string;
  source: string;
}

export interface ContextUsageMessageRoleBreakdown extends ContextUsageMetric {
  count: number;
  role: string;
}
