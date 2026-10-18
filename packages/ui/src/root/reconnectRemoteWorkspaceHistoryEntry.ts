import type { Dispatch, SetStateAction } from "react";
import type { IPlatformService, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { stripRemoteTargetSecrets } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceSessionMutation,
  buildRemoteWorkspaceIdentity,
  createRemoteTargetFromSnapshot,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
} from "@/store/remoteWorkspaceSessionStore.js";
import { refreshRemotePinnedTasksForSession } from "@/store/remotePinnedTaskStore.js";
import { refreshRemoteTimelineTasksForSession } from "@/store/remoteTimelineTaskStore.js";

/** Binds the UI-final canonical workspacePath/workspaceIdentity back onto the main/host logical session. */
export type BindRemoteWorkspaceSessionContextFn = (params: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
}) => Promise<void>;

type ManualReconnectRemoteWorkspaceParams = {
  sessionEntry: RemoteWorkspaceSessionEntry;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
    context?: Parameters<IPlatformService["connectRemote"]>[2],
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  bindRemoteWorkspacePath: typeof bindRemoteWorkspacePath;
  bindRemoteWorkspaceIdentity: typeof bindRemoteWorkspaceIdentity;
  upsertWorkspaceTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  logger: Pick<typeof logger, "warn">;
  toast: typeof toast;
  shouldKeepReconnectedWorkspace?: (
    context: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  options?: ReconnectRemoteWorkspaceOptions;
};

export interface SshReconnectCredentials {
  password: string | null;
  privateKeyPassphrase: string | null;
}

export interface ReconnectRemoteWorkspaceOptions {
  activateWorkspaceAfterReconnect?: boolean;
  showErrorToast?: boolean;
  requestId?: string;
  throwOnFailure?: boolean;
  /** Once the shared host is ready, siblings attach reusing the initiator credentials; never re-read per-history credentials. */
  sshCredentialsOverride?: SshReconnectCredentials;
  /** The logical connect has returned, so the shared SSH host is ready; workspace init may still succeed or fail. */
  onSshHostReady?: (credentials: SshReconnectCredentials) => void;
}

export async function reconnectRemoteWorkspaceHistoryEntry({
  sessionEntry,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  connectRemoteWorkspaceTarget,
  resolveRemoteWorkspaceCanonicalPath,
  disposeRemoteWorkspaceSession,
  bindRemoteWorkspaceSessionContext,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  upsertWorkspaceTab,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  logger,
  toast,
  shouldKeepReconnectedWorkspace,
  onWorkspaceActivated,
  options,
}: ManualReconnectRemoteWorkspaceParams): Promise<void> {
  const activateWorkspaceAfterReconnect = options?.activateWorkspaceAfterReconnect ?? true;
  const showErrorToast = options?.showErrorToast ?? true;
  const fallbackWorkspaceIdentity = resolveRemoteWorkspaceSessionIdentity(sessionEntry);
  const reconnectWorkspaceKey = fallbackWorkspaceIdentity?.trim() || sessionEntry.workspacePath;

  setReconnectingRemoteWorkspaceKeys((currentKeys) =>
    currentKeys.includes(reconnectWorkspaceKey)
      ? currentKeys
      : [...currentKeys, reconnectWorkspaceKey],
  );

  let reconnectTarget = createRemoteTargetFromSnapshot(sessionEntry.target, {
    password: null,
    privateKeyPassphrase: null,
    token: null,
  });
  let resolvedWorkspacePath = sessionEntry.workspacePath;
  let resolvedWorkspaceIdentity = fallbackWorkspaceIdentity;
  try {
    const sshCredentials = options?.sshCredentialsOverride ?? {
      password:
        sessionEntry.target.kind === "ssh" && sessionEntry.target.passwordCredentialKey
          ? await loadCredential(sessionEntry.target.passwordCredentialKey)
          : null,
      privateKeyPassphrase:
        sessionEntry.target.kind === "ssh" && sessionEntry.target.privateKeyPassphraseCredentialKey
          ? await loadCredential(sessionEntry.target.privateKeyPassphraseCredentialKey)
          : null,
    };
    const token =
      sessionEntry.target.kind === "server" && sessionEntry.target.tokenCredentialKey
        ? await loadCredential(sessionEntry.target.tokenCredentialKey)
        : null;
    reconnectTarget = createRemoteTargetFromSnapshot(sessionEntry.target, {
      ...sshCredentials,
      token,
    });
    const sessionId = await connectRemoteWorkspaceTarget(reconnectTarget, options?.requestId, {
      workspacePath: sessionEntry.workspacePath,
      workspaceIdentity: fallbackWorkspaceIdentity,
      connectTrigger: "reconnect",
    });
    if (reconnectTarget.kind === "ssh") {
      // Host-ready and workspace init (provider/tasks) must be notified in phases.
      // From this moment siblings can create attachments with the initiator credential, no waiting or re-reading.
      options?.onSshHostReady?.(sshCredentials);
    }
    resolvedWorkspacePath = await resolveRemoteWorkspaceCanonicalPath(
      sessionId,
      sessionEntry.workspacePath,
    );
    resolvedWorkspaceIdentity = buildRemoteWorkspaceIdentity(
      resolvedWorkspacePath,
      reconnectTarget,
    );

    if (
      resolvedWorkspacePath !== sessionEntry.workspacePath ||
      resolvedWorkspaceIdentity !== fallbackWorkspaceIdentity
    ) {
      // connect carries only the recorded path/identity, and the main logical session descriptor holds the same;
      // if realpath normalization differs, the tab uses the new values while the descriptor keeps the old,
      // and the phone bridge comparing tab path/identity against the descriptor gets REMOTE_WORKSPACE_IDENTITY_MISMATCH.
      // A failed bind means session and tab cannot align: recycle the session and record the failure, no half-connected workspace.
      // This await must precede the retain check below: no async gap may sit between the check and upsertWorkspaceTab,
      // or a tab removed during the bind wait makes the check stale and the workspace re-added.
      try {
        await bindRemoteWorkspaceSessionContext({
          sessionId,
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
      } catch (error) {
        await disposeRemoteWorkspaceSession(sessionId);
        throw error;
      }
    }

    // During a manual reconnect the user may hit reconnect and remove that remote tab immediately.
    // Re-check retention before persisting success, or the just-removed workspace is added back.
    if (
      shouldKeepReconnectedWorkspace &&
      !shouldKeepReconnectedWorkspace({
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
      })
    ) {
      logger.warn("[Root] Remote workspace removed during reconnect; skipping restore and recycling the session", {
        workspacePath: resolvedWorkspacePath,
      });
      await disposeRemoteWorkspaceSession(sessionId);
      return;
    }
    bindRemoteWorkspacePath(resolvedWorkspacePath, sessionId);
    bindRemoteWorkspaceIdentity(resolvedWorkspaceIdentity, sessionId);
    upsertWorkspaceTab(resolvedWorkspacePath, {
      remoteSessionId: sessionId,
      remoteTarget: stripRemoteTargetSecrets(reconnectTarget),
      workspaceIdentity: resolvedWorkspaceIdentity,
      localWorkspacePath: sessionEntry.localWorkspacePath,
    });
    if (activateWorkspaceAfterReconnect) {
      // Sidebar reconnect used to activate a disconnected tab holding only an identity, no remoteSessionId;
      // the conversation provider returned null on remote-waiting and the whole right pane went black during connect.
      // Bind services and silently backfill the tab session metadata first, then activate tab and draft together.
      const activated = activateTabByPath(resolvedWorkspacePath, {
        workspaceIdentity: resolvedWorkspaceIdentity,
      });
      if (activated) {
        onWorkspaceActivated?.({
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
      }
    }
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        localWorkspacePath: sessionEntry.localWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        lastConnectionStatus: "connected",
        touchOpenedAt: true,
      }),
    );
    await Promise.all([
      refreshRemotePinnedTasksForSession({
        sessionId,
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
      }),
      refreshRemoteTimelineTasksForSession({
        sessionId,
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
      logger.warn("[Root] Manual reconnect of the remote workspace failed", {
      workspacePath: resolvedWorkspacePath,
      error: message,
    });
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        lastConnectionStatus: "failed",
        lastConnectionError: message,
        touchOpenedAt: false,
      }),
    );
    if (showErrorToast) {
      toast(message);
    }
    if (options?.throwOnFailure) {
      // The desktop reconnect button swallows exceptions and reports via toast/state persisting,
      // but phone web-remote is RPC semantics: the failure must be returned to the phone explicitly.
      throw error;
    }
  } finally {
    setReconnectingRemoteWorkspaceKeys((currentKeys) =>
      currentKeys.filter((key) => key !== reconnectWorkspaceKey),
    );
  }
}
