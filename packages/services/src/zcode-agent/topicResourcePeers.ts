import type { IChannel } from "@zcode/rpc";
import { zcodeTopicResourceRelayRequestSchema } from "@zcode/shared";
import type { IZCodeAgentService } from "./zcodeAgent.js";
import { readTrustedZCodeAgentV4Connection } from "./zcodeAgentConnectionScope.js";

interface Peer {
  channel: IChannel;
  routes: Map<string, string>;
  closed: boolean;
}

/** The shared server only routes resource returns for authenticated connections; no task or queue state. */
export function createTopicResourcePeers() {
  const owners = new Map<string, Peer>();
  const key = (identity: string, session: string) => JSON.stringify([identity.trim(), session]);
  return {
    getChannel(value: unknown): IChannel {
      const request = zcodeTopicResourceRelayRequestSchema.parse(value);
      const peer = owners.get(key(request.workspaceIdentity, request.remoteSessionId));
      if (!peer || peer.closed) throw new Error("Topic resource source peer unavailable");
      return peer.channel;
    },
    attach(channel: IChannel) {
      const peer: Peer = { channel, routes: new Map(), closed: false };
      const bind = (value: unknown) => {
        // Disconnect only unregisters; the old facade still needs base unsubscribe/flow cleanup.
        if (peer.closed) return;
        // Public params never declare origin; only the carrier written by the connection facade may register a return route.
        if (!readTrustedZCodeAgentV4Connection(value)) return;
        const request = value as Record<string, unknown>;
        if (request.remoteSessionId === undefined) return;
        if (
          typeof request.remoteSessionId !== "string" ||
          !request.remoteSessionId ||
          typeof request.workspaceIdentity !== "string" ||
          !request.workspaceIdentity.trim()
        )
          throw new Error("Topic resource remote identity unavailable");
        const route = key(request.workspaceIdentity, request.remoteSessionId);
        const owner = owners.get(route);
        if (owner && owner !== peer)
          throw new Error("Topic resource route belongs to another peer");
        const previous = peer.routes.get(request.remoteSessionId);
        if (previous && previous !== route && owners.get(previous) === peer)
          owners.delete(previous);
        owners.set(route, peer);
        peer.routes.set(request.remoteSessionId, route);
      };
      return {
        wrapAgent(base: IZCodeAgentService): IZCodeAgentService {
          return new Proxy(base, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                bind(args[0]);
                return value.apply(target, args);
              };
            },
          });
        },
        dispose() {
          peer.closed = true;
          for (const route of peer.routes.values())
            if (owners.get(route) === peer) owners.delete(route);
          peer.routes.clear();
        },
      };
    },
  };
}
export type TopicResourcePeers = ReturnType<typeof createTopicResourcePeers>;
