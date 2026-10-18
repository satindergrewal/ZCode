// ============================================================
// amendWorkflowRunSettings: change two of a run's settings from the GUI
// ============================================================
// Split from command.ts (max-lines gate): payload, accepted result, and rejection vocabulary belong to one command;
// bootstrap mints the fault code, the UI looks up copy -- one shared vocabulary prevents drift.

import { z } from "zod";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";

/**
 * Command payload. Both settings follow the tool three-state rule: omitted = keep, `null` = back to default (session model / default concurrency),
 * value = set. The GUI sends only changed keys. No baseRevision: same family as cancelBackgroundWork /
 * resumeWorkflowRun (the workflowRuns surface is revision-free).
 */
export const amendWorkflowRunSettingsPayloadSchema = z.object({
  /** = runId; the same identity equation as cancel and resume. */
  workId: z.string(),
  /** Spec string `providerId/modelId[$level]`; `null` = the subagent back on the session model. */
  subagentModel: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength)
    .nullable()
    .optional(),
  /** Max concurrent subagents; `null` = lift this run's own bound (back to default concurrency). No cap: above default allowed. */
  maxConcurrency: z.number().int().min(1).nullable().optional(),
});
export type AmendWorkflowRunSettingsPayload = z.infer<typeof amendWorkflowRunSettingsPayloadSchema>;

/**
 * The accepted ACK result. `runId` / `toolCallId` point at the **new** run (toolCallId = `settings-<uuid>`, joining
 * the amend turn's run card and detail page); `supersededRunId` appears only when the old run was live and got stopped.
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
 * is the command's own check, missing_boundaries the port precheck, start_failed a missing or throwing port.
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

/** Full fault code = prefix + reason; same family as workflowRunResumeRejected. */
export const WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunSettingsRejected." as const;
