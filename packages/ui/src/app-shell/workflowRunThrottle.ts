/**
 * Adaptive-concurrency observation surface for the dwf run detail page: the run header's
 * concurrency/cooldown readouts, plus event-log rows for `node-waiting` / `node-executing` /
 * `concurrency-changed` / `run-caps-changed`. The subagent badge is NOT here: it is a single
 * three-state word rendered directly from the protocol actor state.
 *
 * Display rules share event types with workflowRunPanel.ts but additionally record each state's
 * **first-received time** locally. The protocol carries only relative quantities (`cooldownMs` --
 * the engine has no clock), so the deadline can only be projected by the UI from "when this state
 * was first seen". Registration is by object identity (WeakMap): the reducer keeps the same object
 * reference while `concurrency` is unchanged; any replacement by a new event is a new object and
 * re-registers. It stays out of the protocol because it is a local observation, not an engine fact.
 */
import type { WorkflowRunConcurrency } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunEventItem, WorkflowRunEventLine } from "./workflowRunPanel.js";

const MS_PER_SECOND = 1_000;
const I18N_PREFIX = "chat.toolCall.workflow.run.";
const EVENT_KEY_PREFIX = `${I18N_PREFIX}event.`;

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/**
 * Throttle reason -> short-label i18n key (reason is an open string; only the known ones map
 * here, the rest fall into "transient error"). Completely unknown values render verbatim --
 * unrecognized never means hidden.
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

// -- received-at registry --

const concurrencyReceivedAt = new WeakMap<WorkflowRunConcurrency, number>();

function stamp<T extends object>(registry: WeakMap<T, number>, subject: T, now: number): number {
  const seen = registry.get(subject);
  if (seen !== undefined) return seen;
  registry.set(subject, now);
  return now;
}

// -- run header --

interface WorkflowRunConcurrencyView {
  /**
   * The chip's number: **effective** concurrency `min(cap, limit)` -- the shared bucket's cap
   * against this run's own limit, whichever is smaller. It answers how many subagents this run
   * can truly have in flight right now; which bound is binding is not the readout's question.
   */
  cap: number;
  ceiling: number;
  /** Cooldown deadline (epoch ms); absent when no cooldown or already expired. */
  cooldownUntil?: number;
}

/**
 * The run header's concurrency readout. Present only while **effective concurrency < ceiling**:
 * a run riding the ceiling has nothing to say. Cooldown projects the deadline from received-at
 * plus `cooldownMs` and drops out once expired -- the UI never shows a time already past.
 */
export function workflowRunConcurrencyView(
  concurrency: WorkflowRunConcurrency | undefined,
  now: number,
): WorkflowRunConcurrencyView | undefined {
  if (concurrency === undefined) return undefined;
  const effective = Math.min(concurrency.cap, concurrency.limit ?? concurrency.cap);
  if (effective >= concurrency.ceiling) return undefined;
  const view: WorkflowRunConcurrencyView = { cap: effective, ceiling: concurrency.ceiling };
  if (concurrency.cooldownMs !== undefined) {
    const until = stamp(concurrencyReceivedAt, concurrency, now) + concurrency.cooldownMs;
    if (until > now) view.cooldownUntil = until;
  }
  return view;
}

// -- event log --

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { siteId, ordinal } = value;
  if (typeof siteId !== "string" || siteId.length === 0) return undefined;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
}

/** Readout of the engine caps (`{ maxConcurrency }`); "?" when unreadable, same fallback as previous/next. */
function capsMaxConcurrency(value: unknown): string {
  if (!isRecord(value)) return "?";
  return typeof value.maxConcurrency === "number" ? String(value.maxConcurrency) : "?";
}

/**
 * The four concurrency events (node-waiting / node-executing / concurrency-changed /
 * run-caps-changed) -> event-log rows; other kinds return undefined (the main table's default
 * fallback handles them). Same discipline as the rest of workflowRunEventLines: read the payload
 * defensively; one unreadable event never takes down the page. All tones default: waiting is not
 * a failure, nor is a cap change -- the first three are the runtime self-regulating, the last is
 * the user tuning it.
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
    // node-waiting: cause=slot is queueing at the gate, nothing more to say; cause=backoff
    // carries the runner's backoff reason and duration -- the badge omits these details, the
    // event log is their only home.
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
    // run-caps-changed: the user changed this run's **own** bound while it is in flight
    // (effective in place, no new run). Kept as a separate row from the one above:
    // `concurrency-changed` is the governor squeezing the shared bucket (a provider-key matter);
    // this one is the user's decision. No detail -- it belongs to no provider key and no instance.
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
