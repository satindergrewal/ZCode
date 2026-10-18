// ============================================================
// Tool Types - Core tool types for registry and executor
// ============================================================

import type {
  ExecutionShellSelection,
  AutomationPort,
  OffPeakPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  BrowserControlPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  ModelMessageContent,
  ModelContentProtection,
  Model,
  CoordinatorResponsePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  ModelCatalogPort,
  RiskLevel,
  SessionId,
  SessionEvent,
  SessionModePort,
  SessionStorePort,
  SkillPort,
  SkillTelemetryMetadata,
  SubagentRunOptions,
  SubagentPort,
  ToolArtifactStorePort,
  TraceContext,
  TraceId,
  TurnId,
  WorkflowPort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type {
  JsonSchema,
  ModelToolSideEffectScope,
  PermissionBrokerReasonSource,
  PermissionCapabilityGroup,
  PermissionRuleBehavior,
  PermissionRuleValue,
  PermissionUpdate,
  ProviderNativeToolSpec,
  ToolExecutionMode,
  ToolCancellationPolicy,
  ToolContractDeclaration,
  ToolResultBudgetStrategy,
  ToolResultDisplayPayload,
  ToolTimeoutPolicy,
  ToolExecutionSpanWriter,
  ToolExecutionTelemetry,
} from "@zcode/contracts";
import type {
  PersistedReadFileStateMetadata,
  PersistedReadFileStateTool,
} from "./read-file-state-metadata.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";

// -----------------------------------------------
// Tool Metadata
// -----------------------------------------------

export interface ToolMetadata {
  name: string;
  description?: string;
  modelInstructions?: readonly string[];
  allowedInPlanMode?: boolean;
  readOnly: boolean;
  destructive: boolean;
  concurrentSafe: boolean;
  requiresUserInteraction?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sideEffectScope: ModelToolSideEffectScope;
  riskLevel: RiskLevel;
  needsApproval: boolean;
  providerVisible?: boolean;
  /**
   * Declares this tool as a "success ends the turn" terminal tool: on a successful result the executor
   * attaches turnControl to that result and ends the turn. An intrinsic capability flag (like
   * concurrentSafe/destructive) read by the executor, not guessed per call site; submit_result uses it for the actor's terminal commit.
   */
  stopTurnOnSuccess?: boolean;
  /** Trusted display source for MCP discovery; UI projection only, never permission decisions. */
  mcpPresentation?: {
    serverName: string;
    toolName: string;
    description?: string;
    /** MCP server declaring zcode_official auth; only for trusting structured identifiers in its results. */
    official?: boolean;
  };
}

// -----------------------------------------------
// Tool Execution Context
// -----------------------------------------------

export type ToolRuntimeScope = "main" | "subagent";

export interface BackgroundTaskControlStopOptions {
  /** Who stopped it: TaskStop fills "model"; terminal notifications word themselves accordingly. */
  initiator?: "user" | "model";
  strict: true;
  traceContext?: TraceContext;
}

export interface BackgroundTaskControlStopResult {
  command?: string;
  ok: boolean;
  reason?:
    | "background_task_cancel_not_supported"
    | "background_task_not_found"
    | "background_task_not_running";
  status?: string;
  taskId: string;
  type?: string;
}

export interface BackgroundTaskControlPort {
  stopBackgroundTask(
    taskId: string,
    options: BackgroundTaskControlStopOptions,
  ): Promise<BackgroundTaskControlStopResult>;
}

export interface ToolExecutionContext {
  toolCallId: string;
  /**
   * Live observation sink for the current Tool. Handlers record facts via this narrow interface, never raw OTel spans.
   */
  telemetry?: ToolExecutionSpanWriter;
  /** Whether this call belongs to an automation dispatch turn; write-tool handlers use it for the final permission check. */
  automationTurn?: boolean;
  /** Whether this call belongs to an idle-time task dispatch turn; OffPeakCreate uses it for the final rejection. */
  offPeakTurn?: boolean;
  traceContext?: TraceContext;
  traceId: TraceId;
  spanId?: string;
  parentSpanId?: string;
  abortSignal: AbortSignal;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  executionPort?: ExecutionPort;
  /** browser-use control port; node_repl's agent.browsers.* runs through it. Absent = browser unavailable. */
  browserControlPort?: BrowserControlPort;
  /** Official browser-use plugin docs asset dir; used by agent.browsers.documentation() only when browser-use is enabled. */
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  /** Core Server's Selection override for foreground children. */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  /** Port for a workflow actor to submit a terminal result and await the engine verdict; injected only in workflow actor sessions. */
  workflowSubmitPort?: WorkflowSubmitPort;
  /** Port for a workflow actor to escalate a blocking question and await the main agent answer; injected only in workflow actor sessions. */
  workflowEscalatePort?: WorkflowEscalatePort;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** Workflow run port; absent = CreateWorkflow returns a placeholder diagnostic instead of starting. */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /** dwf snippet sync-execution port; absent = EvalWorkflowSnippet fails with a capability-missing business error. */
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** Model catalog port; absent = ListModels reports missing capability and CreateWorkflow rejects subagent_model. */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState?: ReadFileStateMap;
  recordReadFileStateMetadata?: (metadata: PersistedReadFileStateMetadata) => void;
  /** Records Skill resolved metadata; telemetry only, never alters the model-visible result. */
  recordSkillTelemetryMetadata?: (metadata: SkillTelemetryMetadata) => void;
  bashShellSelection?: ExecutionShellSelection;
  embeddedSearch?: ToolEmbeddedSearchContext;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  workingDirectory: string;
  workspaceRoot: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  memoryRoot?: string;
  runtimeScope?: ToolRuntimeScope;
  providerVisibleToolNames?: readonly string[];
  sessionId: SessionId;
  turnId?: TurnId;
}

export interface ToolEmbeddedSearchContext {
  backend?: EmbeddedSearchBackend;
  enabled: boolean;
  findAndGrepEnabled?: boolean;
}

export interface ReadFileStateEntry {
  path: string;
  content: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAt: Date;
  sourceTool?: PersistedReadFileStateTool;
  revisionId?: string;
  mtimeMs?: number;
  sizeBytes?: number;
}

export type ReadFileStateMap = Map<string, ReadFileStateEntry>;

// -----------------------------------------------
// Tool Handler
// -----------------------------------------------

// Tool handlers use this return value for expected business failures; success outputs never use this reserved shape.
export interface ToolHandlerFailure {
  result: false;
  errorCode: number;
  message: string;
}

export interface ToolInputValidationContext {
  runtimeTaskRegistry?: RuntimeTaskRegistry;
}

export type ToolInputValidationResult = { result: true } | ToolHandlerFailure;

/**
 * Context for {@link ToolEntry.resolveInput}. Narrow to exactly what parsing needs -- the workdir is the only
 * door to "where do in-project things live"; more than that turns a normalization hook into a second execution path.
 */
export interface ToolInputResolutionContext {
  workingDirectory?: string;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  /**
   * Workflow run port plus this session id: AmendWorkflow resolves `run_id` into the facts of "is the
   * predecessor this session's / still running". Still read-only --
   * the normalization hook does not become a second execution path because of it.
   */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /**
   * Model catalog port: CreateWorkflow/AmendWorkflow resolve `subagent_model` to canonical form through it;
   * unresolvable values fail as a business error **before** the confirmation window.
   * Synchronous, read-only, here for the same reason as `dynamicWorkflowRunPort`. A field present without the
   * port is rejected -- never silently accept a string the host cannot resolve.
   */
  modelCatalogPort?: ModelCatalogPort;
  sessionId?: string;
  /**
   * Probe for "is a skill loaded in this session right now" (handlers/workflow-skill-gate.ts). The runtime
   * answers from the provider-visible history (agent/loaded-skills.ts), so after compaction the answer reverts
   * along with that history. Absent = no Skill tool here or caller not participating; the gate is inert.
   */
  hasLoadedSkill?: (skillName: string) => boolean;
}

export type ToolInputResolutionResult = { result: true; input: unknown } | ToolHandlerFailure;

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolExecutionContext,
) => Promise<TOutput>;

