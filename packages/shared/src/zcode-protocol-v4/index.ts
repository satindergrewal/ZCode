// ZCode Protocol v4 -- the data-model draft.
//
// Package discipline: schema types + pure functions only
 //(coalesce/conflation/apply); runtime (channel buffering, subscription registries, scheduling) never enters this package.
// Coexists with the legacy packages/shared/src/zcode-protocol.
export * from "./core.js";
export * from "../background-bash-output.js";
export * from "./rows.js";
export * from "./toolDisplay.js";
export * from "./create-workflow-display.js";
export * from "./workflow-observation-display.js";
export * from "./snapshot.js";
export * from "./workflow-runs.js";
export * from "./workflow-runs-reducer.js";
// Key-level deltas of workflowRuns (diff / apply / canonical key order); the ops themselves in delta.ts.
export * from "./workflow-runs-delta.js";
// What the caps leave behind: rejected-instance counters, the entry budget, step readings; table-full eviction; and legacy-consumer clipping.
export * from "./workflow-runs-caps.js";
export * from "./workflow-runs-eviction.js";
export * from "./workflow-runs-tables.js";
export * from "./workflow-runs-legacy.js";
export * from "./workflow-artifact.js";
// One s different from the line above, two different artifacts: singular = serialization of the engine-internal "script top-level return";
// plural = what the script published to users via `artifact.*`. See workflow-artifacts.ts' header.
export * from "./workflow-artifacts.js";
// The workspace transcript (replay of files.* / git.* / world.run).
export * from "./workflow-workspace.js";
export * from "./attachment-ref.js";
export * from "./attachment-faults.js";
export * from "./delta.js";
export * from "./coalesce.js";
export * from "./profiles.js";
export * from "./apply.js";
export * from "./transport.js";
export * from "./wire.js";
export * from "./wire-codec.js";
export * from "./wire-reassembly.js";
export * from "./wire-assembler.js";
export * from "./wire-fault.js";
export * from "./sessions-index.js";
export * from "./sessions-index-workflow-activity.js";
export * from "./workspace-config.js";
export * from "./command.js";
export * from "./workflow-run-settings-command.js";
export * from "./shared-context-ref.js";
export * from "./shared-context-import.js";
export * from "./input-intent.js";
export * from "./submission.js";
export * from "./fork.js";
export * from "./telemetry.js";
export * from "./controller.js";
export * from "./workspace-hook-review.js";
export * from "./cuaPermission.js";

export {
  executionOutputPreviewSchema,
  type ExecutionOutputPreview,
} from "../execution-output-preview.js";

export { bashOutputDisplaySchema } from "../bash-output-display.js";
export { modelSelectionSchema, type ModelSelection } from "../model-selection.js";

export * from "../localTtft.js";
