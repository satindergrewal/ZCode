/**
 * The adaptive-concurrency observation surface for the dwf run detail page
 * (docs/dynamic-workflow/concurrency.md "Protocol and UI"): the run header's concurrency/cooldown
 * readouts plus event log rows for `node-waiting` / `node-executing` / `concurrency-changed` /
 * `run-caps-changed`. The subagent badge is NOT here: it is a single three-state word (decision 39),
 * rendered straight from the protocol actor state.
 *
 * Display rules share event types with workflowRunPanel.ts and additionally record each state's
 * first-seen timestamp locally. The protocol carries only relative quantities (`cooldownMs`, the engine
 * has no clock), so the deadline can only be derived by the UI from when the state was first seen.
 * Registration is by object identity (WeakMap): the reducer keeps the same object while `concurrency`
 * is unchanged; any new event replaces it with a fresh object and re-registers. Kept out of the protocol
 * because it is a local observation, not an engine fact.
 */
import type { WorkflowRunConcurrency, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { isWorkflowRunConfigurable } from "@/components/workflow-timeline/workflowRunSettings.js";
import type { WorkflowRunEventItem, WorkflowRunEventLine } from "./workflowRunPanel.js";

const MS_PER_SECOND = 1_000;
const I18N_PREFIX = "chat.toolCall.workflow.run.";
const EVENT_KEY_PREFIX = `${I18N_PREFIX}event.`;

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/**
 * Throttle reason to short-label i18n key (reason is an open string; only the known kinds are mapped,
 * the rest fold into transient-error; fully unknown values render verbatim, unrecognized is not hidden).
 */
const REASON_LABEL_KEY: Readonly<Record<string, string>> = {
  rate_limited: "throttle.reason.rateLimited",
  provider_overloaded: "throttle.reason.overloaded",
  offpeak_queued: "throttle.reason.offpeak",
  server_error: "throttle.reason.transient",
  network_error: "throttle.reason.transient",
  timeout: "throttle.reason.transient",
  stream_idle_timeout: "throttle.reason.transient",
  stale_connection: "throttle.reason.transient",
  proxy_error: "throttle.reason.transient",
};

export function throttleReasonLabel(reason: string, formatMessage: FormatMessage): string {
  const key = REASON_LABEL_KEY[reason];
  return key === undefined ? reason : formatMessage({ id: `${I18N_PREFIX}${key}` });
}

// ── First-seen registration ──

const concurrencyReceivedAt = new WeakMap<WorkflowRunConcurrency, number>();

function stamp<T extends object>(registry: WeakMap<T, number>, subject: T, now: number): number {
  const seen = registry.get(subject);
  if (seen !== undefined) return seen;
  registry.set(subject, now);
  return now;
}

// ── Run header ──

interface WorkflowRunConcurrencyView {
  /**
   * The number on the chip: the effective bound `min(cap, limit ?? D)` (docs/dynamic-workflow/concurrency.md
   * "Two bounds on a run"), the smaller of the shared bucket's cap and this run's own bound. It is a ceiling,
   * not the in-flight count (hence the chip reads max concurrency); which bound binds is not the readout's question.
   */
  cap: number;
  ceiling: number;
  /** Cooldown deadline (epoch ms); absent when cooling or expired. */
  cooldownUntil?: number;
}

/**
 * The run header's concurrency readout (docs/dynamic-workflow/concurrency.md "What the user sees").
 * `ceiling` is the default concurrency D, a reference line not a cap: this run's bound is `limit ?? D` and the
 * readout is `min(cap, bound)`. Present iff one of: the shared bucket presses the run below its own bound
 * (`effective < bound`), or the run has its own bound (`bound != D`, above or below, a run raised above the
 * default must still show its bound). A run riding the default with shared cap at or above D has nothing to
 * say; same if the shared cap grows past D, the min is still D.
 * Cooldown deadline = first-seen time + `cooldownMs`; absent once expired. The UI never shows a time already past.
 */
export function workflowRunConcurrencyView(
  concurrency: WorkflowRunConcurrency | undefined,
  now: number,
): WorkflowRunConcurrencyView | undefined {
  if (concurrency === undefined) return undefined;
  const bound = concurrency.limit ?? concurrency.ceiling;
  const effective = Math.min(concurrency.cap, bound);
  if (effective >= bound && bound === concurrency.ceiling) return undefined;
  const view: WorkflowRunConcurrencyView = { cap: effective, ceiling: concurrency.ceiling };
  if (concurrency.cooldownMs !== undefined) {
    const until = stamp(concurrencyReceivedAt, concurrency, now) + concurrency.cooldownMs;
    if (until > now) view.cooldownUntil = until;
  }
  return view;
}

/**
 * The run header's concurrency chip: readout present AND the run configurable (docs/dynamic-workflow/
 * concurrency.md "What the user sees"). The chip speaks for one bound and Configure edits that bound, so
 * they appear and disappear together.
 *
 * Fix: the old chip keyed on the readout alone; on completed runs `cap`/`limit` survive the reducer
 * untouched (terminal states only drop cooldown), so an idle run kept showing concurrency 4 like a live
 * gauge. A completed run has nothing left running under the bound and a superseded run's bound belongs to
 * its successor; stopped/errored keep it because resume or retry still runs under that bound.
 */
export function workflowRunConcurrencyChip(
  run: WorkflowRunState | undefined,
  now: number,
): WorkflowRunConcurrencyView | undefined {
  if (!isWorkflowRunConfigurable(run)) return undefined;
  return workflowRunConcurrencyView(run?.concurrency, now);
}

// ── Event log ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { siteId, ordinal } = value;
  if (typeof siteId !== "string" || siteId.length === 0) return undefined;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
}

