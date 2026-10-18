// How lineage fields are read: the two narrow readers used when the reducer carries
// resumedFrom / supersededBy and stop reasons. A separate file because the reducer itself sits at
// oxlint's 400-line cap.

import { WORKFLOW_RUN_STOP_REASONS } from "./workflow-observation-display.js";
import type { WorkflowRunState } from "./workflow-runs.js";

/** A run id field on the payload: present only as a non-empty string. */
export function readRunIdField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Payload stop reason: outside the allowlist (new words legacy CLIs not knowing, or damaged payloads) reads as absent, never dropping the frame. */
export function readWorkflowRunStopReason(value: unknown): WorkflowRunState["stopReason"] {
  return typeof value === "string" &&
    (WORKFLOW_RUN_STOP_REASONS as readonly string[]).includes(value)
    ? (value as WorkflowRunState["stopReason"])
    : undefined;
}
