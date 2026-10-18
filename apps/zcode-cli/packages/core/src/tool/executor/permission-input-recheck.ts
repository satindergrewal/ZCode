import { type CollaborationMode, type PermissionRuleset } from "@zcode/contracts";

import type { PermissionDecisionResult, PermissionContext } from "../../permission/service.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { applyMemoryFilePermission, targetsMemoryFile } from "./memory-file-permission.js";
import { resolveRuntimePermissionCapability } from "./permission-capability.js";
import type { ToolExecutorDeps } from "./types.js";

export interface PermissionHookInputRecheckResult {
  permissionDecision?: PermissionDecisionResult;
}

export function recheckPermissionHookModifiedInput(input: {
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  mode: CollaborationMode;
  modifiedInput: unknown;
  projectRules: PermissionRuleset | null;
  toolCall: ExecutableToolCall;
  /** Same context as the first grant check (mode, bashShellSelection, cwd snapshot), built by the executor and passed through. */
  context: ToolRuntimePermissionCapabilityContext & {
    workingDirectory: string;
    workspaceRoot: string;
  };
}): PermissionHookInputRecheckResult {
  // Root cause (2026-09-17 review): this used to rebuild a reduced context holding only runtimeScope/cwd, dropping mode and
  // bashShellSelection; once guarded reuse took the recheck path the matcher silently broke. Context has exactly one construction site.
  const { context: runtimePermissionContext } = input;
  const { workingDirectory, workspaceRoot } = runtimePermissionContext;
  const permissionContext: PermissionContext = {
    input: input.modifiedInput,
    mode: input.mode,
    prePlanMode: input.deps.sessionModePort?.getPrePlanMode(),
    planEnabled: input.deps.sessionModePort?.isPlanEnabled?.(),
    riskLevel: input.entry.metadata.riskLevel,
    toolName: input.toolCall.name,
    // Same source as the first pass: after hooks edit the input, draft-no-confirm rechecks against the same workdir.
    workingDirectory,
  };
  const rulePolicy = input.entry.resolvePermissionRulePolicy?.(
    input.modifiedInput,
    runtimePermissionContext,
  );
  let decision = input.deps.permissionService.checkPermission(
    permissionContext,
    resolveRuntimePermissionCapability(input.entry, input.modifiedInput, runtimePermissionContext),
    input.projectRules,
    rulePolicy,
  );
  decision = applyMemoryFilePermission({
    decision,
    executionInput: input.modifiedInput,
    memoryRoot: input.deps.getMemoryRoot?.(),
    toolName: input.toolCall.name,
    workingDirectory,
    workspaceRoot,
  });

  if (decision.decision === "deny") {
    return {
      permissionDecision: decision,
    };
  }
  if (
    decision.decision !== "ask" ||
    (decision.ruleId !== "rule.project.ask" &&
      !targetsMemoryFile({
        executionInput: input.modifiedInput,
        memoryRoot: input.deps.getMemoryRoot?.(),
        toolName: input.toolCall.name,
        workingDirectory,
        workspaceRoot,
      }))
  ) {
    return {};
  }

  // Return only the policy facts the legacy mode must keep; request registration/publication/terminal states stay with the executor.
  return { permissionDecision: decision };
}
