import type { IBotsService, ServiceCollection } from "@zcode/services";
import { createTopicResourceRelayChannel } from "@zcode/services/node";
import type { WindowHostAttachmentScope, ZCodeTopicResourceRelayRequest } from "@zcode/shared";

/** Reverse requests must belong to the physical connection that started them and stay bound to the current logical session; path equality alone is not enough. */
export function createWindowTopicResourceRelay(deps: {
  getPeerServices(): ServiceCollection | undefined;
  resolveServices(scope: WindowHostAttachmentScope): ServiceCollection;
  getBots(): IBotsService | undefined;
}) {
  const resolve = (
    request: Pick<
      ZCodeTopicResourceRelayRequest,
      "remoteSessionId" | "workspaceIdentity" | "workspacePath"
    >,
  ) => {
    const peer = deps.getPeerServices();
    if (
      !peer ||
      deps.resolveServices({
        kind: "remote",
        remoteSessionId: request.remoteSessionId,
        workspaceIdentity: request.workspaceIdentity,
        workspacePath: request.workspacePath,
      }) !== peer
    )
      throw new Error("Topic resource source connection mismatch");
    const bots = deps.getBots();
    if (!bots?.readTopicResource || !bots.validateTopicResource)
      throw new Error("Desktop topic resource service unavailable");
    return bots;
  };
  return createTopicResourceRelayChannel({
    reply: (request) => {
      if (!request.remoteSessionId || !request.workspaceIdentity)
        throw new Error("Remote channel reply scope missing");
      const bots = resolve({
        ...request,
        remoteSessionId: request.remoteSessionId,
        workspaceIdentity: request.workspaceIdentity,
      });
      if (!bots.replyToChannel) throw new Error("Bot channel reply unavailable");
      return bots.replyToChannel(request);
    },
    validate: (request, signal) => resolve(request).validateTopicResource!({ ...request, signal }),
    read: (request, signal) => resolve(request).readTopicResource!({ ...request, signal }),
  });
}
