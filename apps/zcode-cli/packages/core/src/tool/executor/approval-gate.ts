import {
  traceContextToLogContext,
  type PermissionOptionsPolicy,
  type ToolResultDisplayPayload,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

interface ResolvedToolApproval {
  gate: "ask" | "proceed";
  display?: ToolResultDisplayPayload;
  optionsPolicy?: PermissionOptionsPolicy;
}

/**
 * Runs the tool-declared `prepareApproval` after the permission service has decided ask, folding its
 * answer with the tool-declared option policy into "what this ask should carry".
 *
 * Narrowing is one-way: a hook may only wave an ask through or attach a preview; it can never turn allow into ask.
 * Tools without a declared hook keep the plain prompt.
 */
function resolveOptionsPolicy(
  allowAlways: false | "session" | undefined,
): PermissionOptionsPolicy | undefined {
  switch (allowAlways) {
    case false:
      return "no-always-allow";
    case "session":
      return "session-always-allow";
    default:
      return undefined;
  }
}

export function resolveToolApproval(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  traceContext: TraceContext,
): ResolvedToolApproval {
  // `permission` is typed required, but the executor is also driven by entries declaring only part of it
  // (test stubs, dynamically registered tools). Surrounding code tolerates that via spreads; so does this gate.
  const optionsPolicy = resolveOptionsPolicy(entry.permission?.askOptions?.allowAlways);

  if (!entry.prepareApproval) {
    return { gate: "ask", ...(optionsPolicy ? { optionsPolicy } : {}) };
  }

  try {
    // This workdir and the handler's come from the same source (deps.getWorkingDirectory already folds in
    // static workingDirectory in impl.ts); else the preview reads one dir while the run writes another.
    const gate = entry.prepareApproval(executionInput);
    if (gate.gate === "proceed") return { gate: "proceed" };
    return {
      gate: "ask",
      ...(gate.display ? { display: gate.display } : {}),
      ...(optionsPolicy ? { optionsPolicy } : {}),
    };
  } catch (error) {
    // Bug guard: the hook producing a preview must never decide "was the user asked". Failing open to the
    // run side silently runs an unapproved tool, so the ask stands and only the preview degrades.
    deps.logger?.warn("Tool approval preview failed; asking without a preview", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "tool.permission.approval_preview_failed",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    return { gate: "ask", ...(optionsPolicy ? { optionsPolicy } : {}) };
  }
}