// -----------------------------------------------
// Tool Entry
// -----------------------------------------------

export interface ToolEntry extends ToolContractDeclaration {
  aliases?: readonly string[];
  /**
   * Host-issued atomicity policy for model content. Only an authority-verified
   * registration path may set this; executor code must never infer it from a
   * tool name or from model-visible content.
   */
  modelContentProtection?: ModelContentProtection["kind"];
  /**
   * Optional provider-visible character threshold for tools whose upstream contract
   * budgets UTF-16 characters rather than UTF-8 bytes.
   */
  maxModelChars?: number;
  /**
   * MIME type for provider-visible model content persisted by the result budget.
   * Defaults to the handler result shape when omitted.
   */
  resultArtifactContentType?: string;
  metadata: ToolMetadata;
  /**
   * Written only from host-verified trusted sources; never derived from model-visible MCP names or descriptors.
   */
  permissionCapabilityGroup?: PermissionCapabilityGroup;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  handler: ToolHandler;
  /** Single-source projection of current-turn model capabilities onto provider descriptor and executor schema. */
  resolveModelContract?: (context: ToolExecutionModelContext) => {
    description?: string;
    inputSchema?: JsonSchema;
  };
  validateInput?: (
    input: unknown,
    context: ToolInputValidationContext,
  ) => ToolInputValidationResult;
  /**
   * Normalize the model's arguments **into the execution facts that will happen**. Called by the executor after
   * `validateInput` and before PreToolUse hooks; the return value replaces `executionInput` wholesale.
   *
   * The position is the whole point. Hooks, project permission rules, permission event payloads,
   * `prepareApproval`, and the handler all read the same normalized input from here on, so three things hold:
   *   1. Policy cannot be bypassed -- a PreToolUse hook scanning scripts sees the real script on saved runs too;
   *   2. Cross-version visibility -- the args channel is schema-free passthrough on every client version; display is not;
   *   3. Approval equals execution byte-for-byte -- parsed once, those same bytes reach the handler; no approve-A-run-B.
   *
   * The return value must still satisfy `inputSchema`/`runtimeInputSchema` (the executor re-validates after
   * hook rewrites). Parse failure returns {@link ToolHandlerFailure} and the executor settles it before hooks --
   * a business failure, not an infrastructure fault; it must not interrupt the user with a confirmation first.
   */
  resolveInput?: (
    input: unknown,
    context: ToolInputResolutionContext,
  ) => Promise<ToolInputResolutionResult> | ToolInputResolutionResult;
  formatModelContent?: (output: unknown) => ModelMessageContent;
  formatPersistedModelContent?: (
    input: ToolPersistedModelContentInput,
  ) => ModelMessageContent | undefined;
  resolveTimeoutBudgetMs?: (
    input: unknown,
    context?: ToolExecutionModelContext,
  ) => number | undefined;
  resolvePermissionCapability?: (
    input: unknown,
    context?: ToolRuntimePermissionCapabilityContext,
  ) => ToolRuntimePermissionCapability | undefined;
  resolvePermissionRulePolicy?: (
    input: unknown,
    context?: ToolRuntimePermissionCapabilityContext,
  ) => ToolPermissionRulePolicy | undefined;
  /**
   * Last word on an `ask` decision, owned by the tool. Runs after the permission service
   * has already decided to ask, so it can only narrow the ask to a pass (`proceed`) or
   * enrich it with a preview — it can never turn an allow into an ask.
   *
   * Synchronous like the other permission hooks: it inspects the input the executor
   * already holds and must not perform I/O on the approval path. A tool that needs to
   * read the world before it can build a preview belongs in {@link resolveInput}, which
   * runs earlier, is async, and whose result the whole downstream chain shares.
   */
  prepareApproval?: (input: unknown) => ToolApprovalGate;
  inputSchema: JsonSchema;
  runtimeInputSchema?: unknown;
  runtimeOutputSchema?: unknown;
  timeout: ToolTimeoutPolicy;
  cancellation: ToolCancellationPolicy;
}

