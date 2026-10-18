import { ShareIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useConversationShareSelectionStore } from "@/store/conversationShareSelectionStore.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

export function ConversationShareMenu({
  taskId,
  useWindowsCaptionSpacing = false,
}: {
  taskId: string;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const setScope = useConversationShareSelectionStore((state) => state.setScope);
  const finishSelection = useConversationShareSelectionStore((state) => state.finishSelection);
  const publishing = useConversationShareSelectionStore(
    (state) => state.dockStates[taskId]?.publishing ?? false,
  );
  const showTimeline = useConversationShareSelectionStore((state) => state.showTimeline);
  const active = useConversationShareSelectionStore(
    (state) => state.drafts[taskId]?.scope === "partial",
  );

  const handleClick = () => {
    const currentState = useConversationShareSelectionStore.getState();
    const currentlyActive = currentState.drafts[taskId]?.scope === "partial";
    if (currentState.dockStates[taskId]?.publishing) return;
    logger.debug("[conversation-share] Header entry toggled sharing", {
      taskId,
      alreadyActive: currentlyActive,
    });
    if (currentlyActive) {
      // A second click must not merely toggle the panel — there would be no way out of sharing.
      // Reuse the cancel path to clear this session's draft and dock.
      finishSelection(taskId);
    } else {
      // First entry selects everything; the panel collapses into the timeline and the left reopen entry adjusts the scope.
      setScope(taskId, "partial");
      showTimeline(taskId);
    }
  };

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      // Sharing once used a larger hit area with its own mask scaling; now it matches the neighboring toolbar buttons' size and icon rules.
      size="icon-md"
      className={cn(
        "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
        useWindowsCaptionSpacing ? "ml-3" : "ml-2.5",
        useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        active && "bg-selected",
      )}
      aria-label={intl.formatMessage({ id: "conversationShare.trigger" })}
      data-testid="conversation-share-trigger"
      aria-pressed={active}
      disabled={publishing}
      onClick={handleClick}
    >
      <ShareIcon className="size-4" />
    </Button>
  );

  return active ? (
    trigger
  ) : (
    <ControlHintTooltip
      title={intl.formatMessage({ id: "conversationShare.trigger" })}
      side="bottom"
    >
      {trigger}
    </ControlHintTooltip>
  );
}
