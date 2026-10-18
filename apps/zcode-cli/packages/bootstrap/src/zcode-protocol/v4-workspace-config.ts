// v4 workspace-config carries workspace presentation only; model candidates and preferences come from the target Host's
// ModelSelectionView, so a second model directory must never be built backwards from live Session settings.
import { getZCodeAgentModeSelectOptions, normalizeAvailableZCodeMode } from "@zcode/shared";
import type { ZCodeSessionSettingsState, ZCodeSlashCommand } from "@zcode/shared";
import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import { mapSessionSettings } from "./mapper.js";
import { listProtocolSlashCommands } from "./slash-commands.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Session settings project only the non-model workspace mode and slash commands. */
export function toV4WorkspaceConfigState(
  settings: ZCodeSessionSettingsState,
  slashCommands: readonly ZCodeSlashCommand[],
): WorkspaceConfigState {
  return {
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: normalizeAvailableZCodeMode(settings.mode.current),
        options: getZCodeAgentModeSelectOptions(),
      },
    ],
    slashCommands: slashCommands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.inputHint !== undefined ? { inputHint: command.inputHint } : {}),
      ...(command.source !== undefined ? { source: command.source } : {}),
    })),
  };
}

/**
 * Subscription seed: the live-session fast path only (mapSessionSettings reads the registered app directly).
 * Deliberately no temporary app -- during host startup warmup, reading workspace presentation with no active session
 * would create a temporary app whose MCP close stalls the protocol channel (see the desktop warmUpZCodeAgent comment).
 * With no registered session it returns null (empty catalog seed); the model selection catalog is provided by the Host's own
 * process Registry View, and this session protocol publishes task-level config only once a live session exists.
 */
export async function buildLiveWorkspaceConfigStateV4(
  context: ZCodeProtocolAgentServerContext,
  workspaceId: string,
): Promise<WorkspaceConfigState | null> {
  const record = Array.from(context.sessions.values()).find(
    (candidate) => candidate.workspace.workspaceKey === workspaceId,
  );
  if (!record) return null;
  const settings = await mapSessionSettings(record.app);
  const slashCommands = await listProtocolSlashCommands({
    // The rollout gate is Host-decided workspace-level state; catalog assembly reads the process cache.
    dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
    env: context.deps.env,
    logger: context.logger,
    workingDirectory: record.workspace.workspacePath,
  });
  return toV4WorkspaceConfigState(settings, slashCommands);
}