export type ToolApprovalGate =
  | { gate: "proceed" }
  | { gate: "ask"; display?: ToolResultDisplayPayload };

export interface ToolPermissionRulePolicy {
  evaluateRules: (
    behavior: PermissionRuleBehavior,
    rules: readonly PermissionRuleValue[],
  ) => boolean;
  suggestedPermissionUpdates: PermissionUpdate[];
}

export interface ToolPersistedModelContentInput {
  output: unknown;
  content: string;
  persistedPath: string;
  originalBytes: number;
}

export interface ToolRuntimePermissionCapability {
  allowedInPlanMode?: boolean;
  destructive?: boolean;
  needsApproval?: boolean;
  readOnly?: boolean;
  requiresUserInteraction?: boolean;
  riskLevel?: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  permission?: Partial<ToolContractDeclaration["permission"]>;
}

export interface ToolRuntimePermissionCapabilityContext {
  runtimeScope?: ToolRuntimeScope;
  workingDirectory?: string;
  workspaceRoot?: string;
}

export interface ToolExecutionModelContext {
  model?: Model;
}

// -----------------------------------------------
// Execution Results
// -----------------------------------------------

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  output: unknown;
  turnControl?: ToolExecutionTurnControl;
  followUpUserInput?: ToolExecutionFollowUpUserInput;
  display?: ToolResultDisplayPayload;
  modelContent?: ModelMessageContent;
  readFileStateMetadata?: PersistedReadFileStateMetadata;
  serialization?: ToolResultSerialization;
  /** Executor-aggregated internal perf facts; never enters the model-visible Tool Output. */
  performance?: ToolExecutionTelemetry;
  error?: {
    code?: string;
    detail?: string;
    type: string;
    message: string;
    reasonSource?: PermissionBrokerReasonSource;
    stack?: string;
  };
  durationMs: number;
  startedAt: Date;
  completedAt: Date;
}

