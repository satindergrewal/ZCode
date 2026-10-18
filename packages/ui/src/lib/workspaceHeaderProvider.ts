import type { ZCodeProvider } from "@zcode/shared";

export function resolveWorkspaceHeaderProvider(
  activeTaskProvider: ZCodeProvider | null,
  selectedProvider: ZCodeProvider,
): ZCodeProvider {
  // While a task is open, the Header must show the task own provider;
  // otherwise a new-task-only provider switch reads as workspace-level, out of sync with the active session.
  return activeTaskProvider ?? selectedProvider;
}
