import type { ZCodeProvider } from "@zcode/shared";

type DraftWorkspacePrepareReason = "mount" | "select-provider";
type WorkspacePrepareReason = DraftWorkspacePrepareReason | "retry" | "first-send";

interface ResolveDraftWorkspacePrepareReasonOptions {
  previousDraftProvider: ZCodeProvider | null;
  previousTaskProvider: ZCodeProvider | null;
  selectedProvider: ZCodeProvider;
  returningFromTask: boolean;
}

export function resolveDraftWorkspacePrepareReason({
  previousDraftProvider,
  previousTaskProvider,
  selectedProvider,
  returningFromTask,
}: ResolveDraftWorkspacePrepareReasonOptions): DraftWorkspacePrepareReason {
  // Bugfix: on task->draft, a provider switched inside the task used to
  // read as mount, letting the draft inherit the previous provider's configOptions
  // and the picker showing the old model. Classify provider changes as select-provider first,
  // mount only when the provider is unchanged -- correct and loading-free.
  if (previousDraftProvider === null) {
    return "mount";
  }

  if (returningFromTask) {
    // Bugfix: the next draft's provider may change via the sidebar while the old task view still shows.
    // That writes workspace.selectedProvider early, so a previousDraftProvider-only
    // comparison misreads no-change. Compare against the provider frozen at task-leave
    // so task->draft detects the cross-provider switch and cleans config via select-provider.
    const taskProviderBeforeDraft = previousTaskProvider ?? previousDraftProvider;
    return taskProviderBeforeDraft === selectedProvider ? "mount" : "select-provider";
  }

  return previousDraftProvider === selectedProvider ? "mount" : "select-provider";
}

interface ShouldShowDraftWorkspacePrepareLoadingOptions {
  taskId: string | null;
  reason: WorkspacePrepareReason;
  hasHydratedConfigOptions: boolean;
}

export function shouldShowDraftWorkspacePrepareLoading({
  taskId,
  reason,
  hasHydratedConfigOptions,
}: ShouldShowDraftWorkspacePrepareLoadingOptions): boolean {
  if (taskId) {
    return false;
  }

  if (reason === "select-provider") {
    return true;
  }

  // Bugfix: on cold start selectedProvider restores from the last choice
  // while the model config waits on the async prepareWorkspace.
  // The mount path never entered loading, so the toolbar showed the default agent
  // with no loading hint. Enter loading only while no configOptions snapshot exists yet --
  // fixing the silent first paint without re-flashing on task->draft.
  return reason === "mount" && !hasHydratedConfigOptions;
}
