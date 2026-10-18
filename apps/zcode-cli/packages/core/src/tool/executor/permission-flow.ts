import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  traceContextToLogContext,
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type PermissionRuleset,
  type TraceContext,
  type ToolExecutionSpanWriter,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type { PermissionContext } from "../../permission/service.js";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import { normalizeToolExecutionInput } from "../input-normalization.js";
import { resolveToolApproval } from "./approval-gate.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { emitPermissionDenied, emitPermissionRequested, emitPermissionResolved } from "./events.js";
import { applyPreToolPermissionDecision, runPermissionRequestHooks } from "./hook-flow.js";
import { racePermissionResponders } from "./permission-responder-race.js";
import {
  loadProjectPermissionRuleset,
  persistProjectPermissionUpdates,
} from "./permission-rules-persistence.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import { recheckPermissionHookModifiedInput } from "./permission-input-recheck.js";
import type { ToolExecutorDeps } from "./types.js";
import { summarizeInput } from "./utils.js";
import { validateInput } from "./validation.js";
import { applyMemoryFilePermission } from "./memory-file-permission.js";

type ToolPermissionFlowResult =
  | { allowed: true; executionInput: unknown; permissionWaitMs?: number }
  | { allowed: false; result: ToolExecutionResult };

export async function resolveToolPermission(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  preToolHookResult: HookRunResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
  telemetry?: ToolExecutionSpanWriter,
): Promise<ToolPermissionFlowResult> {
  const permissionContext: PermissionContext = {
    toolName: toolCall.name,
    input: executionInput,
    riskLevel: entry.metadata.riskLevel,
    mode,
    prePlanMode: deps.sessionModePort?.getPrePlanMode(),
    planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
    // Workflow-draft no-confirm resolves relative paths against the workdir; see PermissionService
    // isPreapprovedWorkflowDraftWrite.
    workingDirectory: deps.getWorkingDirectory(),
  };
  const runtimePermissionContext = resolveRuntimePermissionContext(deps);
  const rulePolicy = entry.resolvePermissionRulePolicy?.(executionInput, runtimePermissionContext);
  const suggestedPermissionUpdates =
    rulePolicy?.suggestedPermissionUpdates ??
    buildDefaultPermissionUpdates(toolCall.name, executionInput, entry.permissionCapabilityGroup);

  let projectRules: PermissionRuleset | null;
  try {
    projectRules = await loadProjectPermissionRuleset(deps);
  } catch (error) {
    return {
      allowed: false,
      result: createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to load project permission rules", {
          cause: error instanceof Error ? error : undefined,
          context: { sessionId: deps.sessionId, toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: true,
        }),
      ),
    };
  }

  let permissionDecision = deps.permissionService.checkPermission(
    permissionContext,
    resolveRuntimePermissionCapability(entry, executionInput, runtimePermissionContext),
    projectRules,
    rulePolicy,
  );
  permissionDecision = applyPreToolPermissionDecision(permissionDecision, preToolHookResult, mode);
  permissionDecision = applyMemoryFilePermission({
    decision: permissionDecision,
    executionInput,
    memoryRoot: deps.getMemoryRoot?.(),
    toolName: toolCall.name,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
  });

  deps.logger?.debug("Tool permission evaluated", {
    ...traceContextToLogContext(traceContext),
    decision: permissionDecision.decision,
    event: "tool.permission.evaluated",
    inputSummary: summarizeInput(toolCall.input),
    mode,
    module: "core.tool.executor",
    reason: permissionDecision.reason,
    riskLevel: permissionDecision.riskLevel,
    ruleId: permissionDecision.ruleId,
    sideEffectScope: permissionDecision.sideEffectScope,
    status:
      permissionDecision.decision === "allow"
        ? "completed"
        : permissionDecision.decision === "ask"
          ? "waiting"
          : "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });

  if (permissionDecision.allowed) {
    telemetry?.setPermissionDecision("not_required");
    return { allowed: true, executionInput };
  }

  if (permissionDecision.decision === "deny") {
    telemetry?.setPermissionDecision("denied");
    await emitPermissionDenied(deps, toolCall, permissionDecision.reason, traceContext);

    deps.logger?.warn("Tool permission denied", {
      ...traceContextToLogContext(traceContext),
      decision: permissionDecision.decision,
      event: "tool.permission.denied",
      mode,
      module: "core.tool.executor",
      reason: permissionDecision.reason,
      ruleId: permissionDecision.ruleId,
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    return {
      allowed: false,
      result: createPermissionErrorResult(toolCall, permissionDecision.reason, {
        decision: permissionDecision.decision,
        mode,
        ruleId: permissionDecision.ruleId,
      }),
    };
  }

  const approval = resolveToolApproval(deps, toolCall, entry, executionInput, traceContext);
  if (approval.gate === "proceed") {
    telemetry?.setPermissionDecision("not_required");
    return { allowed: true, executionInput };
  }

  const requestId = `perm_${crypto.randomUUID()}`;
  telemetry?.markPermissionRequested();
  await emitPermissionRequested(
    deps,
    toolCall,
    executionInput,
    requestId,
    permissionDecision.riskLevel,
    permissionDecision.reason,
    suggestedPermissionUpdates,
    traceContext,
    approval,
  );

  let brokerResult: PermissionBrokerResult;
  let normalizedHookModifiedInput: unknown;
  let useNormalizedHookModifiedInput = false;
  const permissionWaitStartedAt = Date.now();
  try {
    // This used to serially `await runPermissionRequestHooks(...)`, so the broker started only after
    // the hook chain returned. While a synchronous PermissionRequest hook (external approval bridge) blocked,
    // the dialog was already rendered (emitPermissionRequested above) but the answer deferred not yet
    // registered; every click was silently dropped by resolveInteraction's idempotent semantics -- dialog dead.
    // Fix: race the hook chain against the broker; first decision wins; the loser is aborted, never awaited.
    const raceOutcome = await racePermissionResponders({
      onHookFailure: (error) => {
        // A hook-chain failure only forfeits its side: a supporting responder's infra failure must not
        // decide a rejection for the user; the dialog keeps waiting on the broker.
        deps.logger?.warn("PermissionRequest hook chain failed; waiting for client decision", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "tool.permission.hook_race_forfeited",
          module: "core.tool.executor",
          requestId,
          status: "waiting",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });
      },
      requestBroker: (brokerSignal, claimResponse) =>
        deps.permissionBroker.requestPermission(
          {
            input: executionInput,
            mode,
            reason: permissionDecision.reason ?? `Tool ${toolCall.name} requires approval`,
            requestId,
            requestedAt: new Date(),
            riskLevel: permissionDecision.riskLevel,
            ruleId: permissionDecision.ruleId,
            sessionId: deps.sessionId,
            sideEffectScope: permissionDecision.sideEffectScope,
            suggestedPermissionUpdates,
            ...(approval.optionsPolicy ? { optionsPolicy: approval.optionsPolicy } : {}),
            toolCallId: toolCall.id as PermissionBrokerRequest["toolCallId"],
            toolName: toolCall.name,
            traceId: traceContext.traceId,
            turnId: traceContext.turnId ?? deps.turnId,
          },
          {
            signal: brokerSignal,
            claimResponse,
            timeoutMs: deps.permissionTimeoutMs,
          },
        ),
      runHooks: (hookSignal) =>
        runPermissionRequestHooks(
          deps,
          toolCall,
          executionInput,
          requestId,
          permissionDecision,
          mode,
          traceContext,
          hookSignal,
        ),
      ...(signal === undefined ? {} : { signal }),
    });
    brokerResult = raceOutcome.result;
    const permissionHookResult = raceOutcome.source === "hook" ? raceOutcome.result : undefined;

    if (permissionHookResult?.decision === "modify") {
      normalizedHookModifiedInput = normalizeToolExecutionInput({
        entry,
        input: permissionHookResult.modifiedInput ?? executionInput,
        logger: deps.logger,
        source: "permission",
      });
      useNormalizedHookModifiedInput = true;
      if (!validateInput(normalizedHookModifiedInput, entry)) {
        // PermissionRequest hooks may rewrite the target path; the post-edit input cannot inherit the pre-edit verdict.
        const recheck = await recheckPermissionHookModifiedInput({
          deps,
          entry,
          mode,
          modifiedInput: normalizedHookModifiedInput,
          projectRules,
          requestId,
          signal,
          toolCall,
          traceContext,
        });
        if (recheck.permissionDecision) permissionDecision = recheck.permissionDecision;
        if (recheck.brokerResult) {
          brokerResult = recheck.brokerResult;
          useNormalizedHookModifiedInput = brokerResult.decision === "allow";
        }
      }
    }
  } catch (error) {
    telemetry?.setPermissionDecision("denied");
    const coreError = isCoreError(error)
      ? error
      : createCoreError(CoreErrorType.PermissionDenied, "Permission request failed", {
          cause: error instanceof Error ? error : undefined,
          context: { requestId, toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: true,
        });
    await emitPermissionResolved(
      deps,
      toolCall,
      requestId,
      {
        decision: "deny",
        reason: coreError.message,
        resolvedAt: new Date(),
      },
      traceContext,
    );
    return { allowed: false, result: createErrorResult(toolCall, coreError) };
  }

  const resolvedPermission = {
    ...brokerResult,
    resolvedAt: brokerResult.resolvedAt ?? new Date(),
  };
  const permissionWaitMs = Math.max(0, Math.round(Date.now() - permissionWaitStartedAt));
  await emitPermissionResolved(deps, toolCall, requestId, resolvedPermission, traceContext);

  deps.logger?.info("Tool permission resolved", {
    ...traceContextToLogContext(traceContext),
    decision: resolvedPermission.decision,
    event: "tool.permission.resolved",
    mode,
    module: "core.tool.executor",
    reason: resolvedPermission.reason,
    requestId,
    status:
      resolvedPermission.decision === "allow" || resolvedPermission.decision === "modify"
        ? "completed"
        : "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });

  if (resolvedPermission.decision === "deny") {
    telemetry?.setPermissionDecision("denied");
    return {
      allowed: false,
      result: createPermissionErrorResult(
        toolCall,
        resolvedPermission.reason,
        {
          decision: resolvedPermission.decision,
          mode,
          reasonSource: resolvedPermission.reasonSource,
          requestId,
          ruleId: permissionDecision.ruleId,
        },
        resolvedPermission.preserveReasonFormatting
          ? { preserveReasonFormatting: true }
          : undefined,
      ),
    };
  }

  if (resolvedPermission.decision === "escalate") {
    telemetry?.setPermissionDecision("denied");
    return {
      allowed: false,
      result: createErrorResult(
        toolCall,
        createCoreError(
          CoreErrorType.PermissionEscalation,
          resolvedPermission.reason ?? `Permission escalation requested for ${toolCall.name}`,
          {
            context: {
              decision: resolvedPermission.decision,
              mode,
              requestId,
              ruleId: permissionDecision.ruleId,
              toolName: toolCall.name,
            },
            recoverable: true,
          },
        ),
      ),
    };
  }

  if (resolvedPermission.permissionUpdates?.length) {
    try {
      await persistProjectPermissionUpdates(
        deps,
        resolvedPermission.permissionUpdates,
        traceContext,
      );
    } catch (error) {
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(
            CoreErrorType.StorageError,
            "Failed to persist project permission update",
            {
              cause: error instanceof Error ? error : undefined,
              context: {
                requestId,
                sessionId: deps.sessionId,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              },
              recoverable: true,
            },
          ),
        ),
      };
    }
  }

  if (resolvedPermission.sessionPermissionUpdates?.length) {
    // Session-level no-confirm: memory-only session ruleset,
    // invisible to the project-level persistence above and vice versa.
    deps.permissionService.grantSessionPermission(resolvedPermission.sessionPermissionUpdates);
    deps.logger?.info("Session permission granted", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.session_grant.applied",
      module: "core.tool.executor",
      requestId,
      status: "completed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      updateCount: resolvedPermission.sessionPermissionUpdates.length,
    });
  }

  telemetry?.setPermissionDecision("granted");
  if (resolvedPermission.decision !== "modify") {
    return {
      allowed: true,
      executionInput: useNormalizedHookModifiedInput ? normalizedHookModifiedInput : executionInput,
      permissionWaitMs,
    };
  }

  const modifiedInput = useNormalizedHookModifiedInput
    ? normalizedHookModifiedInput
    : normalizeToolExecutionInput({
        entry,
        input: resolvedPermission.modifiedInput ?? executionInput,
        logger: deps.logger,
        source: "permission",
      });
  const modifiedInputValidation = validateInput(modifiedInput, entry);
  if (modifiedInputValidation) {
    return {
      allowed: false,
      result: createErrorResult(toolCall, modifiedInputValidation),
    };
  }
  return { allowed: true, executionInput: modifiedInput, permissionWaitMs };
}
