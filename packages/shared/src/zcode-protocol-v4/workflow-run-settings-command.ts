// ============================================================
// amendWorkflowRunSettings: change two run settings from the GUI
// ============================================================
// Split out of command.ts (max-lines gate): payload, accepted result, and rejection vocabulary belong to one command;
// bootstrap mints the fault code and the UI looks up copy, both sharing this vocabulary to avoid drift.

import { z } from "zod";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";

/**
 * Command payload. Both settings follow the tool's same three-state rule: omitted = keep, `null` = back to default (session model / host cap),
 * value = set. The GUI sends only changed fields. Deliberately no baseRevision: kin of cancelBackgroundWork /
 // resumeWorkflowRun (the workflowRuns surface is revision-free).
 */
export const amendWorkflowRunSettingsPayloadSchema = z.object({
  /// Same identity equation as runId for cancel/resume.
  workId: z.string(),
  /// Canonical `providerId/modelId[$level]` string; `null` = subagents back to the session model.
  subagentModel: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength)
    .nullable()
    .optional(),
  /// Subagent concurrency cap; `null` = lift this run's own bound (back to the host cap). The agent clamps to [1, ceiling].
  maxConcurrency: z.number().int().min(1).nullable().optional(),
});
export type AmendWorkflowRunSettingsPayload = z.infer<typeof amendWorkflowRunSettingsPayloadSchema>;

/**
 * Result of the accepted ACK. `runId` / `toolCallId` point at the **new** run (toolCallId = `settings-<uuid>`,
 // joining the settings round's run card and detail page); `supersededRunId` appears only when the old run was still in flight and stopped by this change.
 */
export const amendWorkflowRunSettingsResultSchema = z.object({
  type: z.literal("amendWorkflowRunSettings"),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  supersededRunId: z.string().min(1).optional(),
});

/**
 * Rejection vocabulary. Every rejection happens before stopping or creating anything:
 * not_found / not_configurable / unchanged / script_missing / model_unavailable / compile_failed
 // invalid_* are the command's own checks, missing_boundaries the port precheck, start_failed a missing or throwing port.
 */
export const workflowRunSettingsRejectionReasonSchema = z.enum([
  "not_found",
  "not_configurable",
  "unchanged",
  "script_missing",
  "model_unavailable",
  "compile_failed",
  "missing_boundaries",
  "start_failed",
]);
export type WorkflowRunSettingsRejectionReason = z.infer<
  typeof workflowRunSettingsRejectionReasonSchema
>;

/** Full fault code = prefix + reason; kin of workflowRunResumeRejected. */
export const WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunSettingsRejected." as const;
