// Resident-Selection derivation for session derivatives (stable fork / pre-edit fork / side conversation).
// Extracted from v4-bridge: pure selection logic, no gateway wiring, independently regression-tested.
import type { ModelSelection } from "@zcode/contracts";
import { isHighspeedProviderId } from "@zcode/shared";

export function cloneModelSelection(
  selection: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

export function modelSelectionWithOptionFallback(
  selection: ModelSelection | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return fallback && cloneModelSelection(fallback);
  // Legacy forks may lack reasoning; the output budget is per-request, not part of the Selection.
  const reasoningLevel = selection.options?.reasoningLevel ?? fallback?.options?.reasoningLevel;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel !== undefined ? { options: { reasoningLevel } } : {}),
  };
}

/**
 * The derived session's initial resident Selection: inherit the fork-point message's, skipping speed-up card selections.
 *
 * Root cause: speed-up turns record the turn's real execution model per highspeed-card-spec 5 on user/assistant messages
 // as account:*-highspeed-card, a selectionScope=execution single-turn fact valid only paired with that turn's
 // requestAuth (speed-up turns never rewrite the resident Selection). Inherit it directly and the child session
 // resides on a credential-less speed-up provider absent from the model list: the user sees "the original model
 // did not come over" and the child's first send fails with ModelRequestAuthMissing. Skipping speed-up selections
 // falls back to the parent's resident — during speed-up that is exactly the user's original model (same basis as 3, rule 13).
 */
export function derivedSessionModelSelection(
  messageSelection: ModelSelection | undefined,
  sessionSelection: ModelSelection | undefined,
): ModelSelection | undefined {
  const inheritable =
    messageSelection && isHighspeedProviderId(messageSelection.providerId)
      ? undefined
      : messageSelection;
  return modelSelectionWithOptionFallback(inheritable, sessionSelection);
}
