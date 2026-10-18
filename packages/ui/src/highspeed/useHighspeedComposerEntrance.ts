import { useEffect, useState } from "react";

/** Highspeed composer entrance: activation plays the effect, restore shows the stable state. */
export type HighspeedComposerEntrance = "activation" | "restore";

function resolveEntrance(
  cardId: string | null,
  activationCardId: string | null,
): HighspeedComposerEntrance {
  return cardId !== null && cardId === activationCardId ? "activation" : "restore";
}

/**
 * Locked per cardId: only a one-shot host activation request for this card plays the effect; switch-back,
 * snapshot restore, and remount always restore (spec 9.2).
 * The lock consumes the request at once, so later remounts see none and never replay.
 */
export function useHighspeedComposerEntrance({
  cardId,
  activationCardId,
  onActivationApplied,
}: {
  cardId: string | null;
  activationCardId: string | null;
  onActivationApplied?: (cardId: string) => void;
}): HighspeedComposerEntrance {
  const [latch, setLatch] = useState(() => ({
    cardId,
    entrance: resolveEntrance(cardId, activationCardId),
  }));
  let current = latch;
  if (latch.cardId !== cardId) {
    // Re-lock during render on identity change; a new card never renders one frame with the old entrance.
    current = { cardId, entrance: resolveEntrance(cardId, activationCardId) };
    setLatch(current);
  }
  const appliedActivationCardId = current.entrance === "activation" ? current.cardId : null;
  useEffect(() => {
    if (appliedActivationCardId !== null) onActivationApplied?.(appliedActivationCardId);
  }, [appliedActivationCardId, onActivationApplied]);
  return current.entrance;
}