export interface ToolExecutionFollowUpUserInput {
  input: string;
  reasonSource: PermissionBrokerReasonSource;
}

export interface ToolExecutionTurnControl {
  reason: "automation_create_limit" | "plan_exit_denied" | "subagent_terminal";
  stopTurnAfterResult: boolean;
}

export interface ToolResultSerialization {
  content: string;
  modelContent?: ModelMessageContent;
  originalBytes: number;
  /**
   * The bytes that actually enter the model request. For protected CUA structured frames the serialized text renders
   * image blocks as short placeholders while the real base64 raster is sent verbatim -- so this equals serialized-text
   * bytes plus real media payload; cost/usage observability (setOutputBytes, turn-tool-usage,
   * usage-observability) must not undercount images. This aggregate is the single public metering state.
   */
  returnedBytes: number;
  truncated: boolean;
  budgetStrategy: ToolResultBudgetStrategy;
  artifactPath?: string;
}

export interface ToolBatchResult {
  toolCallId: string;
  results: ToolExecutionResult[];
  allSucceeded: boolean;
}

// -----------------------------------------------
// Executable Tool Call
// -----------------------------------------------

export interface ExecutableToolCall {
  id: string;
  name: string;
  input: unknown;
}

// -----------------------------------------------
// Batch Events
// -----------------------------------------------

export type ToolBatchEvent =
  | { type: "batch_start"; parallelGroupIndex: number; toolCallIds: string[] }
  | {
      type: "batch_complete";
      parallelGroupIndex: number;
      results: ToolExecutionResult[];
    }
  | { type: "tool_start"; toolCallId: string }
  | { type: "tool_complete"; result: ToolExecutionResult }
  | { type: "error"; error: Error; toolCallId?: string };
