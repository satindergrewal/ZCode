import type { AgentRuntimeInternal } from "../internal.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  OFF_PEAK_MUTATION_TOOL_NAMES,
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";

export function getTurnTools(runtime: AgentRuntimeInternal, state: RegularTurnLoopState) {
  const disallowed = buildTurnDisallowedTools(state);
  if (state.automationCreateLimitReached) return [];
  const tools = runtime.getTools(state.model);
  return disallowed ? tools.filter((tool) => !disallowed.has(tool.name)) : tools;
}

function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  const tools = new Set(state.toolDisallowlist ?? []);
  if (isAutomationMutationRestrictedTurn(state)) {
    // Why: a scheduled-task execution turn runs only the task prompt; it must not manage its own definition.
    // CronList stays for reads; mutations hide at the provider boundary.
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (isOffPeakCreateRestrictedTurn(state)) {
    // D49: idle execution turns may not create idle tasks (free-pool self-amplification); OffPeakList stays read-only.
    // Note automation execution turns do not enter this branch — cron turns allow OffPeakCreate per D49-3.
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? tools : null;
}
