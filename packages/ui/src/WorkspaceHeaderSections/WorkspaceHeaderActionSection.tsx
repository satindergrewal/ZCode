import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { WorkspaceTerminalToggleButton } from "@/WorkspaceTerminalToggleButton.js";
import { cn } from "@/components/lib/utils.js";
import type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";

export type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeaderActionSection({
  variant = "task",
  activeTaskId,
  user,
  readOnlyReason,
  workspaceAbsPath,
  workspaceIdentity,
  remoteTarget,
  isWebRemoteControl = false,
  isDesktop,
  isTerminalOpen,
  isSidePaneOpen,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onSelectedEditorChange,
  simplifyForNarrowRemote = false,
  hideHelpMenu = false,
  showWindowControls = false,
  useWindowsCaptionSpacing = false,
}: WorkspaceHeaderActionSectionProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center [app-region:no-drag]",
        // Windows header padding p-2 caps normal hover at 32px;
        // title buttons offset it for the same 48px face as native controls.
        useWindowsCaptionSpacing ? "-my-2 h-12 gap-0" : "gap-0.5",
      )}
    >
      {variant === "task" ? (
        <WorkspaceEditorButtonGroup
          disabledReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteTarget={remoteTarget}
          onSelectedEditorChange={onSelectedEditorChange}
        />
      ) : null}
      {/* Publish needs auth; hide the entry signed-out instead of a guaranteed failure. */}
      {activeTaskId &&
      user &&
      isDesktop !== false &&
      !isWebRemoteControl &&
      remoteTarget?.kind !== "server" ? (
        <ConversationShareMenu
          taskId={activeTaskId}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {!simplifyForNarrowRemote ? (
        <>
          {!hideHelpMenu ? <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} /> : null}
          {/* Bugfix: phone-remote header is narrow; terminal fights core actions for width. */}
          <WorkspaceTerminalToggleButton
            isTerminalOpen={isTerminalOpen}
            onToggleTerminal={onToggleTerminal}
            disabledReason={readOnlyReason}
            useWindowsCaptionSpacing={useWindowsCaptionSpacing}
          />
        </>
      ) : null}
      {/* Phone remote keeps icons only; diff counts widen the button into the title. */}
      {!isSidePaneOpen ? (
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen={isSidePaneOpen}
          onToggleSidePane={onToggleSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {showWindowControls && !isSidePaneOpen ? <DesktopWindowControls /> : null}
    </div>
  );
}
