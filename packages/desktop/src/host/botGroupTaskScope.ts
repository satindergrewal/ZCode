import type { WindowHostAttachmentScope } from "@zcode/shared";

/** Group control reuses the verified attachment; RPC callers may not declare another remote session. */
export function bindBotGroupTaskScope<T extends object>(
  params: T,
  scope: WindowHostAttachmentScope,
): T {
  return scope.kind === "local"
    ? params
    : {
        ...params,
        workspacePath: scope.workspacePath,
        workspaceIdentity: scope.workspaceIdentity,
        remoteSessionId: scope.remoteSessionId,
      };
}
