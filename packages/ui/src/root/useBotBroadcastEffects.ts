import { useEffect } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeConfigOption } from "@zcode/shared";
import {
  buildTaskContextUsageFromUsageUpdate,
  recordTaskContextUsageUpdate,
} from "@/lib/zcodeTaskUsageFallback.js";
import { normalizeZCodeUiError } from "@/lib/zcodeUiError.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  resolveBotTaskBroadcastRefresh,
  resolveBotTaskBroadcastRuntimeStatus,
} from "@/root/botsTaskBroadcast.js";
import { resolveBotTaskStreamBroadcast } from "@/root/botsTaskStreamBroadcast.js";
import {
  insertTaskIntoTaskCaches,
  syncTaskMetaToTaskCaches,
} from "@/lib/taskListMetaSync.js";

export function syncBotTaskConfigOptionsToStore(params: {
  zcodeSessionStore: Pick<
    ReturnType<typeof useZCodeSessionStore.getState>,
    "setTaskConfigOptions"
  >;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  configOptions: ZCodeConfigOption[];
}) {
  // Bugfix: the bot /mode does not pass through ChatInputToolbar/useTaskStreamEvents.
  // setTaskConfigOptions decides by activeTaskId whether to sync into workspace configOptions,
  // and the current mode derives from configOptions, so the UI never keeps a second mode state.
  params.zcodeSessionStore.setTaskConfigOptions(
    params.workspacePath,
    params.taskId,
    params.configOptions,
    params.workspaceIdentity,
  );
}

export function shouldRefreshBotTaskList(
  event: string,
  hasTaskMeta: boolean,
): boolean {
  // Bugfix: a bot-created task carries task meta in the created broadcast, so the current impl skips the full refetch.
  // But without a task query cache for that workspace the incremental write has no landing spot and the sidebar never pulls the new task.
  // created is rare: keep one version bump as the fallback; other high-frequency events stay incremental to avoid list-flicker regressions.
  if (event === "created") {
    return true;
  }
  if (hasTaskMeta) {
    return false;
  }
  return event === "created" || event === "updated" || event === "completed" || event === "error";
}

export function shouldMirrorBotTaskStreamToStore(params: {
  activeTaskId: string | null;
  taskId: string;
  workspaceIdentity?: string;
}): boolean {
  if (params.activeTaskId !== params.taskId) {
    return true;
  }

  // Bugfix: a remote bot task stream comes from the bot runtime host and may never reach the ChatView agent stream subscription.
  // Skipping bot broadcasts for the active task hid message content until a task switch refetched the snapshot.
  return Boolean(params.workspaceIdentity?.trim());
}

