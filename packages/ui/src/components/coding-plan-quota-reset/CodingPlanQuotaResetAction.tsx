import { CheckIcon, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CodingPlanResetType } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { burstCodingPlanQuotaResetConfetti } from "@/lib/codingPlanQuotaResetConfetti.js";

const MANUAL_RESET_SUCCESS_DISPLAY_MS = 600;

type CodingPlanQuotaResetActionBehavior =
  | { onOpenDialog: () => void; onReset?: never }
  | { onOpenDialog?: never; onReset: () => Promise<void> };

export function LocalizedCodingPlanQuotaResetAction({
  completedAt,
  processing,
  onOpenDialog,
  onReset,
  autoCelebrateCompletedAt,
  onAutoCelebrated,
  resetType = "FIVE_HOUR",
}: {
  completedAt: number | null;
  processing: boolean;
  /** On auto/ops completion, the used_at the Composer trigger requires to replay the confetti after the hover panel expands; null for manual resets. */
  autoCelebrateCompletedAt?: number | null;
  onAutoCelebrated?: (completedAt: number) => void;
  /** The 5-hour and weekly quotas share this button; only a11y/processing copy differs by type. */
  resetType?: CodingPlanResetType;
} & CodingPlanQuotaResetActionBehavior) {
  const { intl, locale } = useZCodeIntl();
  const completedTime = completedAt
    ? new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(completedAt)
    : null;

  return (
    <CodingPlanQuotaResetAction
      ariaLabel={intl.formatMessage({
        id:
          resetType === "WEEK"
            ? "codingPlan.quotaReset.resetAriaWeek"
            : "codingPlan.quotaReset.resetAria",
      })}
      autoCelebrateCompletedAt={autoCelebrateCompletedAt}
      completedAt={completedAt}
      completedLabel={intl.formatMessage({
        id: "codingPlan.quotaReset.completed",
      })}
      completedTooltipLabel={
        completedTime
          ? intl.formatMessage({ id: "codingPlan.quotaReset.completedAt" }, { time: completedTime })
          : undefined
      }
      processing={processing}
      processingLabel={intl.formatMessage({
        id:
          resetType === "WEEK"
            ? "codingPlan.quotaReset.processingWeek"
            : "codingPlan.quotaReset.processing",
      })}
      resetLabel={intl.formatMessage({ id: "codingPlan.quotaReset.reset" })}
      successLabel={intl.formatMessage({ id: "codingPlan.quotaReset.success" })}
      onAutoCelebrated={onAutoCelebrated}
      {...(onOpenDialog ? { onOpenDialog } : { onReset: onReset! })}
    />
  );
}

