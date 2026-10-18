import {
  type AgentTelemetryErrorCategory,
  CoreErrorType,
  createChildTraceContext,
  createCoreError,
  createRootTraceContext,
  getCurrentTraceContext,
  traceContextToLogContext,
  type ToolExecutionSpanWriter,
  type SessionEvent,
} from "@zcode/contracts";
import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  attestOfficialCuaFrameContent,
} from "@zcode/zcode-cua/frame-contract";
import {
  normalizeToolExecutionInput,
  prepareInitialToolExecutionInput,
} from "../input-normalization.js";
import { hasOfficialCuaFrameAuthority } from "../../mcp/image-normalization.js";
import type { SkillTelemetryMetadata } from "@zcode/contracts";
import type { ToolExecutionContext, ToolExecutionResult } from "../types.js";
import type { ToolEntry } from "../types.js";
import type { BackgroundTaskTracker } from "./background-tasks.js";
import {
  createErrorResult,
  createPermissionErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
  isToolHandlerFailureError,
} from "./errors.js";
import { emitToolCallError, emitToolCallResult, emitToolCallStarted } from "./events.js";
import {
  formatHookAdditionalContexts,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from "./hook-flow.js";
import { resolveToolCallCapabilityFlags } from "./permission-capability.js";
import { resolveToolPermission } from "./permission-flow.js";
import { snapshotPermissionInput } from "./permission-input.js";
import { buildToolInputResolutionContext } from "./permission-input-adjustments.js";
import { createMcpToolDisplay, createToolResultDisplay } from "./result-display.js";
import { appendHookAdditionalContexts, serializeOutput } from "./result-serialization.js";
import {
  ToolDeadline,
  executeWithTimeout,
  linkAbortSignal,
  observeToolAdmissionClock,
  resolveTimeoutMs,
} from "./timeout.js";
import { createToolModelStatusSink, withDefaultToolModelStatusSink } from "./model-status-sink.js";
import { runToolCallWithTelemetry } from "./telemetry.js";
import {
  withAutomationCreateLimitTurnStop,
  withPlanExitDeniedTurnStop,
  withTerminalToolTurnStop,
  withWorkflowRefineDeniedFollowUp,
} from "./turn-control.js";
import { mergeToolExecutionTelemetry, readToolExecutionTelemetry } from "../handlers/tool-perf.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";
import { validateInitialModelToolInput, validateInput, validateOutput } from "./validation.js";
import type { ExecutableToolCall } from "../types.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { resolveToolEntryModelContract } from "../model-contract.js";

export async function executeToolCall(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  options?: ToolExecuteOptions,
): Promise<ToolExecutionResult> {
  const totalStartedAt = Date.now();
  const entry = isEmptyToolName(toolCall.name) ? undefined : deps.registry.get(toolCall.name);
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  // Privacy and cardinality: unregistered tool names come from model output; never assume a controlled enum.
  // Business errors keep the real name for model self-repair; remote traces fall into a fixed unknown bucket.
  const telemetryToolCall = entry ? canonicalToolCall : { ...toolCall, name: "unknown" };
  return runToolCallWithTelemetry(deps, telemetryToolCall, options, (telemetry) =>
    executeToolCallImpl(deps, backgroundTasks, toolCall, totalStartedAt, options, telemetry),
  );
}

async function executeToolCallImpl(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  totalStartedAt: number,
  options?: ToolExecuteOptions,
  telemetry?: ToolExecutionSpanWriter,
): Promise<ToolExecutionResult> {
  const parentTraceContext =
    options?.traceContext ??
    getCurrentTraceContext() ??
    deps.traceContext ??
    createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId });
  const emptyToolName = isEmptyToolName(toolCall.name);
  const registeredEntry = emptyToolName ? undefined : deps.registry.get(toolCall.name);
  const model = options?.model ?? deps.model;
  const entry = registeredEntry
    ? resolveToolEntryModelContract(registeredEntry, {
        model,
      })
    : undefined;
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  const traceContext = createChildTraceContext(parentTraceContext, {
    sessionId: deps.sessionId,
    turnId: deps.turnId,
    attributes: {
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    },
  });
  const traceId = traceContext.traceId;
  const turnId = traceContext.turnId ?? deps.turnId;

  if (!entry) {
    const result = createErrorResult(
      toolCall,
      createCoreError(
        CoreErrorType.ToolNotFound,
        emptyToolName
          ? "Model returned an invalid tool call: tool name is empty."
          : `Tool not found: ${toolCall.name}`,
        {
          context: { toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: false,
        },
      ),
    );
    if (emptyToolName) {
      // Stopping an empty name at admission would leave the model without its paired result forever. Reuse the
      // registry-miss lifecycle, but the provider payload keeps the model's original whitespace name verbatim.
      result.modelContent = `<tool_use_error>Error: No such tool available: ${toolCall.name}</tool_use_error>`;
    }
    // A registry miss happens before handler/ToolCallStarted; the old code only returned the failure to the
    // provider with no ToolCallError, leaving the V4 tool row stuck in inputStreaming forever.
    await emitToolCallError(deps, toolCall.id, traceContext, turnId, result.error);
    deps.logger?.warn("Tool call rejected because the tool is not registered", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.not_found",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    telemetry?.finishFailed("lookup", "configuration", result.error);
    return result;
  }

  let lifetime: ReturnType<NonNullable<ToolEntry["retainExecution"]>> | undefined;
  try {
    lifetime = entry.retainExecution?.(canonicalToolCall.id);
  } catch (error) {
    const result = createErrorResult(
      canonicalToolCall,
      createCoreError(
        CoreErrorType.ToolCancelled,
        error instanceof Error ? error.message : "Tool instance is unavailable",
      ),
    );
    await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
    return result;
  }
  if (lifetime)
    options = {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([options.signal, lifetime.signal])
        : lifetime.signal,
    };
  try {
    const mode = deps.getMode();

    if (options?.signal?.aborted) {
      const result = createErrorResult(
        canonicalToolCall,
        createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled"),
      );
      telemetry?.finishCancelled("abort_signal");
      return result;
    }

    const preparedInitialInput = prepareInitialToolExecutionInput({
      entry,
      input: canonicalToolCall.input,
      logger: deps.logger,
    });
    let executionInput = preparedInitialInput.input;
    const initialInputValidation = validateInitialModelToolInput(
      executionInput,
      entry,
      preparedInitialInput.runtimeValidationIssues,
    );
    if (initialInputValidation) {
      const result = createErrorResult(canonicalToolCall, initialInputValidation);
      // Schema failure exits early like a registry miss, before handler/ToolCallStarted; the old code fed
      // the failure back to the model with no ToolCallError, so the V4 row stayed in
      // inputStreaming all turn (CreateWorkflow card stuck at "writing workflow"), stacking a second after retry.
      await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
      telemetry?.finishFailed("validation", "parse", result.error);
      return result;
    }

    const toolInputValidation = entry.validateInput?.(executionInput, {
      runtimeTaskRegistry: deps.runtimeTaskRegistry,
    });
    if (toolInputValidation && isToolHandlerFailure(toolInputValidation)) {
      // Tool-specific semantic validation used to live in handlers, so invalid calls still ran
      // PreToolUse, permission, and failure hooks first; semantic validation must finish before hooks.
      const result = createErrorResult(
        canonicalToolCall,
        createToolHandlerFailureError(canonicalToolCall, toolInputValidation),
      );
      await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
      // Tool-specific validation returns as a plain failure result, not the handler try/catch failure path.
      // Emit ToolCallError to update the row, then mark telemetry failed explicitly; avoids an abandoned record.
      telemetry?.finishFailed("validation", "parse", result.error);
      return result;
    }

    // Normalization: swap the model's args for the execution facts that will happen. Deliberately before hooks -- from
    // here on hooks, permission rules, confirm payloads, prepareApproval, and the handler read one input, so
    // "policy sees the real script", "cross-version visible", and "approval==execution bytes" all hold at once.
    if (entry.resolveInput) {
      const resolution = await entry.resolveInput(
        executionInput,
        buildToolInputResolutionContext(deps),
      );
      if (isToolHandlerFailure(resolution)) {
        // Same lifecycle exit as validateInput: an unparseable input is for the model to fix at once,
        // not worth a confirmation window destined to fail.
        const result = createErrorResult(
          canonicalToolCall,
          createToolHandlerFailureError(canonicalToolCall, resolution),
        );
        await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
        telemetry?.finishFailed("validation", "parse", result.error);
        return result;
      }
      executionInput = resolution.input;
    }

    const preToolHookResult = await runPreToolUseHooks(
      deps,
      canonicalToolCall,
      executionInput,
      entry,
      mode,
      traceContext,
      options?.signal,
    );
    if (preToolHookResult.permissionBehavior === "deny" || preToolHookResult.preventContinuation) {
      const result = appendPreToolAdditionalContextsToErrorResult(
        withPlanExitDeniedTurnStop(
          createPermissionErrorResult(
            canonicalToolCall,
            preToolHookResult.hookPermissionDecisionReason ??
              preToolHookResult.stopReason ??
              "Blocked by PreToolUse hook",
            {
              decision: "deny",
              mode,
              reason:
                preToolHookResult.hookPermissionDecisionReason ?? preToolHookResult.stopReason,
              source: "hook.PreToolUse",
            },
          ),
          {
            mode,
            planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
            toolName: canonicalToolCall.name,
          },
        ),
        preToolHookResult.additionalContexts,
      );
      telemetry?.setPermissionDecision("denied");
      telemetry?.finishDenied("policy_denied");
      return result;
    }
    if (preToolHookResult.updatedInput !== undefined) {
      executionInput = normalizeToolExecutionInput({
        entry,
        input: preToolHookResult.updatedInput,
        logger: deps.logger,
        source: "hook",
      });
      const hookInputValidation = validateInput(executionInput, entry);
      if (hookInputValidation) {
        // Input-validation failure after hook edits returns before the handler; the old branch skipped the
        // unified PreToolUse-context append, so the model saw only the schema error and none of the diagnostics
        // the hook had produced -- inconsistent with the deny/permission-deny early-failure contract.
        const result = appendPreToolAdditionalContextsToErrorResult(
          createErrorResult(canonicalToolCall, hookInputValidation),
          preToolHookResult.additionalContexts,
        );
        telemetry?.finishFailed("validation", "parse", result.error);
        return result;
      }
    }

    // The shell was pinned by the session owner; matching and execution reuse that one choice — no snapshot for a hot-switch that cannot happen.
    const bashShellSelection = deps.getBashShellSelection?.() ?? deps.bashShellSelection;
    const guardedWorkingDirectory = mode === "guarded" ? deps.getWorkingDirectory() : undefined;
    if (mode === "guarded") executionInput = snapshotPermissionInput(executionInput);
    const permissionResult = await resolveToolPermission(
      deps,
      canonicalToolCall,
      entry,
      executionInput,
      preToolHookResult,
      mode,
      traceContext,
      options?.signal,
      telemetry,
      {
        mode,
        bashShellSelection,
        ...(guardedWorkingDirectory === undefined
          ? {}
          : { workingDirectory: guardedWorkingDirectory }),
      },
    );
    if (!permissionResult.allowed) {
      const result = appendPreToolAdditionalContextsToErrorResult(
        withWorkflowRefineDeniedFollowUp(
          withPlanExitDeniedTurnStop(permissionResult.result, {
            mode,
            planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
            toolName: canonicalToolCall.name,
          }),
          { toolName: canonicalToolCall.name },
        ),
        preToolHookResult.additionalContexts,
      );
      if (result.error?.type === CoreErrorType.PermissionDenied) {
        telemetry?.finishDenied("user_denied");
      } else {
        telemetry?.finishFailed(
          "permission",
          errorCategoryForToolError(result.error?.type),
          result.error,
        );
      }
      return result;
    }
    executionInput = permissionResult.executionInput;
    const permissionWaitMs = permissionResult.permissionWaitMs;
    const inputAdjustments = permissionResult.inputAdjustments;

    const startTime = Date.now();
    // Resolve side-effect flags once from the **execution args** (Bash read-only determination lands here), sent with
    // ToolCallStarted: the event precedes the handler, so subscribers (dwf driver import-cache close) know pre-first-byte.
    await emitToolCallStarted(
      deps,
      canonicalToolCall,
      traceContext,
      turnId,
      startTime,
      createMcpToolDisplay(entry.metadata.mcpPresentation),
      resolveToolCallCapabilityFlags(deps, entry, executionInput),
    );

    deps.logger?.info("Tool call started", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.started",
      module: "core.tool.executor",
      status: "started",
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    });

    const timeoutMs = resolveTimeoutMs(entry, executionInput, deps.defaultTimeoutMs, {
      model,
    });
    const executionAbortController = new AbortController();
    const unlinkParentAbort = linkAbortSignal(options?.signal, executionAbortController);
    // Pausable deadline: model requests inside this call pause timing while queued at the admission gate. Both edges
    // arrive as this toolCallId's ModelNetworkStatus session events, so an event-sink intercept suffices; handler unaware.
    const deadline = new ToolDeadline(timeoutMs);
    const emitEvent =
      deps.emitEvent === undefined
        ? undefined
        : async (event: SessionEvent): Promise<void> => {
            observeToolAdmissionClock(event, canonicalToolCall.id, deadline);
            await deps.emitEvent(event);
          };
    let readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
    let skillTelemetryMetadata: SkillTelemetryMetadata | undefined;
    let failureStage: "handler" | "serialize" | "post_hook" = "handler";

    try {
      const model = options?.model ?? deps.model;
      const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
        bashAvailable: deps.registry.has("Bash"),
      });
      const context: ToolExecutionContext = {
        toolCallId: canonicalToolCall.id,
        telemetry,
        automationTurn: options?.automationTurn,
        offPeakTurn: options?.offPeakTurn,
        traceContext,
        traceId,
        spanId: traceContext.spanId,
        parentSpanId: traceContext.parentSpanId,
        abortSignal: executionAbortController.signal,
        backgroundTaskControlPort: deps.backgroundTaskControlPort,
        emitEvent,
        executionPort: deps.executionPort,
        browserControlPort: deps.browserControlPort,
        browserDocumentationRoot: deps.browserDocumentationRoot,
        fileSystemPort: deps.fileSystemPort,
        httpClientPort: deps.httpClientPort,
        imageProcessorPort: deps.imageProcessorPort,
        pdfDocumentPort: deps.pdfDocumentPort,
        // Model requests inside tools emit status events into the session: deadline pauses and driver phases ride this stream.
        model: withDefaultToolModelStatusSink(
          model,
          createToolModelStatusSink({ emitEvent, sessionId: deps.sessionId, turnId, traceId }),
        ),
        subagentModelOverride: options?.subagentModelOverride,
        embeddedSearch: {
          ...(deps.embeddedSearchBackend ? { backend: deps.embeddedSearchBackend } : {}),
          enabled: embeddedSearchDecision?.useEmbeddedSearchBranch ?? false,
          ...(deps.nativeSearchEnhancementsEnabled === false ? { findAndGrepEnabled: false } : {}),
        },
        skillPort: deps.skillPort,
        subagentPort: deps.subagentPort,
        coordinatorResponsePort: deps.coordinatorResponsePort,
        workflowSubmitPort: deps.workflowSubmitPort,
        workflowEscalatePort: deps.workflowEscalatePort,
        artifactStore: deps.artifactStore,
        automationPort: deps.automationPort,
        offPeakPort: deps.offPeakPort,
        topicResourcePort: deps.topicResourcePort,
        sessionStore: deps.sessionStore,
        sessionModePort: deps.sessionModePort,
        workflowPort: deps.workflowPort,
        dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
        dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
        modelCatalogPort: deps.modelCatalogPort,
        runtimeTaskRegistry: deps.runtimeTaskRegistry,
        readFileState: deps.readFileState,
        recordReadFileStateMetadata: (metadata) => {
          readFileStateMetadata = metadata;
        },
        recordSkillTelemetryMetadata: (metadata) => {
          skillTelemetryMetadata = metadata;
        },
        bashShellSelection,
        setWorkingDirectory: deps.setWorkingDirectory,
        workingDirectory: guardedWorkingDirectory ?? deps.getWorkingDirectory(),
        workspaceRoot: deps.getWorkspaceRoot(),
        workspaceIdentity: deps.workspaceIdentity,
        remoteSessionId: deps.remoteSessionId,
        clientMode: deps.clientMode,
        deliveryKind: deps.deliveryKind,
        memoryRoot: deps.getMemoryRoot?.(),
        runtimeScope: deps.runtimeScope,
        providerVisibleToolNames: deps.registry
          .list()
          .filter((name) => deps.registry.getMetadata(name)?.providerVisible !== false),
        sessionId: deps.sessionId,
        turnId,
        ...(inputAdjustments === undefined ? {} : { inputAdjustments }),
      };

      const output = await executeWithTimeout(
        entry.handler,
        executionInput,
        context,
        deadline,
        executionAbortController,
        entry,
      );
      const durationMs = Date.now() - startTime;
      if (isToolHandlerFailure(output)) {
        // Handlers express expected business failure via return value; convert to the existing exception flow and
        // keep the original failure hook, events, and logs -- no second execution lifecycle.
        throw createToolHandlerFailureError(canonicalToolCall, output);
      }
      validateOutput(output, entry);
      // node_repl hosts both Browser Use and CUA; the whole server must not be flagged official at registration.
      // Only when a CUA SDK result carries producer integrity metadata, enable atomic-frame protection for that
      // serialization; else the generic resultBudget truncates/reorders image_ref or non-authority paths strip refs.
      const modelOutputEntry = resolveModelOutputEntry(entry, output);
      failureStage = "serialize";
      let serialization = await serializeOutput(
        deps,
        output,
        modelOutputEntry,
        traceContext,
        canonicalToolCall.id,
        executionAbortController.signal,
      );
      failureStage = "post_hook";
      const postToolHookResult = await runPostToolUseHooks(
        deps,
        canonicalToolCall,
        executionInput,
        output,
        serialization.artifactPath,
        traceContext,
        options?.signal,
      );
      serialization = appendHookAdditionalContexts(
        serialization,
        [...preToolHookResult.additionalContexts, ...postToolHookResult.additionalContexts],
        modelOutputEntry,
      );
      const display = createToolResultDisplay(canonicalToolCall.name, output, {
        mcp: entry.metadata.mcpPresentation,
        officialCua: entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
      });
      const perf = mergeToolExecutionTelemetry(readToolExecutionTelemetry(output), {
        permissionWaitMs,
        // totalMs is the user-visible tool lifetime: registry lookup, validation, hooks, permission wait,
        // handler, serialization, PostToolUse. durationMs keeps meaning only the handler's main execution.
        totalMs: Date.now() - totalStartedAt,
      });

      const finalModelContent = serialization.modelContent ?? serialization.content;
      const modelContentProtection = modelOutputEntry.modelContentProtection
        ? attestOfficialCuaFrameContent(finalModelContent, modelOutputEntry.modelContentProtection)
        : undefined;
      if (
        modelOutputEntry.modelContentProtection &&
        Array.isArray(finalModelContent) &&
        finalModelContent.some((block) => block.type === "image") &&
        !modelContentProtection
      ) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          "Official CUA frame failed final model-content attestation",
          { recoverable: true },
        );
      }

      const result: ToolExecutionResult = withTerminalToolTurnStop(
        {
          toolCallId: canonicalToolCall.id,
          toolName: canonicalToolCall.name,
          success: true,
          output,
          display,
          modelContent: finalModelContent,
          ...(readFileStateMetadata ? { readFileStateMetadata } : {}),
          performance: perf,
          serialization,
          durationMs,
          startedAt: new Date(startTime),
          completedAt: new Date(),
        },
        { entry },
      );

      await emitToolCallResult(
        deps,
        canonicalToolCall,
        traceContext,
        turnId,
        serialization,
        durationMs,
        display,
        perf,
        skillTelemetryMetadata,
      );

      await backgroundTasks.trackBackgroundTask(canonicalToolCall, output, traceContext, turnId);

      deps.logger?.info("Tool call completed", {
        ...traceContextToLogContext(traceContext),
        durationMs,
        event: "tool.call.completed",
        module: "core.tool.executor",
        status: "completed",
        toolCallId: canonicalToolCall.id,
        toolName: canonicalToolCall.name,
      });

      telemetry?.setOutputBytes(serialization.returnedBytes);
      telemetry?.setOutputTruncated(serialization.truncated);
      telemetry?.finishCompleted();
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const failureHookResult = await runPostToolUseFailureHooks(
        deps,
        canonicalToolCall,
        executionInput,
        error,
        traceContext,
        options?.signal,
      );
      let result = createErrorResult(
        canonicalToolCall,
        error instanceof Error ? error : new Error(String(error)),
        durationMs,
      );
      const baseModelContent = result.error
        ? isToolHandlerFailureError(error) && typeof result.modelContent === "string"
          ? result.modelContent
          : result.error.message
        : undefined;
      if (failureHookResult.additionalContexts.length > 0 && baseModelContent) {
        result.modelContent = [
          baseModelContent,
          formatHookAdditionalContexts([
            ...preToolHookResult.additionalContexts,
            ...failureHookResult.additionalContexts,
          ]),
        ].join("\n\n");
      } else if (preToolHookResult.additionalContexts.length > 0 && baseModelContent) {
        result.modelContent = [
          baseModelContent,
          formatHookAdditionalContexts(preToolHookResult.additionalContexts),
        ].join("\n\n");
      }
      result = withAutomationCreateLimitTurnStop(result, {
        error,
        toolName: canonicalToolCall.name,
      });

      // Even after Skill resolves, serialize/post_hook can still fail; error events must also carry
      // resolved metadata, or a failed Skill agent_step cannot be attributed to a skill.
      await emitToolCallError(
        deps,
        canonicalToolCall.id,
        traceContext,
        turnId,
        result.error,
        skillTelemetryMetadata,
      );

      deps.logger?.error(
        "Tool call failed",
        error instanceof Error ? error : new Error(String(error)),
        {
          ...traceContextToLogContext(traceContext),
          durationMs,
          event: "tool.call.failed",
          module: "core.tool.executor",
          status: "failed",
          toolCallId: canonicalToolCall.id,
          toolName: canonicalToolCall.name,
        },
      );

      if (options?.signal?.aborted || result.error?.type === CoreErrorType.ToolCancelled) {
        telemetry?.finishCancelled("abort_signal");
      } else {
        telemetry?.finishFailed(
          failureStage,
          errorCategoryForToolError(result.error?.type),
          // The raw exception goes to Telemetry for controlled redaction; result.error is the business-protocol
          // rewrap and must not overwrite the source message/type/code used for root-cause in traces.
          error,
        );
      }
      return result;
    } finally {
      unlinkParentAbort();
    }
  } finally {
    lifetime?.release();
  }
}

