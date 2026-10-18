import type {
  CollaborationMode,
  ExecutionShellSelection,
  Model,
  ModelSelection,
  ModelToolContract,
  PermissionBrokerRequest,
  ProjectId,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionProjection,
  TraceContext,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
} from "../deps.js";
import { isInspectablePermissionBroker, projectIdFromDirectory } from "../helpers/index.js";
import {
  deriveChildClientPorts,
  type ChildClientPortsContext,
  type ClientFacingPorts,
} from "../helpers/child-client-ports.js";
import type { AgentRuntimeConfig, ActiveTurnInfo } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

import { mirrorSubagentInteractionEvent } from "../../subagent/tool-event-mirror.js";
import { orderProviderVisibleToolContracts } from "../../tool/provider-visible-order.js";
import { projectToolModelContract } from "../../tool/model-contract.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { filterEmbeddedSearchRuntimeVisibleTools } from "./embedded-search-branch.js";
import {
  getSessionShellSelection as readSessionShellSelection,
  initializeSessionShellEnvironmentIfNeeded as initializeSessionShellEnvironment,
  type SessionShellEnvironmentCandidate,
} from "./session-shell-environment.js";

export async function setExecutionState(
  this: AgentRuntimeInternal,
  input: { mode?: string; planEnabled?: boolean },
  traceContext?: TraceContext,
): Promise<void> {
  await applyRuntimeExecutionState(this, input, { source: "command", traceContext });
}

