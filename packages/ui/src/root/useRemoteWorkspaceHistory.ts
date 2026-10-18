/* eslint-disable max-lines -- remote workspace history keeps restore/reconnect/persistence/cleanup in one hook for now; splitting for lint alone risks state regressions.*/
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  AppSettings,
  BotRemoteWorkspaceReconnectedEvent,
  IPlatformService,
  RemoteSessionClosedEvent,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import { buildSshRemoteHostKey, createUuid, stripRemoteTargetSecrets } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  type RemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { refreshRemotePinnedTasksForSession } from "@/store/remotePinnedTaskStore.js";
import { refreshRemoteTimelineTasksForSession } from "@/store/remoteTimelineTaskStore.js";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteWorkspaceSessionMutation,
  buildWorkspaceSessionKey,
  createRemoteTargetFromSnapshot,
  getRemoteWorkspaceSessionEntries,
  removeRemoteWorkspaceSessionEntries,
} from "@/lib/remoteWorkspaceHistory.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { isWorkspaceTab, type TabStoreState, type WindowTabState } from "@/store/tabStore.js";
import {
  buildRemoteWorkspacePersistPatch,
  restorePersistedRemoteWorkspaceSessions,
} from "@/root/remoteWorkspaceSessionPersistence.js";
import { useReconnectingRemoteWorkspaceLogs } from "@/root/useReconnectingRemoteWorkspaceLogs.js";
import {
  reconnectRemoteWorkspaceHistoryEntry,
  type BindRemoteWorkspaceSessionContextFn,
  type ReconnectRemoteWorkspaceOptions,
  type SshReconnectCredentials,
} from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { markRemoteWorkspaceRunningTasksFailed } from "@/lib/remoteWorkspaceSessionRuntime.js";

export { reconnectRemoteWorkspaceHistoryEntry };

