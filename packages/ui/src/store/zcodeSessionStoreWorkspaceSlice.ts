import type { SessionCreateSource } from "@zcode/shared";
/* eslint-disable max-lines -- workspace-level state actions live in this one slice; keeping them together aids maintenance. */
import {
  buildNativeSupplierKey,
  normalizeAgentProviderToZCodeAgent,
  type ZCodeConfigOption,
  type ModelSelectionResolution,
  type ZCodeProvider,
  type ZCodeSlashCommand,
  type ZCodeTaskMeta,
  type ZCodeTaskRuntimeStatus,
  type ZCodeWorkspaceInitStatus,
} from "@zcode/shared";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { pushNavEntry } from "@/lib/taskNavigationHistory.js";
import { resolveTaskRestorePreloadConfigOptions } from "@/lib/taskModelRecovery.js";
import type {
  ZCodeSessionStoreState,
  ConfigOptionsStatus,
  ComposerMentionPrefill,
  GroupedDraftTaskState,
  GroupedDraftTaskPlacement,
  ModelSwitchStage,
  WorkspaceZCodeUIState,
} from "@/store/zcodeSessionStoreTypes.js";
import {
  getTaskMeta,
  getWorkspaceState,
  getWorkspaceInitState,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;

let groupedDraftSequence = 0;

function createGroupedDraftId(createdAt: number): string {
  groupedDraftSequence += 1;
  return `grouped-draft-${createdAt}-${groupedDraftSequence}`;
}

function normalizeThoughtLevelConfigOption(option: ZCodeConfigOption): ZCodeConfigOption {
  if (
    option.type !== "select" ||
    (option.id !== "thought_level" && option.category !== "thought_level")
  ) {
    return option;
  }
  const currentValue = typeof option.currentValue === "string" ? option.currentValue : "";
  if (option.options?.some((entry) => entry.value === currentValue)) {
    return option;
  }
  const fallbackValue = option.options?.[0]?.value;
  if (!fallbackValue) {
    return option;
  }
  // In model-switch races thought_level can be transiently empty; normalize in the store so the toolbar Select never sits empty-selected.
  return { ...option, currentValue: fallbackValue };
}

function normalizeConfigOptions(options: ZCodeConfigOption[]): ZCodeConfigOption[] {
  return options.map(normalizeThoughtLevelConfigOption);
}

function cloneConfigOptions(options: readonly ZCodeConfigOption[]): ZCodeConfigOption[] {
  return options.map((option) => ({
    ...option,
    options: option.options?.map((entry) => ({ ...entry })),
  }));
}

function isSameGroupedDraftPlacement(
  left: GroupedDraftTaskPlacement,
  right: GroupedDraftTaskPlacement,
): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "top") {
    return true;
  }
  return right.type === "group" && left.groupId === right.groupId;
}

function isModeConfigOption(option: ZCodeConfigOption): boolean {
  return option.category === "mode" && option.type === "select";
}

function createFallbackModeOption(params: {
  currentModeId: string;
  options?: NonNullable<ZCodeConfigOption["options"]>;
}): ZCodeConfigOption {
  const options = params.options?.length
    ? params.options
    : [{ value: params.currentModeId, name: params.currentModeId }];
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: params.currentModeId,
    options,
  };
}

function replaceModeConfigOption(
  currentOptions: ZCodeConfigOption[] | null,
  nextModeOption: ZCodeConfigOption | null,
): ZCodeConfigOption[] | null {
  const options = currentOptions ?? [];
  const modeIndex = options.findIndex(isModeConfigOption);
  if (modeIndex === -1) {
    if (!nextModeOption) {
      return currentOptions;
    }
    return normalizeConfigOptions([...options, nextModeOption]);
  }

  if (!nextModeOption) {
    return normalizeConfigOptions([
      ...options.slice(0, modeIndex),
      ...options.slice(modeIndex + 1),
    ]);
  }

  return normalizeConfigOptions([
    ...options.slice(0, modeIndex),
    nextModeOption,
    ...options.slice(modeIndex + 1),
  ]);
}

