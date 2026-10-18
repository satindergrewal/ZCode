import { memo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";

export interface PendingCommandRecoveryBannerProps {
  entry: PendingCommandEntry;
  onResend?: () => void;
  onDismiss: () => void;
}

/** A restart-discarded startNow input supplies explicit user intent only; the component never auto-replays. */
export const PendingCommandRecoveryBanner = memo(function PendingCommandRecoveryBanner({
  entry,
  onResend,
  onDismiss,
}: PendingCommandRecoveryBannerProps) {
  const { intl } = useZCodeIntl();
  const hasReplayPayload = entry.replay.kind === "input";
  // Root cause: the recovery notice used solid warning yellow, inverting the visual hierarchy
  // against plain errors in the same bottom dock. Reuse the ChatErrorBanner default
  // surface/border/foreground.
  return (
    <div
      role="status"
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage({ id: "chat.pendingCommand.discarded" })}
      </p>
      {hasReplayPayload && onResend ? (
        <button
          type="button"
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
          onClick={onResend}
        >
          {intl.formatMessage({ id: "chat.pendingCommand.resend" })}
        </button>
      ) : null}
      <button
        type="button"
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={onDismiss}
      >
        {intl.formatMessage({ id: "chat.pendingCommand.dismiss" })}
      </button>
    </div>
  );
});
