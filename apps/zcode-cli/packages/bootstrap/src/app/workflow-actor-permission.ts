// ============================================================
// The workflow actor's permission face (launching-session mode -> run record -> AgentRuntime mode)
// ============================================================
// See docs/dynamic-workflow/launch.md "Permissions inside a run".
//
// Subagents run under the launching session's permission mode (plan not carried: a run is always executing). When asking, the parent-runtime-derived
// broker to ask the user. The mode is fixed at run creation, recorded on `run-launched`, read back by resume — later
// session mode changes never touch an in-flight run. Absent or unknown means YOLO: pre-feature runs and hosts without mode reads as before.
// Sister module of workflow-actor-tools.ts / workflow-actor-model.ts on the same seam, all expanded by the driver
// side's runtime factory expands when building the AgentRuntime.

import type { CollaborationMode } from "@zcode/contracts";
import { refToString, type ActorRef, type PersonaSpec } from "@zcode/dynamic-workflow";

/** The subagent permission mode recorded on the run: the session's base mode, plan excluded. */
export type WorkflowSubagentPermissionMode = Exclude<CollaborationMode, "plan">;

/** Values honored from the journal; the engine treats them as opaque strings, validated against this table on read. */
const RECORDABLE_MODES: ReadonlySet<string> = new Set<WorkflowSubagentPermissionMode>([
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
]);
/** Subagent mode when nothing is recorded: matches every run from before the feature. */
const UNRECORDED_MODE = "yolo" satisfies CollaborationMode;
/** Placeholder in interaction attribution when the persona has no name. */
const ANONYMOUS_ACTOR_NAME = "subagent";

/**
 * The launching session's mode -> the subagent mode the run records. `getMode()` is the base mode (plan is a separate
 // switch, not included); the legacy `plan` enum maps to build, matching plain subagents' post-split fallback.
 */
export function workflowSubagentPermissionModeOf(
  sessionMode: CollaborationMode | undefined,
): WorkflowSubagentPermissionMode | undefined {
  if (sessionMode === undefined) return undefined;
  return sessionMode === "plan" ? "build" : sessionMode;
}

/**
 * The same mapping lands as an optional key on `run-launched` / RunLaunch: when the host reports no mode the key is
 // absent, not undefined-valued (like the rest of run-launched's optional cargo).
 */
export function workflowSubagentPermissionModeField(sessionMode: CollaborationMode | undefined): {
  subagentPermissionMode?: WorkflowSubagentPermissionMode;
} {
  const mode = workflowSubagentPermissionModeOf(sessionMode);
  return mode === undefined ? {} : { subagentPermissionMode: mode };
}

/**
 * Journal raw value -> subagent permission mode. Unknown values (newer writers' modes, corrupted events) read as absent,
 // i.e. YOLO: an old version never guesses the semantics of a mode it does not know.
 */
export function parseWorkflowSubagentPermissionMode(
  raw: unknown,
): WorkflowSubagentPermissionMode | undefined {
  return typeof raw === "string" && RECORDABLE_MODES.has(raw)
    ? (raw as WorkflowSubagentPermissionMode)
    : undefined;
}

/** The AgentRuntimeConfig permission slice. */
interface WorkflowActorPermissionPolicy {
  mode: CollaborationMode;
}

/** Run-recorded mode -> actor runtime mode; absent means YOLO. */
export function workflowActorPermissionPolicy(
  subagentPermissionMode: WorkflowSubagentPermissionMode | undefined,
): WorkflowActorPermissionPolicy {
  return { mode: subagentPermissionMode ?? UNRECORDED_MODE };
}

/**
 // The `description` on the interaction request's origin: `<persona name> (<siteId>@<ordinal>)`. The permission dialog's source badge
 // names the asking subagent with it; same-named personas disambiguate by instance coordinates.
 */
export function workflowActorInteractionDescription(input: {
  actor: ActorRef;
  persona: Pick<PersonaSpec, "name">;
}): string {
  return `${input.persona.name ?? ANONYMOUS_ACTOR_NAME} (${refToString(input.actor)})`;
}