/** Readout of engine caps (`{ maxConcurrency }`); renders ? when unreadable, same fallback as previous/next. */
function capsMaxConcurrency(value: unknown): string {
  if (!isRecord(value)) return "?";
  return typeof value.maxConcurrency === "number" ? String(value.maxConcurrency) : "?";
}

/**
 * The four concurrency events (node-waiting / node-executing / concurrency-changed / run-caps-changed) to
 * event log rows; other kinds return undefined (the main table's default fallback). Same discipline as the
 * rest of workflowRunEventLines: defensive payload reads, one unreadable event never takes down the page.
 * All tone default: waiting is not failure, nor is a cap change, the first three are the runtime self-tuning,
 * the last is the user tuning it.
 */
export function workflowRunConcurrencyEventLine(
  event: WorkflowRunEventItem,
  formatMessage: FormatMessage,
): WorkflowRunEventLine | undefined {
  const { payload } = event;
  const base = {
    sequence: event.sequence,
    type: event.type,
    ...(event.truncated ? { truncated: event.truncated as true } : {}),
    tone: "default" as const,
  };
  const withDetail = (label: string, detail: string | undefined): WorkflowRunEventLine => ({
    ...base,
    label,
    ...(detail === undefined ? {} : { detail }),
  });
  switch (event.type) {
    // node-waiting: cause=slot is queueing at the gate, nothing more to say; cause=backoff carries the
    // runner's backoff reason and duration. The badge hides these details; the event log is their only home.
    case "node-waiting": {
      if (payload.cause !== "backoff") {
        return withDetail(
          formatMessage({ id: `${EVENT_KEY_PREFIX}nodeWaitingSlot` }),
          refText(payload.instance),
        );
      }
      const reason =
        typeof payload.reason === "string"
          ? throttleReasonLabel(payload.reason, formatMessage)
          : "?";
      const seconds =
        typeof payload.delayMs === "number"
          ? String(Math.ceil(payload.delayMs / MS_PER_SECOND))
          : "?";
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}nodeWaitingBackoff` }, { reason, seconds }),
        refText(payload.instance),
      );
    }
    case "node-executing":
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}nodeExecuting` }),
        refText(payload.instance),
      );
    case "concurrency-changed": {
      const previous = typeof payload.previous === "number" ? String(payload.previous) : "?";
      const next = typeof payload.next === "number" ? String(payload.next) : "?";
      const key =
        typeof payload.key === "string" && payload.key.length > 0 ? payload.key : undefined;
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}concurrencyChanged` }, { previous, next }),
        key,
      );
    }
    // run-caps-changed: the user changed THIS run's own bound while in flight (in-place, no new run).
    // Kept as a separate row from the above: `concurrency-changed` is the governor squeezing the shared
    // bucket (provider-key business), this one is the user's decision. No detail: it belongs to no
    // provider key and no instance.
    case "run-caps-changed":
      return withDetail(
        formatMessage(
          { id: `${EVENT_KEY_PREFIX}runCapsChanged` },
          {
            previous: capsMaxConcurrency(payload.previous),
            next: capsMaxConcurrency(payload.caps),
          },
        ),
        undefined,
      );
    default:
      return undefined;
  }
}
