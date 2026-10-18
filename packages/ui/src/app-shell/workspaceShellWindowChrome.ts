interface WorkspaceShellWindowChromeOptions {
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  macOSMajorVersion?: number | null;
  isWindowsMaximized: boolean;
  supportsNativeRoundedCorners: boolean | null;
}

type WorkspaceShellPlatformRadiusOptions = Pick<
  WorkspaceShellWindowChromeOptions,
  "isMacDesktop" | "isWindowsDesktop" | "isLinuxDesktop" | "macOSMajorVersion"
>;

export function resolveWorkspaceShellPanelRadiusPx({
  isMacDesktop,
  isWindowsDesktop,
  macOSMajorVersion,
}: WorkspaceShellPlatformRadiusOptions): number {
  if (isWindowsDesktop) return 5;
  // Ignoring the macOS version would clash Sequoia's inner 12px radius with the native
  // window's small corners. Keep the 4px outer inset; 6px on older/unknown versions, 12px
  // only when Tahoe 26+ is positively identified.
  if (isMacDesktop) return (macOSMajorVersion ?? 0) >= 26 ? 12 : 6;
  return 12;
}

export function resolveWorkspaceShellResizeHandleInsetPx(
  options: WorkspaceShellPlatformRadiusOptions,
): number {
  return resolveWorkspaceShellPanelRadiusPx(options) + 4;
}

export function resolveWorkspaceShellWindowChromeClass({
  isMacDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  macOSMajorVersion,
  supportsNativeRoundedCorners,
}: WorkspaceShellWindowChromeOptions): string {
  // Linux matches the settings page with xl; the pane has its own inset and does not pose as the system window edge.
  if (isLinuxDesktop) return "rounded-xl border border-border";
  if (!isWindowsDesktop) {
    const radius = resolveWorkspaceShellPanelRadiusPx({ isMacDesktop, macOSMajorVersion });
    return radius === 6 ? "rounded-[6px] border border-border" : "rounded-xl border border-border";
  }

  if (supportsNativeRoundedCorners === null) {
    // While the bridge is unavailable or the first query is still in flight, "unknown"
    // must not be read as Windows 10. Keep the pre-change style so Win11 does not permanently
    // degrade to square corners on the failure path.
    return "rounded-[5px] border border-border";
  }

  if (!supportsNativeRoundedCorners) {
    // Rounding the right side purely because it is Windows would fake a window shape on
    // Windows 10, which lacks native rounded corners. Square only the right outer corners;
    // never drop the pane's existing three weak borders.
    return "rounded-l-[5px] border border-border";
  }

  // The old maximized rule treated the pane as the system window edge and stripped the
  // radius and three borders. The pane's own 4px inset must survive maximizing with full
  // radius and borders. With the 4px Windows inset, a 12px radius reads as a too-thick
  // arc; layout panes use 5px.
  return "rounded-[5px] border border-border";
}