async function bindRemoteWorkspaceContextAndGetSession(params: {
  platform: Pick<IPlatformService, "bindRemoteWorkspaceSessionContext">;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<RemoteWorkspaceSession> {
  if (!getRemoteWorkspaceSession(params.sessionId)) {
    throw new Error(`Remote workspace session not found: ${params.sessionId}`);
  }
  await params.platform.bindRemoteWorkspaceSessionContext?.({
    remoteSessionId: params.sessionId,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
  // bind re-generates the attachment/services of one remoteSessionId from A to B.
  // Objects captured before bind still point at A; re-read the current services by sessionId after the ready ACK.
  const currentSession = getRemoteWorkspaceSession(params.sessionId);
  if (!currentSession) {
    throw new Error(`Remote workspace session not found: ${params.sessionId}`);
  }
  return currentSession;
}

function resolveBotRemoteWorkspaceReconnectedIdentity(params: {
  event: Pick<BotRemoteWorkspaceReconnectedEvent, "workspaceIdentity">;
  resolvedWorkspacePath: string;
  target: BotRemoteWorkspaceReconnectedEvent["target"];
}): string {
  const eventWorkspaceIdentity = params.event.workspaceIdentity.trim();
  if (eventWorkspaceIdentity) {
    // Bugfix: bot task/stream broadcasts keep the workspaceIdentity captured in the bot context.
    // Recomputing it from the canonical path would subscribe the UI tab to another key and filter remote results away.
    return eventWorkspaceIdentity;
  }
  return buildRemoteWorkspaceIdentity(params.resolvedWorkspacePath, params.target);
}

function shouldPersistRemoteWorkspaceFailure(params: {
  pendingReconnectRequestIds: ReadonlyMap<string, string>;
  sessionEntry: RemoteWorkspaceSessionEntry;
  workspaceKey: string;
}): boolean {
  if (params.sessionEntry.target.kind !== "wsl") {
    return true;
  }

  // On WSL flaps, the old session close event can land after the manual reconnect starts.
  // While a reconnect is pending for this workspace, do not persist failed into settings;
  // let this reconnect outcome decide.
  return !params.pendingReconnectRequestIds.has(params.workspaceKey);
}
interface RemoteWorkspaceTabStoreReader {
  getState(): {
    tabs: WindowTabState[];
  };
}

interface OpenRemoteWorkspaceFromHistoryParams {
  workspaceKey: string;
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  inflightReconnectWorkspaceKeys: Set<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  addTab: (
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
  resetLogsForWorkspaceKey: (workspaceKey: string) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  createReconnectRequestId?: () => string;
  pendingReconnectRequestIds?: Map<string, string>;
  reconnectImpl?: typeof reconnectRemoteWorkspaceHistoryEntry;
}

interface ReconnectRemoteWorkspaceByKeyParams {
  workspaceKey: string;
  canUseRemoteWorkspace: boolean;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  runReconnectRemoteWorkspace: (
    sessionEntry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<void>;
  options?: ReconnectRemoteWorkspaceOptions;
}

async function reconnectRemoteWorkspaceByKey({
  workspaceKey,
  canUseRemoteWorkspace,
  getRemoteSessions,
  runReconnectRemoteWorkspace,
  options,
}: ReconnectRemoteWorkspaceByKeyParams): Promise<boolean> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    throw new Error(`Remote workspace not in this window; cannot reconnect: ${workspaceKey}`);
  }

  await runReconnectRemoteWorkspace(sessionEntry, options);
  return true;
}

function collectSshReconnectGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  sessions: RemoteWorkspaceSessionEntry[];
  tabs: WindowTabState[];
}): RemoteWorkspaceSessionEntry[] {
  if (params.selected.target.kind !== "ssh") {
    return [params.selected];
  }
  const remoteHostKey = buildSshRemoteHostKey(params.selected.target);
  const disconnectedWorkspaceKeys = new Set(
    params.tabs.flatMap((tab) => {
      if (!isWorkspaceTab(tab) || tab.remoteSessionId) {
        return [];
      }
      return [buildWorkspaceSessionKey(tab)];
    }),
  );
  const reconnectGroup = params.sessions.filter(
    (entry) =>
      entry.target.kind === "ssh" &&
      buildSshRemoteHostKey(entry.target) === remoteHostKey &&
      disconnectedWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
  );
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  if (!reconnectGroup.some((entry) => buildWorkspaceSessionKey(entry) === selectedWorkspaceKey)) {
    return [params.selected];
  }

  // History order does not say who initiated this reconnect. The initiator must be pinned first,
  // or a sibling may create the shared host first while credentials load concurrently, misusing old credentials group-wide.
  return [
    params.selected,
    ...reconnectGroup.filter((entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey),
  ];
}

async function reconnectRemoteWorkspaceGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  reconnectGroup: RemoteWorkspaceSessionEntry[];
  reconnectEntry: (
    entry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<boolean>;
  options?: ReconnectRemoteWorkspaceOptions;
}): Promise<void> {
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  const siblings = params.reconnectGroup.filter(
    (entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey,
  );

  if (params.selected.target.kind !== "ssh") {
    try {
      await params.reconnectEntry(params.selected, {
        ...params.options,
        throwOnFailure: true,
      });
    } catch (error) {
      if (params.options?.throwOnFailure) {
        throw error;
      }
    }
    return;
  }

  type InitiatorHostGate =
    | { status: "ready"; credentials: SshReconnectCredentials }
    | { status: "skipped" }
    | { status: "failed"; error: unknown };
  let hostReadyCredentials: SshReconnectCredentials | undefined;
  let resolveHostReady!: (result: InitiatorHostGate) => void;
  const hostReadyPromise = new Promise<InitiatorHostGate>((resolve) => {
    resolveHostReady = resolve;
  });

  // Concurrent connects let the sibling that finishes its credential load first grab the shared host.
  // The initiator builds the host to ready; later provider/task init no longer blocks sibling attachments.
  const initiatorPromise = params.reconnectEntry(params.selected, {
    ...params.options,
    throwOnFailure: true,
    onSshHostReady: (credentials) => {
      if (hostReadyCredentials) {
        return;
      }
      hostReadyCredentials = credentials;
      resolveHostReady({ status: "ready", credentials });
    },
  });
  const initiatorFinishedBeforeReady = initiatorPromise.then<InitiatorHostGate, InitiatorHostGate>(
    (didReconnect) => {
      if (hostReadyCredentials) {
        return { status: "ready", credentials: hostReadyCredentials };
      }
      return didReconnect
        ? {
            status: "failed",
            error: new Error("SSH initiator completed without reporting Host ready"),
          }
        : { status: "skipped" };
    },
    (error: unknown) =>
      hostReadyCredentials
        ? { status: "ready", credentials: hostReadyCredentials }
        : { status: "failed", error },
  );
  const hostGate = await Promise.race([hostReadyPromise, initiatorFinishedBeforeReady]);
  if (hostGate.status !== "ready") {
    if (hostGate.status === "failed" && params.options?.throwOnFailure) {
      throw hostGate.error;
    }
    return;
  }

  // Siblings only reuse the initiator credential against the ready host, never their own historical credentials;
  // path/provider/task init runs parallel to the initiator with independent failure semantics.
  const siblingPromise = Promise.allSettled(
    siblings.map((entry) =>
      params.reconnectEntry(entry, {
        ...params.options,
        activateWorkspaceAfterReconnect: false,
        sshCredentialsOverride: hostGate.credentials,
      }),
    ),
  );
  const [initiatorResult] = await Promise.all([
    initiatorPromise.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    siblingPromise,
  ]);
  if (initiatorResult.status === "rejected" && params.options?.throwOnFailure) {
    throw initiatorResult.error;
  }
}

function shouldKeepRemoteWorkspaceInTabs(params: {
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  workspacePath: string;
  workspaceIdentity?: string;
}): boolean {
  const reconnectWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  return params.tabStoreApi
    .getState()
    .tabs.some(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) &&
        ((tab.workspaceIdentity?.trim() || tab.workspacePath) === reconnectWorkspaceKey ||
          tab.workspacePath === params.workspacePath),
    );
}

async function cancelPendingRemoteReconnectsForWorkspaceKeys(params: {
  workspaceKeys: string[];
  pendingRequestIds: Map<string, string>;
  cancelPendingRemoteConnection?: (requestId?: string) => Promise<void>;
  logger: Pick<typeof logger, "warn">;
}): Promise<void> {
  const requestIds = params.workspaceKeys.flatMap((workspaceKey) => {
    const requestId = params.pendingRequestIds.get(workspaceKey);
    if (!requestId) {
      return [];
    }

    params.pendingRequestIds.delete(workspaceKey);
    return [requestId];
  });

  if (!params.cancelPendingRemoteConnection || requestIds.length === 0) {
    return;
  }

  await Promise.all(
    requestIds.map(async (requestId) => {
      try {
        await params.cancelPendingRemoteConnection?.(requestId);
      } catch (error) {
        params.logger.warn("[Root] Failed to cancel the remote workspace reconnect", {
          requestId,
          error,
        });
      }
    }),
  );
}

async function openRemoteWorkspaceFromHistoryEntry({
  workspaceKey,
  tabStoreApi,
  getRemoteSessions,
  inflightReconnectWorkspaceKeys,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  connectRemoteWorkspaceTarget,
  resolveRemoteWorkspaceCanonicalPath,
  disposeRemoteWorkspaceSession,
  bindRemoteWorkspaceSessionContext,
  addTab,
  commitRemoteWorkspaceSessionMutation,
  resetLogsForWorkspaceKey,
  createReconnectRequestId,
  pendingReconnectRequestIds,
  reconnectImpl = reconnectRemoteWorkspaceHistoryEntry,
  onWorkspaceActivated,
}: OpenRemoteWorkspaceFromHistoryParams): Promise<void> {
  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    return;
  }

  if (inflightReconnectWorkspaceKeys.has(workspaceKey)) {
    return;
  }

  const existingWorkspaceTab = tabStoreApi
    .getState()
    .tabs.find(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
    );
  if (existingWorkspaceTab?.remoteSessionId) {
    activateTabByPath(existingWorkspaceTab.workspacePath, {
      workspaceIdentity: existingWorkspaceTab.workspaceIdentity,
    });
    return;
  }

  // The picker remote history and the sidebar reconnect share one restore-existing-workspace semantic.
  // Without a keep-this-workspace recheck, a workspace removed mid-reconnect is re-added by the success callback.
  // Reuse the same shouldKeep predicate so both entries race identically.
  resetLogsForWorkspaceKey(workspaceKey);
  inflightReconnectWorkspaceKeys.add(workspaceKey);
  const requestId = createReconnectRequestId?.();
  if (requestId) {
    pendingReconnectRequestIds?.set(workspaceKey, requestId);
  }
  try {
    await reconnectImpl({
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
      upsertWorkspaceTab: addTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions,
      logger,
      toast,
      shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
        shouldKeepRemoteWorkspaceInTabs({
          tabStoreApi,
          workspacePath,
          workspaceIdentity,
        }),
      onWorkspaceActivated: (target) => {
        logger.debug("[Root] Remote history workspace ready; committing tab and draft activation", target);
        onWorkspaceActivated?.(target);
      },
      options: {
        // The history entry used to backfill only the connected tab without committing tab activation/draft owner,
        // leaving the right side on the old workspace after connect. The shared helper commits only once services are ready,
        // never exposing a remote-waiting tab without remoteSessionId.
        activateWorkspaceAfterReconnect: true,
        showErrorToast: true,
        requestId,
      },
    });
  } finally {
    inflightReconnectWorkspaceKeys.delete(workspaceKey);
    if (requestId && pendingReconnectRequestIds?.get(workspaceKey) === requestId) {
      pendingReconnectRequestIds.delete(workspaceKey);
    }
  }
}

async function selectRemoteWorkspaceProjectFromDialog({
  canUseRemoteWorkspace,
  sessionId,
  path,
  localWorkspacePath,
  loadingMessage,
  getRemoteWorkspaceSession,
  connectionTarget,
  getWorkspaceTabs,
  resolveRemoteWorkspaceCanonicalPath,
  activateTabByPath,
  handleCancelRemoteProject,
  bindRemoteWorkspaceSessionContext,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  addTab,
  onWorkspaceActivated,
  refreshPinnedTasks,
  refreshTimelineTasks,
}: {
  canUseRemoteWorkspace: boolean;
  sessionId: string;
  path: string;
  localWorkspacePath?: string;
  loadingMessage: string;
  getRemoteWorkspaceSession: (sessionId: string) => RemoteWorkspaceSession | null;
  connectionTarget?: Parameters<IPlatformService["connectRemote"]>[0];
  getWorkspaceTabs: () => WindowTabState[];
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  handleCancelRemoteProject: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  bindRemoteWorkspacePath: (workspacePath: string, sessionId: string) => void;
  bindRemoteWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  refreshPinnedTasks: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  refreshTimelineTasks: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
}): Promise<void> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const remoteSession = getRemoteWorkspaceSession(sessionId);
  if (!remoteSession) {
    throw new Error(loadingMessage);
  }
  const remoteTarget = connectionTarget ?? remoteSession.target;
  if (!remoteTarget) {
    // The phone web relay reuses the remote session store for routing only; there is no locally reconnectable target.
    // The history pick/persist flow requires a target; block otherwise, never recording a target-less bridged session.
    throw new Error(`Remote workspace session missing its connection target: ${sessionId}`);
  }

  const canonicalPath = await resolveRemoteWorkspaceCanonicalPath(sessionId, path);
  const workspaceIdentity = buildRemoteWorkspaceIdentity(canonicalPath, remoteTarget);
  const existingWorkspaceTab = getWorkspaceTabs().find(
    (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
      isWorkspaceTab(tab) &&
      tab.workspacePath === canonicalPath &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceIdentity,
  );

  if (
    existingWorkspaceTab?.remoteSessionId &&
    activateTabByPath(canonicalPath, { workspaceIdentity })
  ) {
    onWorkspaceActivated?.({ workspacePath: canonicalPath, workspaceIdentity });
    await handleCancelRemoteProject(sessionId);
    return;
  }

  // Disconnected tabs used to be activated via activateTabByPath before provider/session binding;
  // V4PaneConversationProvider then only saw remote-waiting and returned null on rpcReady=false,
  // blanking the right side until a later addTab wrote back the remoteSessionId.
  // Disconnected and first-connect tabs now activate atomically via addTab only after services bind, never exposing a half-connected workspace.

  // A new connection carries no context: the main/host logical session
  // descriptor stays at the connection root /, identity host-built from the resolved target; while the tab, remote history and
  // phone-visible workspace list all use the canonicalPath/workspaceIdentity computed here.
  // Phone bridging (attachRemoteWorkspaceSessionHost) requires the two triples to match exactly, so after the directory pick the canonical
  // context must bind back to main before committing connected state and the tab. df2db1df7a moved provider sync into main/host
  // and dropped this bind, so post-create directory picks always got REMOTE_WORKSPACE_IDENTITY_MISMATCH on the phone.
  // On bind failure fail closed: recycle the session and throw into the connect dialog, never leaving descriptor/tab mismatched.
  try {
    await bindRemoteWorkspaceSessionContext({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    });
  } catch (error) {
    await handleCancelRemoteProject(sessionId);
    throw error;
  }

  await commitRemoteWorkspaceSessionMutation(
    buildRemoteWorkspaceSessionMutation({
      remoteSessions: getRemoteSessions(),
      workspacePath: canonicalPath,
      localWorkspacePath,
      workspaceIdentity,
      target: remoteTarget,
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    }),
  );

  bindRemoteWorkspacePath(canonicalPath, sessionId);
  bindRemoteWorkspaceIdentity(workspaceIdentity, sessionId);
  addTab(canonicalPath, {
    remoteSessionId: sessionId,
    remoteTarget: stripRemoteTargetSecrets(remoteTarget),
    workspaceIdentity,
    localWorkspacePath,
  });
  // startDraft now runs in the caller only after the pinned/timeline refreshes settle; earlier, the tab
  // had switched to remote while the draft owner lagged, leaving a visible blank frame.
  // The activation callback must follow addTab directly, committing the draft state for the same workspaceKey before any list-refresh await.
  onWorkspaceActivated?.({ workspacePath: canonicalPath, workspaceIdentity });
  await Promise.all([
    refreshPinnedTasks({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    }),
    refreshTimelineTasks({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    }),
  ]);
}

export function useRemoteWorkspaceHistory({
  intl,
  services,
  platform,
  supportsSettings,
  allowRemoteWorkspace = true,
  ensureConversationWorkspaceOnRestore = false,
  deferInactiveWorkspaceRestore = false,
  unavailableWorkspacePath,
  tabStoreApi,
  activateTabByPath,
  addTab,
  onWorkspaceActivated,
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  services: IServiceAccessor;
  platform: IPlatformService;
  supportsSettings: boolean;
  allowRemoteWorkspace?: boolean;
  ensureConversationWorkspaceOnRestore?: boolean;
  /** Desktop main window only: add inactive workspaces to the sidebar/task sources once input is available. */
  deferInactiveWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
}) {
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  const canUseRemoteWorkspace = allowRemoteWorkspace && showRemoteConnectionEntry;
  const allowRemoteWorkspaceRestore = canUseRemoteWorkspace;
  const [remoteWorkspaceSessions, setRemoteWorkspaceSessions] = useState<
    RemoteWorkspaceSessionEntry[]
  >([]);
  const remoteWorkspaceSessionsRef = useRef<RemoteWorkspaceSessionEntry[]>([]);
  const [reconnectingRemoteWorkspaceKeys, setReconnectingRemoteWorkspaceKeys] = useState<string[]>(
    [],
  );
  const inflightReconnectWorkspaceKeysRef = useRef<Set<string>>(new Set());
  const pendingReconnectRequestIdsRef = useRef<Map<string, string>>(new Map());
  const pendingConnectionTargetsBySessionIdRef = useRef<
    Map<string, Parameters<IPlatformService["connectRemote"]>[0]>
  >(new Map());
  // A previous version kept a useRef here for startup reconnect attempts.
  // After auto-reconnect removal, Vite Fast Refresh reuses the old fiber hook slots,
  // making the deeper useReconnectingRemoteWorkspaceLogs useState land on a stale ref slot and trip React "Should have a queue".
  // Keep one empty ref purely to stabilize hook order across hot reloads; no startup reconnect behavior returns.
  const remoteStartupReconnectRefreshCompatibilityRef = useRef<null>(null);
  void remoteStartupReconnectRefreshCompatibilityRef;
  const {
    logsByWorkspaceKey: reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    resetLogsForWorkspaceKey,
  } = useReconnectingRemoteWorkspaceLogs({
    platform,
    reconnectingWorkspaceKeys: reconnectingRemoteWorkspaceKeys,
    resolveWorkspaceTargetByKey: (workspaceKey) =>
      remoteWorkspaceSessionsRef.current.find(
        (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
      )?.target ?? null,
    resolveWorkspaceRequestIdByKey: (workspaceKey) =>
      pendingReconnectRequestIdsRef.current.get(workspaceKey) ?? null,
  });

  const syncPersistedWorkspaceSession = useCallback(
    async (nextRemoteSessions: readonly RemoteWorkspaceSessionEntry[]) => {
      setRemoteWorkspaceSessions([...nextRemoteSessions]);
      remoteWorkspaceSessionsRef.current = [...nextRemoteSessions];

      if (!supportsSettings) {
        return;
      }

      await services.settingService.update(
        buildRemoteWorkspacePersistPatch(tabStoreApi.getState(), nextRemoteSessions),
      );
    },
    [services.settingService, supportsSettings, tabStoreApi],
  );

  const commitRemoteWorkspaceSessionMutation = useCallback(
    async (mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>) => {
      for (const credentialKey of mutation.credentialKeysToDelete) {
        try {
          await services.credentialService.delete(credentialKey);
        } catch (error) {
          logger.warn("[Root] Failed to delete the remote workspace credentials", {
            credentialKey,
            error,
          });
        }
      }

      for (const credential of mutation.credentialsToSave) {
        await services.credentialService.save(credential.key, credential.value);
      }

      await syncPersistedWorkspaceSession(mutation.nextRemoteSessions);
      return mutation.entry;
    },
    [services.credentialService, syncPersistedWorkspaceSession],
  );

  const waitForRemoteWorkspaceSessionReady = useCallback(async (sessionId: string) => {
    if (getRemoteWorkspaceSession(sessionId)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const pollTimer = window.setInterval(() => {
        if (getRemoteWorkspaceSession(sessionId)) {
          window.clearInterval(pollTimer);
          resolve();
          return;
        }

        if (Date.now() - startedAt >= 3000) {
          window.clearInterval(pollTimer);
          reject(new Error(`Timed out waiting for the remote workspace session: ${sessionId}`));
        }
      }, 50);
    });
  }, []);

  const connectRemoteWorkspaceTarget = useCallback(
    async (
      target: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
    ) => {
      const result = await platform.connectRemote(target, requestId, context);
      if (!result.success) {
        throw new Error(getErrorMessage(result.error || "Connection failed"));
      }

      if (!result.sessionId) {
        throw new Error("Remote session was not created");
      }

      // A successful remote connect only means main/host built the session;
      // the renderer-side MessagePort may register into the zustand store a beat later.
      // addTab immediately would briefly hit local services, so first-paint directory reads/warmup hit the wrong service.
      // Wait until the session is really in the store.
      await waitForRemoteWorkspaceSessionReady(result.sessionId);
      if (!context) {
        // The shared host returns only redacted targets to the renderer store; full credentials live only until the picker completes.
        pendingConnectionTargetsBySessionIdRef.current.set(result.sessionId, target);
      }
      return result.sessionId;
    },
    [platform, waitForRemoteWorkspaceSessionReady],
  );

  const resolveRemoteWorkspaceCanonicalPath = useCallback(
    async (sessionId: string, workspacePath: string): Promise<string> => {
      const remoteSession = getRemoteWorkspaceSession(sessionId);
      if (!remoteSession) {
        return workspacePath;
      }

      try {
        // One directory can be entered via symlink aliases (e.g. /dev vs /home/dev);
        // persisting raw user input used to split one workspace into two identities.
        // realpath-normalize once on the remote host before identity computation and persistence.
        return await remoteSession.services.fileService.resolvePath({
          path: workspacePath,
        });
      } catch {
        return workspacePath;
      }
    },
    [],
  );

  const buildPersistedTabPatch = useCallback(
    (state: TabStoreState) =>
      buildRemoteWorkspacePersistPatch(state, remoteWorkspaceSessionsRef.current),
    [],
  );

  const handleCancelRemoteProject = useCallback(
    async (sessionId: string) => {
      try {
        await platform.disposeRemoteSession(sessionId);
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
        // If a remote directory pick is canceled before confirm, a failed release must not leave the front end stuck on a phantom pending session.
        // Always clear the local mapping, so reopening the dialog never reuses a dead session record.
        unregisterRemoteWorkspaceSession(sessionId);
      }
    },
    [platform],
  );

  const bindRemoteWorkspaceSessionContext = useCallback<BindRemoteWorkspaceSessionContextFn>(
    async ({ sessionId, workspacePath, workspaceIdentity }) => {
      // bind re-generates the renderer attachment of one remoteSessionId;
      // reuse bindRemoteWorkspaceContextAndGetSession, return after the ready ACK, and only post-await sessionId reads hit the new generation.
      await bindRemoteWorkspaceContextAndGetSession({
        platform,
        sessionId,
        workspacePath,
        workspaceIdentity,
      });
    },
    [platform],
  );

  const runReconnectRemoteWorkspaceEntry = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ): Promise<boolean> => {
      const workspaceKey = buildWorkspaceSessionKey(sessionEntry);
      if (inflightReconnectWorkspaceKeysRef.current.has(workspaceKey)) {
        return false;
      }
      const workspaceTab = tabStoreApi
        .getState()
        .tabs.find(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
        );
      if (!workspaceTab || workspaceTab.remoteSessionId) {
        return false;
      }

      resetLogsForWorkspaceKey(workspaceKey);
      inflightReconnectWorkspaceKeysRef.current.add(workspaceKey);
      const requestId = createUuid();
      pendingReconnectRequestIdsRef.current.set(workspaceKey, requestId);
      try {
        // During reconnect only silently backfill the ready remoteSessionId; activation belongs to the reconnect helper
        // after the backfill, keeping remote-waiting intermediate states off the active tab.
        const upsertWorkspaceTab = tabStoreApi.getState().ensureWorkspaceTab;
        logger.debug("[Root] Remote workspace reconnecting; keeping the current conversation", {
          workspaceKey,
        });
        await reconnectRemoteWorkspaceHistoryEntry({
          sessionEntry,
          activateTabByPath,
          setReconnectingRemoteWorkspaceKeys,
          loadCredential: services.credentialService.load,
          connectRemoteWorkspaceTarget,
          resolveRemoteWorkspaceCanonicalPath,
          disposeRemoteWorkspaceSession: handleCancelRemoteProject,
          bindRemoteWorkspaceSessionContext,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          upsertWorkspaceTab,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          logger,
          toast,
          shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
            shouldKeepRemoteWorkspaceInTabs({
              tabStoreApi,
              workspacePath,
              workspaceIdentity,
            }),
          onWorkspaceActivated: (target) => {
            logger.debug("[Root] Remote workspace ready; committing tab and draft activation", target);
            onWorkspaceActivated?.(target);
          },
          options: {
            ...options,
            requestId,
          },
        });
        return true;
      } finally {
        inflightReconnectWorkspaceKeysRef.current.delete(workspaceKey);
        if (pendingReconnectRequestIdsRef.current.get(workspaceKey) === requestId) {
          pendingReconnectRequestIdsRef.current.delete(workspaceKey);
        }
      }
    },
    [
      activateTabByPath,
      bindRemoteWorkspaceSessionContext,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      services.credentialService,
      tabStoreApi,
    ],
  );

  const runReconnectRemoteWorkspace = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ) => {
      const reconnectGroup = collectSshReconnectGroup({
        selected: sessionEntry,
        sessions: remoteWorkspaceSessionsRef.current,
        tabs: tabStoreApi.getState().tabs,
      });
      await reconnectRemoteWorkspaceGroup({
        selected: sessionEntry,
        reconnectGroup,
        reconnectEntry: runReconnectRemoteWorkspaceEntry,
        options,
      });
    },
    [runReconnectRemoteWorkspaceEntry, tabStoreApi],
  );

  useEffect(() => {
    // This used to be the startup auto-reconnect effect.
    // Deleting the effect shifts every later hook of the mounted RootInner during Fast Refresh,
    // and a useCallback reuse of the old effect slot trips React hook queue misalignment.
    // This empty effect keeps the hook slot only; startup restore still yields disconnected tabs and never connects.
    const preserveRemoteStartupReconnectEffectSlot = true;
    void preserveRemoteStartupReconnectEffectSlot;
  }, []);

  const restorePersistedSession = useCallback(
    async (settings: AppSettings) => {
      const persistedRemoteSessions = getRemoteWorkspaceSessionEntries(settings);
      setRemoteWorkspaceSessions(persistedRemoteSessions);
      remoteWorkspaceSessionsRef.current = persistedRemoteSessions;
      let conversationWorkspacePath: string | undefined;
      if (ensureConversationWorkspaceOnRestore) {
        try {
          conversationWorkspacePath = (await services.fileService.ensureConversationWorkspace())
            .path;
        } catch (error) {
          // A failed path creation must not swallow real project restore; the later explicit new-conversation keeps its retryable error path.
          logger.warn("[Root] Failed to resolve the conversation workspace during restore", { error });
        }
      }
      // Startup restore of remote workspaces reconnects only the disconnected tabs already in the task list.
      // A later background effect used to auto-fire SSH/WSL/Docker reconnects, so merely opening the app triggered remote connections and runtime uploads.
      // Reconnect now starts only from the user Reconnect button or the remote-history entry, avoiding hidden startup side effects.
      // Plain web also sets allowRemoteWorkspaceRestore false: keep the settings snapshot, restore no tabs, show no entry.
      const workspaceRestore = restorePersistedRemoteWorkspaceSessions({
        settings,
        tabStoreApi,
        allowRemoteWorkspaceRestore,
        unavailableWorkspacePath,
        conversationWorkspacePath,
        restoreMode: deferInactiveWorkspaceRestore ? "active-first" : "all",
      });
      return {
        ...(conversationWorkspacePath
          ? { excludedRecentProjectPaths: [conversationWorkspacePath] }
          : {}),
        ...(workspaceRestore?.deferredRestore
          ? { deferredRestore: workspaceRestore.deferredRestore }
          : {}),
      };
    },
    [
      allowRemoteWorkspaceRestore,
      deferInactiveWorkspaceRestore,
      ensureConversationWorkspaceOnRestore,
      services.fileService,
      tabStoreApi,
      unavailableWorkspacePath,
    ],
  );

  const handleSelectRemoteProject = useCallback(
    async (sessionId: string, path: string, localWorkspacePath?: string) => {
      try {
        await selectRemoteWorkspaceProjectFromDialog({
          canUseRemoteWorkspace,
          sessionId,
          path,
          localWorkspacePath,
          loadingMessage: intl.formatMessage({ id: "common.loading" }),
          getRemoteWorkspaceSession,
          connectionTarget: pendingConnectionTargetsBySessionIdRef.current.get(sessionId),
          getWorkspaceTabs: () => tabStoreApi.getState().tabs,
          resolveRemoteWorkspaceCanonicalPath,
          activateTabByPath,
          handleCancelRemoteProject,
          bindRemoteWorkspaceSessionContext,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          addTab,
          onWorkspaceActivated,
          refreshPinnedTasks: refreshRemotePinnedTasksForSession,
          refreshTimelineTasks: refreshRemoteTimelineTasksForSession,
        });
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
      }
    },
    [
      activateTabByPath,
      addTab,
      bindRemoteWorkspaceSessionContext,
      tabStoreApi,
      commitRemoteWorkspaceSessionMutation,
      handleCancelRemoteProject,
      intl,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      canUseRemoteWorkspace,
    ],
  );

  const handleConnectRemote = useCallback(
    async (
      options: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
    ) => {
      if (!canUseRemoteWorkspace) {
        throw new Error("Remote workspace is disabled in this mode");
      }

      return connectRemoteWorkspaceTarget(options, requestId, context);
    },
    [canUseRemoteWorkspace, connectRemoteWorkspaceTarget],
  );

  const handleReconnectRemoteWorkspace = useCallback(
    async (workspaceKey: string, options?: ReconnectRemoteWorkspaceOptions) => {
      await reconnectRemoteWorkspaceByKey({
        workspaceKey,
        canUseRemoteWorkspace,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        runReconnectRemoteWorkspace,
        options: {
          activateWorkspaceAfterReconnect: true,
          showErrorToast: true,
          throwOnFailure: false,
          ...options,
        },
      });
    },
    [canUseRemoteWorkspace, runReconnectRemoteWorkspace],
  );

  const handleOpenRemoteWorkspaceFromHistory = useCallback(
    async (workspaceKey: string) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      // Both the remote-history entry and the sidebar reconnect can hit the removed-while-reconnecting race.
      // One shared entry keeps concurrency guards, retention checks and error handling identical on both paths.
      await openRemoteWorkspaceFromHistoryEntry({
        workspaceKey,
        tabStoreApi,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        inflightReconnectWorkspaceKeys: inflightReconnectWorkspaceKeysRef.current,
        activateTabByPath,
        setReconnectingRemoteWorkspaceKeys,
        loadCredential: services.credentialService.load,
        connectRemoteWorkspaceTarget,
        resolveRemoteWorkspaceCanonicalPath,
        disposeRemoteWorkspaceSession: handleCancelRemoteProject,
        bindRemoteWorkspaceSessionContext,
        addTab,
        commitRemoteWorkspaceSessionMutation,
        createReconnectRequestId: createUuid,
        pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
        resetLogsForWorkspaceKey,
        onWorkspaceActivated,
      });
    },
    [
      activateTabByPath,
      addTab,
      bindRemoteWorkspaceSessionContext,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      onWorkspaceActivated,
      services.credentialService,
      tabStoreApi,
      canUseRemoteWorkspace,
    ],
  );

  const handleRemoteWorkspaceSessionClosed = useCallback(
    async (event: RemoteSessionClosedEvent) => {
      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      const matchedTabs = tabStoreApi
        .getState()
        .tabs.filter(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && tab.remoteSessionId === sessionId,
        );
      if (matchedTabs.length === 0) {
        unregisterRemoteWorkspaceSession(sessionId);
        return;
      }

      // After the remote host exits, the tab remoteSessionId used to stay set:
      // the UI kept showing connected and routing requests into a dead session.
      // Downgrade to disconnected immediately on the main-process session-close event; afterwards only manual reconnect.
      tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) && tab.remoteSessionId === sessionId
            ? { ...tab, remoteSessionId: undefined }
            : tab,
        ),
      }));
      unregisterRemoteWorkspaceSession(sessionId);

      const matchedWorkspaceKeys = [
        ...new Set(matchedTabs.map((tab) => buildWorkspaceSessionKey(tab))),
      ];
      const reason = [
        "Remote connection lost",
        event.exitCode != null ? `exitCode=${event.exitCode}` : null,
        event.signal ? `signal=${event.signal}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const zcodeSessionStore = useZCodeSessionStore.getState();
      const failedTaskCount = markRemoteWorkspaceRunningTasksFailed({
        tabs: matchedTabs,
        getWorkspaceState: zcodeSessionStore.getWorkspaceState,
        setTaskRuntimeState: zcodeSessionStore.setTaskRuntimeState,
        reason,
      });

      logger.warn("[Root] Remote workspace session closed", {
        sessionId,
        reason: event.reason,
        exitCode: event.exitCode,
        signal: event.signal,
        matchedWorkspaceKeys,
        failedTaskCount,
      });

      for (const workspaceKey of matchedWorkspaceKeys) {
        const sessionEntry = remoteWorkspaceSessionsRef.current.find(
          (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
        );
        if (!sessionEntry) {
          continue;
        }

        const pendingReconnectRequestId = pendingReconnectRequestIdsRef.current.get(workspaceKey);
        if (
          !shouldPersistRemoteWorkspaceFailure({
            pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
            sessionEntry,
            workspaceKey,
          })
        ) {
          logger.info("[Root] WSL session closed; skipping the failure write, awaiting the reconnect outcome", {
            pendingReconnectRequestId,
            sessionId,
            workspaceIdentity: sessionEntry.workspaceIdentity ?? null,
            workspacePath: sessionEntry.workspacePath,
            workspaceKey,
          });
          continue;
        }

        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: sessionEntry.workspacePath,
            workspaceIdentity: sessionEntry.workspaceIdentity,
            target: createRemoteTargetFromSnapshot(sessionEntry.target, {
              password: null,
              privateKeyPassphrase: null,
            }),
            lastConnectionStatus: "failed",
            lastConnectionError: reason,
            touchOpenedAt: false,
          }),
        );
      }
    },
    [commitRemoteWorkspaceSessionMutation, tabStoreApi],
  );

  const handleBotRemoteWorkspaceReconnected = useCallback(
    async (event: BotRemoteWorkspaceReconnectedEvent) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      try {
        await waitForRemoteWorkspaceSessionReady(sessionId);
        const remoteSession = getRemoteWorkspaceSession(sessionId);
        if (!remoteSession) {
          throw new Error(`Remote workspace session not found: ${sessionId}`);
        }
        if (!remoteSession.target) {
          // Bugfix: bot reconnection events come from main/host and must carry a persistable target.
          // Web-relay bridged sessions have no target and never enter the remote-history reconnect branch.
          throw new Error(`Remote workspace session missing its connection target: ${sessionId}`);
        }

        const resolvedWorkspacePath = await resolveRemoteWorkspaceCanonicalPath(
          sessionId,
          event.workspacePath,
        );
        const resolvedWorkspaceIdentity = resolveBotRemoteWorkspaceReconnectedIdentity({
          event,
          resolvedWorkspacePath,
          target: remoteSession.target,
        });

        bindRemoteWorkspacePath(resolvedWorkspacePath, sessionId);
        bindRemoteWorkspaceIdentity(resolvedWorkspaceIdentity, sessionId);
        // Bugfix: a bot-triggered remote reconnect happens in main/host, never through the sidebar React flow.
        // On the main success event, bind the created session back onto tab and remote history; only then does the UI flip to connected.
        tabStoreApi.getState().ensureWorkspaceTab(resolvedWorkspacePath, {
          remoteSessionId: sessionId,
          remoteTarget: remoteSession.target,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: resolvedWorkspacePath,
            workspaceIdentity: resolvedWorkspaceIdentity,
            target: remoteSession.target,
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
        logger.warn("[Root] Failed to sync UI state after the bot remote reconnect", {
          sessionId,
          workspacePath: event.workspacePath,
          workspaceIdentity: event.workspaceIdentity,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      canUseRemoteWorkspace,
      commitRemoteWorkspaceSessionMutation,
      resolveRemoteWorkspaceCanonicalPath,
      tabStoreApi,
      waitForRemoteWorkspaceSessionReady,
    ],
  );

  useEffect(() => {
    return platform.onRemoteSessionClosed((event) => {
      void handleRemoteWorkspaceSessionClosed(event);
    });
  }, [handleRemoteWorkspaceSessionClosed, platform]);

  useEffect(() => {
    return platform.onBotRemoteWorkspaceReconnected((event) => {
      void handleBotRemoteWorkspaceReconnected(event);
    });
  }, [handleBotRemoteWorkspaceReconnected, platform]);

  const handleRemoteWorkspaceTabsClosed = useCallback(
    (workspaceKeys: string[]) => {
      if (workspaceKeys.length === 0) {
        return;
      }

      const workspaceKeySet = new Set(workspaceKeys);

      void (async () => {
        // Closing a disconnected remote tab: no remoteSessionId on the tab yet, while main may already upload the remote runtime.
        // Cancel the pending host by reconnect requestId, so a removed UI never leaves a background upload running.
        await cancelPendingRemoteReconnectsForWorkspaceKeys({
          workspaceKeys,
          pendingRequestIds: pendingReconnectRequestIdsRef.current,
          cancelPendingRemoteConnection: platform.cancelPendingRemoteConnection
            ? (requestId) =>
                platform.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve()
            : undefined,
          logger,
        });
        setReconnectingRemoteWorkspaceKeys((currentKeys) =>
          currentKeys.filter((key) => !workspaceKeySet.has(key)),
        );

        const removal = removeRemoteWorkspaceSessionEntries(
          remoteWorkspaceSessionsRef.current,
          workspaceKeys,
        );
        if (
          removal.nextRemoteSessions.length === remoteWorkspaceSessionsRef.current.length &&
          removal.credentialKeysToDelete.length === 0
        ) {
          return;
        }

        // After the user removes a remote workspace in the sidebar, deleting the tab is not enough:
        // remoteWorkspaceSessionsRef still merges back into setting.json via the persistence patch,
        // restoring the same disconnected item next start. Treat explicit removal as history deletion
        // and clean up the history-exclusive SSH credentials, leaving no unreachable credential key.
        await syncPersistedWorkspaceSession(removal.nextRemoteSessions);
        for (const credentialKey of removal.credentialKeysToDelete) {
          try {
            await services.credentialService.delete(credentialKey);
          } catch (error) {
            logger.warn("[Root] Failed to delete credentials of the removed remote workspace", {
              credentialKey,
              error,
            });
          }
        }
      })();
    },
    [platform, services.credentialService, syncPersistedWorkspaceSession],
  );

  const remoteWorkspaceErrorByWorkspaceKey = useMemo(
    () =>
      Object.fromEntries(
        remoteWorkspaceSessions.flatMap((entry) =>
          entry.lastConnectionError?.trim()
            ? [[buildWorkspaceSessionKey(entry), entry.lastConnectionError] as const]
            : [],
        ),
      ),
    [remoteWorkspaceSessions],
  );

  return {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleOpenRemoteWorkspaceFromHistory,
    handleRemoteWorkspaceTabsClosed,
  };
}
