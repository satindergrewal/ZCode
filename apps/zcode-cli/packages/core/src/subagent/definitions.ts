import { normalizeAgentProfiles, type AgentProfile } from "./profile.js";
import type { TraceContext } from "@zcode/contracts";

export interface AgentDefinitionsSnapshot {
  readonly activeAgents: readonly Readonly<AgentProfile>[];
}

/** Synchronously reads the published memory snapshot; load, override, and removal are the provider's job. */
export type GetAgentDefinitions = () => AgentDefinitionsSnapshot;

export type LoadAgentDefinitions = (input: {
  signal: AbortSignal;
  traceContext: TraceContext;
}) => Promise<AgentDefinitionsSnapshot>;

/** New-parent-context replacement snapshot; load failures finalize with the turn, never swallowing disconnect errors to keep requesting. */
export function createTurnAgentDefinitions(
  getInitial: GetAgentDefinitions,
  load?: LoadAgentDefinitions,
) {
  let snapshot: AgentDefinitionsSnapshot | undefined;
  return {
    get: (): AgentDefinitionsSnapshot => snapshot ?? getInitial(),
    async prepare(input: Parameters<LoadAgentDefinitions>[0]): Promise<void> {
      if (!load) return;
      const next = await load(input);
      input.signal.throwIfAborted();
      snapshot = structuredClone(next);
    },
  };
}

export function createAgentDefinitionsReader(
  profiles: readonly AgentProfile[],
  options: Parameters<typeof normalizeAgentProfiles>[1] = {},
): GetAgentDefinitions {
  const snapshot: AgentDefinitionsSnapshot = {
    activeAgents: normalizeAgentProfiles(profiles, options),
  };
  return () => snapshot;
}
