import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
  resolveSubagentRuntimeProfiles,
  type SubagentRuntimeState,
  type SubagentRuntimeConfig,
} from "@zcode/shared";

/** The standalone CLI disk loader reuses the shared pure parser, preserving the file-config provenance. */
export function parseRuntimeSubagentConfig(configuration: {
  documents: { content: string; path: string; source: "user" | "project" }[];
  state: SubagentRuntimeState;
}) {
  const profiles: AgentProfile[] = [];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  for (const document of configuration.documents) {
    const result = parseAgentProfileFromMarkdown(document);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
    if (!result.profile) continue;
    profiles.push(result.profile);
  }
  return {
    ...resolveSubagentRuntimeProfiles(profiles, configuration.state),
    diagnostics,
  };
}

/** The Host has pure-parsed already; fallback must not mix in old templates or disk overrides. */
export function subagentProfilesFromSnapshot(snapshot: SubagentRuntimeConfig) {
  return snapshot.kind === "ready"
    ? snapshot
    : {
        profiles: [],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      };
}
