/**
 * Pure logic for the workflow run detail page: Cancel availability, result/failure panel
 * decision, event-log line summaries.
 *
 * Extracted as pure functions because these are the only "rules" in the detail page, and all
 * of them are exhaustively unit-testable without rendering a React Flow canvas. Components
 * just paste these results into the DOM.
 */
import {
  readWorkflowRunStopReason,
  type WorkflowRunStopReason,
} from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunActor, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { workflowRunConcurrencyEventLine } from "@/app-shell/workflowRunThrottle.js";

/** Cap on fallback text of unknown event kinds: the event log never flushes a whole journal into the DOM. */
const UNKNOWN_PAYLOAD_MAX_LENGTH = 200;

/**
 * Cancel is available on `running` only.
 *
 * Cancellation rides the existing v4 `cancelBackgroundWork {workId: runId}` (three entry
 * points, one implementation, no second cancel RPC); on already-terminal tasks it is a
 * no-op — the disabled button on terminal states exists so there is never a control that
 * does nothing when clicked, not as a fallback. A run absent from the projection (evicted by
 * the 8-run cap, or not yet projected on cold start) is equally non-cancellable: its
 * in-flight state is unknown.
 */
export function isWorkflowRunCancellable(run: WorkflowRunState | undefined): boolean {
  return run?.status === "running";
}

/**
 * Resume availability. ONE source of truth: the projected run's `resumable` bit — computed
 * by the CLI on the `run-settled` payload with the SAME predicate as the resume gate (live
 * and cold replay mint through the same chain). The UI never re-derives it from
 * status + failureCode (two predicates drift: button lit, command denied).
 *
 * A run absent from the projection (evicted by the 8-run cap) is never resumable: better one
 * button fewer than a control whose click is guaranteed denied.
 */
export function isWorkflowRunResumable(run: WorkflowRunState | undefined): boolean {
  return run?.resumable === true;
}

type WorkflowRunResultView =
  /** Run not in the projection: no result to speak of. */
  | { kind: "absent" }
  /** pending / running: no result panel yet. */
  | { kind: "none" }
  /**
   * Completed. `preview` is ALWAYS absent at this stage — script artifacts live only in
   * `RunSettlement.artifact`, neither on the `run-settled` event (status and error only) nor
   * in the journal. Completion can only point at the session's background-result roll; never
   * fabricate a result view. The schema keeps the field; render it truthfully if ever filled.
   */
  | { kind: "completed"; preview?: string }
  /**
   * errored / stopped. `message` is the preformatted
   * text given by the projection (a plain string in the schema); `stopReason` is present only
   * for stopped when the projection carries it.
   */
  | {
      kind: "error";
      status: "errored" | "stopped";
      stopReason?: WorkflowRunStopReason;
      message?: string;
    };

export function workflowRunResultView(run: WorkflowRunState | undefined): WorkflowRunResultView {
  if (!run) return { kind: "absent" };
  if (run.status === "errored" || run.status === "stopped") {
    const stopReason = readWorkflowRunStopReason(run);
    return {
      kind: "error",
      status: run.status,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(run.error ? { message: run.error } : {}),
    };
  }
  if (run.status === "completed") {
    return { kind: "completed", ...(run.resultPreview ? { preview: run.resultPreview } : {}) };
  }
  return { kind: "none" };
}

/** One event-log input (= an entry of the v4 query result). */
export interface WorkflowRunEventItem {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
}

