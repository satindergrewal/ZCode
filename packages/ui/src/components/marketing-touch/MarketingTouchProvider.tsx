import {
  prepareRequestVerificationClaim,
  useRequestVerificationPrewarm,
} from "@/request-security-edition/claim.js";
import { requestVerificationClaimFailureMessageId } from "@/request-security-edition/errors.js";
import { useStartPlanEntitlement } from "@/hooks/useStartPlanEntitlement.js";
import { createContext, useContext, useEffect, useCallback, useState, useRef } from "react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useOpenRewards } from "@/rewards/RewardsProvider.js";
import { useWorkspaceSidebarFooterUsageSummaryState } from "@/WorkspaceSidebarFooterUsageSummary.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import {
  requestMarketingNavigation,
  marketingNavigation,
  finishMarketingNavigation,
  marketingSettingsSections,
  waitForMarketingCapability,
} from "@/lib/marketingNavigation.js";
import { BUILTIN_MODEL_PROVIDER_IDS, ZCODE_ENV } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCloudHeroEnvironment } from "@/components/cloud-content-dialog/useCloudHeroEnvironment.js";
import { MarketingDialogs } from "@/components/marketing-touch/MarketingDialogs.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { MarketingBannerView } from "@/components/marketing-touch/MarketingBanner.js";
import {
  canOpenMarketingPopup,
  marketingLabel,
} from "@/components/marketing-touch/marketingPopupAdapter.js";
import {
  createMarketingTouchController,
  isMarketingBannerRenderable,
  type MarketingTouchController,
} from "@/components/marketing-touch/marketingTouchController.js";
import {
  createMarketingTouchPoller,
  resolveMarketingTouchPollIntervalMs,
} from "@/components/marketing-touch/marketingTouchPoller.js";
import { prepareMarketingHero } from "@/components/marketing-touch/marketingResources.js";

import { MarketingRefreshContext } from "@/components/marketing-touch/useMarketingTaskCompletionRefresh.js";

const Context = createContext<MarketingTouchController | null>(null);

// Exported for the bottom-left activity arbiter (SidebarBottomActivity) to read banner visibility; the controller stays the sole owner.
export { Context as MarketingTouchContext };

