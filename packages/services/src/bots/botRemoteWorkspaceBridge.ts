import { randomUUID } from "node:crypto";
import {
  HostResponseTypes,
  hostBotRemoteWorkspaceConnectionStatusResultMessageSchema,
  hostBotRemoteWorkspaceRuntimePortMessageSchema,
  hostBotRemoteWorkspaceReconnectResultMessageSchema,
  type RemoteTarget,
} from "@zcode/shared";
import { type IZCodeTaskService as IZCodeTaskServiceShape } from "../session/zcodeTaskService.js";
import type { ICredentialService } from "../credential/credential.js";
import type { ISettingService } from "../setting/setting.js";
import { type ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";
import {
  createRemoteRuntimeServicesFromPort,
  type RemoteBotWorkspaceRuntimeServices,
} from "#src/bots/botRemoteRuntimeServices.js";

interface ParentPortLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  on(event: "message", listener: (event: ParentPortMessageEvent) => void): void;
  off?(event: "message", listener: (event: ParentPortMessageEvent) => void): void;
}

interface ParentPortMessageEvent {
  data: unknown;
  ports?: unknown[];
}

export function createBotRemoteWorkspaceService(params: {
  parentPort?: ParentPortLike | null;
  settingService: ISettingService;
  credentialService: ICredentialService;
  createRuntimeServicesFromPort?: (port: unknown) => RemoteBotWorkspaceRuntimeServices;
}) {
  const parentPort = params.parentPort;
  if (!parentPort) {
    return undefined;
  }
  const activeParentPort = parentPort;
  const connectedWorkspaceKeys = new Set<string>();
  const pending = new Map<
    string,
    (result: { ok: boolean; sessionId?: string; error?: string }) => void
  >();
  const pendingRuntimePorts = new Map<
    string,
    (result: { ok: boolean; port?: unknown; error?: string }) => void
  >();
  const pendingConnectionStatus = new Map<
    string,
    (result: { ok: boolean; connected?: boolean; error?: string }) => void
  >();
  const runtimeServicesByWorkspaceKey = new Map<string, RemoteBotWorkspaceRuntimeServices>();
  let latestAppRuntimePreferences: ZCodeAgentAppRuntimePreferences | undefined;
  let appRuntimePreferencesRevision = 0;
  const onMessage = (event: ParentPortMessageEvent) => {
    const result = hostBotRemoteWorkspaceReconnectResultMessageSchema.safeParse(event.data);
    if (result.success) {
      const { requestId } = result.data;
      const resolve = pending.get(requestId);
      if (!resolve) {
        return;
      }
      pending.delete(requestId);
      resolve({
        ok: result.data.ok,
        sessionId: result.data.sessionId,
        error: result.data.error,
      });
      return;
    }

    const connectionStatusResult =
      hostBotRemoteWorkspaceConnectionStatusResultMessageSchema.safeParse(event.data);
    if (connectionStatusResult.success) {
      const { requestId } = connectionStatusResult.data;
      const resolve = pendingConnectionStatus.get(requestId);
      if (!resolve) {
        return;
      }
      pendingConnectionStatus.delete(requestId);
      resolve({
        ok: connectionStatusResult.data.ok,
        connected: connectionStatusResult.data.connected,
        error: connectionStatusResult.data.error,
      });
      return;
    }

    const runtimePortResult = hostBotRemoteWorkspaceRuntimePortMessageSchema.safeParse(event.data);
    if (!runtimePortResult.success) {
      return;
    }
    const { requestId } = runtimePortResult.data;
    const resolve = pendingRuntimePorts.get(requestId);
    if (!resolve) {
      return;
    }
    pendingRuntimePorts.delete(requestId);
    resolve({
      ok: runtimePortResult.data.ok,
      port: event.ports?.[0],
      error: runtimePortResult.data.error,
    });
  };
  activeParentPort.on("message", onMessage);

  async function buildRemoteTargetForWorkspace(target: {
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<RemoteTarget | null> {
    const settings = await params.settingService.get();
    const workspaceIdentity = target.workspaceIdentity.trim();
    const remoteSessions = (settings.lastWorkspaceSession ?? []).filter(
      (item) => item.kind === "remote",
    );
    const entry =
      // Bugfix: the UI may normalize workspacePath to its realpath after connecting, while the
      // bot context keeps the old path. Identity isolation keys on workspaceIdentity, so hits must go by identity first.
      remoteSessions.find((item) => item.workspaceIdentity === workspaceIdentity) ??
      remoteSessions.find(
        (item) =>
          item.workspacePath === target.workspacePath &&
          item.workspaceIdentity === workspaceIdentity,
      );
    if (!entry || entry.kind !== "remote") {
      return null;
    }
    if (entry.target.kind !== "ssh") {
      return entry.target;
    }
    return {
      kind: "ssh",
      host: entry.target.host,
      port: entry.target.port,
      username: entry.target.username,
      privateKeyPath: entry.target.privateKeyPath,
      password: entry.target.passwordCredentialKey
        ? ((await params.credentialService.load(entry.target.passwordCredentialKey)) ?? undefined)
        : undefined,
      privateKeyPassphrase: entry.target.privateKeyPassphraseCredentialKey
        ? ((await params.credentialService.load(entry.target.privateKeyPassphraseCredentialKey)) ??
          undefined)
        : undefined,
    };
  }

  async function queryMainConnectionStatus(target: {
    workspacePath: string;
    workspaceIdentity: string;
    remoteTarget: RemoteTarget;
  }): Promise<boolean | null> {
    const requestId = `bot-status-${randomUUID()}`;
    const result = await new Promise<{
      ok: boolean;
      connected?: boolean;
      error?: string;
    }>((resolve) => {
      pendingConnectionStatus.set(requestId, resolve);
      activeParentPort.postMessage({
        type: HostResponseTypes.BotRemoteWorkspaceConnectionStatusRequest,
        requestId,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        target: target.remoteTarget,
      });
      setTimeout(() => {
        if (pendingConnectionStatus.delete(requestId)) {
          resolve({ ok: false, error: "Timed out querying remote workspace connection status." });
        }
      }, 5_000);
    });
    return result.ok ? result.connected === true : null;
  }

  return {
    async isConnected(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<boolean> {
      const workspaceKey = target.workspaceIdentity.trim() || target.workspacePath;
      const remoteTarget = await buildRemoteTargetForWorkspace(target);
      if (!remoteTarget) {
        connectedWorkspaceKeys.delete(workspaceKey);
        return false;
      }

      // Bugfix: manual reconnect from the UI never goes through the bot /reconnect command, so a local
      // Set alone would misreport the state. Ask main for the live session table each time and prune stale marks.
      const connected = await queryMainConnectionStatus({
        ...target,
        remoteTarget,
      });
      if (connected !== null) {
        if (connected) {
          connectedWorkspaceKeys.add(workspaceKey);
        } else {
          connectedWorkspaceKeys.delete(workspaceKey);
        }
        return connected;
      }

      return connectedWorkspaceKeys.has(workspaceKey);
    },
    async ensureConnected(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<{ ok: boolean; message?: string }> {
      const remoteTarget = await buildRemoteTargetForWorkspace(target);
      if (!remoteTarget) {
        return {
          ok: false,
          message: "No connection info found for this remote workspace.",
        };
      }
      const requestId = `bot-reconnect-${randomUUID()}`;
      const result = await new Promise<{
        ok: boolean;
        sessionId?: string;
        error?: string;
      }>((resolve) => {
        pending.set(requestId, resolve);
        activeParentPort.postMessage({
          type: HostResponseTypes.BotRemoteWorkspaceReconnectRequest,
          requestId,
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          target: remoteTarget,
        });
        setTimeout(() => {
          if (pending.delete(requestId)) {
            resolve({ ok: false, error: "Timed out reconnecting the remote workspace." });
          }
        }, 60_000);
      });
      if (result.ok) {
        connectedWorkspaceKeys.add(target.workspaceIdentity.trim() || target.workspacePath);
        return { ok: true };
      }
      return { ok: false, message: result.error ?? "unknown" };
    },
    async getZCodeTaskService(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<IZCodeTaskServiceShape | null> {
      return (await getRuntimeServices(target))?.zcodeTaskService ?? null;
    },
    async getModelSelectionService(target: { workspacePath: string; workspaceIdentity: string }) {
      return (await getRuntimeServices(target))?.modelSelectionService ?? null;
    },
    async syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void> {
      latestAppRuntimePreferences = preferences;
      appRuntimePreferencesRevision += 1;
      // Fix: remote bot runtimes belong to no renderer window, so the root agent sync cannot reach them.
      // Only refresh runtimes that are already cached instead of spawning hosts for idle bots.
      await Promise.all(
        Array.from(runtimeServicesByWorkspaceKey.values()).map((services) =>
          services.zcodeAgentService.syncAppRuntimePreferences(preferences),
        ),
      );
    },
    dispose(): void {
      // Bugfix: drop the parentPort listener on host dispose so stale reconnect promises die with the window.
      activeParentPort.off?.("message", onMessage);
      pending.clear();
      pendingRuntimePorts.clear();
      pendingConnectionStatus.clear();
      runtimeServicesByWorkspaceKey.clear();
      connectedWorkspaceKeys.clear();
    },
  };

  async function getRuntimeServices(target: {
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<RemoteBotWorkspaceRuntimeServices | null> {
    const workspaceKey = target.workspaceIdentity.trim() || target.workspacePath;
    const cached = runtimeServicesByWorkspaceKey.get(workspaceKey);
    if (cached) {
      return cached;
    }
    const remoteTarget = await buildRemoteTargetForWorkspace(target);
    if (!remoteTarget) {
      return null;
    }
    const requestId = `bot-runtime-${randomUUID()}`;
    const result = await new Promise<{
      ok: boolean;
      port?: unknown;
      error?: string;
    }>((resolve) => {
      pendingRuntimePorts.set(requestId, resolve);
      activeParentPort.postMessage({
        type: HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest,
        requestId,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        target: remoteTarget,
      });
      setTimeout(() => {
        if (pendingRuntimePorts.delete(requestId)) {
          resolve({ ok: false, error: "Timed out initializing the remote workspace runtime." });
        }
      }, 60_000);
    });
    if (!result.ok || !result.port) {
      throw new Error(result.error ?? "Failed to initialize the remote workspace runtime.");
    }
    // Bugfix: bot tasks used to know only the remote identity yet still hit the local task service.
    // Wrap the remote RPC port forwarded by main into a runtime services bundle: task wrapper
    // commands go through IZCodeTaskService while session state goes through the ZCode session facade.
    const services =
      params.createRuntimeServicesFromPort?.(result.port) ??
      createRemoteRuntimeServicesFromPort(result.port);
    // Remote bots share the remote environment with the UI workspace; only wait for the remote
    // model selection facade here, the desktop no longer injects a full provider registry.
    await services.modelSelectionService.getView();
    while (true) {
      const revision = appRuntimePreferencesRevision;
      const cachedPreferences = latestAppRuntimePreferences;
      const preferences: ZCodeAgentAppRuntimePreferences = cachedPreferences
        ? cachedPreferences
        : await params.settingService.get().then((settings) => ({
            askUserQuestionAutoResolutionEnabled:
              settings.askUserQuestionAutoResolutionEnabled !== false,
            modelIoFullRetentionEnabled: settings.modelIoFullRetentionEnabled === true,
          }));
      await services.zcodeAgentService.syncAppRuntimePreferences(preferences);
      if (revision === appRuntimePreferencesRevision) {
        break;
      }
    }
    // Cache the runtime services only once registry and app runtime preferences are both ready.
    runtimeServicesByWorkspaceKey.set(workspaceKey, services);
    return services;
  }
}