export interface WorkflowRunEventLine {
  sequence: number;
  type: string;
  /** Localized primary label. */
  label: string;
  /** Identity and data (site instance, actor name, log body, error text); never localized. */
  detail?: string;
  /** failed/cancelled coloring; everything else default (no new visual words beyond the overlay's four-value vocabulary). */
  tone: "default" | "failed";
  truncated?: boolean;
}

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{siteId, ordinal}` -> `site@ordinal` (same shape as the engine's refToString, for log cross-reference). */
function refText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { siteId, ordinal } = value;
  if (typeof siteId !== "string" || siteId.length === 0) return undefined;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
}

/** Non-empty string, else undefined (joinDetail drops it entirely rather than leaving an empty separator). */
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.message === "string" && value.message.length > 0 ? value.message : undefined;
}

function joinDetail(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A **short summary** of one report entry in the event log (not the Results panel's full preview).
 *
 * Deliberately flattened to one line in place: the event log is monospace one-entry-per-line; a
 * multiline JSON would blow it up into a second artifact view. The full form (string verbatim /
 * object pretty JSON) is computed CLI-side into `workflowRuns.reports[].preview`, and the Results
 * panel renders that.
 */
function reportItemSummary(item: unknown): string | undefined {
  if (item === undefined) return undefined;
  if (typeof item === "string") {
    return item.length > 0 ? truncate(item, UNKNOWN_PAYLOAD_MAX_LENGTH) : undefined;
  }
  try {
    const serialized = JSON.stringify(item);
    return serialized === undefined ? undefined : truncate(serialized, UNKNOWN_PAYLOAD_MAX_LENGTH);
  } catch {
    // The payload was already normalized JSON-serializable CLI-side; if it still fails here, never
    // take down a whole page of log.
    return undefined;
  }
}

/** Fallback for unknown kinds: type + truncated JSON. Neither crashes nor pretends to know it. */
function unknownDetail(payload: Record<string, unknown>): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    // The payload was already normalized JSON-serializable CLI-side; if it still fails here, one
    // log row must not take down the panel.
    return undefined;
  }
  if (serialized === undefined || serialized === "{}") return undefined;
  return truncate(serialized, UNKNOWN_PAYLOAD_MAX_LENGTH);
}

const EVENT_KEY_PREFIX = "chat.toolCall.workflow.run.event.";

/**
 * Engine event -> one readable line.
 *
 * The vocabulary follows the kinds the engine actually emits: run-started / actor-created /
 * node-queued / node-dispatched / node-repairing / node-nudged / node-settled / usage-updated / log /
 * import-cache-closed / report / escalation-raised / escalation-resolved / run-settled, plus the
 * adaptive-concurrency node-waiting / node-executing / concurrency-changed (the default branch
 * delegates to the sibling module first). The last two are emitted by the driver inside the ask
 * boundary (the engine core is unaware of escalations) but ride the exact same two rails, hence
 * grouped here. `payload` is the event object minus `type` (the run service's mapping contract), so
 * the reads below are the engine's field names -- no re-shaping.
 *
 * Every branch reads the shape defensively: payloads are bounded and deep fields may be trimmed;
 * one unreadable event must never take down the whole event log.
 */
export function workflowRunEventLines(
  events: readonly WorkflowRunEventItem[],
  formatMessage: FormatMessage,
): WorkflowRunEventLine[] {
  return events.map((event) => {
    const { payload } = event;
    const base = {
      sequence: event.sequence,
      type: event.type,
      ...(event.truncated ? { truncated: event.truncated as true } : {}),
    };
    const key = (suffix: string) => ({ id: `${EVENT_KEY_PREFIX}${suffix}` });

    switch (event.type) {
      case "run-started":
        // caps stay off this row: concurrency is not actionable information.
        return { ...base, label: formatMessage(key("runStarted")), tone: "default" };

      case "actor-created": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        return {
          ...base,
          label: formatMessage(key("actorCreated")),
          ...(joinDetail(name, refText(payload.actor)) === undefined
            ? {}
            : { detail: joinDetail(name, refText(payload.actor))! }),
          tone: "default",
        };
      }

      case "node-queued": {
        const kind = typeof payload.kind === "string" ? payload.kind : undefined;
        const detail = joinDetail(refText(payload.instance), kind);
        return {
          ...base,
          label: formatMessage(key("nodeQueued")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-dispatched":
      case "node-nudged": {
        const detail = refText(payload.instance);
        return {
          ...base,
          label: formatMessage(key(event.type === "node-nudged" ? "nodeNudged" : "nodeDispatched")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-repairing": {
        const attempt = typeof payload.attempt === "number" ? String(payload.attempt) : "?";
        const detail = refText(payload.instance);
        return {
          ...base,
          label: formatMessage(key("nodeRepairing"), { attempt }),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-settled": {
        const outcome =
          payload.outcome === "ok" ||
          payload.outcome === "failed" ||
          payload.outcome === "cancelled"
            ? payload.outcome
            : undefined;
        const outcomeLabel = outcome
          ? formatMessage({ id: `chat.toolCall.workflow.run.outcome.${outcome}` })
          : "";
        const detail = joinDetail(refText(payload.instance), errorMessage(payload.error));
        return {
          ...base,
          label: formatMessage(key(payload.cached === true ? "nodeSettledCached" : "nodeSettled"), {
            outcome: outcomeLabel,
          }),
          ...(detail === undefined ? {} : { detail }),
          // failed and cancelled differ semantically in the journal, but this row only needs "the step did not succeed".
          tone: outcome === "failed" || outcome === "cancelled" ? "failed" : "default",
        };
      }

      case "usage-updated": {
        // The event carries the spent total directly; the authoritative value is the usage line in the status header.
        const spentTokens =
          typeof payload.spentTokens === "number" ? payload.spentTokens : undefined;
        return {
          ...base,
          label: formatMessage(key("usageUpdated")),
          ...(spentTokens === undefined
            ? {}
            : { detail: `${spentTokens.toLocaleString()} tokens` }),
          tone: "default",
        };
      }

      case "log": {
        const message = typeof payload.message === "string" ? payload.message : undefined;
        return {
          ...base,
          label: formatMessage(key("log")),
          ...(message === undefined ? {} : { detail: message }),
          tone: "default",
        };
      }

      /** Control flow passed a `phase("…")` marker: name and entry ordinal (replay export reuses this formatter). */
      case "import-cache-closed": {
        // The amend-resume import cache closing: whose first write closed it.
        // detail = subagent name (when present) + instance; a world.run-closed door has no name, only the instance.
        const actorName = typeof payload.actorName === "string" ? payload.actorName : undefined;
        const detail = joinDetail(actorName, refText(payload.instance));
        return {
          ...base,
          label: formatMessage(key("importCacheClosed")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "phase-entered": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        const ordinal = typeof payload.ordinal === "number" ? payload.ordinal : 1;
        return {
          ...base,
          label: formatMessage(key("phaseEntered")),
          ...(name === undefined ? {} : { detail: ordinal >= 2 ? `${name} · ${ordinal}` : name }),
          tone: "default",
        };
      }

      /**
       * report and log are both fire-and-forget, but report **carries site identity**
       * (`report#N@k` into the journal), so the row includes the instance. The item body has its
       * own stage (the Results panel's full preview); this is a short summary only -- the event
       * log's job is "what the engine emitted, when", not a second artifact view.
       */
      case "report": {
        const detail = joinDetail(refText(payload.instance), reportItemSummary(payload.item));
        return {
          ...base,
          label: formatMessage(key("report")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      /**
       * Escalation Q&A: the actor hits a real blocker, escalates the question to the main agent,
       * and waits inside its own ask; once the main agent answers by qid it continues in place.
       *
       * Both rows lead with the **qid**, even though the raised row's protagonist is "who asked
       * what": qid is the only correlation key between the two events, which usually sit dozens of
       * rows apart in the log (waiting is the entire point of the feature). Without it, an
       * "answered" row cannot say which question above it resolved.
       *
       * Body truncated per the detail column's convention (same cap as the report summary): the
       * event log is one row per entry; the full question lives in the pending-questions section
       * above.
       */
      case "escalation-raised": {
        const question = typeof payload.question === "string" ? payload.question : undefined;
        // Without an actor name (anonymous actor), fall back to the site instance: the row would
        // rather say `actor#1@1` than not say who.
        const actorName = typeof payload.actorName === "string" ? payload.actorName : undefined;
        const detail = joinDetail(
          nonEmptyText(payload.qid),
          actorName ?? refText(payload.actor),
          question === undefined ? undefined : truncate(question, UNKNOWN_PAYLOAD_MAX_LENGTH),
        );
        return {
          ...base,
          label: formatMessage(key("escalationRaised")),
          ...(detail === undefined ? {} : { detail }),
          // Escalation is not failure: the actor did not err, it is waiting for an answer. Coloring
          // is reserved for rows that genuinely did not succeed.
          tone: "default",
        };
      }

      case "escalation-resolved": {
        const answer = typeof payload.answer === "string" ? payload.answer : undefined;
        const detail = joinDetail(
          nonEmptyText(payload.qid),
          answer === undefined ? undefined : truncate(answer, UNKNOWN_PAYLOAD_MAX_LENGTH),
        );
        return {
          ...base,
          label: formatMessage(key("escalationResolved")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "run-settled": {
        const status =
          typeof payload.status === "string" && payload.status.length > 0
            ? payload.status
            : undefined;
        const statusLabel = status
          ? formatMessage({ id: `chat.toolCall.workflow.run.status.${status}` })
          : "";
        const detail = errorMessage(payload.error);
        return {
          ...base,
          label: formatMessage(key("runSettled"), { status: statusLabel }),
          ...(detail === undefined ? {} : { detail }),
          tone: status === "errored" || status === "stopped" ? "failed" : "default",
        };
      }

      default: {
        // The four concurrency events (node-waiting / node-executing / concurrency-changed /
        // run-caps-changed) live in the sibling workflowRunThrottle.ts (max-lines gate).
        const concurrencyLine = workflowRunConcurrencyEventLine(event, formatMessage);
        if (concurrencyLine !== undefined) return concurrencyLine;
        // e.g. `compaction`, reserved by the engine for long-context compression (v1 never emits
        // it). When it appears, this must still produce an informative row, not a blank.
        const detail = unknownDetail(payload);
        return {
          ...base,
          label: formatMessage(key("unknown"), { type: event.type }),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }
    }
  });
}

// -- Transcript entry: step card -> actor instance --

/**
 * An openable actor instance.
 *
 * `siteId` + `ordinal` are the identity (the journal's key); `name` is display only. `sessionId` is
 * the real persisted session's id -- the only thing the nested read-only SessionPane needs.
 *
 * `sessionId` is **optional** (schema-optional): progress events can arrive before the actor session
 * persists, old runs may have none at all, and a not-yet-started slot never does. Absent-session
 * instances still open a tab -- the tab's identity is (runId, siteId, ordinal); the session id is
 * just the subscription target riding along, and without it the tab shows the "not started"
 * placeholder.
 */
export interface WorkflowActorInstance {
  siteId: string;
  ordinal: number;
  name?: string;
  sessionId?: string;
  status: WorkflowRunActor["status"];
}

// -- actor not-started gate --

/**
 * The three situations of an actor transcript tab relative to "does the session exist yet".
 *
 * `unknown` is not an error branch but the **most common long-lived state**: tabs are deliberately
 * never GC'd and outlive the 8-run projection eviction.
 */
type WorkflowActorStartState = "notStarted" | "started" | "unknown";

/** The identity an actor transcript tab hands the gate: slot plus the session id known at open time (optional). */
interface WorkflowActorSlotRef {
  runId: string;
  siteId: string;
  ordinal: number;
  actorSessionId?: string;
}

/** The gate's verdict: situation plus the session id to subscribe (absent = nothing to subscribe; the panel can only placeholder). */
interface WorkflowActorGate {
  state: WorkflowActorStartState;
  sessionId?: string;
}

/**
 * Slot -> has this actor started, and which session should be subscribed?
 *
 * Actor sessions are **lazily created**: the engine runs `createActorSession` only at the first ask
 * dispatch, so subscribing before that necessarily faults with `fault.subscribe.sessionNotFound`,
 * and the projection store stops at `error` awaiting manual retry -- a dead panel. This selector is
 * that gate.
 *
 * Race-free by construction: `createActorSession` awaits the session persist before the first
 * dispatch (the `workflow-driver.ts` ordering is pinned by tests), so **dispatched seen in the
 * projection => the session row exists => the subscription must hit**. Conversely `queued` does not
 * count as started: the persistence guarantee is pinned to pre-dispatch, and a queued node is no
 * evidence the session exists.
 *
 * Lookup by **(runId, siteId, ordinal)**: a tab can open before the actor appears (a not-started
 * pill), when there is no session id to reverse-lookup. Of the three values, the `unknown` vs
 * `notStarted` boundary is the one that matters:
 *
 * - Actor absent from the projection, tab **has** a session id -> `unknown`, **never blocked**. When
 *   the run was evicted by the 8-run cap or the projection is empty after cold recovery, direct
 *   subscription is the transcript's only path; blocking it seals off the finished run's only
 *   persistent view.
 * - Actor absent, tab has **no** session id -> `notStarted`: nothing to subscribe; the placeholder
 *   is honest (the script has not reached `agent()`; if the run was evicted, this slot indeed never
 *   started).
 * - Actor present with no non-`queued` node -> `notStarted`; any -> `started`, subscribing to the
 *   projection's session id with the tab's own as fallback. The gate reads the live projection, so
 *   the first node dispatch heals it.
 *
 * Documented exception: a resume's completed-hit short-circuit emits `node-settled` without
 * `ensureSession`, so that actor session may genuinely not exist. Settled opens the gate, the
 * subscription fails, and the existing error+retry panel takes over -- that really is "session not
 * found", for which the existing fallback is the correct answer.
 */
export function workflowActorStartState(
  runs: readonly WorkflowRunState[] | undefined,
  slot: WorkflowActorSlotRef,
): WorkflowActorGate {
  const run = runs?.find((candidate) => candidate.runId === slot.runId);
  const actor = run?.actors.find(
    (candidate) => candidate.siteId === slot.siteId && candidate.ordinal === slot.ordinal,
  );
  const sessionId = actor?.sessionId ?? slot.actorSessionId;
  const withSession = sessionId === undefined ? {} : { sessionId };
  if (run === undefined || actor === undefined) {
    return { state: sessionId === undefined ? "notStarted" : "unknown", ...withSession };
  }
  // Attribution compares `siteId` + `ordinal` (the journal's key): a wrong ordinal is another
  // instance, and world-read nodes lack both fields, so they never open the door for anyone.
  const started = run.nodes.some(
    (node) =>
      node.actorSiteId === actor.siteId &&
      node.actorOrdinal === actor.ordinal &&
      // `queued` is the only phase that does NOT prove the session exists. Take the complement
      // rather than enumerating dispatched/repairing/nudged/settled so future phases default to
      // open -- the same leaning as not blocking `unknown`.
      node.phase !== "queued",
  );
  return { state: started ? "started" : "notStarted", ...withSession };
}
