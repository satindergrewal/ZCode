import type {
  CompactPhase,
  CompactReason,
  MessageId,
  ModelStreamRecoveryStatus,
  Model,
  OutputStylePromptConfig,
  SessionEvent,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { SubagentRunOptions } from "@zcode/contracts";
import type { DrainedPendingInputDiagnostics } from "../types.js";
import type { TurnMachineImpl } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export type PendingStreamRecoveryRequest = ModelStreamRecoveryStatus;

export const RAPID_REFILL_TOOL_TURN_THRESHOLD = 3;
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;
export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
const AUTOMATION_QUERY_ID_PREFIX = "automation-";
/**
 * Tools hidden on off-peak dispatch turns; OffPeakList stays read-only.
 * - OffPeakCreate: no recursive self-spawn, unbounded schedules.
 * - SendMessage / Workflow: spawn subagents outside off-peak modelExecution (SendMessage resumes
 *   finished ones, Workflow spawns script sessions), modeled on the parent resident choice.
 *
 * A separate constant, never in AUTOMATION_MUTATION_TOOL_NAMES — cron automation allows
 * OffPeakCreate (scheduled off-peak spawns); merging mis-denies automation turns.
 */
export const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate", "SendMessage", "Workflow"] as const;
// Off-peak init-leg traceIds have no fixed prefix; only resume legs look like `${offPeakTaskId}:resume:*`
// (offpeak- prefixed); the prefix is a fallback, the real signal the explicit offPeakTaskId.
const OFF_PEAK_QUERY_ID_PREFIX = "offpeak-";

export interface CompactLoopTracking {
  consecutiveRapidRefills: number;
  toolTurnsSinceCompact: number;
}

export interface RapidRefillDecision {
  consecutiveRapidRefills: number;
  shouldBlock: boolean;
  toolTurnsSinceCompact: number;
}

export type CompactAttemptOutcome = "skipped" | "compacted" | "failed";

export type AutoCompactOutcome = CompactAttemptOutcome | "rapid_refill_blocked";

export interface AutoCompactLoopContext {
  compactReason: CompactReason;
  modelStepIndex: number;
  phase: CompactPhase;
  rapidRefill: RapidRefillDecision;
  model: Model;
  turnRequestState: TurnRequestState;
}

export interface ReactiveCompactLoopContext {
  activeEntries?: readonly RuntimeMessageEntry[];
  modelStepIndex: number;
  model: Model;
  rapidRefillCount: number;
  turnRequestState: TurnRequestState;
}

export interface TurnRequestState {
  entries: readonly RuntimeMessageEntry[];
  outputTokenContinuationCount: number;
}

export interface RegularTurnLoopState {
  activeTurn?: ActiveTurnSteeringState;
  /** Host-admission automation identity for this turn; never inferred from task metadata. */
  automationId?: string;
  /** Host-admission off-peak identity; exclusive with automationId, never inferred. */
  offPeakTaskId?: string;
  /** Post CronCreate cap-hit, this turn goes text-only permanently; no self-restore. */
  automationCreateLimitReached?: boolean;
  anomalyWarningsInjected: number;
  /** Whether this turn consumed a subagent-source result. */
  backgroundSubagentResultConsumed: boolean;
  /** Whether this turn consumed a workflow (dynamic run) notice. */
  workflowResultConsumed: boolean;
  compactTracking?: CompactLoopTracking;
  currentUserMessageId: MessageId;
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  events: SessionEvent[];
  input: string;
  modelResponse: string;
  /** The pinned callable model; config changes affect future Loops only. */
  model: Model;
  /** execution: the Active Model cannot be rewritten by same-loop guides. */
  modelSelectionScope?: "execution";
  /** Core Server foreground-child Selection override; beats profile and parent. */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  modelStepCount: number;
  /** Assistant/compact artifacts persisted provider-visibly for this query. */
  historyRoundCount: number;
  reactiveCompactAttemptedInCurrentModelStep: boolean;
  repeatedToolCallSignature?: string;
  repeatedToolCallStreakCount: number;
  pendingStreamRecoveryRequest?: PendingStreamRecoveryRequest;
  stopHookContinuationCount: number;
  /** Final product-turn raw transcript start; set once no-continue is sure. */
  stableProductStartMessageId?: MessageId;
  /** Final assistant boundary; paired with stableProductStartMessageId. */
  stableBoundaryAssistantMessageId?: MessageId;
  streamRecoveryRetryCount: number;
  tokenCount: number;
  toolCallCount: number;
  /** This Turn provider-local history; dropped at end. */
  turnRequestState: TurnRequestState;
  /** Tool names hidden from the provider; registry keeps them for defense. */
  toolDisallowlist?: readonly string[];
  traceId: TraceId;
  turnAbortSignal: AbortSignal;
  turnId: TurnId;
  turnMachine: TurnMachineImpl;
  /** Provider-visible output style this Turn; no subagent model override implied. */
  turnOutputStyle?: OutputStylePromptConfig;
  turnTraceContext: TraceContext;
  userMessageId: MessageId;
}

export function isAutomationMutationRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.automationId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(AUTOMATION_QUERY_ID_PREFIX)) return true;

  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  // active/busy automation merges the turn denylist into the loop; even off the loop head,
  // the fact must reach the handler execution boundary.
  return AUTOMATION_MUTATION_TOOL_NAMES.every((toolName) => disallowedTools.has(toolName));
}

/**
 * Off-peak auto-dispatch turn (deny OffPeakCreate)? Three signals, isomorphic to
 * isAutomationMutationRestrictedTurn: explicit offPeakTaskId primary;
 * resume-leg prefix and turn denylist as defense.
 */
export function isOffPeakCreateRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.offPeakTaskId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(OFF_PEAK_QUERY_ID_PREFIX)) return true;

  // The fallback trusts only the OffPeakCreate sentinel: older denylists may lack new tools.
  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  return disallowedTools.has(OFF_PEAK_MUTATION_TOOL_NAMES[0]);
}

export function evaluateRapidRefill(
  tracking: CompactLoopTracking | undefined,
): RapidRefillDecision {
  const toolTurnsSinceCompact = tracking?.toolTurnsSinceCompact ?? 0;
  const consecutiveRapidRefills =
    tracking && toolTurnsSinceCompact < RAPID_REFILL_TOOL_TURN_THRESHOLD
      ? tracking.consecutiveRapidRefills + 1
      : 0;

  return {
    consecutiveRapidRefills,
    shouldBlock: consecutiveRapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS,
    toolTurnsSinceCompact,
  };
}

export function recordCompactSuccess(
  state: RegularTurnLoopState,
  decision: RapidRefillDecision,
): void {
  state.compactTracking = {
    consecutiveRapidRefills: decision.consecutiveRapidRefills,
    toolTurnsSinceCompact: 0,
  };
}

export function recordCompletedToolBatch(state: RegularTurnLoopState): void {
  // The old guard lived the whole user turn, staying used post-batch — later overflow could never re-compact.
  state.reactiveCompactAttemptedInCurrentModelStep = false;
  if (state.compactTracking) {
    state.compactTracking.toolTurnsSinceCompact += 1;
  }
}

export function recordModelHistoryRound(state: RegularTurnLoopState): void {
  // toolCallCount explodes parallel calls; it misses model-written history rounds.
  // Keep the modelStepCount commit boundary; count history rounds, no control change.
  state.historyRoundCount += 1;
}

export function recordCompactHistoryRound(state: RegularTurnLoopState): void {
  // A compact summary is provider-visible history, no plain model step; count once, separately.
  state.historyRoundCount += 1;
}
