import type { IPlatformService, UserInfo } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { ReactNode } from "react";
import type { CreateTaskRequest } from "@/app-shell/types.js";

export interface RootProps {
  services: IServiceAccessor;
  platform: IPlatformService;
  /** When passed from the main process, skip the project picker. */
  initialWorkspaceAbsPath?: string;
  /** App-owned workspace display kind; defaults to a real project. */
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  /** The workspace precisely activated at desktop start is unavailable; this renderer lifetime only. */
  unavailableWorkspacePath?: string;
  /** Identity key of the initial workspace; remote workspaces must pass it through. */
  initialWorkspaceIdentity?: string;
  /** Initial task to open, passed through when entering from the global task list. */
  initialTaskId?: string;
  /** True from the Electron renderer; enables the custom title bar. */
  isDesktop?: boolean;
  /** macOS needs the safe area for the traffic-light buttons. */
  isMacDesktop?: boolean;
  /** Windows needs the more accurate Explorer copy. */
  isWindowsDesktop?: boolean;
  /** Whether to restore the tabs closed last time; true for the first window, false for new ones. */
  restoreSession?: boolean;
  /** Whether the local settings service is reachable; false on remote windows. */
  supportsSettings?: boolean;
  /** Whether this shell may switch or open workspaces. */
  allowOpenWorkspace?: boolean;
  /** Prefer the server-side directory browser; plain web cannot rely on the OS picker. */
  preferDirectoryBrowser?: boolean;
  /** Whether the embedded-browser side pane is supported; desktop only by default. */
  supportsEmbeddedBrowser?: boolean;
  /** Whether remote workspaces are enabled; plain web starts with local-server workspaces only. */
  allowRemoteWorkspace?: boolean;
  /** Loading kept up until the initial workspace is injected on non-desktop entries; unused on desktop. */
  initialWorkspaceLoadingFallback?: ReactNode;
  /** Assistant code-comment card rollout; off by default, keeping the raw directive while off. */
  assistantCodeCommentCardsEnabled?: boolean;
}

export interface WorkspaceSettingsLayerProps {
  workspaceScopedServices?: IServiceAccessor;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  allowOpenWorkspace?: RootProps["allowOpenWorkspace"];
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}
