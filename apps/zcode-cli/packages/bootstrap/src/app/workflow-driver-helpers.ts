// ============================================================
// AgentRuntime-backed WorkflowDriver: pure helpers
// ============================================================
// workflow-driver.ts sits at the oxlint max-lines cap (400 lines), so pure functions and constants
// that never touch driver state (deferred, actor session id minting, escalation budget and qid
// fragments, nudge / schema epilogues, verdict and stats mapping, turn failure normalization) live
// here; the public surface (mintActorSessionId) is still re-exported from workflow-driver.ts.

import {
  CoreErrorType,
  createSessionId,
  type SessionId,
  type SubmitVerdict as ContractsSubmitVerdict,
  type SubmitViolation,
} from "@zcode/contracts";
import type { TurnResult } from "@zcode/core";
import {
  refToString,
  WorkflowError,
  type ActorRef,
  type AskStats,
  type InstanceRef,
  type PersonaSpec,
  type Violation,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import type { ActorToolCounts } from "./workflow-driver-tool-activity.js";
import type { Deferred, SessionState } from "./workflow-driver-types.js";

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Actor session id: run-scoped and charset-safe.
 *
 * The old scheme `createSessionId("wf-actor-" + refToString(actor))` had two flaws: no runId, so
 * the same site x ordinal actor across two concurrent runs collided onto one id; and it carried
 * `#`/`@` (refToString yields `actor#1@1`) while session ids end up in URLs, file paths, and logs.
 */
/**
 * Actor session id: run-scoped and charset-safe.
 *
 * **Exported on purpose**: the progress projection must carry the session id on the
 * `actor-created` event (Boundary C does not include it), and "derive the session id from
 * (runId, actorRef)" must have exactly one implementation - two independent derivations will
 * eventually disagree, manifesting as the details page opening a nonexistent session. The run
 * service calls this very function (tests pin both sides equal).
 */
export function mintActorSessionId(runId: string, actor: ActorRef): SessionId {
  return createSessionId(
    `dwf-${sanitizeIdSegment(runId)}-${sanitizeIdSegment(refToString(actor))}`,
  );
}

/**
 * Folds an arbitrary string into `[A-Za-z0-9.\-_]`, where `_` appears only as escape output.
 *
 * **Two steps, and the order is the contract**: first escape literal `_` to `__`, then map every
 * character outside `[A-Za-z0-9.-]` to a single `_`. Reversing the order breaks the escaping
 * (the `_` produced by step two would be re-expanded by step one). The `_` produced by step one
 * is a fixed point of step two's mapping, so the two steps compose safely.
 *
 * Why the escape step: without it, `my_actor#1` and `my#actor#1` both fold to `my_actor_1` - a
 * real collision. A plain whitelist is collision-free only under the assumption "the site id
 * vocabulary contains no `_`", and that vocabulary is owned by the analyzer, not this file. The
 * escape step trades "relying on someone else's vocabulary shape" for a locally provable property.
 *
 * Residual (smaller) assumption: two **different** special characters still both map to `_`, so
 * hypothetical `a#b` and `a@b` would collide. Today and for the foreseeable site ids, special
 * characters appear in fixed positions (`actor#N@M`, site-specific `kind#N/M`) and no such
 * homoglyph pair exists; eliminating it would require a distinct encoding per character.
 */
function sanitizeIdSegment(value: string): string {
  return value.replace(/_/g, "__").replace(/[^A-Za-z0-9.-]/g, "_");
}

/**
 * Cap on escalations per ask (same family as the nudge budget).
 *
 * Beyond the cap is **not an error but a discipline**: the fourth call gets the plain
 * "proceed on your best judgement" result. Escalations write no dwf_node row (waiting is not
 * work), so this counter is the only bound.
 */
export const MAX_ESCALATIONS_PER_ASK = 3;

/** Tool-result text returned to the model once the budget is gone (a plain result, not an error). */
export const ESCALATION_BUDGET_EXHAUSTED =
  `Escalation budget exhausted: at most ${MAX_ESCALATIONS_PER_ASK} escalations per task. ` +
  "Do not call escalate again. Proceed on your best judgement with the information you have, " +
  "and state in your final result the assumptions you relied on and the doubts that remain.";

/** Candidate qid fragments beyond the actor session id segment (shortest to longest; last is the full runId). */
export function questionIdFragments(runId: string): string[] {
  // The `dwfrun-` prefix is identical for every run; keeping it only lengthens the qid without
  // adding discriminative power.
  const body = runId.startsWith("dwfrun-") ? runId.slice("dwfrun-".length) : runId;
  const full = sanitizeIdSegment(body);
  const candidates = [full.slice(0, 8), full.slice(0, 16), full];
  // On short runIds the three candidates degenerate to the same string; dedup just avoids
  // pointless repeated lookups.
  return [...new Set(candidates)];
}

/**
 * The actor's **effective name**: taken directly from `persona.name`; absent or empty means
 * anonymous.
 *
 * No re-normalization here - the persona the driver receives is already the engine's
 * `normalizePersona` output (the scheduler passes `actor.persona` verbatim into
 * `createActorSession`), so `spec.name` is exactly the effective name the engine recognized: the
 * name on the `actor-created` event, the amend-resume cache identity key, and the
 * DuplicateActorName dedup key are all it.
 *
 * **Deliberately no trim**, unlike {@link normalizeEscalationContext}: the engine's anonymous
 * test is `name !== undefined && name !== ""` (createActor in engine.ts), so an actor named
 * `"  "` is **named** for the engine and holds a cache identity key. Trimming to anonymous here
 * would give two answers about "has a name" for the same actor - and that is exactly what the
 * escalation records use to identify the asker. Follow the engine.
 */
export function effectiveActorName(persona: PersonaSpec): string | undefined {
  const name = persona.name;
  return name === undefined || name === "" ? undefined : name;
}

/** Optional `escalate` context: whitespace equals absent (models often pass empty strings; keeping them is just event noise). */
export function normalizeEscalationContext(context: string | undefined): string | undefined {
  const trimmed = context?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** Nudge prompt used when a turn ends without a submission. */
export const NUDGE_PROMPT =
  "You ended your turn without submitting a result. Call the submit_result tool now with a payload conforming to the required schema.";

/**
 * Typed-ask schema epilogue: appended to the instruction body, telling the model to submit a
 * schema-conforming result via submit_result. Format (this comment is the contract): separator
 * line + one sentence requesting the tool call + the JSON Schema indented 2 spaces + one
 * result-constraint sentence. The wording avoids "exactly once" - during repair rounds the model
 * may legitimately call submit_result multiple times.
 */
export function schemaEpilogue(schema: unknown): string {
  const rendered = schema === undefined ? "(any JSON value)" : JSON.stringify(schema, null, 2);
  return [
    "",
    "",
    "---",
    "When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must be a JSON value conforming to this JSON Schema:",
    "",
    rendered,
    "",
    "Pass the conforming JSON as the `result` argument — do not wrap it or add commentary.",
  ].join("\n");
}

/**
 * Typed-ask epilogue for mono subagents: the schema already lives in the tool declaration, so
 * only the "when done, call the tool" sentence remains. Same structural skeleton as
 * {@link schemaEpilogue} (two blank lines + separator); the GUI folds epilogues by boundary
 * index, not text, so it is unaffected.
 */
export const TYPED_TOOL_EPILOGUE = [
  "",
  "",
  "---",
  "When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must match the tool's declared schema — pass the conforming JSON directly, do not wrap it or add commentary.",
].join("\n");

/** Engine Violation -> contracts SubmitViolation (structurally isomorphic, 1:1). */
export function mapViolations(violations: readonly Violation[]): SubmitViolation[] {
  return violations.map((v) => ({ path: v.path, expected: v.expected, got: v.got }));
}

/** Synthesize a binary rejection (for driver-local interception, bypassing the engine). */
export function rejectWith(message: string): ContractsSubmitVerdict {
  return {
    accept: false,
    violations: [{ path: "$", expected: message, got: "submit_result call" }],
  };
}

/**
 * Distills AskStats from the TurnResult plus the tool-activity surface. tokens is the only field
 * the engine hard-depends on (budget accounting); turns and the two tool counters feed the
 * journal - `toolCalls === 0` marks this ask as a **pure** ask, still cache-hit eligible after
 * import closes, and `worldToolCalls` records whether it touched the outside world. Protocol
 * tools (`submit_result` / `escalate`) are excluded, else every typed ask would stop being pure
 * merely by submitting its result.
 *
 * The counts used to be counted from `ToolCallStarted` in `result.events`, but TurnResult's
 * event array carries no tool events - 2097 ask rows in the production journal all have
 * `toolCalls` 0, including subagents that clearly wrote files. Had the pure-ask test leaned on
 * that 0, every cache entry would keep hitting as pure after the closing, exactly the class the
 * closing guards against. Counting therefore moved to the driver's tool-activity surface over
 * the **session event stream** (where tool calls actually appear), accumulated per ask and
 * passed in.
 */
export function statsFromTurn(result: TurnResult, toolCounts: ActorToolCounts): AskStats {
  const usage = result.usage;
  return {
    tokens: usage?.totalTokens ?? 0,
    toolCalls: toolCounts.toolCalls,
    turns: usage?.modelRequestCount ?? 1,
    worldToolCalls: toolCounts.worldToolCalls,
  };
}

/** Whether an executeTurn rejection is a user/engine cancellation (a normal end, not a driver failure). */
export function isTurnCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === CoreErrorType.TurnCancelled
  );
}

