import { memo, useCallback, useEffect, useState } from "react";
import { FloatingParticles } from "@/components/ui/floating-particles.js";
import { HighSpeedDiffusionCanvas } from "@/v4/highspeed/HighSpeedDiffusionCanvas.js";

type HighspeedVisualPhase = "diffusing" | "handoff" | "stable";

const HIGHSPEED_HANDOFF_FALLBACK_MS = 1_000;

/**
 * Renders only the visual layer of the input shell; eligibility/expiry/model come from the outer card snapshot.
 */
export const HighspeedComposerBackground = memo(function HighspeedComposerBackground({
  animated,
  onModelTransitionStart,
}: {
  /**
   * True only for a fresh-draw activation entrance. Restores mount straight at stable, no dissolve canvas;
   * the mode applies at mount only; the host keys by cardId.
   */
  animated: boolean;
  onModelTransitionStart: () => void;
}) {
  const [phase, setPhase] = useState<HighspeedVisualPhase>(animated ? "diffusing" : "stable");
  const handleHandoffStart = useCallback(() => setPhase("handoff"), []);
  const handleDiffusionComplete = useCallback(() => setPhase("stable"), []);

  useEffect(() => {
    if (phase !== "handoff") return;
    // Bug: backgrounded/busy renderers can lose the canvas opacity transitionend, stranding the state
    // machine in handoff so the stable-only purple border and shadow vanish.
    // The normal path still settles via transitionend; the timeout only rescues lost-event runs to stable.
    const fallbackTimer = window.setTimeout(handleDiffusionComplete, HIGHSPEED_HANDOFF_FALLBACK_MS);
    return () => window.clearTimeout(fallbackTimer);
  }, [handleDiffusionComplete, phase]);

  return (
    <div
      data-testid="highspeed-composer-background"
      data-phase={phase}
      aria-hidden="true"
      className="highspeed-composer-background pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
    >
      {phase !== "stable" ? (
        <HighSpeedDiffusionCanvas
          onModelTransitionStart={onModelTransitionStart}
          onHandoffStart={handleHandoffStart}
          onComplete={handleDiffusionComplete}
        />
      ) : null}
      <FloatingParticles className="highspeed-particle-layer z-0" settled={!animated} />
    </div>
  );
});
