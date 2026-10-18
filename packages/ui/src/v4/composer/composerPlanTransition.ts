import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

/** The new tool result sets the marker directly; dedupes handled results only, never shields in-between manual rechoices. */
export function applyComposerPlanTransition(
  draft: V4ComposerDraft,
  transition: SessionConfigState["planTransition"],
): V4ComposerDraft {
  if (!transition || draft.lastPlanTransitionId === transition.toolCallId) return draft;
  return {
    ...draft,
    lastPlanTransitionId: transition.toolCallId,
    planEnabled: transition.planEnabled,
  };
}
