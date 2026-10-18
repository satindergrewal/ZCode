export function runWorkspaceVisibleCommand({
  isWorkspaceVisible,
  onReturnToWorkspace,
  run,
}: {
  isWorkspaceVisible: boolean;
  onReturnToWorkspace?: () => void;
  run: () => void;
}) {
  if (!isWorkspaceVisible) {
    // Settings only overlays the workspace; the underlying App still answers quickpick/shortcuts.
    // Running workspace commands (sidebar, terminal, file search) directly would change the covered layer beneath, reading as a no-op.
    // Switch back to the workspace first, then run, so the result is immediately visible.
    onReturnToWorkspace?.();
  }

  run();
}