export function CodingPlanQuotaResetAction({
  ariaLabel,
  autoCelebrateCompletedAt,
  completedAt,
  completedLabel,
  completedTooltipLabel,
  processing,
  processingLabel,
  resetLabel,
  successLabel,
  onAutoCelebrated,
  onOpenDialog,
  onReset,
  onCelebrate = burstCodingPlanQuotaResetConfetti,
}: {
  ariaLabel: string;
  autoCelebrateCompletedAt?: number | null;
  completedAt: number | null;
  completedLabel: string;
  completedTooltipLabel?: string;
  processing: boolean;
  processingLabel: string;
  resetLabel: string;
  successLabel: string;
  onAutoCelebrated?: (completedAt: number) => void;
  onCelebrate?: (origin: HTMLElement) => void;
} & CodingPlanQuotaResetActionBehavior) {
  const [localProcessing, setLocalProcessing] = useState(false);
  const [successCompletedAt, setSuccessCompletedAt] = useState<number | null>(null);
  const previousCompletedAtRef = useRef(completedAt);
  const clickedOriginRef = useRef<HTMLElement | null>(null);
  const awaitingOwnCompletionRef = useRef(false);
  // The "reset done" element for auto/ops completions, used to replay confetti from the same spot as a manual reset.
  const completedTextRef = useRef<HTMLSpanElement | null>(null);
  const autoCelebratedCompletedAtRef = useRef<number | null>(null);
  const effectiveProcessing = processing || localProcessing;

  useEffect(() => {
    const previousCompletedAt = previousCompletedAtRef.current;
    previousCompletedAtRef.current = completedAt;
    if (
      completedAt === null ||
      completedAt === previousCompletedAt ||
      !awaitingOwnCompletionRef.current
    ) {
      return;
    }

    // The success animation must be driven by the server's used_at; never fake completion optimistically with Date.now() on click.
    awaitingOwnCompletionRef.current = false;
    setSuccessCompletedAt(completedAt);
    if (clickedOriginRef.current) {
      onCelebrate(clickedOriginRef.current);
    }
  }, [completedAt, onCelebrate]);

  // Auto/ops reset: after the user's hover expands the panel (Composer passes autoCelebrateCompletedAt),
  // replay confetti once from the "reset done" copy. Manual resets confetti in the click branch above; this never fires there (not armed).
  useEffect(() => {
    if (
      autoCelebrateCompletedAt == null ||
      completedAt === null ||
      autoCelebrateCompletedAt !== completedAt ||
      autoCelebratedCompletedAtRef.current === completedAt
    ) {
      return;
    }

    // Do not consume the arm the moment the layer commits to the DOM: the panel may not have finished mounting/positioning, and the animation could play to nothing.
    // Wait one frame, confirm the anchor is still connected, and mark played only after confetti actually fires; closing the layer cancels that frame.
    const frameId = window.requestAnimationFrame(() => {
      const origin = completedTextRef.current;
      if (!origin?.isConnected) {
        return;
      }
      onCelebrate(origin);
      autoCelebratedCompletedAtRef.current = completedAt;
      onAutoCelebrated?.(completedAt);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [autoCelebrateCompletedAt, completedAt, onAutoCelebrated, onCelebrate]);

  useEffect(() => {
    if (successCompletedAt === null) {
      return;
    }
    const timer = window.setTimeout(
      () => setSuccessCompletedAt(null),
      MANUAL_RESET_SUCCESS_DISPLAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [successCompletedAt]);

  const awaitingSuccessRender = Boolean(
    completedAt !== null &&
    awaitingOwnCompletionRef.current &&
    completedAt !== previousCompletedAtRef.current,
  );
  const showSuccess =
    completedAt !== null && (successCompletedAt === completedAt || awaitingSuccessRender);

  if (showSuccess) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={successLabel}
        disabled
        className="rounded-md px-1 text-ui-sm text-success hover:text-success"
      >
        <CheckIcon
          className="size-3 animate-in zoom-in-75 motion-reduce:animate-none"
          aria-hidden="true"
        />
      </Button>
    );
  }

  if (completedAt !== null) {
    const completedText = (
      <span
        ref={completedTextRef}
        // min-h matches the reset button's xs size (h-5): all three states equal height, so the completed state cannot
        // grow the quota bar's label row and misalign the values and meters of sibling bars.
        className="inline-flex min-h-5 items-center text-ui-xs text-foreground-subtlest tabular-nums"
        tabIndex={completedTooltipLabel ? 0 : undefined}
      >
        {completedLabel}
      </span>
    );

    return completedTooltipLabel ? (
      <ControlHintTooltip title={completedTooltipLabel}>{completedText}</ControlHintTooltip>
    ) : (
      completedText
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={effectiveProcessing ? processingLabel : ariaLabel}
      disabled={effectiveProcessing}
      className="rounded-md bg-interaction-confirmation-surface px-1 text-ui-sm text-interaction-confirmation-foreground hover:bg-interaction-confirmation-surface hover:text-interaction-confirmation-foreground"
      onClick={(event) => {
        if (effectiveProcessing || completedAt) {
          return;
        }
        // The entry beside the page's quota title only opens the unified dialog; it never pre-enters processing nor redeems directly.
        if (onOpenDialog) {
          onOpenDialog();
          return;
        }
        clickedOriginRef.current = event.currentTarget;
        awaitingOwnCompletionRef.current = true;
        setLocalProcessing(true);
        void onReset()
          .catch(() => {
            // Failure copy is toasted by the integration hook; the Action only restores interaction and plays no success animation.
            awaitingOwnCompletionRef.current = false;
          })
          .finally(() => {
            setLocalProcessing(false);
          });
      }}
    >
      {effectiveProcessing ? (
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        resetLabel
      )}
    </Button>
  );
}
