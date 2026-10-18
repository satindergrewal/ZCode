// ============================================================
// On-demand activation of the dynamic-workflow tool surface (docs/dynamic-workflow/launch.md "On demand: activation"):
// ============================================================
// a session with gradation mode `onDemand` is born without the ten workflow tools (the Agent/Task descriptions lack the
// CreateWorkflow line too) until the session first needs them: the user runs `/workflow`, the GUI hits Resume / settings /
// direct-launch on one of the session's runs, or a restore finds a session that already has workflows. Activation only adds:
// once a run exists the model needs GetWorkflowRun and friends to receive notifications — compaction never turns them off
// (contrast the skill gate, which asks "can the model still see it now"; this asks "has this session ever had a workflow").
//
// The state owner is the runtime (dynamicWorkflowToolsActivated), not config: AgentRuntime copies config at construction, and the
// runtimeConfig object captured in assembly closures never sees the runtime flip.

import {
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import { isDynamicWorkflowToolName } from "../../tool/index.js";
import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";

/** Where the activation came from, recorded in the session entry for debugging; behaviorally all four are equivalent. */
export type DynamicWorkflowActivationSource =
  | "command"
  | "run_control"
  | "resume_entry"
  | "resume_history";

export interface DynamicWorkflowActivationEntryData {
  activated: true;
  source: DynamicWorkflowActivationSource;
}

/**
 * Built-in `/workflow` command name (BUILTIN_WORKFLOW_COMMAND_NAME in bootstrap's builtin-workflow-command.ts).
 * core does not depend on bootstrap, so the literal lives in the reserved-word table; what persists on user messages is `displayInput` — the raw command.
 */
const WORKFLOW_COMMAND_TEXT_PATTERN = /^\/workflow(?:\s|$)/i;

/** Born-activated sessions: non-onDemand (alwaysOn, TUI / headless / subagents with the field unset). */
export function resolveInitialDynamicWorkflowToolsActivated(config: AgentRuntimeConfig): boolean {
  return config.dynamicWorkflowToolsOnDemand !== true;
}

/**
 * Activates this session's workflow tool surface. A no-op returning false when already active (including born-activated).
 * Order: flip state, re-register (the gate shared by both registration entry points reads this state), persist the entry — re-registration is synchronous,
 * so the first model request the caller issues after return necessarily carries the ten tools.
 */
export async function activateDynamicWorkflowTools(
  this: AgentRuntimeInternal,
  input: { source: DynamicWorkflowActivationSource; traceContext?: TraceContext },
): Promise<boolean> {
  if (this.dynamicWorkflowToolsActivated) return false;
  markDynamicWorkflowToolsActivated(this, input.source);
  // A failed entry write logs warn and never propagates. Reason: throwing used to fail `/workflow` / Resume even though the surface
  // was already active (add-only); later calls no-op as activated, yielding "operation failed but state applied". The entry is only a cold-restore
  // shortcut — every activation source leaves a `/workflow` or CreateWorkflow call in the record,
  // and restoreDynamicWorkflowActivationOnResume infers activation from history and backfills when the entry is missing.
  try {
    await persistDynamicWorkflowActivation(this);
  } catch (error) {
    this.logger?.warn("Dynamic workflow activation entry write failed", {
      ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.activation_entry_write_failed",
      module: "core.runtime",
      sessionId: this.sessionId,
    });
  }
  this.logger?.info("Dynamic workflow tools activated", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "dynamic_workflow.tools_activated",
    module: "core.runtime",
    sessionId: this.sessionId,
    source: input.source,
  });
  return true;
}

/**
 * Cold restore: decide from the entry or history whether this session ever had a workflow (launch.md "What activates", third row).
 * The history test covers two session shapes: born alwaysOn later switched to onDemand by the Host, and sessions persisted before this rule.
 * No-op when the runtime is already active; messages is every persisted message in the session store (including pre-rewind ones —
 * "ever had" does not vary by branch).
 */
export async function restoreDynamicWorkflowActivationOnResume(
  this: AgentRuntimeInternal,
  messages: readonly MessageWithParts[],
): Promise<void> {
  if (this.dynamicWorkflowToolsActivated) return;
  const entries = await this.sessionStore?.sessionEntries?.({
    sessionID: this.sessionId,
    type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  });
  const source: DynamicWorkflowActivationSource | undefined =
    entries !== undefined && entries.length > 0
      ? "resume_entry"
      : persistedMessagesShowDynamicWorkflow(messages)
        ? "resume_history"
        : undefined;
  if (source === undefined) return;
  markDynamicWorkflowToolsActivated(this, source);
  // When the entry already exists, do not rewrite; backfill one from history so the next restore skips the scan. Written directly instead of via
  // persistDynamicWorkflowActivation: during resume, sessionPersisted is set only at the end, and the session being restored
  // is necessarily already in the store.
  if (source === "resume_history") await writeDynamicWorkflowActivationEntryIfActivated(this);
}

/** Whether the persisted messages contain a `/workflow` command or any call to one of the ten tools. */
export function persistedMessagesShowDynamicWorkflow(
  messages: readonly MessageWithParts[],
): boolean {
  for (const message of messages) {
    const role = message.info.role;
    for (const part of message.parts) {
      if (
        role === "user" &&
        part.type === "text" &&
        WORKFLOW_COMMAND_TEXT_PATTERN.test(part.text.trim())
      )
        return true;
      if (role === "assistant" && part.type === "tool" && isDynamicWorkflowToolName(part.tool))
        return true;
    }
  }
  return false;
}

/**
 * On first persistence (ensureSessionPersisted in events.ts) backfill the entry: when `/workflow` arrives as the session's first turn,
 * activation precedes persistence and persistDynamicWorkflowActivation has nothing to write to yet.
 */
export async function writeDynamicWorkflowActivationEntryIfActivated(
  runtime: AgentRuntimeInternal,
): Promise<void> {
  if (runtime.config.dynamicWorkflowToolsOnDemand !== true) return;
  if (
    !runtime.dynamicWorkflowToolsActivated ||
    runtime.dynamicWorkflowActivationSource === undefined
  )
    return;
  await runtime.sessionStore?.saveSessionEntry?.(
    buildDynamicWorkflowActivationEntry(runtime.sessionId, runtime.dynamicWorkflowActivationSource),
  );
}

export function buildDynamicWorkflowActivationEntry(
  sessionId: SessionId,
  source: DynamicWorkflowActivationSource,
): SessionEntryInfo {
  const timestamp = Date.now();
  const data: DynamicWorkflowActivationEntryData = { activated: true, source };
  return {
    id: `${sessionId}:runtime-dynamic-workflow-activation`,
    sessionID: sessionId,
    type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data,
  };
}

function markDynamicWorkflowToolsActivated(
  runtime: AgentRuntimeInternal,
  source: DynamicWorkflowActivationSource,
): void {
  runtime.dynamicWorkflowToolsActivated = true;
  runtime.dynamicWorkflowActivationSource = source;
  // Same entry point as the branch refresh: it already re-registers every built-in tool under the shared gate (Agent / Task descriptions
  // revert to the CreateWorkflow-bearing variants) and clears cachedTools.
  refreshBranchAwareBuiltInTools(runtime);
}

async function persistDynamicWorkflowActivation(runtime: AgentRuntimeInternal): Promise<void> {
  if (!runtime.sessionPersisted) return;
  await writeDynamicWorkflowActivationEntryIfActivated(runtime);
}
