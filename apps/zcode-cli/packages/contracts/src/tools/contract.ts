// ============================================================
// Tool Contract - shared tool declaration surface
// ============================================================

import type { RiskLevel } from "../interfaces/session.port.js";

export type ToolSideEffectScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session"
  | "userInteraction";

/**
 * Side-effect scopes that rewrite the workspace: filesystem, git,
 * and shell/host execution that cannot prove read-only. `network`, `session`, `userInteraction`, `none` never touch it.
 * dynamic-workflow's import cache treats these as "first write": a tool call whose resolved capability has
 * `readOnly !== true` and whose scope lands here counts as a write. The rule lives in contracts because both the
 * marker producer (core) and consumer driver (bootstrap) must agree on it.
 */
export const WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES: ReadonlySet<ToolSideEffectScope> =
  new Set<ToolSideEffectScope>(["workspace", "git", "system"]);

/** Whether one tool call (per resolved capability) rewrites the workspace. Absent scope counts as mutating (conservative: undeclared means untrusted). */
export function isWorkspaceMutatingToolCall(capability: {
  readOnly?: boolean | undefined;
  sideEffectScope?: ToolSideEffectScope | undefined;
}): boolean {
  if (capability.readOnly === true) return false;
  return capability.sideEffectScope === undefined
    ? true
    : WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES.has(capability.sideEffectScope);
}

/**
 * Protocol-only scopes that never see or touch the outside world: `session` hands results/questions back to the
 * caller (dynamic-workflow's `submit_result` and `escalate`), `userInteraction` asks the user.
 */
const PROTOCOL_ONLY_SIDE_EFFECT_SCOPES: ReadonlySet<ToolSideEffectScope> =
  new Set<ToolSideEffectScope>(["session", "userInteraction"]);

/**
 * Whether one tool call **sees or touches the outside world** (reads files, runs commands, hits the network...).
 *
 * Division of labor with `isWorkspaceMutatingToolCall`: that one rules on "writes" (when to close the amend-resume
 * import cache); this one rules on "touching", deciding whether a cache entry is **pure** (pure = answers only from
 * instruction and transcript prefix, still hit-worthy after closing). Reads count as touching: `Read` declares
 * `none` (no side effects) yet depends on the workspace. So the test is by exclusion -- only protocol scopes
 * (`session` / `userInteraction`) are excluded; everything else touches, absent scope included.
 */
export function isWorldTouchingToolCall(capability: {
  sideEffectScope?: ToolSideEffectScope | undefined;
}): boolean {
  return capability.sideEffectScope === undefined
    ? true
    : !PROTOCOL_ONLY_SIDE_EFFECT_SCOPES.has(capability.sideEffectScope);
}

export type ToolPermissionPatternSource =
  | "none"
  | "toolName"
  | "input"
  | "path"
  | "command"
  | "network"
  | "custom";

export type ToolResultBudgetStrategy = "inline" | "truncate" | "artifact";

export type ToolExecutionMode = "client" | "providerNative";

export interface ProviderNativeToolSpec {
  kind: "provider_native";
  logicalName: string;
  providerToolName: string;
  providerIds?: string[];
  args?: Record<string, unknown>;
  fallback: "disabled";
}

export interface ToolPermissionSpec {
  permission: string;
  reason: string;
  riskLevel: RiskLevel;
  sideEffectScope: ToolSideEffectScope;
  needsApproval: boolean;
  patternSources: ToolPermissionPatternSource[];
  alwaysAllowPatternSources?: ToolPermissionPatternSource[];
  denyPriority: "beforeAsk" | "afterStaticAllow";
  /**
   * Requires explicit user approval in every permission mode. Unlike `needsApproval`, which
   * the permissive modes are allowed to short-circuit, this survives yolo's pass-through and
   * plan mode's read-only pass-through: the tool's unit of work is large enough that no
   * permissiveness setting should be able to run it unattended.
   *
   * It overrides allow-granting branches only, never deny-granting ones — an explicitly
   * disallowed tool stays denied.
   */
  alwaysAsk?: true;
  /**
   * Narrows the options offered when this tool asks. `allowAlways: false` suppresses the
   * persistent project rule: a tool whose input is different code on every call cannot
   * have a decision remembered without permanently disabling its gate. `"session"` swaps
   * the persistent rule for an in-memory, session-scoped one ("Always allow in this
   * session"): the gate stays closed for the rest of this runtime only, and every new
   * session (restart, cold resume, `/new`) asks again first.
   */
  askOptions?: { allowAlways: false | "session" };
}

export interface ToolResultBudget {
  /** Inline UI/event threshold before a result should be summarized, truncated, or redirected. */
  maxInlineBytes: number;
  /**
   * Provider-visible inline threshold. For artifact strategy this is the threshold that triggers
   * artifact persistence; the successful <persisted-output> preview uses its own preview budget.
   */
  maxModelBytes: number;
  strategy: ToolResultBudgetStrategy;
  preview?: {
    maxBytes?: number;
    maxLines?: number;
    direction?: "head" | "tail";
  };
  artifact?: {
    enabled: boolean;
    retention?: "session" | "project" | "temporary";
  };
}

export interface NoToolTimeoutPolicy {
  kind: "none";
}

export interface TimedToolTimeoutPolicy {
  kind?: "timed";
  defaultMs: number;
  maxMs?: number;
  allowCallOverride: boolean;
  /**
   * Extra wall-clock budget reserved for cancellation and adapter cleanup after the
   * tool's own timeout. The user-facing timeout still comes from defaultMs/input.
   */
  cleanupGraceMs?: number;
}

export type ToolTimeoutPolicy = NoToolTimeoutPolicy | TimedToolTimeoutPolicy;

export interface ToolCancellationPolicy {
  supported: boolean;
  cleanup: "none" | "bestEffort" | "required";
  userVisibleMessage: string;
}

export interface ToolTracePolicy {
  required: true;
  propagateToAdapters: boolean;
  recordInput: "summary" | "full" | "none";
  recordOutput: "summary" | "full" | "none";
}

export interface ToolContractDeclaration {
  capability: string;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /**
   * Declares `inputSchema` **eligible** for the provider's strict mode (Anthropic `strict: true`: constrained
   * decoding guarantees tool_use.input matches the schema exactly). Eligibility, not a command: the adapter decides
   * per provider/model whether to actually send it, and folds keywords the strict subset cannot express into the
   * description. Absent means not strict. First user: dwf mono subagents' typed `submit_result`.
   */
  strict?: boolean;
  requiresUserInteraction?: boolean;
  permission: ToolPermissionSpec;
  resultBudget: ToolResultBudget;
  timeout: ToolTimeoutPolicy;
  cancellation: ToolCancellationPolicy;
  trace: ToolTracePolicy;
}