export function useBotBroadcastEffects(
  services: IServiceAccessor,
  tabStoreApi: ReturnType<typeof useTabStoreApi>,
) {
  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      const stream = resolveBotTaskStreamBroadcast(
        message,
        tabStoreApi.getState().tabs,
      );
      if (stream) {
        const zcodeSessionStore = useZCodeSessionStore.getState();
        const workspaceState = zcodeSessionStore.getWorkspaceState(
          stream.workspacePath,
          stream.workspaceIdentity,
        );
        if (
          !shouldMirrorBotTaskStreamToStore({
            activeTaskId: workspaceState.activeTaskId,
            taskId: stream.taskId,
            workspaceIdentity: stream.workspaceIdentity,
          })
        ) {
          return;
        }

        // While the bot task runs in the background or a remote runtime, this window may not subscribe to the same stream.
        // Message bodies no longer replay into the renderer store: a bot prompt
        // goes through the v4 command and appears via the conversation projection (the pane subscribed to that session);
        // only running/permission/usage state syncs here for the sidebar and dialogs.
        const event = stream.event;
        switch (event.type) {
          case "agent_message_chunk":
          case "agent_thought_chunk":
          case "tool_call":
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "streaming",
              undefined,
              stream.workspaceIdentity,
            );
            break;
          case "permission_request":
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, event, stream.workspaceIdentity);
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "streaming",
              undefined,
              stream.workspaceIdentity,
            );
            break;
          case "task_complete":
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "completed",
              undefined,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            zcodeSessionStore.setTaskError(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            break;
          case "task_error": {
            const normalizedError = normalizeZCodeUiError(
              {
                message: event.error,
                detail: event.detail,
                code: event.code,
              },
              {
                fallbackCode: event.code ?? "UNKNOWN",
                traceId: event.traceId,
                taskId: event.taskId,
              },
            );
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "failed",
              normalizedError.message,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            zcodeSessionStore.setTaskError(stream.workspacePath, stream.taskId, normalizedError, stream.workspaceIdentity);
            break;
          }
          case "task_warning":
            zcodeSessionStore.setTaskError(
              stream.workspacePath,
              stream.taskId,
              normalizeZCodeUiError(
                {
                  message: event.warning,
                  detail: event.detail,
                  code: event.code,
                },
                {
                  fallbackCode: event.code ?? "WARNING",
                  traceId: event.traceId,
                  taskId: event.taskId,
                },
              ),
              stream.workspaceIdentity,
            );
            break;
          case "usage_update":
            {
              const workspaceState = zcodeSessionStore.getWorkspaceState(
                stream.workspacePath,
                stream.workspaceIdentity,
              );
              const previousUsage =
                workspaceState.taskRuntimeByTaskId[stream.taskId]?.usage ?? null;
              // taskMessagesByTaskId retired together with message replay; without the latest
              // user input, estimate via the fallback (that branch only bounds the usage popup ratio).
              const incomingUsage = {
                size: event.size,
                used: event.used,
                cost: event.cost,
                ...(event.cache ? { cache: event.cache } : {}),
                ...(event.breakdown ? { breakdown: event.breakdown } : {}),
              };
              const nextUsage = buildTaskContextUsageFromUsageUpdate({
                currentUsage: previousUsage,
                incomingUsage,
              });
              recordTaskContextUsageUpdate({
                workspacePath: stream.workspacePath,
                workspaceIdentity: stream.workspaceIdentity,
                taskId: stream.taskId,
                size: event.size,
                used: event.used,
              });
              zcodeSessionStore.setTaskContextWindow(
                stream.workspacePath,
                stream.taskId,
                event.size,
                stream.workspaceIdentity,
              );
              zcodeSessionStore.setTaskUsage(
                stream.workspacePath,
                stream.taskId,
                nextUsage,
                stream.workspaceIdentity,
              );
            }
            break;
          case "session_info_update":
            if (event.apiRetry !== undefined) {
              zcodeSessionStore.setTaskApiRetryStatus(
                stream.workspacePath,
                stream.taskId,
                event.apiRetry ?? null,
                stream.workspaceIdentity,
              );
            }
            break;
        }
        return;
      }

      const refresh = resolveBotTaskBroadcastRefresh(
        message,
        tabStoreApi.getState().tabs,
      );
      if (!refresh) {
        return;
      }
      // Bots create/advance tasks host-side and never mount the chat-view stream subscription.
      // Beyond the list refresh, task run state must sync too, or the sidebar shows the new task with no running state.
      const zcodeSessionStore = useZCodeSessionStore.getState();
      const workspaceState = zcodeSessionStore.getWorkspaceState(
        refresh.workspacePath,
        refresh.workspaceIdentity,
      );
      const provider = refresh.task?.provider ?? refresh.provider;
      const shouldSyncVisibleTaskConfig = workspaceState.activeTaskId === refresh.taskId;
      if (provider && shouldSyncVisibleTaskConfig) {
        // Bugfix: /model /mode from third-party bots change the real agent state of the current task.
        // They bypass ChatInputToolbar, and the local store never synced provider/configOptions,
        // leaving the dropdown stale while the bot replies had already switched.
        zcodeSessionStore.bindRuntimeProvider(
          refresh.workspacePath,
          provider,
          refresh.workspaceIdentity,
        );
      }
      if (refresh.configOptions) {
        syncBotTaskConfigOptionsToStore({
          zcodeSessionStore,
          workspacePath: refresh.workspacePath,
          workspaceIdentity: refresh.workspaceIdentity,
          taskId: refresh.taskId,
          configOptions: refresh.configOptions,
        });
      }
      zcodeSessionStore.setTaskRuntimeState(
        refresh.workspacePath,
        refresh.taskId,
        resolveBotTaskBroadcastRuntimeStatus(refresh.event),
        undefined,
        refresh.workspaceIdentity,
      );
      if (refresh.task) {
        // Bugfix: bot state changes used to refetch everything via bumpTaskListVersion.
        // Back-to-back prompt_sent/completed events kept rotating the sidebar queryKey, briefly invalidating cache and flickering the list.
        // With task meta present, write incrementally into the task/query cache; keep the full refetch only for legacy broadcasts without meta.
        const membership = { pinned: false, archived: false };
        if (refresh.event === "created") {
          insertTaskIntoTaskCaches({
            workspacePath: refresh.workspacePath,
            workspaceIdentity: refresh.workspaceIdentity,
            task: refresh.task,
            membership,
          });
        } else {
          syncTaskMetaToTaskCaches({
            workspacePath: refresh.workspacePath,
            workspaceIdentity: refresh.workspaceIdentity,
            task: refresh.task,
            membership,
            ensureInWorkspaceTaskCache: true,
          });
        }
      }
      // prompt_sent no longer backfills a user message locally: a bot prompt
      // enters the session event log via the v4 command, the conversation projection subscribed to that session
      // renders it naturally, and the local assembly surface retired with the legacy ChatView.
      if (refresh.event === "permission_request" && refresh.permissionRequest) {
        zcodeSessionStore.setTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.permissionRequest,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "permission_resolved" && refresh.requestId) {
        zcodeSessionStore.removeTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.requestId,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "elicitation_request" && refresh.elicitationRequest) {
        // Bugfix: after a bot channel consumes AskUserQuestion, the next question lands in the bot runtime first.
        // This window may not hold that agent stream subscription; write the new elicitation_request into the store explicitly.
        zcodeSessionStore.setTaskElicitationRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.elicitationRequest,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "elicitation_resolved" && refresh.requestId) {
        // Bugfix: when a bot submits AskUserQuestion on the user behalf, this window may miss the agent stream
        // elicitation_response. Dequeue the requestId explicitly via bots:task so the question dialog never hangs.
        zcodeSessionStore.removeTaskElicitationRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.requestId,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "completed" || refresh.event === "error") {
        zcodeSessionStore.setTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          null,
          refresh.workspaceIdentity,
        );
      }
      if (shouldRefreshBotTaskList(refresh.event, Boolean(refresh.task))) {
        zcodeSessionStore.bumpTaskListVersion(refresh.workspacePath, refresh.workspaceIdentity);
      }
    });
    return () => disposable.dispose();
  }, [services.broadcastService, tabStoreApi]);
}
