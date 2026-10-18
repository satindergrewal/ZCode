/* oxlint-disable eslint(max-lines) -- message_completion and agent_step share prompt lifecycle state; splitting would add cross-file sync complexity. */
import {
  legacyTelemetryModelFields,
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "@/lib/providerTelemetryIdentity.js";
import type {
  InputId,
  PlanIdentitySnapshot,
  ZCodeContextCompactionTimelineMeta,
  ZCodePersistedFileChange,
  ZCodeProvider,
  ZCodeStreamEvent,
  ZCodeTimelineStatus,
  ZCodeUsage,
} from "@zcode/shared";
import {
  CUSTOM_SUPPLIER_KEY_PREFIX,
  GHOST_SUPPLIER_KEY_PREFIX,
  NATIVE_SUPPLIER_KEY_PREFIX,
  createUuid,
  computeLineChangeStat,
  decodeCustomModelValue,
} from "@zcode/shared";
interface ComposerInputTimingState {
  inputStartTime: number;
  inputFirstCharTime: number;
}

interface PromptTelemetryState {
  taskId: string;
  messageId: string;
  inputId?: InputId;
  baseEventExtraDetail: Record<string, string>;
  sendTime: number;
  inputStartTime: number;
  inputFirstCharTime: number;
  waitingMs: number;
  permissionWaitsByRequestId: Map<string, PermissionWaitState>;
  firstTokenAt: number | null;
  usage: ZCodeUsage | null;
  usageEventKeys: Set<string>;
  finalizedAgentStepCount: number;
  toolCallTotal: number;
  toolCallFailed: number;
  firstToolCallError: string;
}

interface PermissionWaitState {
  requestedAt: number;
  toolCallId?: string;
}

interface FinalizePromptTelemetryInput {
  taskId: string;
  status: string;
  finishedAt: number;
  fileChanges?: readonly ZCodePersistedFileChange[];
  usage?: ZCodeUsage;
  errorType?: string;
  errorMsg?: string;
  messageSource?: PromptMessageSource;
  agentComposition?: AgentComposition;
}

/** Sources of a standalone background wake: the Agent tool's background subagent, or a dynamic-workflow run notification. */
export type PromptMessageSource = "background_subagent" | "background_workflow";

/**
 * `message_completion.agent_composition`: which Subagent results this turn consumed
 * (fg = foreground, bg = background, wf = dynamic-workflow run). Eight values = three booleans.
 */
type AgentComposition =
  | "main_only"
  | "main_plus_fg"
  | "main_plus_bg"
  | "main_plus_wf"
  | "main_plus_fg_bg"
  | "main_plus_fg_wf"
  | "main_plus_bg_wf"
  | "main_plus_fg_bg_wf";

export function composeAgentComposition(input: {
  hasForegroundSubagentResult: boolean;
  hasBackgroundSubagentResult: boolean;
  hasWorkflowResult: boolean;
}): AgentComposition {
  const parts = [
    ...(input.hasForegroundSubagentResult ? ["fg"] : []),
    ...(input.hasBackgroundSubagentResult ? ["bg"] : []),
    ...(input.hasWorkflowResult ? ["wf"] : []),
  ];
  return parts.length === 0 ? "main_only" : (`main_plus_${parts.join("_")}` as AgentComposition);
}

interface FinalizedPromptTelemetry {
  taskId: string;
  messageId: string;
  eventExtraDetail: Record<string, string>;
}

type AgentStepType = "reasoning" | "tool_call" | "generation";
type GenerationCloseReason = "reasoning" | "tool_call" | "task_complete" | "task_error";
type AgentStepTelemetryClientMode = "desktop-continuous" | "web-remote-replayable";
export type AgentStepRole = "foreground subagent" | "background subagent" | "workflow subagent";

interface ActiveAgentStep {
  stepId: string;
  stepType: AgentStepType;
  loopIndex: number;
  startedAt: number;
  waitingMs: number;
  model?: AgentStepModelIdentity;
  usage?: AgentStepUsageAttribution;
  lastMessageChunkAt?: number;
  toolId?: string;
  toolName?: string;
  agentId?: string;
  agentRole?: AgentStepRole;
  skillMetadata?: AgentStepSkillMetadata;
}

interface AgentStepSkillMetadata {
  qualifiedName?: string;
  pluginId?: string;
  source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
}

interface AgentStepModelIdentity {
  requestId?: string;
  modelName: string;
  modelProvider: string;
  providerName: string;
}

interface AgentStepUsageAttribution {
  requestIds: string[];
  requestCount: number;
  scope: "model_request" | "subagent_requests";
  usage: ZCodeUsage;
}

interface AgentStepToolAttribution {
  agentId?: string;
  agentRole?: AgentStepRole;
  modelName?: string;
  modelProvider?: string;
  providerName?: string;
}

interface AgentStepTelemetryState {
  nextLoopIndex: number;
  currentModelRequest: AgentStepModelIdentity | null;
  pendingUsageByRequestId: Map<string, AgentStepUsageAttribution>;
  reasoningStep: ActiveAgentStep | null;
  generationStep: ActiveAgentStep | null;
  toolStepsById: Map<string, ActiveAgentStep>;
  settledPermissionWaitsByToolId: Map<string, SettledPermissionWaitAttribution>;
}

interface SettledPermissionWaitAttribution {
  waitingMs: number;
  earliestRequestedAt: number;
}

interface FinalizedAgentStepTelemetry {
  taskId: string;
  messageId: string;
  eventExtraDetail: Record<string, string>;
}

const composerInputTimingByWorkspace = new Map<string, ComposerInputTimingState>();
const queuedPromptTelemetryByTask = new Map<string, PromptTelemetryState[]>();
const activePromptTelemetryByTask = new Map<string, PromptTelemetryState>();
const agentStepTelemetryByTask = new Map<string, AgentStepTelemetryState>();

function resolvePromptTelemetryModelProvider(params: {
  modelName?: string | null;
  provider?: ZCodeProvider;
  selectedSupplierKey?: string | null;
}): string {
  const { modelName, provider, selectedSupplierKey } = params;
  // Bugfix: send_btn's model_name is already corrected to the UI model value, but
  // selectedSupplierKey occasionally still points at the previous supplier, producing
  // `uuid/model` paired with a `glm` provider. When the model value carries its own provider
  // dimension, the provider must align with the same UI selection.
  const providerFromModelName = readProviderIdFromModelValue(modelName);
  if (providerFromModelName) {
    return providerFromModelName;
  }

  if (!selectedSupplierKey) {
    return provider ?? "";
  }

  if (selectedSupplierKey.startsWith(CUSTOM_SUPPLIER_KEY_PREFIX)) {
    const customProviderId = selectedSupplierKey.slice(CUSTOM_SUPPLIER_KEY_PREFIX.length).trim();
    return customProviderId || provider || "";
  }

  // A ghost supplier is the temporary quarantine before a stable custom provider resolves; fall back to the current ZCode Agent provider.
  if (selectedSupplierKey.startsWith(GHOST_SUPPLIER_KEY_PREFIX)) {
    return provider ?? "";
  }

  if (selectedSupplierKey.startsWith(NATIVE_SUPPLIER_KEY_PREFIX)) {
    const nativeProvider = selectedSupplierKey.slice(NATIVE_SUPPLIER_KEY_PREFIX.length).trim();
    return nativeProvider || provider || "";
  }

  return provider ?? "";
}

function readProviderIdFromModelValue(modelValue: string | null | undefined): string | null {
  const normalizedModelValue = modelValue?.trim() ?? "";
  if (!normalizedModelValue) {
    return null;
  }

  const customModel = decodeCustomModelValue(normalizedModelValue);
  if (customModel?.providerId?.trim()) {
    return customModel.providerId.trim();
  }

  const separatorIndex = normalizedModelValue.indexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }

  const providerId = normalizedModelValue.slice(0, separatorIndex).trim();
  return providerId || null;
}

