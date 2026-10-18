// ============================================================
// Runtime guard for the submit profile
// ============================================================
// A separate file: workflow-driver.ts is far past max-lines, and this piece only reads driver deps / sink / session state,
// unrelated to the rest of the state machine.
//
// The static profile is a derivation over the site graph's may-set; a typed ask landing on a mismatched session means the analysis was
// imprecise -- not the script's fault, and the run must not fail silently:
//   - `mono` but different schema: swap this session's submit_result back to the generic declaration and let the runtime recompute the tool surface;
//     the session then runs as generic (footer carries the full schema). Cost: one cache-prefix invalidation; correctness unaffected.
//   - `untyped`: this runtime has no submit port at all (the factory injected none for this profile) and there is no tool to swap back --
//     fail **this ask** with a DriverError naming the site, instead of letting it burn its nudges and die as
//     ResultNotSubmitted, dressing an analysis bug up as a model problem.

import { submitResultToolEntry } from "@zcode/core";
import {
  GENERIC_SUBMIT_PROFILE,
  canonicalJson,
  refToString,
  WorkflowError,
  type AskMessage,
  type InstanceRef,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/** Log event name for a static-profile/ask mismatch. */
const SUBMIT_PROFILE_MISMATCH_EVENT = "dynamic_workflow.submit_profile.mismatch";

/**
  * Makes the session's submit_result shape match this typed ask. false = the ask already failed and the caller must not
  * dispatch a turn. generic sessions and mono sessions with the same schema pass through untouched.
 */
export function ensureSubmitProfileFits(
  deps: AgentRuntimeWorkflowDriverDeps,
  sink: WorkflowReportSink,
  state: SessionState,
  instance: InstanceRef,
  message: AskMessage,
): boolean {
  const profile = state.submitProfile;
  if (profile.kind === "generic") return true;
  if (profile.kind === "mono" && canonicalJson(profile.schema) === canonicalJson(message.schema)) {
    return true;
  }
  if (profile.kind === "untyped") {
    sink.askFailed(
      instance,
      new WorkflowError(
        "DriverError",
        `Typed ask ${refToString(instance)} reached subagent session ${state.sessionId} whose static ` +
          `submit profile is "untyped" (no submit_result registered): the ask→actor analysis missed this ask.`,
      ),
    );
    return false;
  }
  deps.logger?.warn?.(
    "Dynamic workflow submit profile mismatch: falling back to the generic submit_result",
    {
      event: SUBMIT_PROFILE_MISMATCH_EVENT,
      module: "bootstrap.app",
      instance: refToString(instance),
      runId: deps.runId ?? "run",
      sessionId: state.sessionId,
    },
  );
    // Same registry, same name: register overwrites the typed entry, silently, because overwriting is the intent. The cache must be invalidated,
    // or getTools keeps sending the old typed declaration to the model.
  state.runtime.getToolRegistry().register(submitResultToolEntry, { silentDuplicateWarning: true });
  state.runtime.invalidateToolCache();
  state.submitProfile = GENERIC_SUBMIT_PROFILE;
  return true;
}
