// ============================================================
// Shared face of the workflow-run introspection tools (ListWorkflowRuns / GetWorkflowRun)
// ============================================================
//
// Three things must match verbatim, so they live here once, not per handler:
//
//   1. The capability-absent business failure. Port absent (journal down, no run service) and
//      port present but method missing (no introspection queries) are the same to the model: no such capability here.
//      Two tools, two probes, one wording.
//   2. Failure codes. `ToolHandlerFailure.errorCode` is a number (the executor-side
//      `isToolHandlerFailure` takes a number), so the two stable discriminators
//      (`workflow_introspection_unavailable` / `run_not_found`) ride the message prefix —
//      the only discriminator model and logs can read.
//   3. The async guidance. Both descriptions must say runs arrive automatically via artifact-bearing notifications;
//      divergent wording means two default behaviors for the model.

import { escapeXml } from "../../runtime-task/notification.js";
import type { ToolHandlerFailure } from "../types.js";

/**
 * Business failure codes. Numbers never reach the model (projected `code: "1"`); the discriminator is the message prefix.
 * The codes differ: absent capability and unknown run need separate handling.
 */
const WORKFLOW_RUN_INTROSPECTION_ERROR_CODE = {
  INTROSPECTION_UNAVAILABLE: 1,
  RUN_NOT_FOUND: 2,
} as const;

/**
 * No workflow-introspection capability in this session. **Never** a silent empty list: it merges never-ran-here
 * with cannot-read-here into one conclusion (as with the CreateWorkflow visible degradation).
 */
export function workflowIntrospectionUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: WORKFLOW_RUN_INTROSPECTION_ERROR_CODE.INTROSPECTION_UNAVAILABLE,
    message:
      "workflow_introspection_unavailable: this session cannot read workflow runs — workflow execution is not available here, so no run history is reachable. This is a capability gap, not an empty project.",
  };
}

export function workflowRunNotFoundFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: WORKFLOW_RUN_INTROSPECTION_ERROR_CODE.RUN_NOT_FOUND,
    message: `run_not_found: no workflow run with ID ${runId} exists for this project. Use ListWorkflowRuns to see the runs that do.`,
  };
}

/**
 * Async guidance shared by both descriptions.
 *
 * Not anti-polling — watching a live run on request is right; this sets the default only.
 */
export const WORKFLOW_RUN_INTROSPECTION_STEERING = [
  "Runs this session starts settle on their own: you receive a completion notification carrying the final output. Do NOT poll this tool while waiting for one — continue with other work.",
  "Reach for it when: (a) the user asks how a workflow is going, (b) you want to review this project's earlier runs, including ones other sessions started, (c) a completion notification was truncated and you need the run's full record by ID.",
].join("\n");

/**
 * epoch ms → ISO 8601 (UTC). Structured output keeps epoch ms (journal verbatim); the model face gets
 * ISO — readable age without mental math on 13 digits.
 *
 * Bad values (NaN / out of range) fall back to the raw number, no throw — one timestamp must not fail the result.
 */
export function formatWorkflowRunTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return String(epochMs);
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return String(epochMs);
  }
}

/** The duration ladder. Defined once, shared by summary and formatter — copies drift at the first tuning. */
const DURATION_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

function padTwo(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Milliseconds → human duration (`40s` / `5m 10s` / `2h 15m` / `3d 2h`).
 *
 * Two units only: readers want magnitude, not precision, and 1h-02m-03s invites digit-counting. Minutes and seconds pad
 * (same base-60 family; unpadded `1m 5s` vs `1m 50s` is hard to scan); hours under a day do not.
 * Non-finite and negative (clock skew) collapse to 0; a timestamp must never NaN the result.
 */
export function formatWorkflowRunDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (total < DURATION_MS.minute) return `${Math.floor(total / DURATION_MS.second)}s`;
  if (total < DURATION_MS.hour) {
    const minutes = Math.floor(total / DURATION_MS.minute);
    const seconds = Math.floor((total % DURATION_MS.minute) / DURATION_MS.second);
    return `${minutes}m ${padTwo(seconds)}s`;
  }
  if (total < DURATION_MS.day) {
    const hours = Math.floor(total / DURATION_MS.hour);
    const minutes = Math.floor((total % DURATION_MS.hour) / DURATION_MS.minute);
    return `${hours}h ${padTwo(minutes)}m`;
  }
  const days = Math.floor(total / DURATION_MS.day);
  const hours = Math.floor((total % DURATION_MS.day) / DURATION_MS.hour);
  return `${days}d ${hours}h`;
}

/**
 * How long ago. Absent or non-finite `at` returns `undefined` — readers omit the age entirely,
 * never 0 or unknown: timestamp-less journals have no age; that is a fact.
 */
export function formatRelativeAge(now: number, at: number | undefined): string | undefined {
  if (at === undefined || !Number.isFinite(at) || !Number.isFinite(now)) return undefined;
  return `${formatWorkflowRunDuration(now - at)} ago`;
}

/** Formats the ISO instant and relative age; age-unknown shows ISO only. */
export function formatWorkflowRunInstant(now: number, at: number): string {
  const age = formatRelativeAge(now, at);
  const iso = formatWorkflowRunTimestamp(at);
  return age === undefined ? iso : `${iso} (${age})`;
}

/**
 * Thousands separators. `toLocaleString` depends on host ICU, and every model-face character must be
 * pin-able verbatim, so the commas are inserted here.
 */
export function formatWorkflowRunCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.trunc(Math.abs(value)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/**
 * XML-ish attribute. Collapse whitespace, then escape: newlines in an attribute break one-run-per-row,
 * and the label is free text (user-named, or first script line).
 */
export function workflowRunAttribute(name: string, value: string | number | boolean): string {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : String(value);
  return `${name}="${escapeXml(text)}"`;
}

/**
 * Escaping **reuses** the runtime-task notification one (notification.ts): both are the same kind of
 * XML-ish model-face projection, and a copied escape table drifts at the first tweak.
 */
export { escapeXml as escapeWorkflowRunText };
