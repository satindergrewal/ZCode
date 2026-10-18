// The workspace-config topic (v4 additive): liveness source of workspace-level config directories.
// Background: legacy protocol delivered provider registry / model-catalog hot updates via per-session `state.updated` (settings patch),
// which the host-side zcodeTaskIndexSyncer rebroadcast as workspace_config_options_update;
// the legacy session/subscribe + state.updated vocabulary carries no config directory, so everything moves to this topic.
// Semantics: conflated latest state (as sessions-index); payload = workspace config directory + slash-command directory.
// Workspace-level, not session-level--the session's current choice lives in the conversation topic's
// `config` (sessionConfigStateSchema); this topic's currentValue is the workspace default.
// Discipline: additive evolution--new topics / new optional fields legal; reshaping existing fields is not.
import { z } from "zod";

// Structurally aligned with the host-side ZCodeConfigSelectValue (zcode-task-types-core):
// the syncer forwards workspace_config_options_update with zero mapping, so downstream useZCodeConfig consumers stay untouched.
export const workspaceConfigSelectValueSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().optional(),
  // Value source: native model list or session-injected entry (UI dedupe and display control).
  origin: z.enum(["native", "injected"]).optional(),
  // Provider/group id owning this model option (provider -> grouped selection).
  modelProviderId: z.string().optional(),
  modelProviderName: z.string().optional(),
  // Absent = legacy payload/capability unknown; empty = the catalog known to have no selectable reasoning level.
  modelThoughtLevels: z.array(z.string()).optional(),
  modelDefaultThoughtLevel: z.string().optional(),
});
export type WorkspaceConfigSelectValue = z.infer<typeof workspaceConfigSelectValueSchema>;

// Aligned with the host-side ZCodeConfigOption (id: model / mode / thought_level / custom).
export const workspaceConfigOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(["select", "boolean"]),
  currentValue: z.union([z.string(), z.boolean()]),
  options: z.array(workspaceConfigSelectValueSchema).optional(),
});
export type WorkspaceConfigOption = z.infer<typeof workspaceConfigOptionSchema>;

// Slash-command catalog (workspace-level; aligned with the host-side ZCodeSlashCommand).
export const workspaceSlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputHint: z.string().optional(),
  source: z.enum(["builtin", "custom"]).optional(),
});
export type WorkspaceSlashCommand = z.infer<typeof workspaceSlashCommandSchema>;

// The topic payload: whole-replace semantics (conflated latest, never deep-merge--same discipline).
export const workspaceConfigStateSchema = z.object({
  configOptions: z.array(workspaceConfigOptionSchema),
  slashCommands: z.array(workspaceSlashCommandSchema),
});
export type WorkspaceConfigState = z.infer<typeof workspaceConfigStateSchema>;

export const workspaceConfigSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  workspaceId: z.string(),
  // Host-level config log generation (isomorphic to sessions-index's logEpoch, independent of it).
  logEpoch: z.string(),
  config: workspaceConfigStateSchema,
});
export type WorkspaceConfigSnapshot = z.infer<typeof workspaceConfigSnapshotSchema>;

// The delta set deliberately has one op: the config directory is small and whole-replace; no field-level deltas.
export const workspaceConfigDeltaSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("config.updated"), config: workspaceConfigStateSchema }),
]);
export type WorkspaceConfigDelta = z.infer<typeof workspaceConfigDeltaSchema>;

/** workspace-config topic key construction (dual of parseWorkspaceConfigTopic). */
export function workspaceConfigTopic(workspaceId: string): string {
  return `workspace-config/${workspaceId}`;
}

/** workspace-config topic key parse ("workspace-config/<workspaceId>"). */
export function parseWorkspaceConfigTopic(topic: string): string | null {
  if (!topic.startsWith("workspace-config/")) return null;
  const workspaceId = topic.slice("workspace-config/".length);
  return workspaceId.length > 0 ? workspaceId : null;
}