export function updateConfig(
  this: AgentRuntimeInternal,
  patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
): void {
  if (patch.mode !== undefined || patch.planEnabled !== undefined) {
    const previous = resolveExecutionState(this.config);
    const next = resolveExecutionState(patch, previous);
    Object.assign(this.config, next);
    if (previous.planEnabled !== next.planEnabled)
      this.needsPlanModeExitReminder = !next.planEnabled;
  }
  if (patch.language !== undefined) {
    this.config.language = patch.language;
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
  if ("outputStyle" in patch) {
    this.config.outputStyle = patch.outputStyle;
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
}

export function initializeSessionShellEnvironmentIfNeeded(
  this: AgentRuntimeInternal,
  selection: SessionShellEnvironmentCandidate,
): boolean {
  return initializeSessionShellEnvironment(this, selection);
}

export function getSessionShellSelection(
  this: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return readSessionShellSelection(this);
}

export function getMode(this: AgentRuntimeInternal): CollaborationMode {
  return this.config.mode ?? "build";
}

export function getPlanEnabled(this: AgentRuntimeInternal): boolean {
  return resolveExecutionState(this.config).planEnabled;
}

export function getSessionModelSelection(this: AgentRuntimeInternal): ModelSelection | undefined {
  return this.sessionModelSelection && cloneModelSelection(this.sessionModelSelection);
}

export function setSessionModelSelection(
  this: AgentRuntimeInternal,
  selection: ModelSelection | undefined,
): void {
  // Restore/config refresh may clear a stale selection; an unbound state must not borrow the default model, nor touch the Active Model in flight.
  this.sessionModelSelection = selection && cloneModelSelection(selection);
}

export function getProjectId(this: AgentRuntimeInternal): ProjectId {
  // Bash cd changes the exec cwd, but project identity must not drift with tool-internal cwds.
  return projectIdFromDirectory(this.workspaceRoot);
}

export function setWorkingDirectory(this: AgentRuntimeInternal, cwd: string): void {
  // Persisted Bash cwd affects the current runtime session only, never workspace identity.
  this.workingDirectory = cwd;
}

export async function ensureSessionPersistedForExternalActivity(
  this: AgentRuntimeInternal,
  input: string,
  options?: { traceContext?: TraceContext },
): Promise<void> {
  await this.ensureSessionPersisted(input, options?.traceContext ?? this.rootTraceContext);
}

export function getActiveTurnInfo(this: AgentRuntimeInternal): ActiveTurnInfo | undefined {
  const activeTurn = this.activeTurn;
  if (!activeTurn) return undefined;
  return {
    kind: activeTurn.kind,
    ...(activeTurn.inputId === undefined ? {} : { inputId: activeTurn.inputId }),
    queueLength: activeTurn.pendingInputs.length,
    steerable: activeTurn.steerable,
    turnId: activeTurn.turnId,
  };
}

export function getTools(this: AgentRuntimeInternal, model?: Model): ModelToolContract[] {
  if (this.cachedTools === null) {
    this.cachedTools = filterRuntimeVisibleTools.call(this, this.registry.toContracts());
  }
  return this.cachedTools
    .filter((tool) => tool.name !== "WebSearch" || shouldExposeWebSearch.call(this, model))
    .map((tool) =>
      projectToolModelContract(tool, this.registry.get(tool.name), {
        model,
      }),
    );
}

export function invalidateToolCache(this: AgentRuntimeInternal): void {
  this.cachedTools = null;
}

export function getToolRegistry(this: AgentRuntimeInternal): ToolRegistry {
  return this.registry;
}

export function getToolExecutor(this: AgentRuntimeInternal): ToolExecutor {
  return this.executor;
}

export function subscribeEvents(this: AgentRuntimeInternal, sink: SessionEventSink): () => void {
  this.eventSinks.add(sink);
  return () => {
    this.eventSinks.delete(sink);
  };
}

/**
 * External sub-runtime seam (1): hand this runtime's session-event store to the child.
 *
 * Child runtimes built outside the class (bootstrap's dwf actor / legacy script workflow) must share the parent's
 * store, or the child's events land in a private store nobody reads and v4's
 * `loadPersistedEvents(childSessionId)` stays empty forever — a permanently blank transcript. Child events still persist under the
 * child's own sessionId; both sessions coexist in one store without overwrite (`subagent.ts:280`'s
 * `eventStore: this.eventStore` is the same covenant).
 */
export function getSessionEventStore(this: AgentRuntimeInternal): SessionEventStorePort {
  return this.eventStore;
}

/**
 * External sub-runtime seam (2): fan the child session's raw events out to this runtime's external sinks.
 *
 * Semantics are identical to `subagent.ts:338`'s `notifyEventSinks(event, {...trace, sessionId: childSessionId})`:
 * keep the child sessionId (the protocol layer routes detached live sessions by it); notify only, never append.
 *
 * The child runtime must wire this call as its `deps.eventSink` at **construction time**:
 * `ensureSessionPersistedForExternalActivity` writes SessionTitleUpdated as sequenceNumber 1,
 * and the v4 gateway drains only contiguous seqs — a subscription attached after construction starts at seq 2 and would wait forever for a seq 1 that never comes.
 */
export async function notifyExternalChildSessionEvent(
  this: AgentRuntimeInternal,
  input: {
    childSessionId: SessionId;
    event: SessionEvent;
    traceContext?: TraceContext;
    interactionOrigin?: ChildClientPortsContext;
  },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  // Notify only, never append: the child runtime already persisted this event under its own sessionId;
  // routing it through the parent's append path would duplicate it in the shared store.
  await this.notifyEventSinks(input.event, { ...traceContext, sessionId: input.childSessionId });
  if (input.interactionOrigin === undefined) return;
  // Root cause (2026-09-23, live): a guarded dwf actor's permission request reached the desktop via the parent broker, but v4's
  // confirm dialog is generated only from the **parent session's** live PermissionRequested projection; the event lived only in the child,
  // no dialog appeared, and the actor waited forever. Same mirror as core subagents (interactions only; the parent timeline gets no tool activity), notify-only again.
  const mirrored = mirrorSubagentInteractionEvent(input.event, {
    ...input.interactionOrigin,
    parentSessionId: this.sessionId,
  });
  if (mirrored === undefined) return;
  await this.notifyEventSinks(mirrored, { ...traceContext, sessionId: this.sessionId });
}

/**
 * External sub-runtime seam (3): mint the child runtime's **outward interaction** ports.
 *
 * The child's ledger identity (its sessionId) is not an identity protocol clients can answer. The dwf actor and legacy
 * workflow child used to read `providerRuntimeHeadersPort` / `permissionBroker` straight off `appOptions`,
 * then asked the desktop as `sess_dwf-…`; `requireSession` on the reply path threw, the response never went out,
 * and the subagent hung before its first model request (8 subagents, 80 minutes, zero events). Core's built-in subagent escaped via
 * two private wrappers — three wirings, two wrong — proof that rules scattered across call sites always drift.
 *
 * Fix: derivation converges on `deriveChildClientPorts`, callable only from the **parent runtime** — the parent fills
 * `parentSessionId` itself, so callers cannot get it wrong. Any assembly building a child runtime outside the class
 * (dwf actor, legacy workflow child) must take its ports here.
 */
export function createChildClientPorts(
  this: AgentRuntimeInternal,
  context: ChildClientPortsContext,
): ClientFacingPorts {
  return deriveChildClientPorts(
    {
      ...(this.permissionBroker === undefined ? {} : { permissionBroker: this.permissionBroker }),
      ...(this.providerRuntimeHeadersPort === undefined
        ? {}
        : { providerRuntimeHeadersPort: this.providerRuntimeHeadersPort }),
    },
    { ...context, parentSessionId: this.sessionId },
  );
}

export function getContextBuilder(this: AgentRuntimeInternal): ContextBuilder {
  if (!this.contextBuilder) {
    this.contextBuilder = this.createContextBuilderFromSnapshot(
      this.createConfigOnlyContextSnapshot(this.workingDirectory),
      undefined,
      { persistEnvInfo: false },
    );
  }
  // This getter may only supply the synchronous preview builder; it must not initialize messageHistory.
  // Otherwise the first executeTurn skips async context-source resolution and the real workspace context is lost.
  return this.contextBuilder;
}

export function getPendingPermissionRequests(
  this: AgentRuntimeInternal,
): PermissionBrokerRequest[] {
  if (!isInspectablePermissionBroker(this.permissionBroker)) return [];
  return this.permissionBroker.listPendingRequests();
}

export async function getProjection(this: AgentRuntimeInternal): Promise<SessionProjection> {
  return this.rebuildProjection();
}

export function getSessionId(this: AgentRuntimeInternal): SessionId {
  return this.sessionId;
}

function filterRuntimeVisibleTools(
  this: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  const visibleTools = filterEmbeddedSearchRuntimeVisibleTools(this, tools);
  // Provider-visible tool order belongs to the final output boundary; the toolset only decides which tools are visible.
  return orderProviderVisibleToolContracts(visibleTools);
}

function shouldExposeWebSearch(this: AgentRuntimeInternal, model?: Model): boolean {
  // Calls without a model enumerate the full registry, for persistence and UI metadata; real execution always passes
  // the current Active Model and reads only its frozen capability facts.
  if (!model) return true;
  return model.properties.supportsNativeWebSearch;
}
import { resolveExecutionState } from "@zcode/shared";