function updateCurrentModeConfigOption(
  currentOptions: ZCodeConfigOption[] | null,
  modeId: string | null,
): ZCodeConfigOption[] | null {
  const options = currentOptions ?? [];
  const existingModeOption = options.find(isModeConfigOption);
  if (!modeId) {
    if (!existingModeOption) {
      return currentOptions;
    }
    if ((existingModeOption.options?.length ?? 0) === 0) {
      return replaceModeConfigOption(currentOptions, null);
    }
    return replaceModeConfigOption(currentOptions, {
      ...existingModeOption,
      currentValue: "",
    });
  }

  if (!existingModeOption) {
    return replaceModeConfigOption(
      currentOptions,
      createFallbackModeOption({ currentModeId: modeId }),
    );
  }

  return replaceModeConfigOption(currentOptions, {
    ...existingModeOption,
    currentValue: modeId,
  });
}

function updateActiveTaskConfigOptions(
  current: WorkspaceZCodeUIState,
  updater: (options: ZCodeConfigOption[] | null) => ZCodeConfigOption[] | null,
): Pick<WorkspaceZCodeUIState, "taskConfigOptionsByTaskId"> | null {
  const activeTaskId = current.activeTaskId;
  if (!activeTaskId) {
    return null;
  }

  const currentTaskOptions = current.taskConfigOptionsByTaskId[activeTaskId];
  if (!currentTaskOptions) {
    return null;
  }

  const nextTaskOptions = updater(currentTaskOptions);
  if (nextTaskOptions === currentTaskOptions || !nextTaskOptions) {
    return null;
  }

  return {
    taskConfigOptionsByTaskId: {
      ...current.taskConfigOptionsByTaskId,
      [activeTaskId]: nextTaskOptions,
    },
  };
}

function resolveActiveTaskConfigOptionsOnSwitch(
  current: WorkspaceZCodeUIState,
  taskId: string,
): { configOptions: ZCodeConfigOption[]; status: ConfigOptionsStatus } | null {
  const cachedTaskConfigOptions = current.taskConfigOptionsByTaskId[taskId];
  if (cachedTaskConfigOptions) {
    return {
      configOptions: cachedTaskConfigOptions,
      status: current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready",
    };
  }

  const taskMeta = getTaskMeta(current, taskId);
  // On historical tasks the toolbar model and context usage come from different state buckets.
  // Without a task-level settings cache, warm the model from task meta and enter loading until runtime settings fill in,
  // instead of pairing the previous task model (e.g. glm-0531[1m]) with the current task contextWindow.
  const preloadedOptions = normalizeConfigOptions(
    resolveTaskRestorePreloadConfigOptions({
      taskMeta: {
        provider: taskMeta?.provider ?? current.selectedProvider,
        model: taskMeta?.model,
        mode: taskMeta?.mode,
        thoughtLevel: taskMeta?.thoughtLevel,
      },
    }),
  );
  if (preloadedOptions.length === 0) {
    return null;
  }

  return {
    configOptions: preloadedOptions,
    status: "loading",
  };
}

