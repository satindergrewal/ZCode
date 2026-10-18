import { memo, useEffect } from "react";
import { App } from "@/App.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { WorkspaceSettingsLayer } from "@/root/WorkspaceSettingsLayer.js";
import type { AppProps } from "@/app-shell/types.js";
import type { RootProps } from "@/root/types.js";
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";
import { ConversationTelemetryWorkspaceAttachment } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

const StableWorkspaceApp = memo(App);

interface RootWorkspaceContentProps {
  workspaceScopedServices: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
  workspaceShellPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeWorkspacePath: string | null;
  isSettingsTabActive: boolean;
  handleConnectRemote: AppProps["onConnectRemote"];
  handleSelectRemoteProject: AppProps["onSelectRemoteProject"];
  handleCancelRemoteProject: AppProps["onCancelRemoteProject"];
  handleReconnectRemoteWorkspace: AppProps["onReconnectRemoteWorkspace"];
  handleCreateTask: AppProps["onCreateTask"];
  handleCreateConversationTask: NonNullable<AppProps["onCreateConversationTask"]>;
  handleResolveConversationWorkspace: NonNullable<AppProps["onResolveConversationWorkspace"]>;
  handleOpenWorkspace: AppProps["onOpenWorkspace"];
  handleOpenFolderFromWorkspaceMenu: AppProps["onOpenFolderFromWorkspaceMenu"];
  handleOpenRemoteWorkspace?: AppProps["onOpenRemoteWorkspace"];
  handleCreateScratchWorkspace: AppProps["onCreateScratchWorkspace"];
  remoteConnectionInProgress?: AppProps["remoteConnectionInProgress"];
  remoteWorkspaceSessions: NonNullable<AppProps["remoteWorkspaceSessions"]>;
  allowRemoteWorkspace: NonNullable<RootProps["allowRemoteWorkspace"]>;
  handleBackFromSettings: () => void;
  handleLogout?: () => void;
  onLogin?: () => void;
  user: AppProps["user"];
  reconnectingRemoteWorkspaceKeys: AppProps["reconnectingRemoteWorkspaceKeys"];
  remoteWorkspaceErrorByWorkspaceKey: AppProps["remoteWorkspaceErrorByWorkspaceKey"];
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: AppProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"];
  remoteConnectionLogs?: AppProps["remoteConnectionLogs"];
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  webRemoteControlWorkspaceSwitcher?: RootProps["webRemoteControlWorkspaceSwitcher"];
  initialWebRemoteControlMobileNavigationIntent?: RootProps["initialWebRemoteControlMobileNavigationIntent"];
  initialWebRemoteControlWorkspaceList?: RootProps["initialWebRemoteControlWorkspaceList"];
  webRemoteControlTerminalTransportState?: RootProps["webRemoteControlTerminalTransportState"];
  isDesktop?: RootProps["isDesktop"];
  isMacDesktop?: RootProps["isMacDesktop"];
  isWindowsDesktop?: RootProps["isWindowsDesktop"];
  supportsEmbeddedBrowser: NonNullable<RootProps["supportsEmbeddedBrowser"]>;
  windowsWindowControlsRightPaddingPx?: number;
}

