import type {
  IPlatformService,
  UserInfo,
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceSwitchOptions,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { ReactNode } from "react";
import type { CreateTaskRequest } from "@/app-shell/types.js";

export type WebRemoteControlTerminalTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "kicked"
  | "error";

export interface WebRemoteControlWorkspaceSwitcherApi {
  listWorkspaces(): Promise<WebRemoteControlWorkspaceListResult>;
  onWorkspaceListUpdated?(
    listener: (result: WebRemoteControlWorkspaceListResult) => void,
  ): () => void;
  switchWorkspace(
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ): Promise<void>;
  /** Phone task home confirms the user saw unread tasks in the current bridge; unused by desktop task selection. */
  markTaskRead?(task: WebRemoteControlTaskTarget): Promise<void>;
  updateMobileViewState?(workspaceKey: string, taskId?: string): Promise<void>;
  reconnectWorkspace?(workspaceKey: string): Promise<void>;
  startDraft?(
    workspaceKey: string,
    options?: { mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent },
  ): Promise<void>;
}

export interface RootProps {
  services: IServiceAccessor;
  platform: IPlatformService;
  /** Skips the project picker when passed from the main process. */
  initialWorkspaceAbsPath?: string;
  /** App-owned workspace display kind; defaults to a real project. */
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  /** The desktop-startup exactly-active local workspace was unavailable; this renderer session only. */
  unavailableWorkspacePath?: string;
  /** Identity isolation key of the initial workspace; required for remote workspaces. */
  initialWorkspaceIdentity?: string;
  /** Initial task to open, passed when entering from the global task list. */
  initialTaskId?: string;
  /** True in the Electron renderer; enables the custom title bar. */
  isDesktop?: boolean;
  /** macOS desktop reserves safe space for the traffic lights. */
  isMacDesktop?: boolean;
  /** Windows desktop needs more precise Explorer copy. */
  isWindowsDesktop?: boolean;
  /** Restore tabs closed last session; true for the first window, false for new ones. */
  restoreSession?: boolean;
  /** Whether the local settings service is reachable; false in remote windows. */
  supportsSettings?: boolean;
  /** Whether this shell may switch or add workspaces. */
  allowOpenWorkspace?: boolean;
  /** Prefer the server directory browser; plain web cannot rely on the system picker. */
  preferDirectoryBrowser?: boolean;
  /** Whether the Electron embedded-browser side pane is supported (desktop only by default). */
  supportsEmbeddedBrowser?: boolean;
  /** Whether remote workspaces are enabled; plain web starts local-server-only. */
  allowRemoteWorkspace?: boolean;
  /** Switcher for already-open workspaces in web remote control mode. */
  webRemoteControlWorkspaceSwitcher?: WebRemoteControlWorkspaceSwitcherApi;
  /** One-shot mobile destination after a cross-workspace task click in web remote. */
  initialWebRemoteControlMobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  /** Workspaces/tasks prefetched for the phone home when no bridgeable workspace exists. */
  initialWebRemoteControlWorkspaceList?: WebRemoteControlWorkspaceListResult;
  /** Relay terminal transport state for phone web remote; drives the light recovery hint after entry. */
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
  /** Entry loading kept until the phone web-remote initial workspace is injected; unused on desktop. */
  initialWorkspaceLoadingFallback?: ReactNode;
  /** Web remote control entry flag; development-only by default. */
  webRemoteControlFeatureEnabled?: boolean;
  /** Assistant code-comment card rollout; off keeps the raw directive. */
  assistantCodeCommentCardsEnabled?: boolean;
}

export interface WorkspaceSettingsLayerProps {
  workspaceScopedServices?: IServiceAccessor;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isWebRemoteControl?: boolean;
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