function resolveProviderHostname(baseURL: string | null | undefined): string {
  const normalizedBaseURL = baseURL?.trim() ?? "";
  if (!normalizedBaseURL) {
    return "";
  }

  try {
    return new URL(normalizedBaseURL).hostname;
  } catch {
    return "";
  }
}

function createAgentStepTelemetryState(): AgentStepTelemetryState {
  return {
    nextLoopIndex: 1,
    currentModelRequest: null,
    pendingUsageByRequestId: new Map(),
    reasoningStep: null,
    generationStep: null,
    toolStepsById: new Map(),
    settledPermissionWaitsByToolId: new Map(),
  };
}

function getAgentStepTelemetryState(taskId: string): AgentStepTelemetryState {
  const existing = agentStepTelemetryByTask.get(taskId);
  if (existing) {
    return existing;
  }

  const created = createAgentStepTelemetryState();
  agentStepTelemetryByTask.set(taskId, created);
  return created;
}

function createAgentStep(
  state: AgentStepTelemetryState,
  stepType: AgentStepType,
  startedAt: number,
  options: {
    toolId?: string;
    toolName?: string;
    skillMetadata?: AgentStepSkillMetadata;
  } = {},
): ActiveAgentStep {
  const step: ActiveAgentStep = {
    stepId: createUuid(),
    stepType,
    loopIndex: state.nextLoopIndex,
    startedAt,
    waitingMs: 0,
    ...(state.currentModelRequest ? { model: { ...state.currentModelRequest } } : {}),
    ...options,
  };
  const requestId = step.model?.requestId;
  if (requestId) {
    const pendingUsage = state.pendingUsageByRequestId.get(requestId);
    if (pendingUsage) {
      step.usage = pendingUsage;
      state.pendingUsageByRequestId.delete(requestId);
    }
  }
  state.nextLoopIndex += 1;
  return step;
}