export function RootWorkspaceContent({
  workspaceScopedServices,
  baseFeedbackService,
  workspaceShellPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeWorkspacePath,
  isSettingsTabActive,
  handleConnectRemote,
  handleSelectRemoteProject,
  handleCancelRemoteProject,
  handleReconnectRemoteWorkspace,
  handleCreateTask,
  handleCreateConversationTask,
  handleResolveConversationWorkspace,
  handleOpenWorkspace,
  handleOpenFolderFromWorkspaceMenu,
  handleOpenRemoteWorkspace,
  handleCreateScratchWorkspace,
  remoteConnectionInProgress,
  remoteWorkspaceSessions,
  allowRemoteWorkspace,
  handleBackFromSettings,
  handleLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  remoteConnectionLogs,
  allowOpenWorkspace,
  webRemoteControlWorkspaceSwitcher,
  initialWebRemoteControlMobileNavigationIntent,
  initialWebRemoteControlWorkspaceList,
  webRemoteControlTerminalTransportState,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser,
  windowsWindowControlsRightPaddingPx,
}: RootWorkspaceContentProps) {
  const workspaceKey = workspaceIdentity?.trim() || workspaceShellPath;

  useEffect(() => {
    logger.info("[RootWorkspaceContent] settings layer visibility changed", {
      isSettingsTabActive,
      workspaceShellPath,
      workspaceHiddenByLayout: false,
    });
  }, [isSettingsTabActive, workspaceShellPath]);

  return (
    <>
      <div
        className={isSettingsTabActive ? "h-full opacity-0 pointer-events-none" : "h-full"}
        aria-hidden={isSettingsTabActive}
        data-root-workspace-surface={isSettingsTabActive ? "inert" : "interactive"}
        inert={isSettingsTabActive ? true : undefined}
      >
        {/* Bugfix: settings used to conditionally swap out the whole App, so closing settings unmounted and
            rebuilt the main tree; chat/terminal local state counted as a fresh workspace entry.
            The workspace shell now stays mounted and settings just overlay it.
            The old extra workspacePath key remount also tore down sidebar and task list on cross-workspace
            task switches, which users saw as list flicker plus mount/unmount spam in the logs.
            App identity is now continuous and workspace-local state syncs internally, so neither closing
            settings nor switching workspaces remounts the tree. Do NOT hide the shell via display:none under
            settings: the sidebar entry hosts a Radix DropdownMenu, and an anchor exiting mid-close-animation
            leaves Floating UI without a reference, flashing the menu to the top-left before it disappears.
            invisible kept the geometry, but some platforms read the visibility flip as an abrupt
            visible change, so entering settings flickered the left edge.
            Now opacity-0 + pointer-events-none: layout and the menu anchor stay, no lost reference,
            and the overlay is stable transparency instead of a hard visible/hidden switch.
            Bugfix: with hidden, the mounted workspace subtree also hid quickpick popovers, so
            Cmd/Ctrl+K opened fully invisible; keep layout and only disable interaction.
            Bugfix: opacity/pointer-events alone still let underlying permission/AskUserQuestion autofocus
            steal the settings form focus; mark the workspace subtree inert until the user returns. */}
        <ConversationTelemetryWorkspaceAttachment
          enabled={isDesktop === true}
          foregroundEnabled={!isSettingsTabActive}
          services={workspaceScopedServices}
          workspacePath={workspaceShellPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={workspaceRemoteSessionId}
        >
          <ServiceProvider services={workspaceScopedServices}>
            <ScopedErrorBoundary
              scope="workspace-app"
              resetKeys={[workspaceKey]}
              variant="panel"
              className="h-full"
            >
              <StableWorkspaceApp
                services={workspaceScopedServices}
                baseFeedbackService={baseFeedbackService}
                onConnectRemote={handleConnectRemote}
                onSelectRemoteProject={handleSelectRemoteProject}
                onCancelRemoteProject={handleCancelRemoteProject}
                onReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
                onLogout={handleLogout}
                onLogin={onLogin}
                user={user}
                reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                  reconnectingRemoteWorkspaceLogsByWorkspaceKey
                }
                remoteConnectionLogs={remoteConnectionLogs}
                workspaceAbsPath={workspaceShellPath}
                workspaceRemoteSessionId={workspaceRemoteSessionId}
                workspaceIdentity={workspaceIdentity}
                onCreateTask={handleCreateTask}
                onCreateConversationTask={handleCreateConversationTask}
                onResolveConversationWorkspace={handleResolveConversationWorkspace}
                onOpenWorkspace={handleOpenWorkspace}
                onOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
                onOpenRemoteWorkspace={handleOpenRemoteWorkspace}
                onCreateScratchWorkspace={handleCreateScratchWorkspace}
                remoteConnectionInProgress={remoteConnectionInProgress}
                onReturnToWorkspace={handleBackFromSettings}
                allowOpenWorkspace={allowOpenWorkspace}
                webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
                initialWebRemoteControlMobileNavigationIntent={
                  initialWebRemoteControlMobileNavigationIntent
                }
                initialWebRemoteControlWorkspaceList={initialWebRemoteControlWorkspaceList}
                webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
                allowRemoteWorkspace={allowRemoteWorkspace}
                remoteWorkspaceSessions={remoteWorkspaceSessions}
                isWorkspaceVisible={!isSettingsTabActive}
                isDesktop={isDesktop}
                isMacDesktop={isMacDesktop}
                isWindowsDesktop={isWindowsDesktop}
                supportsEmbeddedBrowser={supportsEmbeddedBrowser}
              />
            </ScopedErrorBoundary>
          </ServiceProvider>
        </ConversationTelemetryWorkspaceAttachment>
      </div>

      {isSettingsTabActive ? (
        <ScopedErrorBoundary
          scope="workspace-settings-layer"
          resetKeys={[workspaceKey, isSettingsTabActive]}
          variant="panel"
          className="absolute inset-0 z-10"
        >
          <WorkspaceSettingsLayer
            workspaceScopedServices={workspaceScopedServices}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={activeWorkspacePath}
            onBack={activeWorkspacePath ? handleBackFromSettings : undefined}
            onCreateTask={handleCreateTask}
            onOpenWorkspace={handleOpenWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
            onLogin={onLogin}
            onLogout={handleLogout}
            user={user}
          />
        </ScopedErrorBoundary>
      ) : null}
    </>
  );
}
