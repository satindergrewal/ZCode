import type { DynamicWorkflowMode, RemoteTarget } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";

/**
 * Pushes the dynamic-workflow user choice to remote Hosts (docs/dynamic-workflow/launch.md "The user's choice").
 *
 * Desktop-attached remote Hosts (SSH/WSL/Docker) cannot read desktop settings, so only the desktop can push the choice: once when remote workspace services are created, and again to every online connection of this window when the local Host sees a change. A standalone server owns its settings and gets nothing. A per-connection failure (unknown method on old versions, dropped link) is reported only - other connections are unaffected and connection setup never blocks.
 */
export async function pushDynamicWorkflowUserModeToRemoteHosts(
  connections: ReadonlyArray<{
    target: RemoteTarget;
    zcodeAgentService: Pick<IZCodeAgentService, "syncDynamicWorkflowUserMode">;
  }>,
  mode: DynamicWorkflowMode | undefined,
  onError: (error: unknown) => void,
): Promise<void> {
  await Promise.all(
    connections
      .filter((connection) => connection.target.kind !== "server")
      .map(async (connection) => {
        try {
          await connection.zcodeAgentService.syncDynamicWorkflowUserMode(mode ? { mode } : {});
        } catch (error) {
          onError(error);
        }
      }),
  );
}
