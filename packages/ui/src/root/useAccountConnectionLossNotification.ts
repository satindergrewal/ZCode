import { useEffect, useRef } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast, dismissToast } from "@/components/ui/toast.js";
import {
  createAccountConnectionRefreshObserver,
  type AccountConnectionLoss,
} from "@/root/accountConnectionRefreshObserver.js";
import { prepareAccountConnectionSwitch } from "@/root/accountConnectionLossSuggestion.js";
import { logger } from "@/logger.js";

/** The root layer observes once; page/copy changes never re-baseline the account. */
export function useAccountConnectionLossNotification(
  services: IServiceAccessor,
  intentKey: string,
  refreshAppSettings?: () => Promise<void>,
) {
  const { intl } = useZCodeIntl();
  const latest = useRef({ intl, refreshAppSettings });
  latest.current = { intl, refreshAppSettings };
  const observerRef = useRef<ReturnType<typeof createAccountConnectionRefreshObserver> | null>(
    null,
  );
  const noticeRef = useRef<{ id: number; event: AccountConnectionLoss } | null>(null);
  useEffect(() => {
    // Settings/login intent precedes the account query response; even after switching away and back, the stale button must not become valid again.
    observerRef.current?.invalidate();
    if (noticeRef.current) dismissToast(noticeRef.current.id);
    noticeRef.current = null;
  }, [intentKey]);
  useEffect(() => {
    const observer = createAccountConnectionRefreshObserver(async (event) => {
      let suggestion: Awaited<ReturnType<typeof prepareAccountConnectionSwitch>> = null;
      try {
        suggestion = await prepareAccountConnectionSwitch(services, event);
      } catch (error) {
        logger.lifecycle.warn("[AccountConnection] Could not confirm the alternate plan; surfacing status only", { error });
      }
      if (!event.isCurrent()) return;
      const { intl: copy } = latest.current;
      const label =
        suggestion?.label ??
        (suggestion
          ? copy.formatMessage({
              id:
                suggestion.selection.kind === "start-plan"
                  ? "settings.modelProvider.codingPlan.purchaseBanner.startPlanTitle"
                  : "settings.modelProvider.codingPlan.purchase.individualsSectionTitle",
            })
          : "");
      const target = suggestion;
      let id: number;
      let submitting = false;
      const submit = () => {
        if (!target || submitting) return;
        submitting = true;
        void (async () => {
          try {
            const result = await target.apply();
            dismissToast(id);
            if (result === "stale") {
              toast(
                latest.current.intl.formatMessage({
                  id: "settings.modelProvider.connectionSuggestionStale",
                }),
                { variant: "info" },
              );
              return;
            }
            // The conditional write succeeded; this only refreshes the display, and a refresh failure is not a save failure.
            try {
              await latest.current.refreshAppSettings?.();
            } catch (error) {
              logger.lifecycle.warn("[AccountConnection] Connection saved; settings snapshot refresh failed", { error });
            }
          } catch (error) {
            logger.lifecycle.warn("[AccountConnection] Manual plan switch failed", { error });
            if (!event.isCurrent()) return;
            // Toast clicks auto-dismiss. On failure, offer an explicit retry of the same suggestion; never pick a new target in the background.
            id = toast(
              latest.current.intl.formatMessage({
                id: "settings.modelProvider.connectionSwitchFailed",
              }),
              {
                variant: "warning",
                durationMs: 12000,
                actionLabel: latest.current.intl.formatMessage({ id: "common.retry" }),
                onAction: submit,
              },
            );
            noticeRef.current = { id, event };
          } finally {
            submitting = false;
          }
        })();
      };
      id = toast(copy.formatMessage({ id: "settings.modelProvider.connectionUnavailableNotice" }), {
        variant: "info",
        durationMs: 12000,
        actionLabel: target
          ? copy.formatMessage(
              { id: "settings.modelProvider.switchConnection" },
              { connection: label },
            )
          : undefined,
        onAction: target ? submit : undefined,
      });
      noticeRef.current = { id, event };
    });
    observerRef.current = observer;
    const accept = (view: Parameters<typeof observer.accept>[0]) => {
      void observer.accept(view);
      const notice = noticeRef.current;
      if (notice && !notice.event.isCurrent()) {
        dismissToast(notice.id);
        noticeRef.current = null;
      }
    };
    const subscription = services.providerSettingsService.onDidChange(accept);
    void services.providerSettingsService
      .getView()
      .then(accept)
      .catch((error) => {
        logger.lifecycle.warn("[AccountConnection] Initial read failed; waiting for the regular refresh", { error });
      });
    return () => {
      observer.dispose();
      observerRef.current = null;
      subscription.dispose();
      if (noticeRef.current) dismissToast(noticeRef.current.id);
      noticeRef.current = null;
    };
  }, [services]);
}
