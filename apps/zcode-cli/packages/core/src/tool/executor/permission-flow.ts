import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  traceContextToLogContext,
  type CollaborationMode,
  type PermissionBrokerResult,
  type PermissionRuleset,
  type TraceContext,
  type ToolExecutionSpanWriter,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { resolveToolApproval } from "./approval-gate.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { emitPermissionDenied, emitPermissionResolved } from "./events.js";
import { applyPreToolPermissionDecision } from "./hook-flow.js";
import { applyMemoryFilePermission } from "./memory-file-permission.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { preparePermissionInput } from "./permission-input.js";
import { applyPermissionInputAdjustments } from "./permission-input-adjustments.js";
import { recheckPermissionHookModifiedInput } from "./permission-input-recheck.js";
import { requestPermissionResponse } from "./permission-request.js";
import {
  interpretPermissionResponse,
  type PermissionFlowResult,
  type PermissionResponseTransition,
} from "./permission-response.js";
import {
  loadProjectPermissionRuleset,
  applyGrantedPermissionUpdates,
} from "./permission-rules-persistence.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import type { ToolExecutorDeps } from "./types.js";
import { summarizeInput } from "./utils.js";

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
  preparedContext?: ToolRuntimePermissionCapabilityContext,
): Promise<PermissionFlowResult> {
  const context = {
    ...resolveRuntimePermissionContext(deps),
    ...preparedContext,
    mode,
    workingDirectory: preparedContext?.workingDirectory ?? deps.getWorkingDirectory(),
    workspaceRoot: preparedContext?.workspaceRoot ?? deps.getWorkspaceRoot(),
  };
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
          recoverable: true,
        }),
      ),
    };
  }
  let firstInput = true;
  let hooksAvailable = true;
  let permissionWaitMs = 0;
  // Root cause: recursive re-entry re-ran Hooks and treated Q&A answers as new actions; the explicit transition re-evaluates new input only.
  while (true) {
    if (signal?.aborted)
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled", {
            recoverable: true,
          }),
        ),
      };
    const rulePolicy = entry.resolvePermissionRulePolicy?.(executionInput, context);
    let decision = deps.permissionService.checkPermission(
      {
        toolName: toolCall.name,
        input: executionInput,
        riskLevel: entry.metadata.riskLevel,
        mode,
        planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
        prePlanMode: deps.sessionModePort?.getPrePlanMode(),
        // Draft pre-approval and the real tool input share the prepared cwd; never drop it when merging Guarded.
        workingDirectory: context.workingDirectory,
      },
      resolveRuntimePermissionCapability(entry, executionInput, context),
      projectRules,
      rulePolicy,
    );
    if (firstInput && decision.approvalMode !== "user-once") {
      decision = applyPreToolPermissionDecision(decision, preToolHookResult, mode);
    }
    firstInput = false;
    decision = applyMemoryFilePermission({
      decision,
      executionInput,
      memoryRoot: deps.getMemoryRoot?.(),
      toolName: toolCall.name,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    });
    // Why: the unified approval flow lost the original logging contract; restore the correlation fields, input still logs a structural summary only.
    deps.logger?.debug("Tool permission evaluated", {
      ...traceContextToLogContext(traceContext),
      decision: decision.decision,
      event: "tool.permission.evaluated",
      inputSummary: summarizeInput(toolCall.input),
      mode,
      module: "core.tool.executor",
      reason: decision.reason,
      riskLevel: decision.riskLevel,
      ruleId: decision.ruleId,
      sideEffectScope: decision.sideEffectScope,
      status:
        decision.decision === "allow"
          ? "completed"
          : decision.decision === "ask"
            ? "waiting"
            : "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    if (decision.allowed) {
      telemetry?.setPermissionDecision(permissionWaitMs ? "granted" : "not_required");
      return { allowed: true, executionInput, permissionWaitMs };
    }
    if (decision.decision === "deny") {
      telemetry?.setPermissionDecision("denied");
      await emitPermissionDenied(deps, toolCall, decision.reason, traceContext);
      deps.logger?.warn("Tool permission denied", {
        ...traceContextToLogContext(traceContext),
        decision: decision.decision,
        event: "tool.permission.denied",
        mode,
        module: "core.tool.executor",
        reason: decision.reason,
        ruleId: decision.ruleId,
        status: "failed",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
      return {
        allowed: false,
        result: createPermissionErrorResult(toolCall, decision.reason, {
          mode,
          ruleId: decision.ruleId,
        }),
      };
    }

    // Tool previews govern plain approvals only; they must not override Guarded's one-shot confirmation.
    const approval =
      decision.approvalMode === "user-once"
        ? { gate: "ask" as const }
        : resolveToolApproval(deps, toolCall, entry, executionInput, traceContext);
    if (approval.gate === "proceed") {
      telemetry?.setPermissionDecision("not_required");
      return { allowed: true, executionInput, permissionWaitMs };
    }

    const requestId = "perm_" + crypto.randomUUID();
    const startedAt = Date.now();
    const suggestedPermissionUpdates =
      decision.approvalMode === "user-once"
        ? []
        : (rulePolicy?.suggestedPermissionUpdates ??
          buildDefaultPermissionUpdates(
            toolCall.name,
            executionInput,
            entry.permissionCapabilityGroup,
          ));
    telemetry?.markPermissionRequested();
    let transition: PermissionResponseTransition;
    let resolved: PermissionBrokerResult;
    try {
      let outcome = await requestPermissionResponse({
        deps,
        toolCall,
        input: executionInput,
        decision,
        mode,
        requestId,
        traceContext,
        suggestedPermissionUpdates,
        approval,
        runHooks: hooksAvailable && decision.approvalMode !== "user-once",
        signal,
      });
      hooksAvailable = false;
      let rewrite: PermissionResponseTransition | undefined;
      // Non-guarded keeps the published Hook/project/Memory re-evaluation scope and authorization semantics.
      if (mode !== "guarded" && outcome.source === "hook" && outcome.result.decision === "modify") {
        const normalized = preparePermissionInput(
          outcome.result.modifiedInput ?? executionInput,
          entry,
          deps,
        );
        const recheck = recheckPermissionHookModifiedInput({
          context,
          deps,
          entry,
          mode,
          modifiedInput: normalized,
          projectRules,
          toolCall,
        });
        if (recheck.permissionDecision?.decision === "ask") {
          // The legacy branch re-calls the broker with the same requestId; a late response could approve newer input.
          // Keep the project/Memory re-evaluation scope; lifecycle moves to the same close-then-recreate transition.
          rewrite = { kind: "rewrite", input: normalized };
        } else {
          executionInput = normalized;
          outcome = {
            source: "hook",
            result: {
              ...outcome.result,
              modifiedInput: undefined,
              decision: recheck.permissionDecision?.decision === "deny" ? "deny" : "allow",
              reason: recheck.permissionDecision?.reason ?? outcome.result.reason,
            },
          };
        }
      }
      transition =
        rewrite ??
        interpretPermissionResponse({
          deps,
          toolCall,
          entry,
          input: executionInput,
          mode,
          decision,
          outcome,
          requestId,
        });
      resolved = { ...outcome.result, resolvedAt: outcome.result.resolvedAt ?? new Date() };
    } catch (error) {
      const coreError = isCoreError(error)
        ? error
        : createCoreError(
            mode === "guarded" ? CoreErrorType.ToolExecutionFailed : CoreErrorType.PermissionDenied,
            "Permission request failed",
            {
              cause: error instanceof Error ? error : undefined,
              context: { requestId, toolCallId: toolCall.id, toolName: toolCall.name },
              recoverable: true,
            },
          );
      resolved = { decision: "deny", reason: coreError.message, resolvedAt: new Date() };
      transition = {
        kind: "complete",
        result: { allowed: false, result: createErrorResult(toolCall, coreError) },
      };
    }
    permissionWaitMs += Math.max(0, Date.now() - startedAt);
    // Only this site ends the request: validation errors, cancel, rewrite, and the normal response each emit exactly one terminal state.
    await emitPermissionResolved(deps, toolCall, requestId, resolved, traceContext);
    deps.logger?.info("Tool permission resolved", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.resolved",
      module: "core.tool.executor",
      requestId,
      mode,
      ruleId: decision.ruleId,
      decision: resolved.decision,
      reason: resolved.reason,
      status:
        resolved.decision === "allow" || resolved.decision === "modify" ? "completed" : "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    if (transition.kind === "rewrite") {
      executionInput = transition.input;
      continue;
    }
    const result = transition.result;
    telemetry?.setPermissionDecision(result.allowed ? "granted" : "denied");
    if (!result.allowed) return result;
    if (signal?.aborted)
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled", {
            recoverable: true,
          }),
        ),
      };
    const updateFailure = await applyGrantedPermissionUpdates({
      deps,
      permissionUpdates: resolved.permissionUpdates,
      requestId,
      sessionPermissionUpdates: resolved.sessionPermissionUpdates,
      toolCall,
      traceContext,
    });
    if (updateFailure) return { allowed: false, result: updateFailure };
    const adjusted = applyPermissionInputAdjustments({
      deps,
      entry,
      toolCall,
      executionInput: result.executionInput,
      adjustments: resolved.inputAdjustments,
      traceContext,
    });
    if (!adjusted.ok) return { allowed: false, result: adjusted.result };
    return {
      ...result,
      executionInput: adjusted.executionInput,
      permissionWaitMs,
      ...(adjusted.applied === undefined ? {} : { inputAdjustments: adjusted.applied }),
    };
  }
}
