import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback } from "react";
import type { ModelSelectionView } from "@zcode/provider";
import {
  TID_START_PLAN_RECOMMENDATION_DIALOG,
  isStartPlanModelProviderId,
  type ModelSelection,
} from "@zcode/shared";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { resolveStartPlanRecommendation } from "@/lib/startPlanRecommendation.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/** The recommendation only edits this submission's choice; settings and entitlement remain owned by the App/Host services. */
export function useStartPlanRecommendation(
  view: ModelSelectionView | null | undefined,
  surface?: "subagent",
) {
  const services = useOptionalBaseWorkspaceServices();
  const { intl } = useZCodeIntl();
  const requestChoice = useConfirmDialogStore((state) => state.requestChoice);
  // The Registry has already validated login brand, entitlement, and model config; never infer the execution identity from display names.
  const start = view?.providers.find((provider) => isStartPlanModelProviderId(provider.providerId));
  const settings = useProviderSettingsView();
  const entitlement = useUsageEntitlementWithService(services?.usageStatsService, {
    ...buildStartPlanEntitlementOptions(
      settings.state.status === "ready" ? settings.state.view : null,
      start?.providerId ?? "",
    ),
    refreshOnMount: true,
    mountRefreshReason: "access",
  });
  return useCallback(
    async (selection: ModelSelection): Promise<ModelSelection | null> => {
      // Submission never waits on the network; expired entitlements skip the recommendation, and access refresh keeps the one-minute throttle with failure backoff.
      void entitlement.refresh({ silent: true, reason: "access" });
      const candidate = entitlement.error
        ? null
        : resolveStartPlanRecommendation(selection, view, entitlement.snapshot);
      if (!candidate || !services) return selection;
      try {
        // Read the same Host's preference each time, so a choice made via the other entry point or on the phone applies to the next submission.
        if ((await services.settingService.get()).startPlanRecommendationDismissed)
          return selection;
      } catch (error) {
        logger.warn("[StartRecommendation] failed to read preference; keeping original selection", { error });
        return selection;
      }
      let dismissed = false;
      const choice = await requestChoice({
        testId: TID_START_PLAN_RECOMMENDATION_DIALOG,
        title: intl.formatMessage({ id: "startPlan.recommendation.title" }),
        description: intl.formatMessage(
          {
            id:
              surface === "subagent"
                ? "startPlan.recommendation.subagentDescription"
                : "startPlan.recommendation.description",
          },
          { model: selection.modelId },
        ),
        confirmLabel: intl.formatMessage({ id: "startPlan.recommendation.switch" }),
        cancelLabel: intl.formatMessage({ id: "startPlan.recommendation.decline" }),
        showCloseButton: true,
        showKeyboardHints: false,
        checkbox: {
          label: intl.formatMessage({ id: "startPlan.recommendation.dismiss" }),
          onCheckedChange: (checked) => {
            dismissed = checked;
          },
        },
      });
      if (choice === "dismiss") return null;
      if (dismissed) {
        try {
          await services.settingService.update({ startPlanRecommendationDismissed: true });
        } catch (error) {
          logger.warn("[StartRecommendation] failed to save preference", { error });
          toast(intl.formatMessage({ id: "startPlan.recommendation.preferenceSaveFailed" }));
        }
      }
      return choice === "confirm" ? candidate : selection;
    },
    [
      entitlement.error,
      entitlement.snapshot,
      entitlement.refresh,
      intl,
      requestChoice,
      services,
      surface,
      view,
    ],
  );
}
