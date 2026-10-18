// Bridge from session events to the workflowRuns mirror (the dwf case in app-events.ts calls just this function).
//
// Two reasons for a dedicated module: keep contracts payload types here so app-workflow-mirror.ts keeps its
// "depend on @zcode/shared only" discipline (same stance as shared reducers never depending back on contracts);
// and keep app-events.ts's switch within max-lines.
import type { DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { applyWorkflowProgressToMirror, type TuiWorkflowMirror } from "./app-workflow-mirror.js";

export type WorkflowMirrorSetter = (
  updater: (current: TuiWorkflowMirror) => TuiWorkflowMirror,
) => void;

/**
 * Reduce one `dynamic_workflow_run_progress` event into the mirror.
 *
 * The bootstrap counterpart is `onDynamicWorkflowRunProgress` -- both call the **same** shared reducer, so TUI and
 * desktop cannot derive different state from the same event stream.
 */
export function applyWorkflowProgressEvent(
  payload: unknown,
  setWorkflowMirror?: WorkflowMirrorSetter,
): void {
  if (!setWorkflowMirror) return;
  // Cast to the bounded contracts payload first, then assign into the shared structured input: this assignment is the
  // compile-time gate against shape drift (same stance as bootstrap's v4 projection).
  const envelope: WorkflowRunProgressEnvelope = payload as DynamicWorkflowRunProgressPayload;
  // With no change, applyWorkflowProgressToMirror returns the same reference, so React skips the re-render:
  // the shared reducer's "null = no semantic change" is, UI-side, simply "no repaint".
  setWorkflowMirror((current) => applyWorkflowProgressToMirror(current, envelope));
}
