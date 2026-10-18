// Rejection vocabularies and fault prefixes for dynamic-workflow commands; split out of command.ts (max-lines cap)
// and re-exported by command.ts so existing import paths keep working.
import { z } from "zod";

// startSavedWorkflow rejection reasons (docs/dynamic-workflow/launch.md, 'On the agent'):
// the bootstrap handler mints the fault code and the ui launcher maps it back to i18n copy; sharing this enum prevents drift.
// invalid_name / not_found: resolution; invalid_args: argument validation; compile_failed: analyzeScript diagnostics;
// session_busy: a turn is active; start_failed: any other failure before port.submit.
export const savedWorkflowStartRejectionReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "invalid_args",
  "compile_failed",
  "session_busy",
  "start_failed",
]);
export type SavedWorkflowStartRejectionReason = z.infer<
  typeof savedWorkflowStartRejectionReasonSchema
>;

// Full fault code = prefix + reason (e.g. fault.command.savedWorkflowStartRejected.not_found).
// Same namespace family as workflowRunResumeRejected; exported for bootstrap assembly and ui prefix matching.
export const SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX =
  "fault.command.savedWorkflowStartRejected." as const;

// resumeWorkflowRun rejections: prefix + port reason (not_found / not_resumable / superseded /
// already_running / script_missing / script_mismatch / compile_failed); `ack.message` carries the
// bounded compile_failed diagnostics (docs/dynamic-workflow/presentation.md, 'The run pane').
export const WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunResumeRejected." as const;