function resolveModelOutputEntry(entry: ToolEntry, output: unknown): ToolEntry {
  const isSharedNodeRepl =
    entry.metadata.name === "mcp__node_repl__js" ||
    entry.metadata.mcpPresentation?.serverName === "node_repl";
  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION ||
    !isSharedNodeRepl ||
    !hasOfficialCuaFrameAuthority(output)
  ) {
    return entry;
  }
  return {
    ...entry,
    modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    resultBudget: {
      ...entry.resultBudget,
      maxInlineBytes: Math.max(entry.resultBudget.maxInlineBytes, 256 * 1024),
      maxModelBytes: Math.max(entry.resultBudget.maxModelBytes, 256 * 1024),
      strategy: "truncate",
      preview: { direction: "head" },
    },
  };
}

function isEmptyToolName(toolName: string): boolean {
  return toolName.trim().length === 0;
}

function errorCategoryForToolError(type: string | undefined): AgentTelemetryErrorCategory {
  switch (type) {
    case CoreErrorType.ConfigurationError:
    case CoreErrorType.ToolNotFound:
      return "configuration";
    case CoreErrorType.PermissionDenied:
    case CoreErrorType.PermissionEscalation:
    case CoreErrorType.PermissionTimeout:
      return "permission";
    case CoreErrorType.InvalidInput:
      return "parse";
    case CoreErrorType.ToolCancelled:
      return "cancelled";
    case CoreErrorType.ToolTimeout:
      return "timeout";
    default:
      return "internal";
  }
}

function appendPreToolAdditionalContextsToErrorResult(
  result: ToolExecutionResult,
  additionalContexts: string[],
): ToolExecutionResult {
  if (result.success || !result.error || additionalContexts.length === 0) return result;

  // PreToolUse deny and permission denials return before the handler; the old code appended context only on the
  // handler success/exception paths, so a hook's additionalContext never reached the model.
  const baseModelContent =
    typeof result.modelContent === "string" ? result.modelContent : result.error.message;
  return {
    ...result,
    modelContent: [baseModelContent, formatHookAdditionalContexts(additionalContexts)].join("\n\n"),
  };
}
