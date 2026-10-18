/**
  * scheduler.ts sat at oxlint's max-lines cap (400); Boundary B's two upward reports
  * (submit_result arrival, turn end) plus their repair / nudge budgets and submit normalization live here;
  * the public surface still exports from scheduler.ts.
 *
  * Free functions reach the scheduler's live node table and both settlement entries via {@link SubmitSeam}; on AskScheduler,
  * submitAttempted / turnEnded are thin delegates.
 */

import type { AskNode, SchedulerHost } from "./scheduler-types.js";
import type { InstanceRef, Violation } from "./types.js";
import { REPAIR_ATTEMPTS, WorkflowError } from "./types.js";

/** The minimal seam the report handlers get: look up live nodes, settle by result. */
export interface SubmitSeam {
  readonly host: SchedulerHost;
    /** Live node by instance (undefined once out of liveNodes). */
  liveNode(instance: InstanceRef): AskNode | undefined;
  settleOk(node: AskNode, artifact: unknown): void;
  settleFailed(node: AskNode, error: WorkflowError): void;
}

export function handleSubmitAttempted(
  seam: SubmitSeam,
  instance: InstanceRef,
  payload: unknown,
): void {
  const node = seam.liveNode(instance);
  if (node === undefined || node.settled) return;
    // Untyped asks provide no submit_result; even on receipt, never settle by it.
  if (!node.spec.typed) return;

  const { value, violations } = normalizeSubmit(seam.host, node.spec.schema, payload);
  if (violations.length === 0) {
    seam.host.driver.respondToSubmit(instance, { kind: "accept" });
    seam.settleOk(node, value);
    return;
  }
  if (node.repairsRemaining > 0) {
    node.repairsRemaining--;
    const attempt = REPAIR_ATTEMPTS - node.repairsRemaining;
    seam.host.driver.respondToSubmit(instance, { kind: "reject", violations });
    seam.host.record({ type: "node-repairing", instance, attempt, violations });
    return;
  }
  seam.host.driver.cancelAsk(instance);
  seam.settleFailed(
    node,
    new WorkflowError(
      "ValidationFailed",
      "submit_result failed schema validation repeatedly and the repair budget is exhausted.",
      { violations },
    ),
  );
}

/**
  * Lenient submit-payload normalization: validate the raw value first; only when it fails and is a string, one JSON.parse
  * then re-validate -- on success the parsed value wins (both the verdict and the journal).
 *
  * Field finding (GLM-5.3 via the Anthropic-compatible endpoint): real models often serialize submit_result's result parameter as a
  * JSON string (a quoted object) instead of a JSON object, so the validator correctly reports expected-object-got-string and
  * the run fails after 3 repairs. legacy script-workflow's parseStructuredResponse long tolerated this via lenient JSON parsing;
  * this adds the same tolerance, schema-aware:
  *   1. Raw value passes -> use it, never parse (a legal string result survives; under a string-or-null schema a quoted 42 stays a string).
  *   2. Raw fails and is a string -> a single JSON.parse (no recursion, no double parse; the legacy single-extraction precedent), revalidate, take the parsed value on pass.
  *   3. Otherwise -> raw value plus original violations, handed to the model for repair.
  * The engine is a pure package; JSON.parse is pure, deterministic, IO-free -- safe here.
 */
function normalizeSubmit(
  host: SchedulerHost,
  schema: unknown,
  payload: unknown,
): { value: unknown; violations: Violation[] } {
  const direct = host.validate(schema, payload);
  if (direct.length === 0) return { value: payload, violations: [] };
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      const after = host.validate(schema, parsed);
      if (after.length === 0) return { value: parsed, violations: [] };
            // Bug: when parsing succeeded but the parsed value still failed, the reported violations were the
            // pre-parse direct ones (expected object, got string) -- the model faces a decoded object it cannot repair, so it
            // re-quotes / double-encodes / degenerates to an empty object, exhausting the repair budget. Repair violations must describe
            // a value the model can change, hence after (path-level violations on the parsed object); the single-parse contract stands.
      return { value: parsed, violations: after };
    } catch {
            // Non-JSON string: JSON.parse throws; fall back to the raw-value violations for model repair.
    }
  }
  return { value: payload, violations: direct };
}

export function handleTurnEnded(seam: SubmitSeam, instance: InstanceRef, finalText: string): void {
  const node = seam.liveNode(instance);
  if (node === undefined || node.settled) return;
  if (!node.spec.typed) {
    seam.settleOk(node, finalText);
    return;
  }
  if (node.nudgesRemaining > 0) {
    node.nudgesRemaining--;
    seam.host.driver.respondToSubmit(instance, { kind: "nudge" });
    seam.host.record({ type: "node-nudged", instance });
    return;
  }
  seam.host.driver.cancelAsk(instance);
  seam.settleFailed(
    node,
    new WorkflowError(
      "ResultNotSubmitted",
      "The typed ask ended without a submit_result call, so there is no result.",
      { finalText },
    ),
  );
}
