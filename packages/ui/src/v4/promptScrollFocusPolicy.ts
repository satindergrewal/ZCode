import type { InputRouting } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationComposerSendOptions } from "@/v4/ConversationComposer.js";

interface PromptScrollFocusPolicyInput {
  draftMode: boolean;
  inputRoutingMode: InputRouting["mode"] | null;
  heldQueueDisposition?: ConversationComposerSendOptions["heldQueueDisposition"];
}

/**
 * Focus the timeline bottom only when a new prompt takes the immediate-send path.
 * Reason: enqueue expresses future intent while the user may be reading; queueing never steals the reading position;
 * both explicit dispositions of a held choice startNow immediately, same as a plain direct send.
 */
export function shouldFocusTimelineAfterComposerSend(input: PromptScrollFocusPolicyInput): boolean {
  if (input.draftMode) return true;
  if (input.heldQueueDisposition) return true;
  return input.inputRoutingMode === "startNow";
}
