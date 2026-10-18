import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* New-task page idle-jobs entry (Figma node 5488-3978; spec 5 Templates / D30-4 second entry).
      Onboarding banner Use-free-run-Idle-time-task + Client Scenes template cards (prefilled creation form, Customize empty).
      No render on rollout miss (D31); banner dismissible for the session (D28: returns next login/restart).
      Card click: stage the prefill draft, then open the Automations view (idle tab) whose form consumes it.
      Entry sits in the draft page's fixed bottom area (38px above bottom); templates: desktop 3-across, narrow single column.
      Business logic (rollout, Coding Plan checks, upgrade toast, draft prefill, telemetry) unchanged. */
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { Megaphone, Moon, X } from "lucide-react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useOffPeakEligibility } from "@/hooks/useOffPeakEligibility.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import {
  createIdleTimeCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanStateFromProviderSettings,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  appendLocalCustomizeTemplate,
  materializeOffPeakTemplateDraft,
  resolveOffPeakTemplateText,
  type OffPeakAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useOffPeakTaskStore, type OffPeakCreateDraft } from "@/store/offPeakTaskStore.js";
import { useMemo } from "react";

interface OffPeakNewTaskEntryProps {
  /** Opens the Automations view (idle tab); the prefill draft is staged before the card click lands. */
  onOpenAutomations?: () => void;
}

