import { MessagePortProtocol, ChannelClient } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import { isRendererProductionBuild } from "./rendererLoggingEnv.js";

function logMessagePortDebug(message: string): void {
  // In production builds, renderer connection logs are silenced to avoid synchronous
  // console cost on window startup and reconnection paths.
  if (isRendererProductionBuild()) {
    return;
  }
  console.log(message);
}

export interface MessagePortServiceConnection {
  services: IServiceAccessor;
  dispose: (reason?: Error) => void;
}

/**
 * Creates a MessagePort service connection with an explicit lifecycle.
 *
 * When a scoped remote session is replaced, both the ChannelClient and the underlying port
 * must be released; otherwise pending RPCs on the old attachment never settle and keep
 * occupying upstream deduplication state.
 */
export function createMessagePortServiceConnection(
  port: MessagePort,
): MessagePortServiceConnection {
  logMessagePortDebug("[messageport] creating protocol and client...");
  const protocol = new MessagePortProtocol(port);
  const client = new ChannelClient(protocol);
  client.onDidInitialize(() => {
    logMessagePortDebug("[messageport] ChannelClient received Initialize from server");
  });
  logMessagePortDebug("[messageport] client created, waiting for Initialize...");

  const services = new RemoteServiceAccess(client);
  let disposed = false;
  return {
    services,
    dispose: (reason?: Error) => {
      if (disposed) {
        return;
      }
      disposed = true;
      client.dispose(reason);
      protocol.disconnect();
    },
  };
}

/**
 * Connect to services over a MessagePort.
 *
 * In desktop mode the utilityProcess (or the main process's remote proxy) exposes the
 * ChannelServer over a MessagePort; the renderer calls this to establish the ChannelClient.
 */
export function connectViaMessagePort(port: MessagePort): IServiceAccessor {
  return createMessagePortServiceConnection(port).services;
}
