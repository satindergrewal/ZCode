import type {
  WebRemoteControlExternalWorkspaceBridge,
  WebRemoteControlWorkspaceBridge,
} from "@zcode/shared";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
  type RemoteWorkspaceSession,
} from "@zcode/ui/remote-workspace-session-store";

type WebRemoteControlBridgeWithRemoteSession =
  | WebRemoteControlExternalWorkspaceBridge
  | WebRemoteControlWorkspaceBridge;

export interface WebRemoteControlWorkspaceBridgeServiceRegistration {
  dispose: () => void;
}

export function registerWebRemoteControlWorkspaceBridgeServices(params: {
  bridge: WebRemoteControlBridgeWithRemoteSession;
  services: RemoteWorkspaceSession["services"];
}): WebRemoteControlWorkspaceBridgeServiceRegistration {
  const { bridge, services } = params;
  if (bridge.kind !== "remote") {
    return { dispose: () => {} };
  }

  // Bugfix: the phone web relay bridge connected to the host but never entered the remote session store.
  // Hooks then miss the session by workspaceIdentity and fall through to the disconnected proxy with ZCODE_REMOTE_WORKSPACE_DISCONNECTED.
  registerRemoteWorkspaceSession({
    sessionId: bridge.remoteSessionId,
    services,
  });
  bindRemoteWorkspaceIdentity(bridge.workspaceIdentity, bridge.remoteSessionId);
  bindRemoteWorkspacePath(bridge.workspacePath, bridge.remoteSessionId);

  return {
    dispose: () => {
      // Bugfix: hard recovery rebuilds the bridge for the same SSH session, remoteSessionId possibly unchanged.
      // When the old bridge disposes after the new one registers, sessionId-only cleanup would drop the new services
      // and identity/path maps, later misread as ZCODE_REMOTE_WORKSPACE_DISCONNECTED.
      if (getRemoteWorkspaceSession(bridge.remoteSessionId)?.services !== services) {
        return;
      }
      unregisterRemoteWorkspaceSession(bridge.remoteSessionId);
    },
  };
}