export function OffPeakNewTaskEntry({ onOpenAutomations }: OffPeakNewTaskEntryProps) {
  const { intl, locale } = useZCodeIntl();
  const { clientScenesService } = useServices();
  const { offPeak: remoteOffPeakTemplates } = useAutomationTemplates(clientScenesService);
  const offPeakTemplates = useMemo(
    () => appendLocalCustomizeTemplate(remoteOffPeakTemplates),
    [remoteOffPeakTemplates],
  );
  const { settings: sharedSettings } = useSettings();
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  useOffPeakEligibility(sharedSettings, providerSettingsView?.revision);
  const codingPlanUpgradeDialog = useOptionalCodingPlanUpgradeDialog();
  const entryGate = useCodingPlanEntryGate();
  const grayConfig = useOffPeakTaskStore((state) => state.grayConfig);
  const dismissed = useOffPeakTaskStore((state) => state.newTaskBannerDismissed);
  const dismiss = useOffPeakTaskStore((state) => state.dismissNewTaskBanner);
  const setPendingCreateDraft = useOffPeakTaskStore((state) => state.setPendingCreateDraft);

  // Rollout miss / user-dismissed -> no render (D31 exposure gate + D28 dismiss).
  if (grayConfig?.enabled !== true || dismissed) return null;

  const entryPlanState = resolveCodingPlanEntryPlanStateFromProviderSettings(providerSettingsView);
  const codingPlanUnavailable =
    grayConfig.codingPlanActive === false ||
    (grayConfig.codingPlanActive === undefined &&
      providerSettingsView !== null &&
      entryPlanState.entryPlanStatus !== "coding_plan");

  const showCodingPlanRequiredToast = () => {
    toast(entryGate.label ?? intl.formatMessage({ id: "offPeak.create.codingPlanToast" }), {
      durationMs: 8000,
      position: "top-center",
      variant: "info",
      actionLabel:
        entryGate.status === "loading"
          ? undefined
          : (entryGate.label ??
            intl.formatMessage({
              id: "settings.modelProvider.codingPlan.upgrade",
            })),
      onAction:
        entryGate.status === "error"
          ? entryGate.retry
          : () => {
              const providerId =
                sharedSettings?.providerFamilyDomain === "bigmodel"
                  ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
                  : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
              const eventText = intl.formatMessage({
                id: "settings.modelProvider.codingPlan.upgrade",
              });
              // Telemetry gap: the entry passed only providerId, so the purchase panel could not build a sourced funnel
              // nor keep attribution across OAuth. Freeze the context once at click; the global dialog carries it across sign-in.
              codingPlanUpgradeDialog?.openCodingPlanUpgrade({
                providerId,
                initialAudience: "personal",
                funnelContext: createIdleTimeCodingPlanFunnelContext({
                  providerId,
                  eventText,
                  entryPlanState,
                }),
              });
            },
      dismissible: true,
      dismissLabel: intl.formatMessage({ id: "common.close" }),
    });
  };

  const handleCardClick = (template: OffPeakAutomationTemplate) => {
    // Cause: the selected-connection gate conflated no-provider with no-plan, blocking subscribed users.
    // This page only navigates: any Coding Plan passes; form submit stays gated by Automations' selected-support check.
    if (codingPlanUnavailable) {
      logger.debug("[off-peak] blocked home template without any Coding Plan", {
        templateId: template.id,
      });
      showCodingPlanRequiredToast();
      return;
    }
    // Bugfix: home copy was i18n but the draft hardcoded English, mixing languages on the creation form for zh systems.
    // Generate same-source title/instructions per current locale at click; Customize still starts blank.
    const materialized = materializeOffPeakTemplateDraft(template, locale);
    const draft: OffPeakCreateDraft = {
      ...(template.customize ? {} : { title: materialized.title, prompt: materialized.prompt }),
      telemetrySource: {
        eventRegion: "app.session",
        templateId: template.id,
      },
    };
    setPendingCreateDraft(draft);
    onOpenAutomations?.();
  };

  return (
    // 5488-3978: the entry lives at the draft page bottom; pb-[38px] fixes the gap to the window edge.
    // Width does not extend via the @container/conversation breakpoint (declared only inside the timeline).
    <div
      data-off-peak-new-task-entry="true"
      className="flex w-full shrink-0 flex-col items-center gap-3 px-4 pb-[38px]"
    >
      {/* Onboarding banner: 32px icon slot + 4px gap + copy/tooltip, horizontally centered;
             // close button hidden this round (see note below) */}
      <div
        data-off-peak-new-task-banner="true"
        className="flex w-full max-w-[580px] items-center justify-center"
      >
        <div className="flex min-w-0 items-center gap-1 text-foreground-subtle opacity-80">
          <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
            <Megaphone className="size-4" strokeWidth={2} />
          </span>
          {/* Cause: joining eligibility note and headline into one line triggered ellipsis, hiding both
                 the headline and the parenthesized limits. The headline wraps fully and the whole text area hosts the tooltip;
                 plain text hints skip cursor-help to avoid the question-mark cursor. */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Fix: caption scales with UI font settings; relative leading keeps large sizes from clipping in a fixed 18px line box. */}
                <span
                  tabIndex={0}
                  className="min-w-0 cursor-default rounded-sm text-ui-caption font-normal leading-snug focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-hover"
                >
                  {intl.formatMessage({ id: "offPeak.newTask.bannerText" })}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="max-w-none whitespace-nowrap">
                <span>
                  {intl.formatMessage({
                    id: "offPeak.newTask.bannerTipText",
                  })}
                </span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {/* 5488-3978: no close entry yet -- product wants it hidden, not deleted;
               dismissNewTaskBanner and the offPeak.newTask dismiss semantics stay wired;
               to re-enable, swap hidden back to flex (same display group; cannot coexist). */}
        <button
          type="button"
          data-off-peak-new-task-dismiss="true"
          onClick={dismiss}
          aria-label={intl.formatMessage({ id: "common.close" })}
          className="ml-auto hidden size-8 shrink-0 items-center justify-center rounded-md text-foreground-subtle opacity-80 hover:bg-hover hover:opacity-100"
        >
          <X className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* Remote template buttons use equal-width columns: desktop row, narrow single column;
             descriptions take no fixed height; the tallest sibling stretches the card. */}
      <div
        data-off-peak-template-grid="true"
        className="grid w-full max-w-[780px] grid-cols-1 gap-4 sm:grid-cols-3"
      >
        {offPeakTemplates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => handleCardClick(template)}
            className="flex h-full w-full flex-col gap-2 rounded-2xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-surface-hover"
          >
            <div className="flex items-center gap-1.5 text-foreground">
              <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                <ClientSceneLucideIcon
                  name={template.iconName}
                  aria-hidden="true"
                  className="size-4"
                  size={16}
                  strokeWidth={2}
                  fallback={
                    <Moon
                      aria-hidden="true"
                      className="size-4"
                      data-off-peak-homepage-template-icon="moon"
                      size={16}
                      strokeWidth={2}
                    />
                  }
                />
              </span>
              <span className="truncate text-ui-base leading-5 text-foreground">
                {resolveOffPeakTemplateText(template, "title", locale, intl.formatMessage)}
              </span>
            </div>
            <p className="text-wrap-phrase line-clamp-2 text-ui-caption font-normal leading-snug text-foreground-subtle">
              {resolveOffPeakTemplateText(
                template,
                "homepageDescription",
                locale,
                intl.formatMessage,
              )}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