export function createWorkspaceSlice(set: SetFn) {
  return {
    setActiveTaskId: (workspacePath: string, id: string | null, workspaceIdentity?: string) => {
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [id ?? ""]: _ignoredUnreadTask, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const optimisticTask = id ? current.optimisticTaskListByTaskId[id] : undefined;
            const nextOptimisticTaskListByTaskId =
              id && typeof optimisticTask?.unreadAt === "number"
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [id]: {
                      ...optimisticTask,
                      // Mark-unread writes unreadAt into the optimistic task as well;
                      // reopening the current task used to clear only the old unread map, and the list merge wrote the dot
                      // back from the optimistic task. Opening a task must clear that projection in the same workspace transaction.
                      unreadAt: undefined,
                    },
                  }
                : current.optimisticTaskListByTaskId;
            const activeTaskId = id;
            const activeTaskConfig = activeTaskId
              ? resolveActiveTaskConfigOptionsOnSwitch(current, activeTaskId)
              : null;
            const nextState = {
              ...current,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              activeTaskId: id,
              // The grouped New-task draft row is only the current draft-state anchor.
              // Selecting a real task means leaving the transient entity: clear it at once, or the sidebar keeps an inert fake row.
              groupedDraftTask: id ? null : current.groupedDraftTask,
            };
            return activeTaskId && activeTaskConfig
              ? {
                  ...nextState,
                  taskConfigOptionsByTaskId: {
                    ...current.taskConfigOptionsByTaskId,
                    [activeTaskId]: activeTaskConfig.configOptions,
                  },
                  taskConfigOptionsStatusByTaskId: {
                    ...current.taskConfigOptionsStatusByTaskId,
                    [activeTaskId]: activeTaskConfig.status,
                  },
                }
              : nextState;
          },
          workspaceIdentity,
        );

        const navUpdate = id
          ? {
              taskNavHistory: pushNavEntry(
                state.taskNavHistory,
                workspacePath,
                id,
                workspaceIdentity,
              ),
            }
          : {};

        return { ...workspaceUpdate, ...navUpdate };
      });
    },

    promoteGroupedDraftTask: (
      workspacePath: string,
      taskId: string,
      draft: GroupedDraftTaskState,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const optimisticTask: ZCodeTaskMeta = {
              taskId,
              traceId: `session-${taskId}` as ZCodeTaskMeta["traceId"],
              title: "",
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              createdAt: draft.createdAt,
              // A renderer placeholder row plugging the ACK gap only; not session truth.
              // updatedAt uses the lowest sentinel so any authoritative sessions-index meta wins
              // in mergeTaskWithOptimisticMeta, keeping the local clock from overriding mode/provider/status.
              updatedAt: 0,
              mode: "build",
              provider: current.selectedProvider,
            };
            // Task navigation and draft-session creation are different transitions. Only the successful-create boundary
            // may bind the grouped placement captured at command time to the new task. During the ACK wait the user
            // may already sit in another draft, so clear the current draft only while the identity still matches.
            // Clearing the draft row used to precede the real task meta from sessions-index,
            // leaving a gap between the create/send ACK and the authoritative projection. The promoting transaction also writes minimal optimistic meta,
            // without faking conversation state; the desktop-continuous/web-replayable authoritative projections still finalize.
            return {
              ...current,
              groupedDraftTask:
                current.groupedDraftTask?.draftId === draft.draftId
                  ? null
                  : current.groupedDraftTask,
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                // task_created can reach the renderer before the command ACK; with richer optimistic meta already present,
                // this gap-plugging minimal row must not downgrade it.
                [taskId]: current.optimisticTaskListByTaskId[taskId] ?? optimisticTask,
              },
              promotedGroupedDraftTaskByTaskId: {
                ...current.promotedGroupedDraftTaskByTaskId,
                [taskId]: draft,
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    clearPromotedGroupedDraftTask: (
      workspacePath: string,
      taskId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (!current.promotedGroupedDraftTaskByTaskId[taskId]) {
              return current;
            }
            // The promoted placement covers the single transaction before the draft lands in SQLite ordering.
            // Consume it after persistence, or a later manual drag is pulled back to the old group by the stale placement.
            const { [taskId]: _consumedPromotedDraft, ...restPromotedGroupedDraftTaskByTaskId } =
              current.promotedGroupedDraftTaskByTaskId;
            return {
              ...current,
              promotedGroupedDraftTaskByTaskId: restPromotedGroupedDraftTaskByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setDraftSessionId: (
      workspacePath: string,
      sessionId: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.draftSessionId === sessionId) {
              return current;
            }
            return { ...current, draftSessionId: sessionId };
          },
          workspaceIdentity,
        ),
      );
    },

    invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // A protocol-v4 draft warmup session lives only inside the SessionPane; clearing the legacy
            // draftSessionId alone is not enough. The version bump lets the pane reclaim the unpromoted warmup and rebuild capability snapshots.
            draftRuntimeInvalidationVersion: current.draftRuntimeInvalidationVersion + 1,
            draftSessionId: null,
          }),
          workspaceIdentity,
        ),
      );
    },

    requestComposerTextInsert: (
      workspacePath: string,
      text: string,
      workspaceIdentity?: string,
      mention?: ComposerMentionPrefill,
      mode?: "replace" | "prepend-if-missing",
    ) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.composerTextInsertVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              composerTextInsertVersion: requestId,
              composerTextInsertRequest: {
                requestId,
                text,
                ...(mention ? { mention } : {}),
                ...(mode ? { mode } : {}),
              },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearComposerTextInsertRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.composerTextInsertRequest?.requestId === requestId
              ? { ...current, composerTextInsertRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    requestTimelineBottom: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.timelineBottomRequestVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              timelineBottomRequestVersion: requestId,
              timelineBottomRequest: { requestId, taskId },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearTimelineBottomRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.timelineBottomRequest?.requestId === requestId
              ? { ...current, timelineBottomRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    startDraft: (
      workspacePath: string,
      provider?: ZCodeProvider,
      workspaceIdentity?: string,
      options?: {
        groupedDraftPlacement?: GroupedDraftTaskPlacement;
        createSource?: SessionCreateSource;
      },
    ) => {
      const normalizedProvider = provider
        ? normalizeAgentProviderToZCodeAgent(provider)
        : undefined;

      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextSelectedProvider = normalizeAgentProviderToZCodeAgent(
              normalizedProvider ?? current.selectedProvider,
            );
            const shouldResetSupplierForDraftProvider =
              Boolean(normalizedProvider) && nextSelectedProvider !== current.selectedProvider;
            const shouldClearSlashCommands =
              current.activeTaskId !== null || shouldResetSupplierForDraftProvider;
            const shouldInheritActiveTaskConfig =
              current.activeTaskId !== null && !shouldResetSupplierForDraftProvider;
            const activeTaskIdForInheritance = shouldInheritActiveTaskConfig
              ? current.activeTaskId
              : null;
            const cachedActiveTaskConfigOptions = activeTaskIdForInheritance
              ? current.taskConfigOptionsByTaskId[activeTaskIdForInheritance]
              : null;
            const inheritedConfigOptions = activeTaskIdForInheritance
              ? cachedActiveTaskConfigOptions && cachedActiveTaskConfigOptions.length > 0
                ? cachedActiveTaskConfigOptions
                : // A protocol-v4 current-task config may have completed only the workspace projection;
                  // legacy task cache not yet written or still a first-frame empty array, while the toolbar already shows
                  // current.configOptions; a new draft must inherit the current projection, never warm up seedless.
                  current.configOptions
              : null;
            const inheritedDraftConfigOptions =
              inheritedConfigOptions && inheritedConfigOptions.length > 0
                ? cloneConfigOptions(inheritedConfigOptions)
                : null;
            const inheritedConfigOptionsStatus =
              current.activeTaskId && inheritedDraftConfigOptions
                ? (current.taskConfigOptionsStatusByTaskId[current.activeTaskId] ?? "ready")
                : current.configOptionsStatus;
            const nextGroupedDraftTask = (() => {
              const placement = options?.groupedDraftPlacement;
              if (!placement) {
                return null;
              }
              if (
                current.activeTaskId === null &&
                current.groupedDraftTask &&
                isSameGroupedDraftPlacement(current.groupedDraftTask.placement, placement)
              ) {
                return current.groupedDraftTask;
              }
              if (current.activeTaskId === null && current.groupedDraftTask) {
                // One grouped draft can be re-targeted by different New-task entries.
                // Repeated clicks on one entry reuse the transient entity, but global-entry -> group-entry must move the creation spot.
                return {
                  ...current.groupedDraftTask,
                  workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                  placement,
                };
              }
              const createdAt = Date.now();
              return {
                draftId: createGroupedDraftId(createdAt),
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                placement,
                createdAt,
              };
            })();
            return {
              ...current,
              activeTaskId: null,
              groupedDraftTask: nextGroupedDraftTask,
              draftCreateSource:
                options?.createSource ?? (options?.groupedDraftPlacement ? "group" : "session"),
              draftRuntime: { status: "idle", error: null },
              // New Task from an existing task must inherit that task full config into the draft input,
              // or the later workspace prepare rebuilds the draft from Team Plan/default models and deepseek bounces back to GLM.
              ...(inheritedDraftConfigOptions
                ? {
                    configOptions: inheritedDraftConfigOptions,
                    configOptionsStatus: inheritedConfigOptionsStatus,
                    // A stale deferred draft session may still sit on the previous default model.
                    // After inheriting the active task the draft session must be recreated, or the old session reply overwrites the new draft.
                    draftSessionId: null,
                  }
                : {}),
              draftError: null,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
              // Cmd/Ctrl+N and the task-list New task used to flip store state only, never handing focus back to the input.
              // The Electron menu/button takes focus first, so the draft looks open while the caret returns a beat later.
              // Bump a version on every draft entry so ChatView can focus the Lexical input once the state switch settles.
              draftFocusVersion: current.draftFocusVersion + 1,
              optimisticMessages: [],
              // The new-task state (taskId=null) now has its own unsent draft.
              // Entering draft state resets only this creation transient state and never clears the null-scope draft,
              // so returning to New task from taskA/B/C can still edit the unsent text.
              // A new draft inheriting the previous session slashCommands shows stale commands on /.
              // Clearing on every New task emptied the list on repeated draft clicks, with no refill triggered.
              // Clear only on task->draft or a real provider switch, sparing repeated clicks within one draft.
              ...(shouldClearSlashCommands ? { slashCommands: [] } : {}),
              ...(normalizedProvider ? { selectedProvider: nextSelectedProvider } : {}),
              ...(shouldResetSupplierForDraftProvider
                ? {
                    // Some New-task entries pass the current selectedProvider back into startDraft.
                    // Force-resetting the supplier without a real provider change tears the UI: a custom model shown with custom locked.
                    // Return to native only on a real provider switch, preserving supplier context for same-provider drafts.
                    selectedSupplierKey: buildNativeSupplierKey(nextSelectedProvider),
                    isGhostSupplier: false,
                    supplierMismatchReason: null,
                  }
                : {}),
            };
          },
          workspaceIdentity,
        ),
      );
    },

    clearGroupedDraftTask: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.groupedDraftTask ? { ...current, groupedDraftTask: null } : current,
          workspaceIdentity,
        ),
      );
    },

    bindRuntimeProvider: (
      workspacePath: string,
      provider: ZCodeProvider,
      workspaceIdentity?: string,
    ) =>
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedProvider: normalizeAgentProviderToZCodeAgent(provider),
          }),
          workspaceIdentity,
        ),
      ),

    setModelSelectionResolution: (
      workspacePath: string,
      resolution: Pick<
        ModelSelectionResolution,
        "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
      >,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedSupplierKey: resolution.selectedSupplierKey,
            isGhostSupplier: resolution.isGhostSupplier,
            supplierMismatchReason: resolution.supplierMismatchReason,
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitState: (
      workspacePath: string,
      status: ZCodeWorkspaceInitStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitAttempts: (
      workspacePath: string,
      attempts: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              attempts,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskState: (
      workspacePath: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            draftRuntime: {
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setDraftError: (
      workspacePath: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // On first-send failure there is no taskId yet; an error kept only in component memory
            // disappears across page switches. A dedicated workspace-level draftError
            // keeps the no-task-yet error visible inside the current workspace.
            draftError: error,
          }),
          workspaceIdentity,
        ),
      );
    },

    startModelSwitch: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage = "settingModel",
      workspaceIdentity?: string,
      options?: { pending?: boolean },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            modelSwitchRequestId: requestId,
            // A plain session/setModel already updated the UI optimistically; the requestId only guards stale replies.
            // Only heavy paths (custom provider, runtime restart) put the toolbar into loading.
            modelSwitchPending: options?.pending ?? true,
            modelSwitchStage: stage,
          }),
          workspaceIdentity,
        ),
      );
    },

    updateModelSwitchStage: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchStage: stage,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setConfigOptions: (
      workspacePath: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const normalizedOptions = normalizeConfigOptions(options);
        const skipped = areConfigOptionsEquivalent(current.configOptions, normalizedOptions);
        if (skipped) {
          // Without an API key or with a dead model, the toolbar recovery effect commits the same empty model config repeatedly.
          // An equal config must not notify the workspace store, or ChatInputToolbar sets configOptions again in its effect.
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // startDraft stores the active task warmup seed first, then async catalog hydration lands here.
            // A catalog refresh is not the end of the draft lifecycle; clearing the seed lets createSession fall back to the global default model.
            configOptions: normalizedOptions,
          }),
          workspaceIdentity,
        );
      });
    },

    setConfigOptionsStatus: (
      workspacePath: string,
      status: "idle" | "loading" | "ready" | "error",
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            configOptionsStatus: status,
          }),
          workspaceIdentity,
        ),
      );
    },

    setSlashCommands: (
      workspacePath: string,
      commands: ZCodeSlashCommand[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            slashCommands: commands,
          }),
          workspaceIdentity,
        ),
      );
    },

    setCurrentModeId: (
      workspacePath: string,
      modeId: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextConfigOptions = updateCurrentModeConfigOption(current.configOptions, modeId);
            const activeTaskPatch = updateActiveTaskConfigOptions(current, (options) =>
              updateCurrentModeConfigOption(options, modeId),
            );
            if (nextConfigOptions === current.configOptions && !activeTaskPatch) {
              return current;
            }
            return {
              ...current,
              configOptions: nextConfigOptions,
              // The active-task runtime ignores workspace_config_options_update, and
              // first-send/restore may already have written a model-only task config.
              // mode_update is session truth and must be mirrored into the task config bucket, or the mode entry vanishes after send.
              ...activeTaskPatch,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListVersion: current.taskListVersion + 1,
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskListCache: (
      workspacePath: string,
      tasks: ZCodeTaskMeta[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListCache: tasks,
            // Unread truth now converges on task meta.unreadAt.
            // Never rebuild the list cache into a second unread source; cache refresh and local optimistic updates would fight.
            taskUnreadByTaskId: current.taskUnreadByTaskId,
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskUnreadIndicator: (
      workspacePath: string,
      taskId: string,
      hasUnread: boolean,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const optimisticTaskMeta = current.optimisticTaskListByTaskId[taskId];
            const cachedTaskMeta = current.taskListCache?.find((task) => task.taskId === taskId);
            const baseTaskMeta = optimisticTaskMeta ?? cachedTaskMeta;
            const currentHasUnread = current.taskUnreadByTaskId[taskId] === true;
            const currentUnreadAt = optimisticTaskMeta?.unreadAt ?? cachedTaskMeta?.unreadAt;

            if (hasUnread) {
              const nextUnreadAt = baseTaskMeta?.unreadAt ?? Date.now();
              if (currentHasUnread && currentUnreadAt === nextUnreadAt) {
                return current;
              }

              const nextOptimisticTaskListByTaskId = baseTaskMeta
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [taskId]: {
                      ...baseTaskMeta,
                      unreadAt: nextUnreadAt,
                    },
                  }
                : current.optimisticTaskListByTaskId;

              return {
                ...current,
                optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
                taskUnreadByTaskId: {
                  ...current.taskUnreadByTaskId,
                  [taskId]: true,
                },
              };
            }

            if (!currentHasUnread && currentUnreadAt === undefined) {
              // After a permission confirm, both the local response and the stream response clear unread.
              // Already-read reuses the workspace state, sparing pointless task-list/ChatView refreshes.
              return current;
            }

            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const nextOptimisticTaskListByTaskId = baseTaskMeta
              ? {
                  ...current.optimisticTaskListByTaskId,
                  [taskId]: {
                    ...baseTaskMeta,
                    unreadAt: undefined,
                  },
                }
              : current.optimisticTaskListByTaskId;

            return {
              ...current,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },
  };
}