function normalizeAgentStepStatus(status: string): string {
  if (status === "failed" || status === "fail" || status === "denied") {
    return "fail";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "success";
}

function cronCreateAutomationId(content: unknown): string | undefined {
  let value = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const automation = (value as { automation?: unknown }).automation;
  if (!automation || typeof automation !== "object" || Array.isArray(automation)) return undefined;
  const automationId = (automation as { automationId?: unknown }).automationId;
  return typeof automationId === "string" && automationId.trim() ? automationId.trim() : undefined;
}

function markPromptFirstToken(prompt: PromptTelemetryState, now: number): void {
  if (prompt.firstTokenAt !== null) {
    return;
  }

  prompt.firstTokenAt = now;
}

function finalizeAgentStep(input: {
  prompt: PromptTelemetryState;
  step: ActiveAgentStep;
  finishedAt: number;
  status: string;
  errorType?: string;
  errorMsg?: string;
  generationTailFinalizeMs?: number;
  automationId?: string;
}): FinalizedAgentStepTelemetry {
  const normalizedStatus = normalizeAgentStepStatus(input.status);
  const isToolCall = input.step.stepType === "tool_call";
  const usage = input.step.usage?.usage;
  const model = input.step.model;
  // Bugfix: scanning all of taskMessages before completion made later turns double-count
  // historical steps/tools. Per-step closure is the source of truth for the current message,
  // so aggregation must accumulate here, synchronously.
  input.prompt.finalizedAgentStepCount += 1;
  if (isToolCall) {
    input.prompt.toolCallTotal += 1;
    const isFailed = normalizedStatus !== "success" || Boolean(input.errorMsg);
    if (isFailed) {
      input.prompt.toolCallFailed += 1;
      if (!input.prompt.firstToolCallError && input.errorMsg) {
        input.prompt.firstToolCallError = input.errorMsg;
      }
    }
  }

  return {
    taskId: input.prompt.taskId,
    messageId: input.prompt.messageId,
    eventExtraDetail: {
      step_id: input.step.stepId,
      is_tftt_cached: "0",
      loop_index: String(input.step.loopIndex),
      step_type: input.step.stepType,
      // Root cause: the old code read the model from shared prompt fields, so a later main or
      // child request overwrote already-created steps. A step must freeze the model its request
      // actually used; fall back to the prompt seed only when the legacy fact lacks request identity.
      model_name: legacyTelemetryModelValue(
        model?.modelName ?? input.prompt.baseEventExtraDetail.model_name ?? "",
      ),
      model_provider: legacyTelemetryProviderId(
        model?.modelProvider ?? input.prompt.baseEventExtraDetail.model_provider ?? "",
      ),
      provider_name: model?.providerName ?? input.prompt.baseEventExtraDetail.provider_name ?? "",
      model_request_id:
        input.step.usage?.requestIds.length === 1 ? (input.step.usage.requestIds[0] ?? "") : "",
      model_request_count: String(input.step.usage?.requestCount ?? 0),
      token_usage_scope: input.step.usage?.scope ?? "",
      is_tool_call: isToolCall ? "1" : "0",
      tool_name: input.step.toolName ?? "",
      tool_call_id: isToolCall ? (input.step.toolId ?? "") : "",
      ...(input.step.agentId ? { agent_id: input.step.agentId } : {}),
      ...(input.step.agentRole ? { agent_role: input.step.agentRole } : {}),
      duration_ms: String(Math.max(input.finishedAt - input.step.startedAt, 0)),
      waiting_ms: String(input.step.waitingMs),
      generation_tail_finalize_ms:
        input.generationTailFinalizeMs !== undefined ? String(input.generationTailFinalizeMs) : "",
      status: normalizedStatus,
      input_tokens: String(usage?.inputTokens ?? 0),
      output_tokens: String(usage?.outputTokens ?? 0),
      reasoning_tokens: String(usage?.reasoningTokens ?? 0),
      cached_tokens: String(usage?.cachedInputTokens ?? 0),
      cache_write_input_tokens: String(usage?.cachedWriteInputTokens ?? 0),
      total_tokens: String(usage?.totalTokens ?? 0),
      error_type: normalizedStatus === "success" ? "" : (input.errorType ?? "UNKNOWN"),
      error_msg: normalizedStatus === "success" ? "" : (input.errorMsg ?? ""),
      ...(input.automationId ? { automation_id: input.automationId } : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.qualifiedName
        ? { skill_qualified_name: input.step.skillMetadata.qualifiedName }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.pluginId
        ? { skill_plugin_id: input.step.skillMetadata.pluginId }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.source
        ? { skill_source: input.step.skillMetadata.source }
        : {}),
    },
  };
}

function closeReasoningStep(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  output: FinalizedAgentStepTelemetry[],
): void {
  if (!state.reasoningStep) {
    return;
  }

  output.push(
    finalizeAgentStep({
      prompt,
      step: state.reasoningStep,
      finishedAt: now,
      status: "success",
    }),
  );
  state.reasoningStep = null;
}

function closeGenerationStep(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  status: string,
  output: FinalizedAgentStepTelemetry[],
  error?: { type?: string; msg?: string },
  closeReason?: GenerationCloseReason,
  clientMode: AgentStepTelemetryClientMode = "desktop-continuous",
): void {
  if (!state.generationStep) {
    return;
  }

  // Fix: replayable resume replays historical chunk/terminal events on the client, so
  // Date.now() is local processing time, not the true tail latency from the source's final
  // content chunk to the terminal state.
  const canReportGenerationTailFinalize = clientMode === "desktop-continuous";
  const generationTailFinalizeMs =
    canReportGenerationTailFinalize &&
    (closeReason === "task_complete" || closeReason === "task_error") &&
    state.generationStep.lastMessageChunkAt !== undefined
      ? Math.max(now - state.generationStep.lastMessageChunkAt, 0)
      : undefined;

  output.push(
    finalizeAgentStep({
      prompt,
      step: state.generationStep,
      finishedAt: now,
      status,
      errorType: error?.type,
      errorMsg: error?.msg,
      generationTailFinalizeMs,
    }),
  );
  state.generationStep = null;
}

function settlePermissionWait(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState | undefined,
  requestId: string,
  now: number,
): void {
  const permissionWait = prompt.permissionWaitsByRequestId.get(requestId);
  if (!permissionWait) {
    return;
  }

  const waitingMs = Math.max(now - permissionWait.requestedAt, 0);
  prompt.waitingMs += waitingMs;
  if (permissionWait.toolCallId) {
    const toolStep = state?.toolStepsById.get(permissionWait.toolCallId);
    if (toolStep) {
      toolStep.waitingMs += waitingMs;
    } else if (state) {
      const settled = state.settledPermissionWaitsByToolId.get(permissionWait.toolCallId);
      state.settledPermissionWaitsByToolId.set(permissionWait.toolCallId, {
        waitingMs: (settled?.waitingMs ?? 0) + waitingMs,
        earliestRequestedAt: Math.min(
          settled?.earliestRequestedAt ?? permissionWait.requestedAt,
          permissionWait.requestedAt,
        ),
      });
    }
  }
  prompt.permissionWaitsByRequestId.delete(requestId);
}

function applySettledPermissionWaitAttribution(
  state: AgentStepTelemetryState,
  step: ActiveAgentStep,
): void {
  if (!step.toolId) {
    return;
  }

  const settled = state.settledPermissionWaitsByToolId.get(step.toolId);
  if (!settled) {
    return;
  }

  step.waitingMs += settled.waitingMs;
  step.startedAt = Math.min(step.startedAt, settled.earliestRequestedAt);
  state.settledPermissionWaitsByToolId.delete(step.toolId);
}

function findEarliestPermissionRequestedAt(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  toolCallId: string,
): number | undefined {
  let earliest = state.settledPermissionWaitsByToolId.get(toolCallId)?.earliestRequestedAt;
  for (const permissionWait of prompt.permissionWaitsByRequestId.values()) {
    if (permissionWait.toolCallId !== toolCallId) {
      continue;
    }
    earliest = Math.min(earliest ?? permissionWait.requestedAt, permissionWait.requestedAt);
  }
  return earliest;
}

function settlePermissionWaitsForTool(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  toolCallId: string,
  now: number,
): void {
  for (const [requestId, permissionWait] of prompt.permissionWaitsByRequestId) {
    if (permissionWait.toolCallId === toolCallId) {
      settlePermissionWait(prompt, state, requestId, now);
    }
  }
}

function settleAllPermissionWaits(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState | undefined,
  now: number,
): void {
  for (const requestId of prompt.permissionWaitsByRequestId.keys()) {
    settlePermissionWait(prompt, state, requestId, now);
  }
}

function closeToolSteps(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  status: string,
  output: FinalizedAgentStepTelemetry[],
  error?: { type?: string; msg?: string },
): void {
  for (const [toolId, toolStep] of state.toolStepsById) {
    settlePermissionWaitsForTool(prompt, state, toolId, now);
    output.push(
      finalizeAgentStep({
        prompt,
        step: toolStep,
        finishedAt: now,
        status,
        errorType: error?.type,
        errorMsg: error?.msg,
      }),
    );
  }
  state.toolStepsById.clear();
}

export function buildPromptTelemetryExtraDetail(params: {
  askMode?: string | null;
  modelName?: string | null;
  provider?: ZCodeProvider;
  selectedSupplierKey?: string | null;
  providerBaseURL?: string | null;
  planIdentitySnapshot?: PlanIdentitySnapshot | null;
}): Record<string, string> {
  const modelProvider = resolvePromptTelemetryModelProvider({
    modelName: params.modelName,
    provider: params.provider,
    selectedSupplierKey: params.selectedSupplierKey,
  });
  const providerHostname = resolveProviderHostname(params.providerBaseURL);

  return {
    ask_mode: params.askMode ?? "",
    model_name: legacyTelemetryModelValue(params.modelName ?? ""),
    model_provider: legacyTelemetryProviderId(modelProvider),
    // Fix: a custom provider's model_provider is often an internal uuid, meaningless for
    // warehouse analysis of the real backend. provider_name now carries the provider hostname;
    // model_provider is untouched to preserve the existing uuid/provider-id warehouse
    // dimensions. Only the hostname is parsed from the URL -- never the full endpoint, to
    // avoid leaking path or query.
    ...(providerHostname ? { provider_name: providerHostname } : {}),
    // agent comes from the ZCode Agent provider; this repo has no separate session.agentId.
    agent: params.provider ?? "",
    plan_status: params.planIdentitySnapshot?.planStatus ?? "unknown",
    plan_product_id: params.planIdentitySnapshot?.planProductId ?? "",
  };
}

const COMPACTION_TERMINAL_STATUSES: readonly ZCodeTimelineStatus[] = [
  "completed",
  "failed",
  "interrupted",
];

function isCompactionTerminalStatus(status: ZCodeTimelineStatus): boolean {
  return COMPACTION_TERMINAL_STATUSES.includes(status);
}

/**
 * Telemetry fields for context-compaction outcomes.
 * Returns the field object only in terminal states (completed/failed/interrupted) and null
 * while running (started/retrying/skipped); callers use that to decide whether to report.
 * The warehouse computes the success rate by status: completed / (completed + failed + interrupted).
 * provider/model dimensions reuse buildPromptTelemetryExtraDetail; version is injected by the
 * backend reportEvent.
 */
export function buildCompactionTelemetryExtraDetail(params: {
  timeline: ZCodeContextCompactionTimelineMeta;
  provider?: ZCodeProvider;
  /** Provider normalized by the V4 fact from the real model request; preferred over legacy UI supplier derivation. */
  modelProvider?: string | null;
  modelName?: string | null;
  selectedSupplierKey?: string | null;
}): Record<string, string> | null {
  const { timeline } = params;
  if (!isCompactionTerminalStatus(timeline.status)) {
    return null;
  }

  const modelFields = params.provider
    ? buildPromptTelemetryExtraDetail({
        modelName: params.modelName,
        provider: params.provider,
        selectedSupplierKey: params.selectedSupplierKey,
      })
    : { model_name: params.modelName ?? "", model_provider: "" };

  const preCompactTokens = timeline.preCompactTokenCount ?? 0;
  const postCompactTokens = timeline.postCompactTokenCount ?? 0;
  // Compaction ratio uses the provider's post/pre figures; leave empty when pre is 0 (no data) to avoid divide-by-zero polluting the distribution.
  const compactRatio =
    preCompactTokens > 0 ? (postCompactTokens / preCompactTokens).toFixed(4) : "";
  const durationMs =
    timeline.startedAt !== undefined && timeline.endedAt !== undefined
      ? String(Math.max(timeline.endedAt - timeline.startedAt, 0))
      : "";

  return {
    status: timeline.status,
    trigger: timeline.trigger,
    reason: timeline.reason ?? "",
    attempt: String(timeline.attempt ?? 0),
    duration_ms: durationMs,
    pre_compact_tokens: String(preCompactTokens),
    post_compact_tokens: String(postCompactTokens),
    true_post_compact_tokens: String(timeline.truePostCompactTokenCount ?? 0),
    compact_ratio: compactRatio,
    model_name: legacyTelemetryModelValue(modelFields.model_name ?? ""),
    model_provider: legacyTelemetryProviderId(
      params.modelProvider?.trim() || modelFields.model_provider || "",
    ),
  };
}

function buildPromptUsageTelemetryExtraDetail(
  usage: ZCodeUsage | undefined,
  tokenSource?: string,
): Record<string, string> {
  if (!usage) {
    return {};
  }

  return {
    input_tokens: String(usage.inputTokens),
    output_tokens: String(usage.outputTokens),
    reasoning_tokens: String(usage.reasoningTokens ?? 0),
    cached_input_tokens: String(usage.cachedInputTokens ?? 0),
    cache_write_input_tokens: String(usage.cachedWriteInputTokens ?? 0),
    // The ZCode Agent path never surfaces tool-use prompt tokens; pad success states with 0 to keep the extraDetail field set complete.
    tool_use_prompt_tokens: "0",
    total_tokens: String(usage.totalTokens),
    ...(tokenSource ? { token_source: tokenSource } : {}),
  };
}

function mergePromptUsage(left: ZCodeUsage | null, right: ZCodeUsage): ZCodeUsage {
  if (!left) {
    return {
      inputTokens: right.inputTokens,
      outputTokens: right.outputTokens,
      totalTokens: right.totalTokens,
      reasoningTokens: right.reasoningTokens ?? 0,
      cachedInputTokens: right.cachedInputTokens ?? 0,
      cachedWriteInputTokens: right.cachedWriteInputTokens ?? 0,
    };
  }

  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

function ensureComposerInputTiming(workspacePath: string): ComposerInputTimingState {
  const existing = composerInputTimingByWorkspace.get(workspacePath);
  if (existing) {
    return existing;
  }

  const created: ComposerInputTimingState = {
    inputStartTime: 0,
    inputFirstCharTime: 0,
  };
  composerInputTimingByWorkspace.set(workspacePath, created);
  return created;
}

function consumeComposerInputTiming(workspacePath: string, sendTime: number) {
  const current = ensureComposerInputTiming(workspacePath);
  const inputStartTime = current.inputStartTime || current.inputFirstCharTime || sendTime;
  const inputFirstCharTime = current.inputFirstCharTime || inputStartTime || sendTime;

  composerInputTimingByWorkspace.set(workspacePath, {
    inputStartTime: 0,
    inputFirstCharTime: 0,
  });

  return {
    inputStartTime,
    inputFirstCharTime,
  };
}

function collectFileChangeMetrics(fileChanges: readonly ZCodePersistedFileChange[] | undefined) {
  if (!fileChanges || fileChanges.length === 0) {
    return {
      changedFileCount: 0,
      generatedCodeLines: 0,
    };
  }

  const changedFileMap = new Map<string, { beforeContent: string | null; afterContent: string }>();

  for (const turn of fileChanges) {
    for (const snapshot of turn.snapshots) {
      const existing = changedFileMap.get(snapshot.path);
      if (existing) {
        existing.afterContent = snapshot.afterContent;
      } else {
        changedFileMap.set(snapshot.path, {
          beforeContent: snapshot.beforeContent,
          afterContent: snapshot.afterContent,
        });
      }
    }
  }

  let generatedCodeLines = 0;
  for (const file of changedFileMap.values()) {
    generatedCodeLines += computeLineChangeStat(file.beforeContent, file.afterContent).added;
  }

  return {
    changedFileCount: changedFileMap.size,
    generatedCodeLines,
  };
}

export function recordComposerFocus(workspacePath: string, now = Date.now()): void {
  const inputTiming = ensureComposerInputTiming(workspacePath);
  inputTiming.inputStartTime = now;
  inputTiming.inputFirstCharTime = 0;
}

export function recordComposerTextChange(
  workspacePath: string,
  nextText: string,
  now = Date.now(),
): void {
  if (nextText.length === 0) {
    return;
  }

  const inputTiming = ensureComposerInputTiming(workspacePath);
  if (inputTiming.inputFirstCharTime !== 0) {
    return;
  }

  inputTiming.inputFirstCharTime = now;
  if (inputTiming.inputStartTime === 0) {
    inputTiming.inputStartTime = now;
  }
}

function createPromptTelemetryState(input: {
  taskId: string;
  messageId: string;
  inputId?: InputId;
  sendTime: number;
  inputStartTime: number;
  inputFirstCharTime: number;
  extraDetail?: Record<string, string>;
}): PromptTelemetryState {
  return {
    taskId: input.taskId,
    messageId: input.messageId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    baseEventExtraDetail: input.extraDetail ? { ...input.extraDetail } : {},
    sendTime: input.sendTime,
    inputStartTime: input.inputStartTime,
    inputFirstCharTime: input.inputFirstCharTime,
    waitingMs: 0,
    permissionWaitsByRequestId: new Map(),
    firstTokenAt: null,
    usage: null,
    usageEventKeys: new Set(),
    finalizedAgentStepCount: 0,
    toolCallTotal: 0,
    toolCallFailed: 0,
    firstToolCallError: "",
  };
}

export function queuePromptTelemetry(input: {
  workspacePath: string;
  taskId: string;
  messageId: string;
  inputId?: InputId;
  sendTime: number;
  extraDetail?: Record<string, string>;
}) {
  const { inputStartTime, inputFirstCharTime } = consumeComposerInputTiming(
    input.workspacePath,
    input.sendTime,
  );
  const promptTelemetry = createPromptTelemetryState({
    taskId: input.taskId,
    messageId: input.messageId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    sendTime: input.sendTime,
    inputStartTime,
    inputFirstCharTime,
    ...(input.extraDetail ? { extraDetail: input.extraDetail } : {}),
  });

  const existingQueue = queuedPromptTelemetryByTask.get(input.taskId) ?? [];
  queuedPromptTelemetryByTask.set(input.taskId, [...existingQueue, promptTelemetry]);

  return {
    ...promptTelemetry.baseEventExtraDetail,
    input_start_time: String(inputStartTime),
    input_first_char_time: String(inputFirstCharTime),
    input_send_time: String(input.sendTime),
  };
}

export function activatePromptTelemetry(taskId: string, messageId: string): void {
  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue || queue.length === 0) {
    return;
  }

  const targetIndex = queue.findIndex((item) => item.messageId === messageId);
  if (targetIndex === -1) {
    return;
  }

  const [target] = queue.splice(targetIndex, 1);
  if (!target) {
    return;
  }

  if (queue.length === 0) {
    queuedPromptTelemetryByTask.delete(taskId);
  } else {
    queuedPromptTelemetryByTask.set(taskId, queue);
  }

  activePromptTelemetryByTask.set(taskId, target);
  agentStepTelemetryByTask.set(taskId, createAgentStepTelemetryState());
}

/** Background children reuse agent_step state only; they never create or report a separate message lifecycle. */
export function activateDetachedAgentStepTelemetry(input: {
  taskId: string;
  messageId: string;
  sendTime: number;
  extraDetail?: Record<string, string>;
}): void {
  activePromptTelemetryByTask.set(
    input.taskId,
    createPromptTelemetryState({
      taskId: input.taskId,
      messageId: input.messageId,
      sendTime: input.sendTime,
      inputStartTime: input.sendTime,
      inputFirstCharTime: input.sendTime,
      ...(input.extraDetail ? { extraDetail: input.extraDetail } : {}),
    }),
  );
  agentStepTelemetryByTask.set(input.taskId, createAgentStepTelemetryState());
}

export function recordPromptModelRequestStarted(
  taskId: string,
  event: Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>,
  activeInputId?: string,
): void {
  if (event.statusType !== "model_request_started") {
    return;
  }

  const active = activePromptTelemetryByTask.get(taskId);
  if (!active) {
    return;
  }

  const expectedInputId = activeInputId ?? active.inputId;
  if (expectedInputId && event.inputId && expectedInputId !== event.inputId) {
    return;
  }

  const modelProvider = event.providerId?.trim();
  const rawModelName = event.modelId?.trim();
  const providerHostname = resolveProviderHostname(event.baseURL);
  const modelName =
    rawModelName && modelProvider && !readProviderIdFromModelValue(rawModelName)
      ? `${modelProvider}/${rawModelName}`
      : rawModelName;
  if (!modelProvider && !modelName) {
    return;
  }

  const state = getAgentStepTelemetryState(taskId);
  state.currentModelRequest = {
    ...(event.requestId?.trim() ? { requestId: event.requestId.trim() } : {}),
    modelName: modelName ?? active.baseEventExtraDetail.model_name ?? "",
    modelProvider: modelProvider ?? active.baseEventExtraDetail.model_provider ?? "",
    providerName: providerHostname || active.baseEventExtraDetail.provider_name || "",
  };
  active.baseEventExtraDetail = {
    ...active.baseEventExtraDetail,
    // Fix: send_btn is a UI selection snapshot, but message_completion/agent_step should
    // reflect the real model request. When a custom provider is selected the workspace
    // configOptions may still name a builtin model; override the terminal-state model
    // dimensions with the runtime request_started payload.
    ...(modelName ? { model_name: modelName } : {}),
    ...(modelProvider ? { model_provider: modelProvider } : {}),
    ...(providerHostname ? { provider_name: providerHostname } : {}),
  };
}

function findModelOutputStepForRequest(
  state: AgentStepTelemetryState,
  requestId: string,
): ActiveAgentStep | undefined {
  const candidates = [state.generationStep, state.reasoningStep];
  return candidates.find((step) => step?.model?.requestId === requestId) ?? undefined;
}

function assignUsageToStep(step: ActiveAgentStep, attribution: AgentStepUsageAttribution): void {
  step.usage = step.usage
    ? {
        requestIds: [...new Set([...step.usage.requestIds, ...attribution.requestIds])],
        requestCount: step.usage.requestCount + attribution.requestCount,
        scope:
          step.usage.scope === "subagent_requests" || attribution.scope === "subagent_requests"
            ? "subagent_requests"
            : "model_request",
        usage: mergePromptUsage(step.usage.usage, attribution.usage),
      }
    : attribution;
}

/**
 * Write the Subagent's real model and cumulative usage onto its Agent step.
 * Foreground uses the parent task state; background uses the detached child state.
 */
export function recordSubagentToolAttribution(input: {
  taskId: string;
  toolCallId: string;
  requestIds: string[];
  requestCount: number;
  modelName: string;
  modelProvider: string;
  providerName: string;
  agentId: string;
  agentRole?: AgentStepRole;
  usage?: ZCodeUsage;
}): void {
  const state = agentStepTelemetryByTask.get(input.taskId);
  const step = state?.toolStepsById.get(input.toolCallId);
  if (!step) return;

  step.agentId = input.agentId;
  step.agentRole = input.agentRole ?? "foreground subagent";
  if (input.modelName || input.modelProvider || input.providerName) {
    step.model = {
      modelName: input.modelName,
      modelProvider: input.modelProvider,
      providerName: input.providerName,
    };
  }
  if (input.usage) {
    // Root cause: on cancel/failure the parent Agent tool's terminal state can precede
    // SubagentStopped. Attributing only at stopped would find the tool step already removed
    // from the active index and wrongly fall back to the main model with 0 tokens. The child
    // fact carries lifetime cumulative values, so overwrite rather than add to keep
    // incremental sync from double-counting.
    step.usage = {
      requestIds: [...input.requestIds],
      requestCount: input.requestCount,
      scope: "subagent_requests",
      usage: { ...input.usage },
    };
  }
}

function applyAgentStepToolAttribution(
  step: ActiveAgentStep,
  attribution: AgentStepToolAttribution | undefined,
): void {
  if (!attribution) return;
  if (attribution.agentId) {
    step.agentId = attribution.agentId;
    step.agentRole = attribution.agentRole ?? "foreground subagent";
  }
  if (attribution.modelName || attribution.modelProvider || attribution.providerName) {
    step.model = {
      modelName: attribution.modelName ?? "",
      modelProvider: attribution.modelProvider ?? "",
      providerName: attribution.providerName ?? "",
    };
  }
}

function applyAgentStepSkillMetadata(
  step: ActiveAgentStep,
  metadata: AgentStepSkillMetadata | undefined,
): void {
  // Fix: metadata may only be written to Skill steps, keeping dirty fields from non-Skill
  // tool_calls out of telemetry.
  if (!metadata || step.toolName !== "Skill") return;
  step.skillMetadata = {
    ...step.skillMetadata,
    ...(metadata.qualifiedName ? { qualifiedName: metadata.qualifiedName } : {}),
    ...(metadata.pluginId ? { pluginId: metadata.pluginId } : {}),
    ...(metadata.source ? { source: metadata.source } : {}),
  };
}

function materializePendingModelUsageBeforeTool(input: {
  prompt: PromptTelemetryState;
  state: AgentStepTelemetryState;
  now: number;
  finalized: FinalizedAgentStepTelemetry[];
  clientMode?: AgentStepTelemetryClientMode;
}): void {
  const requestId = input.state.currentModelRequest?.requestId;
  if (
    !requestId ||
    input.state.reasoningStep ||
    input.state.generationStep ||
    !input.state.pendingUsageByRequestId.has(requestId)
  ) {
    return;
  }

  // Root cause: when the model returns tool_use directly there is no content step, and the
  // old logic let pending usage be consumed by the tool step created afterwards. Once the
  // Agent tool adds child usage on top, main-model-A and child-model-B tokens blend into one
  // model dimension. Emit a zero-duration generation that carries only this real model
  // request; the tool step stays separate, awaiting the tool's or foreground child's facts.
  input.state.generationStep = createAgentStep(input.state, "generation", input.now);
  closeGenerationStep(
    input.prompt,
    input.state,
    input.now,
    "success",
    input.finalized,
    undefined,
    "tool_call",
    input.clientMode,
  );
}

export function recordAgentStepTelemetryEvent(input: {
  taskId: string;
  event: ZCodeStreamEvent;
  activeInputId?: string;
  clientMode?: AgentStepTelemetryClientMode;
  toolAttribution?: AgentStepToolAttribution;
  skillMetadata?: AgentStepSkillMetadata;
  now?: number;
}): FinalizedAgentStepTelemetry[] {
  const prompt = activePromptTelemetryByTask.get(input.taskId);
  if (!prompt) {
    return [];
  }
  const eventInputId =
    "inputId" in input.event && typeof input.event.inputId === "string"
      ? input.event.inputId
      : undefined;
  if (input.activeInputId && eventInputId && input.activeInputId !== eventInputId) {
    // Bugfix: once completion moved to per-step aggregation, late chunks/tools from a stale
    // input would pollute the current message. Ownership follows the runtime activeInputId,
    // tolerating inputId rebinding when a queued prompt is actually sent.
    return [];
  }

  const now = input.now ?? Date.now();
  const state = getAgentStepTelemetryState(input.taskId);
  const finalized: FinalizedAgentStepTelemetry[] = [];

  switch (input.event.type) {
    case "agent_thought_chunk":
      markPromptFirstToken(prompt, now);
      if (!state.reasoningStep) {
        closeGenerationStep(
          prompt,
          state,
          now,
          "success",
          finalized,
          undefined,
          "reasoning",
          input.clientMode,
        );
        state.reasoningStep = createAgentStep(state, "reasoning", now);
      }
      return finalized;

    case "agent_message_chunk":
      if (input.event.zcodeTimeline) {
        return finalized;
      }
      if (input.event.parentToolUseId) {
        // Fix: chunks carrying parentToolUseId are tool/subagent output shown on the tool
        // card; they must not open a generation step as main assistant content nor refresh
        // the content-tail timestamp.
        return finalized;
      }
      markPromptFirstToken(prompt, now);
      closeReasoningStep(prompt, state, now, finalized);
      if (!state.generationStep) {
        state.generationStep = createAgentStep(state, "generation", now);
      }
      state.generationStep.lastMessageChunkAt = now;
      return finalized;

    case "tool_call": {
      markPromptFirstToken(prompt, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "success",
        finalized,
        undefined,
        "tool_call",
        input.clientMode,
      );
      materializePendingModelUsageBeforeTool({
        prompt,
        state,
        now,
        finalized,
        clientMode: input.clientMode,
      });
      const toolStep = createAgentStep(state, "tool_call", now, {
        toolId: input.event.toolId,
        toolName: input.event.toolName ?? input.event.kind,
      });
      applyAgentStepToolAttribution(toolStep, input.toolAttribution);
      applyAgentStepSkillMetadata(toolStep, input.skillMetadata ?? input.event.skillMetadata);
      applySettledPermissionWaitAttribution(state, toolStep);
      state.toolStepsById.set(input.event.toolId, toolStep);
      return finalized;
    }

    case "tool_call_update": {
      markPromptFirstToken(prompt, now);
      if (input.event.status === "pending" || input.event.status === "in_progress") {
        if (!state.toolStepsById.has(input.event.toolId)) {
          closeReasoningStep(prompt, state, now, finalized);
          closeGenerationStep(
            prompt,
            state,
            now,
            "success",
            finalized,
            undefined,
            "tool_call",
            input.clientMode,
          );
          materializePendingModelUsageBeforeTool({
            prompt,
            state,
            now,
            finalized,
            clientMode: input.clientMode,
          });
          const toolStep = createAgentStep(state, "tool_call", now, {
            toolId: input.event.toolId,
            toolName: input.event.toolName ?? input.event.kind,
          });
          applyAgentStepToolAttribution(toolStep, input.toolAttribution);
          applyAgentStepSkillMetadata(toolStep, input.skillMetadata ?? input.event.skillMetadata);
          applySettledPermissionWaitAttribution(state, toolStep);
          state.toolStepsById.set(input.event.toolId, toolStep);
        }
        return finalized;
      }

      let existing = state.toolStepsById.get(input.event.toolId);
      if (!existing) {
        materializePendingModelUsageBeforeTool({
          prompt,
          state,
          now,
          finalized,
          clientMode: input.clientMode,
        });
        existing = createAgentStep(
          state,
          "tool_call",
          findEarliestPermissionRequestedAt(prompt, state, input.event.toolId) ?? now,
          {
            toolId: input.event.toolId,
            toolName: input.event.toolName ?? input.event.kind,
          },
        );
      }
      applyAgentStepSkillMetadata(existing, input.skillMetadata ?? input.event.skillMetadata);
      applyAgentStepToolAttribution(existing, input.toolAttribution);
      // Fix: recovery/out-of-order paths can observe permission_request followed directly by
      // the tool terminal state with no preceding tool_call. Backfill settled waits first,
      // then return the fallback step to the index to consume still-open waits, and finally
      // correct startedAt so tool wall-clock time always covers waiting_ms.
      applySettledPermissionWaitAttribution(state, existing);
      state.toolStepsById.set(input.event.toolId, existing);
      settlePermissionWaitsForTool(prompt, state, input.event.toolId, now);
      existing.startedAt = Math.min(existing.startedAt, now - existing.waitingMs);
      state.toolStepsById.delete(input.event.toolId);
      finalized.push(
        finalizeAgentStep({
          prompt,
          step: {
            ...existing,
            toolName: input.event.toolName ?? input.event.kind ?? existing.toolName,
          },
          finishedAt: now,
          status: input.event.status,
          errorType: input.event.status === "failed" ? "TOOL_EXEC_ERROR" : undefined,
          errorMsg: input.event.error,
          // Root cause: the compatibility stream only gave agent_step the tool name and
          // status; the new task ID returned by CronCreate stayed in content, so ops could
          // not correlate the creation step with the task.
          automationId:
            input.event.status === "completed" &&
            (input.event.toolName ?? input.event.kind ?? existing.toolName) === "CronCreate"
              ? cronCreateAutomationId(input.event.content)
              : undefined,
        }),
      );
      return finalized;
    }

    case "task_complete":
      settleAllPermissionWaits(prompt, state, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "success",
        finalized,
        undefined,
        "task_complete",
        input.clientMode,
      );
      closeToolSteps(prompt, state, now, "success", finalized);
      agentStepTelemetryByTask.delete(input.taskId);
      return finalized;

    case "task_error":
      settleAllPermissionWaits(prompt, state, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "fail",
        finalized,
        {
          type: input.event.code ?? "UNKNOWN",
          msg: input.event.error,
        },
        "task_error",
        input.clientMode,
      );
      closeToolSteps(prompt, state, now, "fail", finalized, {
        type: input.event.code ?? "UNKNOWN",
        msg: input.event.error,
      });
      agentStepTelemetryByTask.delete(input.taskId);
      return finalized;

    default:
      return finalized;
  }
}

// Model name of the currently active prompt, letting ARMS mirror events (stream_stall etc.)
// fill the model dimension; undefined when no prompt is active or it has no model_name, and
// callers leave the field empty.
export function getActivePromptModelName(taskId: string): string | undefined {
  const active = activePromptTelemetryByTask.get(taskId);
  return active?.baseEventExtraDetail.model_name || undefined;
}

export function getActivePromptMessageId(taskId: string): string | undefined {
  return activePromptTelemetryByTask.get(taskId)?.messageId;
}

export function recordPromptTokenUsageDelta(input: {
  taskId: string;
  eventKey: string;
  usage: ZCodeUsage;
  requestId?: string;
  modelName?: string;
  modelProvider?: string;
  providerName?: string;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  const eventKey = input.eventKey.trim();
  if (!active || eventKey.length === 0 || active.usageEventKeys.has(eventKey)) {
    return;
  }

  active.usageEventKeys.add(eventKey);
  active.usage = mergePromptUsage(active.usage, input.usage);

  const requestId = input.requestId?.trim();
  if (!requestId) return;
  const state = getAgentStepTelemetryState(input.taskId);
  const modelName = input.modelName?.trim();
  const modelProvider = input.modelProvider?.trim();
  const providerName = input.providerName?.trim();
  const step = findModelOutputStepForRequest(state, requestId);
  if (step) {
    step.model = {
      requestId,
      modelName: modelName ?? step.model?.modelName ?? "",
      modelProvider: modelProvider ?? step.model?.modelProvider ?? "",
      providerName: providerName ?? step.model?.providerName ?? "",
    };
    assignUsageToStep(step, {
      requestIds: [requestId],
      requestCount: 1,
      scope: "model_request",
      usage: input.usage,
    });
    return;
  }

  state.pendingUsageByRequestId.set(requestId, {
    requestIds: [requestId],
    requestCount: 1,
    scope: "model_request",
    usage: input.usage,
  });
}

export function recordPromptPermissionRequest(input: {
  taskId: string;
  requestId: string;
  toolCallId?: string;
  raw?: unknown;
  now?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  const requestId = input.requestId.trim();
  if (!active || requestId.length === 0 || active.permissionWaitsByRequestId.has(requestId)) {
    return;
  }

  const raw =
    input.raw !== null && typeof input.raw === "object"
      ? (input.raw as Record<string, unknown>)
      : {};
  const rawToolCallId =
    typeof raw.toolCallId === "string" && raw.toolCallId.trim().length > 0
      ? raw.toolCallId.trim()
      : undefined;
  const toolCallId = input.toolCallId?.trim() || rawToolCallId || requestId;
  active.permissionWaitsByRequestId.set(requestId, {
    requestedAt: input.now ?? Date.now(),
    ...(toolCallId ? { toolCallId } : {}),
  });
}

export function recordPromptPermissionResponse(input: {
  taskId: string;
  requestId: string;
  now?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) {
    return;
  }

  settlePermissionWait(
    active,
    agentStepTelemetryByTask.get(input.taskId),
    input.requestId,
    input.now ?? Date.now(),
  );
}

export function finalizePromptTelemetry(
  input: FinalizePromptTelemetryInput,
): FinalizedPromptTelemetry | null {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) {
    return null;
  }

  settleAllPermissionWaits(active, agentStepTelemetryByTask.get(input.taskId), input.finishedAt);
  activePromptTelemetryByTask.delete(input.taskId);
  agentStepTelemetryByTask.delete(input.taskId);

  const { changedFileCount, generatedCodeLines } = collectFileChangeMetrics(input.fileChanges);
  const isSuccess = input.status === "success";
  // V4 live-fact usage arrives as low-frequency deltas; terminal does not re-carry the full
  // aggregate. The legacy path may still pass usage at terminal. Prefer explicit terminal
  // usage on success, falling back to the aggregated deltas.
  const usageForTelemetry = isSuccess
    ? (input.usage ?? active.usage ?? undefined)
    : (active.usage ?? undefined);
  const tokenSource = !isSuccess && active.usage ? "usage_delta" : undefined;
  const errorType = isSuccess
    ? ""
    : input.errorType?.trim() || (active.toolCallFailed > 0 ? "TOOL_CALL_FAILED" : "UNKNOWN");
  const errorMsg = isSuccess ? "" : input.errorMsg?.trim() || active.firstToolCallError;

  return {
    taskId: input.taskId,
    messageId: active.messageId,
    eventExtraDetail: {
      ...legacyTelemetryModelFields(active.baseEventExtraDetail),
      ...(usageForTelemetry
        ? buildPromptUsageTelemetryExtraDetail(usageForTelemetry, tokenSource)
        : {}),
      duration_ms: String(Math.max(input.finishedAt - active.sendTime, 0)),
      waiting_ms: String(active.waitingMs),
      generated_code_lines: String(generatedCodeLines),
      file_change_cnt: String(changedFileCount),
      time_to_first_token:
        active.firstTokenAt === null
          ? "-1"
          : String(Math.max(active.firstTokenAt - active.sendTime, 0)),
      request_time: String(active.sendTime),
      status: input.status,
      ...(input.messageSource ? { message_source: input.messageSource } : {}),
      agent_composition: input.agentComposition ?? "main_only",
      agent_step_cnt: String(active.finalizedAgentStepCount),
      retry_cnt: "0",
      tool_call_total: String(active.toolCallTotal),
      tool_call_failed: String(active.toolCallFailed),
      error_type: errorType,
      error_msg: errorMsg,
    },
  };
}

/** Releasing a workspace telemetry attachment clears only its own task keys, never other workspaces'. */
export function discardPromptTelemetry(taskId: string): void {
  queuedPromptTelemetryByTask.delete(taskId);
  activePromptTelemetryByTask.delete(taskId);
  agentStepTelemetryByTask.delete(taskId);
}

/** Discard only the not-yet-activated prompt so other queued messages in the session survive. */
export function discardQueuedPromptTelemetry(taskId: string, messageId: string): void {
  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue) return;
  const next = queue.filter((item) => item.messageId !== messageId);
  if (next.length === 0) {
    queuedPromptTelemetryByTask.delete(taskId);
    return;
  }
  queuedPromptTelemetryByTask.set(taskId, next);
}