/** Normalize any (non-model-layer) turn failure into a node-level WorkflowError (DriverError), keeping the original cause. */
export function toWorkflowError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WorkflowError("DriverError", `Subagent turn failed: ${message}`, { cause: error });
}

// ------------------------------------ model-side failure containment: constants and pure helpers ------------------------------------

/** Upper bound for the raw provider text in ProviderStop details (both the notification and the journal carry it; it must stay bounded). */
export const PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS = 2000;

/** Continue prompt for transient re-drives (same mechanism as the nudge: a fresh turn on the same persistent runtime). */
export const TRANSIENT_CONTINUE_PROMPT =
  "The previous model request failed transiently and was abandoned; continue from where you left off.";

const TRANSIENT_BACKOFF_BASE_MS = 2_000;
const TRANSIENT_BACKOFF_MAX_MS = 60_000;

/** Same curve as the runner: start at 2s, double up to a 60s cap, times jitter in [0.5, 1]. */
export function transientBackoffMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(TRANSIENT_BACKOFF_MAX_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(raw * (0.5 + 0.5 * random()));
}

/** Retry-After on an adapter error (`context.retryAfterMs`, within one cause level), read structurally. */
export function readRetryAfterMs(error: unknown): number | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    const context = (candidate as { context?: { retryAfterMs?: unknown } } | undefined)?.context;
    const value = context?.retryAfterMs;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** How the notification texts name a subagent: the name when present, else `site@ordinal`. */
export function subagentLabel(state: Pick<SessionState, "actor" | "actorName">): string {
  return state.actorName ?? refToString(state.actor);
}

export const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

/**
 * The two facts a resolved turn reports to the engine; the order is load-bearing:
 *   1. `askProgress` -> `node-progress`: which round this ask reached, tool usage, what it
 *      touched last;
 *   2. `askStats` -> `usage-updated`: tokens spent this round (reported once for accept / text /
 *      nudge alike).
 * Progress first, so anyone reading the new usage has already seen the progress that earned it.
 * Both live in one function precisely so this ordering has a single addressable home instead of
 * two adjacent lines at every call site.
 */
export function reportTurnObservations(
  sink: WorkflowReportSink,
  state: SessionState,
  instance: InstanceRef,
  result: TurnResult,
): void {
  sink.askProgress(instance, state.modelActivity.noteTurnResolved());
  sink.askStats(instance, statsFromTurn(result, state.modelActivity.toolCounts()));
}
