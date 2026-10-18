import type { SessionCreateSource } from "@zcode/shared";
/* eslint-disable max-lines -- workspace-level state actions live in one slice, on purpose */
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
import { persistLastSelectedAgentProvider } from "@/lib/zcodeProviderPreference.js";
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
  // Model-switch races can leave thought_level briefly empty; normalize in the store so the toolbar Select never sits empty-selected.
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
  // Historical tasks source toolbar model and context usage from different buckets.
  // Without a per-task settings cache, prewarm the model from task meta and wait loading for runtime settings,
  // never showing the previous task's model (glm-0531[1m]) with this task's contextWindow.
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
                      // Marking unread writes unreadAt into the optimistic task too;
                      // reopening the current task cleared only the legacy unread map while the merge re-added
                      // the dot from the optimistic task; clear that projection in the same workspace transaction.
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
              // The grouped New task draft row is only the current draft anchor.
              // Selecting a real task means leaving it: clear immediately, or a dead fake row sticks in the sidebar.
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
              // A renderer placeholder bridging the ACK gap, not session truth.
              // updatedAt uses the lowest sentinel so any authoritative sessions-index meta wins
              // in mergeTaskWithOptimisticMeta; the local clock must not outrank mode/provider/status.
              updatedAt: 0,
              mode: "default",
              provider: current.selectedProvider,
            };
            // Task navigation and draft creation are different transitions. Only the successful-create boundary
            // binds the captured grouped placement to the new task. During the ACK wait the user
            // may already be in another draft, so clear the current draft only while identity still matches.
            // Clearing the draft row used to precede real task meta (sessions-index only),
            // flashing a gap between create/send ACK and the authoritative projection. Promote now writes
            // minimal optimistic meta without faking conversation state; desktop-continuous/web-replayable projections settle it.
            return {
              ...current,
              groupedDraftTask:
                current.groupedDraftTask?.draftId === draft.draftId
                  ? null
                  : current.groupedDraftTask,
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                // task_created can beat the command ACK to the renderer; with richer optimistic meta present,
                // never let this gap-bridging minimal row downgrade it.
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
            // Promoted placement covers the single promote-to-sqlite transaction only.
            // Consume it once persisted, or a later manual drag gets pulled back by the stale placement.
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
            // protocol-v4 prewarmed draft sessions live only in SessionPane; clearing legacy draftSessionId
            // is not enough. Bump the version so the pane reclaims unpromoted prewarms and rebuild capability snapshots.
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
      if (normalizedProvider) {
        persistLastSelectedAgentProvider(normalizedProvider);
      }

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
                : // Bug rationale: protocol-v4 current-task config may exist only as a workspace projection,
                  // with the legacy task cache unwritten or an empty first frame. The toolbar already
                  // shows current.configOptions; new drafts must inherit it, never prewarm unseeded.
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
                // One grouped draft can be re-anchored by different New task entries.
                // Repeat clicks reuse the transient entity, but global-entry to group-entry switches must move creation with it.
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
              // New Task from a task must inherit that task's full config into the draft input.
              // Otherwise the later workspace prepare rebuilds per Team Plan/default and bounces the model to GLM.
              ...(inheritedDraftConfigOptions
                ? {
                    configOptions: inheritedDraftConfigOptions,
                    configOptionsStatus: inheritedConfigOptionsStatus,
                    // A legacy deferred draft may still sit on the previous default model.
                    // After inheriting the active task, recreate the draft session so stale replies cannot overwrite it.
                    draftSessionId: null,
                  }
                : {}),
              draftError: null,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
              // Cmd/Ctrl+N and the list's New Task only flipped store state, never restoring focus to the input.
              // Electron menus/buttons take focus first: the draft opens but the cursor returns a beat late.
              // Bump a version on every draft entry so ChatView can focus the Lexical input once the transition settles.
              draftFocusVersion: current.draftFocusVersion + 1,
              optimisticMessages: [],
              // The new-task state (taskId null) now has its own unsent draft.
              // Draft entry resets only this creation's transient state, never the null-scope draft,
              // so returning from taskA/B/C keeps the unsent text editable.
              // A new draft inheriting the previous session's slashCommands shows stale commands on slash.
              // Unconditional clears on every New-task entry emptied the list on repeat clicks, with no refill.
              // Clear only on task-to-draft or real provider switches, sparing repeat clicks in the same draft.
              ...(shouldClearSlashCommands ? { slashCommands: [] } : {}),
              ...(normalizedProvider ? { selectedProvider: nextSelectedProvider } : {}),
              ...(shouldResetSupplierForDraftProvider
                ? {
                    // Some New task entries echo the current selectedProvider back into startDraft.
                    // Resetting the supplier without a real change tears the state: custom model shown, custom option locked.
                    // Return to native only on a real provider switch, sparing same-provider drafts' supplier context.
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
            // A failed first send has no taskId yet; an error held only in component memory
            // vanishes on navigation. Keep a workspace-level draftError so
            // pre-task errors stay visible in this workspace.
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
            // Plain session/setModel already updated optimistically; the requestId only guards stale replies.
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
          // Without an API key or with a dead model, the toolbar recovery effect resubmits the same empty config.
          // Equal configs must not notify the workspace store, or ChatInputToolbar setConfigOptions loops in effect.
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // startDraft persists the active task's prewarm seed; the async catalog hydration lands here after.
            // A catalog refresh is no draft-lifecycle end: keep the seed, or createSession falls back to the global default model.
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
              // The active task's runtime ignores workspace_config_options_update,
              // while first-send/restore may have written a model-only task config.
              // mode_update is the session truth: sync it into the task bucket or the mode entry vanishes after send.
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
            // Unread truth is unified in task meta.unreadAt.
            // Stop rebuilding the list cache into a second unread source; cache refresh and optimistic updates would fight.
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
              // Both the local response and the stream response clear unread after permission confirmation.
              // Already-read reuses workspace state, sparing pointless task list and ChatView refreshes.
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