export function MarketingTouchProvider({
  children,
  desktop,
}: {
  children: ReactNode;
  desktop: boolean;
}) {
  const services = useServices();
  const platform = usePlatform();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const tabStore = useTabStoreApi();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const workspacePath = useTabStore((state) => state.activeWorkspacePath);
  const workspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const { upgradeTargetProviderId } = useWorkspaceSidebarFooterUsageSummaryState({
    enabled: true,
    workspacePath: workspacePath ?? undefined,
    workspaceIdentity: workspaceIdentity ?? undefined,
  });
  const upgradeTargetRef = useRef(upgradeTargetProviderId);
  upgradeTargetRef.current = upgradeTargetProviderId;
  const user = useZCodeStore((state) => state.user);
  const restoring = useZCodeStore((state) => state.isRestoringOAuthSession);
  const requestLogin = useZCodeStore((state) => state.requestLoginEntry);
  const openRewards = useOpenRewards();
  const openRewardsRef = useRef(openRewards);
  openRewardsRef.current = openRewards;
  const { intl, locale } = useZCodeIntl();
  const startEntitlement = useStartPlanEntitlement(
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    services.usageStatsService,
  );
  const refreshStartEntitlementRef = useRef(startEntitlement.refresh);
  refreshStartEntitlementRef.current = startEntitlement.refresh;
  const identity = user?.id ?? "anonymous";
  const createRuntime = useCallback(() => {
    const service = services.marketingTouchService;
    if (!service || restoring) return null;
    let poller: ReturnType<typeof createMarketingTouchPoller>;
    const controller = createMarketingTouchController({
      query: () => service.query({ locale }),
      report: (input) => service.report(input),
      locale,
      canOpen: canOpenMarketingPopup,
      refresh: () => poller.refresh(),
      prepare: async (delivery) => {
        const assets = services.cloudContentService;
        const visual =
          delivery.resource_position === "banner"
            ? delivery.banner.success_popup?.hero
            : delivery.popup.hero;
        const success = prepareMarketingHero(visual, assets, locale, desktop);
        const background =
          delivery.resource_position === "banner"
            ? prepareMarketingHero(delivery.banner.background, assets, locale, desktop)
            : undefined;
        let released = false;
        const release = async () => {
          if (!released) {
            released = true;
            await Promise.all([
              (async () => (await success).release())(),
              (async () => (await background)?.release())(),
            ]);
          }
        };
        if (delivery.resource_position === "banner") {
          try {
            if (!assets) throw new Error("marketing_resources_unavailable");
            const prepared = (await background)?.hero;
            if (!prepared) throw new Error("marketing_banner_unavailable");
            return {
              delivery,
              image: prepared.type === "image" ? prepared.src : undefined,
              darkImage: prepared.type === "image" ? prepared.darkSrc : undefined,
              bannerHero:
                prepared.type === "interactive_bundle" || prepared.type === "video"
                  ? prepared
                  : undefined,
              hero: null,
              success,
              release,
            };
          } catch (error) {
            void release();
            throw error;
          }
        }
        const prepared = await success;
        return { delivery, hero: prepared.hero, release };
      },
      execute: async (action, signal, phase) => {
        if (action.type === "close") return { status: "cancelled" };
        if (action.type === "navigate" || action.type === "copy_text") {
          try {
            signal.throwIfAborted();
            phase("submitting");
            if (action.type === "copy_text") {
              await waitForMarketingCapability(
                navigator.clipboard.writeText(action.args.text),
                signal,
                10_000,
              );
              signal.throwIfAborted();
              if (!controller.store.getState().dialog)
                toast(intl.formatMessage({ id: "manualClaimPlan.claim.share.copyTextSucceeded" }));
            } else if (action.args.page === "rewards") {
              // Only confirms the window-level Provider got the intent; login continuation never depends on a marketing instance destroyed on account change.
              if (!openRewardsRef.current) throw new Error("marketing_navigation_unavailable");
              await openRewardsRef.current();
            } else {
              const opening = new AbortController();
              const abortOpening = () => opening.abort();
              signal.addEventListener("abort", abortOpening, { once: true });
              try {
                await requestMarketingNavigation(action.args, signal, () => {
                  if (action.args.page === "upgrade") {
                    if (!desktop) throw new Error("marketing_navigation_unavailable");
                    const requestId = marketingNavigation.getState().request!.id;
                    if (
                      !openCodingPlanUpgrade(
                        { providerId: upgradeTargetRef.current },
                        {
                          signal: opening.signal,
                          onResult: (opened) =>
                            finishMarketingNavigation(
                              requestId,
                              opened ? undefined : new Error("marketing_upgrade_unavailable"),
                            ),
                        },
                      )
                    )
                      throw new Error("marketing_upgrade_unavailable");
                    return;
                  }
                  if (action.args.page === "settings") {
                    if (action.args.section)
                      setPendingSettingsSectionIntent(
                        marketingSettingsSections[action.args.section],
                        { modelProviderId: action.args.provider_id },
                      );
                    openSettingsTab();
                  } else if (action.args.page === "plugin_marketplace") {
                    const tabs = tabStore.getState();
                    if (!tabs.activeWorkspacePath)
                      throw new Error("marketing_navigation_unavailable");
                    requestPluginStoreOpen(action.args.plugin_id);
                    // The marketplace lives in a workspace; merely emitting the event mounts behind the settings layer — exit settings and activate the original workspace.
                    if (
                      !tabs.activateTabByPath(tabs.activeWorkspacePath, {
                        workspaceIdentity: tabs.activeWorkspaceIdentity ?? undefined,
                      })
                    )
                      throw new Error("marketing_navigation_unavailable");
                  }
                });
              } finally {
                signal.removeEventListener("abort", abortOpening);
                opening.abort();
              }
            }
            return { status: "success" };
          } catch (error) {
            const timedOut =
              error instanceof Error && error.message === "marketing_capability_timeout";
            if (!signal.aborted)
              logger.warn("[marketing-touch] capability failed", {
                action: action.type,
                reason: timedOut ? "timeout" : "unavailable",
              });
            return {
              status: signal.aborted ? "cancelled" : timedOut ? "uncertain" : "failure",
              message: intl.formatMessage({
                id: timedOut ? "marketingTouch.uncertain" : "marketingTouch.failed",
              }),
            };
          }
        }
        if (action.type === "open_url") {
          try {
            await platform.openExternal(action.args.url);
            return { status: "success" };
          } catch {
            return {
              status: "failure",
              message: intl.formatMessage({ id: "marketingTouch.failed" }),
            };
          }
        }
        if (!user) {
          requestLogin();
          return { status: "cancelled" };
        }
        let submitted = false;
        try {
          const proof = await prepareRequestVerificationClaim(
            services.codingPlanSubscriptionService,
            signal,
            () => phase("verifying"),
          );
          if (!proof)
            return {
              status: "cancelled",
              message: intl.formatMessage({ id: requestVerificationClaimFailureMessageId }),
            };
          phase("submitting");
          submitted = true;
          const result = await services.codingPlanSubscriptionService.claimManualPlan({
            planId: action.args.plan_id,
            ...proof,
          });
          signal.throwIfAborted();
          if (!result.success)
            return {
              status: "failure",
              terminal: [1001, 1002, 1003, 1004, 1005].includes(result.code),
              message: result.message?.trim()
                ? result.message
                : intl.formatMessage({ id: "manualClaimPlan.claim.failure.generic" }),
            };
          // The claim already settled success; a follow-up refresh failure only skews the local entitlement projection and cannot reverse it.
          void Promise.allSettled([
            refreshStartEntitlementRef.current({ force: true, silent: true, reason: "purchase" }),
            // After the provider migration the old service is gone; refresh the authoritative settings view instead of building a second credential-refresh chain.
            services.providerSettingsService.refresh("marketing-plan-claim"),
          ]).then((results) => {
            if (results.some((value) => value.status === "rejected"))
              logger.warn("[marketing-touch] claim succeeded but entitlement refresh failed");
          });
          // The claim result surfaces in the Controller's result dialog, so the success toast cannot duplicate it.
          return { status: "success" };
        } catch {
          if (signal.aborted) return { status: "cancelled" };
          return {
            status: submitted ? "uncertain" : "failure",
            message: intl.formatMessage({
              id: submitted ? "marketingTouch.uncertain" : "marketingTouch.failed",
            }),
          };
        }
      },
    });
    poller = createMarketingTouchPoller({
      intervalMs: resolveMarketingTouchPollIntervalMs(import.meta.env.PROD, ZCODE_ENV),
      query: async () => {
        await controller.refresh();
        await controller.showPending();
      },
      visible: () => document.visibilityState !== "hidden",
    });
    return { controller, poller };
  }, [
    services,
    platform,
    identity,
    Boolean(user),
    restoring,
    locale,
    intl,
    requestLogin,
    desktop,
    openSettingsTab,
    tabStore,
    openCodingPlanUpgrade,
  ]);
  const [runtime, setRuntime] = useState<ReturnType<typeof createRuntime>>(null);
  useEffect(() => {
    const runtime = createRuntime();
    setRuntime(runtime);
    if (!runtime) return;
    const { controller, poller } = runtime;
    const visibility = () => {
      poller.visibilityChanged();
      void controller.showPending();
    };
    const online = () => poller.refresh();
    const observer = new MutationObserver(() => {
      void controller.showPending().catch(() => {});
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    poller.refresh();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      poller.dispose();
      controller.dispose();
    };
  }, [createRuntime]);
  return (
    <Context.Provider value={runtime?.controller ?? null}>
      <MarketingRefreshContext.Provider value={runtime?.poller.refresh ?? null}>
        {children}
      </MarketingRefreshContext.Provider>
      {runtime ? <MarketingDialogs controller={runtime.controller} /> : null}
    </Context.Provider>
  );
}

export function MarketingBanner() {
  const controller = useContext(Context);
  return controller ? <ConnectedBanner controller={controller} /> : null;
}
function ConnectedBanner({ controller }: { controller: MarketingTouchController }) {
  const state = useStore(controller.store);
  const { dark } = useCloudHeroEnvironment();
  const { intl, locale } = useZCodeIntl();
  const banner = state.banner;
  useRequestVerificationPrewarm(
    Boolean(
      banner?.delivery.resource_position === "banner" &&
      (banner.image || banner.bannerHero) &&
      banner.delivery.banner.buttons.find((button) => button.action.type !== "close")?.action
        .type === "claim_zcode_plan",
    ),
  );
  // Shares the arbiter's (SidebarBottomActivity) visibility predicate so the two checks cannot drift.
  if (!isMarketingBannerRenderable(banner)) return null;
  const buttons = banner.delivery.banner.buttons;
  const action = buttons.find((button) => button.action.type !== "close");
  const close = buttons.find((button) => button.action.type === "close");
  return (
    <MarketingBannerView
      src={dark && banner.darkImage ? banner.darkImage : banner.image}
      bundle={banner.bannerHero?.type === "interactive_bundle" ? banner.bannerHero : undefined}
      video={banner.bannerHero?.type === "video" ? banner.bannerHero : undefined}
      locale={locale}
      // Image-only banners may carry empty copy; action presence is never inferred from the label.
      hasAction={Boolean(action)}
      hasClose={Boolean(close)}
      actionLabel={
        (action && marketingLabel(action.text).trim()) || intl.formatMessage({ id: "common.open" })
      }
      closeLabel={
        (close && marketingLabel(close.text).trim()) || intl.formatMessage({ id: "common.close" })
      }
      pending={state.pending}
      pendingLabel={intl.formatMessage({ id: `marketingTouch.${state.phase}` })}
      onClick={() => {
        void controller.clickBanner().catch(() => logger.warn("[marketing-touch] action failed"));
      }}
      onClose={() => {
        void controller.closeBanner();
      }}
    />
  );
}
