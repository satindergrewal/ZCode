import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- the Model Provider detail page currently orchestrates the Plan Card, API Key form, and OAuth plan states together; split by family/API/OAuth once stable. */
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  ZAI_PROVIDER_ID,
  type BuiltinModelProviderId,
  type ProviderFamilyConnectionSelectionSettings,
  type StartPlanPreviewConfig,
  isStartPlanModelProviderId,
  isIndividualCodingPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  type ModelConnectivityResult,
  type OAuthProviderId,
} from "@zcode/shared";
import {
  getProviderFormApiKeyManagementUrl,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import { ArrowRightIcon, AstroidIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  type CodingPlanStatus,
  type CodingPlanProviderId,
  type ModelProviderNavItem,
} from "./constants.js";
import { InlineEditableProviderCard } from "./InlineEditableProviderCard.js";
import {
  ModelProviderLoadingCard,
  PresetProviderPlaceholderCard,
  CodingPlanStatusPanel,
} from "./StatusCards.js";
import {
  resolveCodingPlanUpgradeProductsProviderId,
  type CodingPlanLoginOptions,
} from "./codingPlanPricingCards.js";
import {
  type EnterpriseCodingPlanProductGroup,
  type PurchaseAudience,
} from "./codingPlanEnterpriseTiers.js";
import { resolveCodingPlanStatusPanelViewState } from "./codingPlanStatusPanelViewState.js";
import {
  formatCodingPlanAmount,
  pickProductPrice,
  type CodingPlanProductDisplay,
} from "./codingPlanProductPresentation.js";
import {
  ProviderFamilyDetailShell,
  ProviderFamilyHeader,
  ProviderFamilyPlanModeSwitch,
} from "./ProviderFamilyModeHeader.js";
import { resolveStartPlanEntitlementSummary } from "./StartPlanCard.js";
import { useCodingPlanProducts } from "./useCodingPlanProducts.js";
import { useEnterpriseCodingPlanProducts } from "./useEnterpriseCodingPlanProducts.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import type { ProviderSettingsView } from "@zcode/services";
import type { SavePersonalModelDraftInput } from "@zcode/provider";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import { projectProviderSettingsViewToFormProviders } from "@/lib/providerSettingsFormProjection.js";

const START_PLAN_ENTRY_BANNER_CLASS =
  "min-h-20 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,var(--color-success)_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,var(--color-success)_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4 text-left transition-colors hover:border-border-hover";
const PERSONAL_PLAN_ENTRY_BANNER_CLASS =
  "min-h-20 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,#4099ff_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,#4099ff_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4 text-left transition-colors hover:border-border-hover";
const TEAM_PLAN_ENTRY_BANNER_CLASS =
  "min-h-20 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,#0ea5e9_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,#0ea5e9_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4 text-left transition-colors hover:border-border-hover";

function isPlanNavItem(
  item: ModelProviderNavItem | null,
): item is Extract<ModelProviderNavItem, { type: "codingPlan" | "teamPlan" }> {
  return item?.type === "codingPlan" || item?.type === "teamPlan";
}

function hasTeamPlanContext(item: ModelProviderNavItem | null): item is Extract<
  ModelProviderNavItem,
  { type: "teamPlan" }
> & {
  organizationId: string;
  projectId: string;
} {
  return (
    item?.type === "teamPlan" &&
    (item.organizationId?.trim().length ?? 0) > 0 &&
    (item.projectId?.trim().length ?? 0) > 0
  );
}

function resolveTeamScopedPlanNavItem(
  item: Extract<ModelProviderNavItem, { type: "codingPlan" | "teamPlan" }>,
  entitlement: ReturnType<typeof useUsageEntitlement>,
): Extract<ModelProviderNavItem, { type: "codingPlan" | "teamPlan" }> {
  if (item.type !== "teamPlan" || !hasTeamPlanContext(item)) {
    return item;
  }
  if (
    item.availabilityReason === "credential-unavailable" &&
    entitlement.snapshot?.unavailableReason !== "no_plan"
  ) {
    // With a known-unusable Project Key, later quota loading/error must not rewrite the real cause
    // into "checking" or "team plan not allocated". Provider config stays presented by the Settings View.
    return {
      ...item,
      status: "unavailable" as const,
      statusLabelId: undefined,
      statusActive: false,
      quotaLimits: [],
    };
  }
  const snapshot = entitlement.snapshot;
  if (!snapshot) {
    if (entitlement.loading) {
      return {
        ...item,
        // Team Plan quota re-queries per organization/project; never keep the previous team's quota after a switch.
        status: "checking" as const,
        statusLabelId: undefined,
        availabilityReason: undefined,
        statusActive: false,
        quotaLimits: [],
      };
    }
    if (entitlement.error) {
      return {
        ...item,
        // A failed request only proves the entitlement state unknown; it is never the server's explicit "not allocated".
        status: "unavailable" as const,
        statusLabelId: undefined,
        availabilityReason: undefined,
        statusActive: false,
        quotaLimits: [],
      };
    }
    return item;
  }
  if (entitlement.loading && !snapshot.subscription) {
    return {
      ...item,
      status: "checking" as const,
      statusLabelId: undefined,
      availabilityReason: undefined,
      statusActive: false,
      quotaLimits: [],
    };
  }
  if (entitlement.error && !snapshot.subscription) {
    return {
      ...item,
      status: "unavailable" as const,
      statusLabelId: undefined,
      availabilityReason: undefined,
      statusActive: false,
      quotaLimits: [],
    };
  }
  const hasTeamSubscription = Boolean(snapshot.subscription?.details.length);
  const noPlan = snapshot.unavailableReason === "no_plan";
  const expired = noPlan && snapshot.teamPlanUnavailableReason === "expired";
  return {
    ...item,
    // Entitlement comes only from the team subscription query; a failed quota query neither revokes
    // the subscription nor counts as "not allocated".
    status: hasTeamSubscription ? ("purchased" as const) : ("unavailable" as const),
    planLevel: item.teamPlanName?.trim() || item.planLevel,
    currentProductId: item.currentProductId,
    subscriptionBillingCycle: null,
    subscriptionRenewTime: null,
    subscriptionExpireTime: null,
    subscriptionDetails: [],
    quotaLimits: snapshot.quota?.limits ?? [],
    statusLabelId:
      !hasTeamSubscription && noPlan
        ? expired
          ? "settings.modelProvider.codingPlan.status.teamExpired"
          : "settings.modelProvider.codingPlan.status.teamUnavailable"
        : undefined,
    statusMessage: noPlan ? undefined : item.statusMessage,
    availabilityReason:
      !hasTeamSubscription && noPlan ? (expired ? "expired" : "not-allocated") : undefined,
    statusActive: hasTeamSubscription,
  };
}

function resolveTeamPlanInspectionAccess(
  item: Extract<ModelProviderNavItem, { type: "teamPlan" }>,
) {
  // Unavailable plans still need the failure reason; org/project identity comes from team navigation
  // and must not be wiped by execution-availability gating.
  const family = resolveModelProviderFamilySpecByProviderId(item.presetId)?.id;
  const productId = item.currentProductId?.trim();
  const organizationId = item.organizationId?.trim();
  const projectId = item.projectId?.trim();
  if (!family || !productId || !organizationId || !projectId) return undefined;
  return {
    type: "zhipu-account" as const,
    family,
    planKind: "team-coding-plan" as const,
    productId,
    organizationId,
    projectId,
  };
}

function resolvePlanSettingsProvider({
  view,
  providerId,
  fallback,
}: {
  view: ProviderSettingsView | null | undefined;
  providerId: string;
  fallback: ProviderSettingsFormProvider | null;
}): ProviderSettingsFormProvider | null {
  if (view) {
    return (
      projectProviderSettingsViewToFormProviders(view).find(
        (provider) => provider.providerId === providerId,
      ) ?? null
    );
  }
  return fallback?.providerId === providerId ? fallback : null;
}

export function ModelProviderSectionDetail({
  selectedNavItem,
  navigationItems = selectedNavItem ? [selectedNavItem] : [],
  connectionSettingsFailed = false,
  connectionSelections,
  startPlanSubscriptionCount = 0,
  presetLoading,
  codingPlanPurchaseTokenAuthenticatedByProviderId,
  codingPlanAuthError,
  presetSubscriptionProviderId,
  codingPlanStatusSyncProviderId,
  codingPlanDisconnectProviderId,
  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onReorderProviderModels,
  onTestModel,
  onCodingPlanLogin,
  onRetryCodingPlan,
  onCodingPlanDisconnect,
  onOpenApiKeyUrl,
  onOpenBigModelRegistration,
  onCodingPlanPurchaseComplete,
  onSelectNavItem,
  providerSettingsView: providerSettingsViewOverride,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  navigationItems?: ModelProviderNavItem[];
  connectionSettingsFailed?: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  startPlanSubscriptionCount?: number;
  presetLoading: boolean;
  codingPlanPurchaseTokenAuthenticatedByProviderId: Partial<
    Record<BuiltinModelProviderId, boolean>
  >;
  codingPlanAuthError?: string | null;
  presetSubscriptionProviderId: BuiltinModelProviderId | null;
  codingPlanStatusSyncProviderId: BuiltinModelProviderId | null;
  codingPlanDisconnectProviderId: BuiltinModelProviderId | null;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete: (provider: ProviderSettingsFormProvider) => Promise<void>;
  onReorderProviderModels?: (providerId: string, modelIds: string[]) => Promise<void>;
  onTestModel: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
  onRetryCodingPlan?: () => void | Promise<void>;
  onCodingPlanLogin: (
    presetId: BuiltinModelProviderId,
    providerId: OAuthProviderId,
    providerName: string,
    status: CodingPlanStatus,
    options?: CodingPlanLoginOptions,
  ) => number | void;
  onCodingPlanDisconnect: (
    presetId: BuiltinModelProviderId,
    providerId: OAuthProviderId,
    providerName: string,
  ) => void;
  onOpenApiKeyUrl: (url: string) => void;
  onOpenBigModelRegistration: () => void;
  onCodingPlanPurchaseComplete: () => void | Promise<void>;
  onSelectNavItem?: (item: ModelProviderNavItem) => void;
  providerSettingsView?: ProviderSettingsView | null;
}) {
  const { intl } = useZCodeIntl();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const loadingLabel = intl.formatMessage({ id: "common.loading" });
  const [upgradePlansVisibleProviderId, setUpgradePlansVisibleProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  const selectedItemKey = selectedNavItem?.key ?? null;
  const rootProviderSettingsRead = useProviderSettingsView();
  const rootProviderSettingsView =
    rootProviderSettingsRead.state.status === "ready" ? rootProviderSettingsRead.state.view : null;
  const providerSettingsView = providerSettingsViewOverride ?? rootProviderSettingsView;
  // The account branch once dropped the delete callback, deleting UI without persisting. All details share one model-action assembly.
  const modelEditingProps = {
    onAddPersonalModel,
    onSavePersonalModelDraft,
    onSetPersonalModelEnabled,
    onDeletePersonalModel,
    settingsRevision: providerSettingsView?.revision,
  };
  const selectedPlanAccess = useMemo(() => {
    if (!isPlanNavItem(selectedNavItem)) return undefined;
    if (selectedNavItem.type === "teamPlan")
      return resolveTeamPlanInspectionAccess(selectedNavItem);
    const access = resolveAccountProviderInspectionAccess(
      providerSettingsView,
      selectedNavItem.presetId,
    );
    if (
      !access ||
      (access.access.mode !== "start-plan" && access.access.mode !== "individual-coding-plan")
    )
      return undefined;
    return {
      type: "zhipu-account" as const,
      family: access.access.accountType,
      planKind: access.access.mode,
    };
  }, [providerSettingsView, selectedNavItem]);
  const selectedTeamPlanContext = useMemo(
    () =>
      hasTeamPlanContext(selectedNavItem)
        ? {
            organizationId: selectedNavItem.organizationId.trim(),
            projectId: selectedNavItem.projectId.trim(),
          }
        : null,
    [selectedNavItem],
  );
  const selectedTeamPlanEntitlement = useUsageEntitlement({
    enabled: Boolean(selectedTeamPlanContext),
    includeSubscription: true,
    preferredProviderId:
      selectedNavItem?.type === "teamPlan" ? selectedNavItem.presetId : undefined,
    accountAccess: selectedPlanAccess,
    // With a purchased Team Plan, the individual Coding Plan provider may be flagged disabled for lack of
    // personal entitlement. Team quota queries still reuse the Coding Plan quota path plus org/project
    // context, and must not be filtered out at provider selection.
    allowDisabledPreferredProvider: selectedNavItem?.type === "teamPlan",
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: selectedNavItem?.key ?? undefined,
    refreshOnMount: false,
  });
  useEffect(() => {
    if (!selectedTeamPlanContext) {
      return;
    }
    void selectedTeamPlanEntitlement.refresh({
      silent: true,
      reason: "access",
    });
  }, [selectedTeamPlanContext, selectedTeamPlanEntitlement.refresh]);
  const effectiveSelectedPlanNavItem = isPlanNavItem(selectedNavItem)
    ? resolveTeamScopedPlanNavItem(selectedNavItem, selectedTeamPlanEntitlement)
    : null;
  const planModeSwitch = (
    <ProviderFamilyPlanModeSwitch
      selectedNavItem={selectedNavItem}
      navigationItems={navigationItems}
      connectionSettingsFailed={connectionSettingsFailed}
      connectionSelections={connectionSelections}
      startPlanSubscriptionCount={startPlanSubscriptionCount}
      onSelectNavItem={onSelectNavItem}
    />
  );

  useEffect(() => {
    setUpgradePlansVisibleProviderId(null);
  }, [selectedItemKey]);

  if (!selectedNavItem) {
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  if (selectedNavItem.type === "preset") {
    if (!selectedNavItem.provider) {
      // On a slow first load the preset provider config has not returned; this used to show
      // "not yet synced, finish OAuth login first", which reads as "account signed out" while still
      // downloading. During first load show loading explicitly and decide on the unsynced placeholder
      // only after the request settles.
      if (presetLoading) {
        return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
      }

      return <PresetProviderPlaceholderCard displayName={selectedNavItem.displayName} />;
    }

    const presetProvider = selectedNavItem.provider;

    const familySpec = resolveModelProviderFamilySpecByProviderId(selectedNavItem.presetId);
    const presetFamilyHeader = (
      <ProviderFamilyHeader
        selectedNavItem={selectedNavItem}
        trailingAction={familySpec ? planModeSwitch : undefined}
      />
    );
    return (
      <ProviderFamilyDetailShell header={presetFamilyHeader}>
        <InlineEditableProviderCard
          provider={presetProvider}
          onSave={onSave}
          {...modelEditingProps}
          onReorderModelIds={
            onReorderProviderModels
              ? (modelIds) => onReorderProviderModels(presetProvider.providerId, modelIds)
              : undefined
          }
          onTestModel={onTestModel}
          readOnlyEndpoints
          // Preset provider names carry the fixed API-Key-entry semantics; renames would desync the
          // sidebar and model picker, so only custom providers may rename.
          nameEditable={false}
          headerVisible={!familySpec}
          headerActionsVisible={familySpec ? false : undefined}
        />
      </ProviderFamilyDetailShell>
    );
  }

  if (effectiveSelectedPlanNavItem) {
    const selectedNavItem = effectiveSelectedPlanNavItem;
    const dedicatedProvider = resolvePlanSettingsProvider({
      view: providerSettingsView,
      providerId: selectedNavItem.presetId,
      fallback: selectedNavItem.provider,
    });
    // Purchase/payment endpoints still rely on the OAuth business token.
    // Passed separately from the card's login state so a lit-up Provider API Key is never mistaken
    // for a usable purchase token.
    const codingPlanPurchaseTokenAuthenticated =
      codingPlanPurchaseTokenAuthenticatedByProviderId[selectedNavItem.presetId] === true;
    const codingPlanLoginPending = presetSubscriptionProviderId === selectedNavItem.presetId;
    const codingPlanStatusSyncPending = codingPlanStatusSyncProviderId === selectedNavItem.presetId;
    const codingPlanDisconnectPending = codingPlanDisconnectProviderId === selectedNavItem.presetId;
    const hasResolvedEntitlementStatus =
      selectedNavItem.status === "purchased" || selectedNavItem.status === "notPurchased";
    const statusPanelViewState =
      codingPlanDisconnectPending || (codingPlanStatusSyncPending && !hasResolvedEntitlementStatus)
        ? {
            // Provider-key persistence and entitlement refresh after login/logout are async chains.
            // Keeping the old connected/disconnected status until the refresh settles would read as a failed action.
            displayStatus: "checking" as const,
            actionStatus: "checking" as const,
            balanceStatus: "checking" as const,
            loginLoading: codingPlanStatusSyncPending,
          }
        : resolveCodingPlanStatusPanelViewState({
            status: selectedNavItem.status,
            loginPending: codingPlanLoginPending || codingPlanStatusSyncPending,
          });
    const visibleStatusLabelId =
      statusPanelViewState.displayStatus === "checking" ? undefined : selectedNavItem.statusLabelId;
    const isStartPlanProvider = isStartPlanModelProviderId(selectedNavItem.presetId);
    // Hide the config entry on explicit no-entitlement; a failed query/key fetch never implies none, and config is never deleted.
    const hasNoPlanEntitlement =
      !isStartPlanProvider &&
      (selectedNavItem.type === "teamPlan"
        ? selectedNavItem.availabilityReason === "not-allocated" ||
          selectedNavItem.availabilityReason === "expired"
        : selectedNavItem.status === "notPurchased");
    // Once the Account snapshot confirms Start is available, the quota query clearing/refreshing its own cache must not unmount the editor.
    // Without a plan, show no executable models; the config area never depends on transient quota loading.
    const accountAvailable =
      providerSettingsView?.providers.find(
        (provider) => provider.providerId === selectedNavItem.presetId,
      )?.accountState?.availability === "available";
    const hidePlanModels =
      hasNoPlanEntitlement ||
      selectedNavItem.status === "disconnected" ||
      selectedNavItem.status === "notPurchased";
    const shouldShowDedicatedProviderDetail =
      dedicatedProvider !== null &&
      !hidePlanModels &&
      (!isStartPlanProvider || accountAvailable || selectedNavItem.status === "purchased");
    const reloginOnFailure =
      selectedNavItem.type === "codingPlan" &&
      isIndividualCodingPlanModelProviderId(selectedNavItem.presetId) &&
      selectedNavItem.provider?.accountState?.unavailableReason === "credential-failed";
    // A failed team query/key fetch is not signed-out: refresh Host credentials first, then this team's entitlement.
    const retryTeamPlan =
      selectedNavItem.type === "teamPlan" &&
      selectedNavItem.status === "unavailable" &&
      selectedNavItem.availabilityReason !== "not-allocated" &&
      selectedNavItem.availabilityReason !== "expired" &&
      onRetryCodingPlan
        ? async () => {
            await onRetryCodingPlan();
            await selectedTeamPlanEntitlement.refresh({ force: true, reason: "manual" });
          }
        : undefined;
    const accessBanner =
      isStartPlanProvider ||
      (selectedNavItem.type === "teamPlan" &&
        (selectedNavItem.availabilityReason === "not-allocated" ||
          selectedNavItem.availabilityReason === "expired"))
        ? null
        : resolveCodingPlanAccessBanner(statusPanelViewState.displayStatus, intl, reloginOnFailure);
    const upgradePlansVisible = upgradePlansVisibleProviderId === selectedNavItem.presetId;
    const handleUpgradePlansVisibleChange = (visible: boolean) => {
      setUpgradePlansVisibleProviderId(visible ? selectedNavItem.presetId : null);
    };
    const purchaseChoiceBannersVisible =
      statusPanelViewState.displayStatus === "notPurchased" &&
      (selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID ||
        (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID &&
          codingPlanPurchaseTokenAuthenticated));
    const anonymousPurchaseChoiceBannersVisible =
      (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID ||
        selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID) &&
      statusPanelViewState.displayStatus === "disconnected";
    const handlePurchaseChoiceSelect = (
      audience: PurchaseAudience,
      options: { initialTeamPlanKey?: string; eventText?: string } = {},
    ) => {
      if (resolvePurchaseChoiceSelectionIntent(statusPanelViewState.displayStatus) === "login") {
        // Signed out, individual/team plans must first establish the provider's OAuth identity.
        // Opening the purchase panel directly bypasses account state, so price/order APIs would just
        // report oauth_required again.
        onCodingPlanLogin(
          selectedNavItem.presetId,
          selectedNavItem.oauthProviderId,
          selectedNavItem.providerName,
          selectedNavItem.status,
        );
        return;
      }
      const nextFunnelContext = createCodingPlanFunnelContext({
        providerId: selectedNavItem.presetId,
        upgradeSource:
          audience === "team" ? "setting_team_plan_banner" : "setting_personal_plan_banner",
        eventRegion: "app.setting",
        eventText:
          options.eventText ??
          intl.formatMessage({
            id:
              audience === "team"
                ? "settings.modelProvider.codingPlan.purchaseBanner.teamTitle"
                : "settings.modelProvider.codingPlan.purchaseBanner.personalTitle",
          }),
        entryPlanState: resolveCodingPlanEntryPlanState({
          displayStatus: statusPanelViewState.displayStatus,
          providerId: selectedNavItem.presetId,
          planLevel: selectedNavItem.planLevel,
        }),
        purchaseAudience: audience,
      });
      openCodingPlanUpgrade({
        providerId: selectedNavItem.presetId,
        initialAudience: audience,
        initialTeamPlanKey: options.initialTeamPlanKey,
        funnelContext: nextFunnelContext,
      });
    };
    const codingPlanFamilyHeader = (
      <ProviderFamilyHeader selectedNavItem={selectedNavItem} trailingAction={planModeSwitch} />
    );
    // Team navigation can read purchased even when pricing returns historical subscribed records.
    // Purchase/upgrade entries read only Account-owner-confirmed entitlements; catalog display state
    // is never current entitlement.
    const hasActivePaidPlan = navigationItems.some(
      (item) =>
        (item.type === "teamPlan" ||
          (item.type === "codingPlan" && isIndividualCodingPlanModelProviderId(item.presetId))) &&
        item.oauthProviderId === selectedNavItem.oauthProviderId &&
        providerSettingsView?.providers.some(
          (provider) =>
            provider.providerId === item.presetId &&
            provider.accountState?.availability === "available" &&
            provider.accountState.entitled,
        ),
    );
    const planSupplementalContent =
      isStartPlanProvider && hasActivePaidPlan ? null : anonymousPurchaseChoiceBannersVisible ||
        purchaseChoiceBannersVisible ? (
        <CodingPlanPurchaseChoiceBanners
          providerId={selectedNavItem.presetId}
          soldOutVisible={codingPlanPurchaseTokenAuthenticated}
          accountDisconnected={statusPanelViewState.displayStatus === "disconnected"}
          onSelect={handlePurchaseChoiceSelect}
          teamVisible={selectedNavItem.oauthProviderId !== ZAI_PROVIDER_ID}
        />
      ) : accessBanner ? (
        <CodingPlanAccessBanner title={accessBanner.title} description={accessBanner.description} />
      ) : null;

    if (shouldShowDedicatedProviderDetail && dedicatedProvider) {
      const statusPanel = (
        <CodingPlanStatusPanel
          providerId={selectedNavItem.presetId}
          providerName={selectedNavItem.providerName}
          status={selectedNavItem.status}
          viewState={statusPanelViewState}
          planLevel={selectedNavItem.planLevel}
          subscriptionRenewTime={selectedNavItem.subscriptionRenewTime}
          subscriptionExpireTime={selectedNavItem.subscriptionExpireTime}
          subscriptionDetails={selectedNavItem.subscriptionDetails}
          quotaLimits={selectedNavItem.quotaLimits}
          mcpQuotaLimit={selectedNavItem.mcpQuotaLimit ?? null}
          authError={codingPlanAuthError}
          onOpenRegistration={onOpenBigModelRegistration}
          purchaseUrl={selectedNavItem.purchaseUrl}
          inactivePlanTitle={selectedNavItem.inactivePlanTitle}
          statusLabelId={visibleStatusLabelId}
          statusMessage={selectedNavItem.statusMessage}
          teamPlanAvailabilityReason={
            selectedNavItem.type === "teamPlan" ? selectedNavItem.availabilityReason : undefined
          }
          quotaResetSourceKey={
            selectedNavItem.type === "teamPlan" ? selectedNavItem.key : selectedNavItem.presetId
          }
          quotaResetAccountAccess={selectedPlanAccess}
          onQuotaResetEntitlementRefresh={
            selectedNavItem.type === "teamPlan"
              ? () =>
                  selectedTeamPlanEntitlement.refresh({
                    force: true,
                    reason: "manual",
                  })
              : onCodingPlanPurchaseComplete
          }
          onOpenPurchase={onOpenApiKeyUrl}
          onDisconnect={
            (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID ||
              selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID) &&
            dedicatedProvider.providerId === selectedNavItem.presetId
              ? () => {
                  onCodingPlanDisconnect(
                    selectedNavItem.presetId,
                    selectedNavItem.oauthProviderId,
                    selectedNavItem.providerName,
                  );
                }
              : undefined
          }
          disconnectLoading={codingPlanDisconnectProviderId === selectedNavItem.presetId}
          // The Plan Card remains the user's selected entry even signed-out or with a expired login.
          // The detail page once lacked the status card's built-in login action, leaving users on the
          // Coding tab with only "not connected" copy.
          loginActionVisible
          loginActionPlacement="trailing"
          reloginOnFailure={!upgradePlansVisible && reloginOnFailure}
          onRetry={
            retryTeamPlan ??
            (!upgradePlansVisible &&
            selectedNavItem.type === "codingPlan" &&
            !selectedNavItem.accountLoginRequired &&
            (selectedNavItem.status === "unavailable" ||
              selectedNavItem.statusLabelId ===
                "settings.modelProvider.codingPlan.status.unavailable" ||
              (isIndividualCodingPlanModelProviderId(selectedNavItem.presetId) &&
                selectedNavItem.provider?.accountState?.unavailableReason === "credential-failed"))
              ? onRetryCodingPlan
              : undefined)
          }
          onLogin={(options) => {
            return onCodingPlanLogin(
              selectedNavItem.presetId,
              selectedNavItem.oauthProviderId,
              selectedNavItem.providerName,
              // The plan-status API requires a valid business OAuth; "relink" while purchased must not
              // silently refresh the key, or an expired OAuth click has no visible feedback. The upgrade
              // state's reconnect forces the re-login path.
              upgradePlansVisible ? "unavailable" : selectedNavItem.status,
              options,
            );
          }}
          onOpenUpgradePlans={(options) => {
            openCodingPlanUpgrade({
              providerId: selectedNavItem.presetId,
              initialAudience: options.initialAudience,
              funnelContext: options.funnelContext ?? undefined,
            });
          }}
          upgradePlansVisible={upgradePlansVisible}
          onUpgradePlansVisibleChange={handleUpgradePlansVisibleChange}
          purchaseInitialAudience={selectedNavItem.type === "teamPlan" ? "team" : "personal"}
          upgradeActionVisible={!isStartPlanProvider || !hasActivePaidPlan}
          startPlanPreviewVisible={false}
        />
      );

      return (
        <ProviderFamilyDetailShell header={codingPlanFamilyHeader}>
          <InlineEditableProviderCard
            provider={dedicatedProvider}
            onSave={onSave}
            {...modelEditingProps}
            onReorderModelIds={
              onReorderProviderModels
                ? (modelIds) => onReorderProviderModels(dedicatedProvider.providerId, modelIds)
                : undefined
            }
            onTestModel={onTestModel}
            nameEditable={false}
            statusSection={
              <div className="space-y-3">
                {statusPanel}
                {planSupplementalContent}
              </div>
            }
            headerActionsVisible={false}
          />
        </ProviderFamilyDetailShell>
      );
    }

    return (
      <ProviderFamilyDetailShell header={codingPlanFamilyHeader}>
        <div className="space-y-3">
          <CodingPlanStatusPanel
            providerId={selectedNavItem.presetId}
            providerName={selectedNavItem.providerName}
            status={selectedNavItem.status}
            viewState={statusPanelViewState}
            // Signed out, the right side renders only the Plan Card — no API Key form fallback.
            // The login entry must therefore live on the Plan Card itself, or the Coding tab dead-ends.
            loginActionVisible
            loginActionPlacement="trailing"
            purchaseUrl={selectedNavItem.purchaseUrl}
            planLevel={selectedNavItem.planLevel}
            inactivePlanTitle={selectedNavItem.inactivePlanTitle}
            statusLabelId={visibleStatusLabelId}
            statusMessage={selectedNavItem.statusMessage}
            teamPlanAvailabilityReason={
              selectedNavItem.type === "teamPlan" ? selectedNavItem.availabilityReason : undefined
            }
            quotaResetSourceKey={
              selectedNavItem.type === "teamPlan" ? selectedNavItem.key : selectedNavItem.presetId
            }
            quotaResetAccountAccess={selectedPlanAccess}
            onQuotaResetEntitlementRefresh={
              selectedNavItem.type === "teamPlan"
                ? () =>
                    selectedTeamPlanEntitlement.refresh({
                      force: true,
                      reason: "manual",
                    })
                : onCodingPlanPurchaseComplete
            }
            subscriptionRenewTime={selectedNavItem.subscriptionRenewTime}
            subscriptionExpireTime={selectedNavItem.subscriptionExpireTime}
            subscriptionDetails={selectedNavItem.subscriptionDetails}
            quotaLimits={selectedNavItem.quotaLimits}
            mcpQuotaLimit={selectedNavItem.mcpQuotaLimit ?? null}
            authError={codingPlanAuthError}
            onOpenRegistration={onOpenBigModelRegistration}
            onLogin={(options) => {
              return onCodingPlanLogin(
                selectedNavItem.presetId,
                selectedNavItem.oauthProviderId,
                selectedNavItem.providerName,
                selectedNavItem.status,
                options,
              );
            }}
            reloginOnFailure={!upgradePlansVisible && reloginOnFailure}
            onRetry={
              retryTeamPlan ??
              (!upgradePlansVisible &&
              selectedNavItem.type === "codingPlan" &&
              !selectedNavItem.accountLoginRequired &&
              (selectedNavItem.status === "unavailable" ||
                selectedNavItem.statusLabelId ===
                  "settings.modelProvider.codingPlan.status.unavailable" ||
                (isIndividualCodingPlanModelProviderId(selectedNavItem.presetId) &&
                  selectedNavItem.provider?.accountState?.unavailableReason ===
                    "credential-failed"))
                ? onRetryCodingPlan
                : undefined)
            }
            onOpenPurchase={onOpenApiKeyUrl}
            onDisconnect={
              (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID ||
                selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID) &&
              selectedNavItem.provider?.providerId === selectedNavItem.presetId &&
              selectedNavItem.status !== "disconnected"
                ? () => {
                    onCodingPlanDisconnect(
                      selectedNavItem.presetId,
                      selectedNavItem.oauthProviderId,
                      selectedNavItem.providerName,
                    );
                  }
                : undefined
            }
            disconnectLoading={codingPlanDisconnectProviderId === selectedNavItem.presetId}
            onOpenUpgradePlans={(options) => {
              openCodingPlanUpgrade({
                providerId: selectedNavItem.presetId,
                initialAudience: options.initialAudience,
                funnelContext: options.funnelContext ?? undefined,
              });
            }}
            upgradePlansVisible={upgradePlansVisible}
            onUpgradePlansVisibleChange={handleUpgradePlansVisibleChange}
            purchaseInitialAudience={selectedNavItem.type === "teamPlan" ? "team" : "personal"}
            upgradeActionVisible={!isStartPlanProvider || !hasActivePaidPlan}
            startPlanPreviewVisible={false}
          />
          {hidePlanModels ? null : providerSettingsView && !dedicatedProvider ? (
            <PresetProviderPlaceholderCard
              displayName={selectedNavItem.providerName}
              messageId="settings.modelProvider.accountProviderConfigMissing"
            />
          ) : !selectedNavItem.provider ||
            selectedNavItem.provider.providerId !== selectedNavItem.presetId ? (
            <ModelProviderLoadingCard loadingLabel={loadingLabel} />
          ) : null}
          {planSupplementalContent}
        </div>
      </ProviderFamilyDetailShell>
    );
  }

  if (selectedNavItem.type === "codingPlanLoading") {
    // The Z.AI plan-verdict placeholder belongs to the left navigation only; never the detail form path.
    return null;
  }

  if (!selectedNavItem.provider) {
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  const customProvider = selectedNavItem.provider;
  const customApiKeyUrl = customProvider.templateId
    ? getProviderFormApiKeyManagementUrl(customProvider)
    : undefined;
  return (
    // Show only entry points declared by the preset template; never guess a custom provider's key console from its URL.
    <InlineEditableProviderCard
      provider={customProvider}
      onSave={onSave}
      {...modelEditingProps}
      onDelete={() => onDelete(customProvider)}
      onReorderModelIds={
        onReorderProviderModels
          ? (modelIds) => onReorderProviderModels(customProvider.providerId, modelIds)
          : undefined
      }
      onTestModel={onTestModel}
      presetApiKeyUrl={customApiKeyUrl}
      readOnlyEndpoints={false}
      nameEditable
      onOpenPresetApiKey={
        customApiKeyUrl
          ? () => {
              onOpenApiKeyUrl(customApiKeyUrl);
            }
          : undefined
      }
    />
  );
}

function resolvePurchaseChoiceSelectionIntent(status: CodingPlanStatus): "login" | "purchase" {
  return status === "disconnected" ? "login" : "purchase";
}

function CodingPlanPurchaseChoiceBanners({
  providerId,
  startPlanPreview = null,
  personalVisible = true,
  teamVisible = true,
  soldOutVisible = false,
  accountDisconnected = false,
  onSelect,
  onSelectStartPlan,
}: {
  providerId: CodingPlanProviderId;
  startPlanPreview?: StartPlanPreviewConfig | null;
  personalVisible?: boolean;
  teamVisible?: boolean;
  soldOutVisible?: boolean;
  accountDisconnected?: boolean;
  onSelect: (
    audience: PurchaseAudience,
    options?: { initialTeamPlanKey?: string; eventText?: string },
  ) => void;
  onSelectStartPlan?: () => void;
}) {
  const entryGate = useCodingPlanEntryGate();
  const { intl, locale } = useZCodeIntl();
  const startPlanSummary = startPlanPreview
    ? resolveStartPlanEntitlementSummary(startPlanPreview, intl, locale)
    : null;
  // Start Plan is only the free entry; its price must come from the matching paid Coding Plan product
  // source, or a free SKU/empty list here would hide the paid plan's starting price.
  const pricingProviderId = resolvePurchaseChoiceBannerProductsProviderId(providerId);
  const staticProducts = useCodingPlanProducts(pricingProviderId, {
    remotePreviewEnabled: false,
  });
  const enterpriseProducts = useEnterpriseCodingPlanProducts({
    // The static team catalog loads even signed out; sold-out visibility must not gate catalog loading.
    enabled:
      teamVisible && pricingProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    authenticated: soldOutVisible,
    staticOnly: !soldOutVisible,
  });
  const personalPrice = resolvePurchaseChoiceBannerPrice({
    providerId: pricingProviderId,
    audience: "personal",
    products: staticProducts.snapshot?.productList ?? [],
    soldOutVisible,
  });
  // The team entry shows a single banner priced at the configured products' lowest price, never split per tier.
  const teamPrice = resolveEnterprisePurchaseChoiceBannerPrice({
    key: "team",
    title: "",
    products: enterpriseProducts.error
      ? []
      : (enterpriseProducts.snapshot?.productList ?? []).filter((product) =>
          enterpriseProducts.snapshot?.staticProductIds?.includes(product.productId),
        ),
  });
  const startPlanTitle = resolveStartPlanPurchaseChoiceBannerTitle({
    fallbackTitle: intl.formatMessage({
      id: "settings.modelProvider.codingPlan.purchaseBanner.startPlanTitle",
    }),
    locale,
    remoteTitle: startPlanPreview?.name,
  });
  const bannerItems = [
    ...(startPlanPreview && startPlanSummary
      ? [
          {
            key: "startPlan" as const,
            label: startPlanTitle,
            description: startPlanSummary.detailsDescription,
            metric: startPlanSummary.grantUnitsLabel,
            metricUnit: startPlanSummary.unitLabel,
            priceState: null,
            className: START_PLAN_ENTRY_BANNER_CLASS,
            Icon: AstroidIcon,
            iconClassName: "text-success",
            onClick: onSelectStartPlan,
          },
        ]
      : []),
    ...(personalVisible && personalPrice !== null
      ? [
          {
            key: "personal" as const,
            label: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.personalTitle",
            }),
            description: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.personalDescription",
            }),
            metric: null,
            metricUnit: null,
            priceState: personalPrice,
            className: PERSONAL_PLAN_ENTRY_BANNER_CLASS,
            Icon: AstroidIcon,
            iconClassName: "text-[#4099ff]",
            onClick: () => onSelect("personal"),
          },
        ]
      : []),
    // Historical subscriptions never gate purchase entry visibility; the team banner keeps static-catalog pricing.
    ...(teamVisible && teamPrice !== null
      ? [
          {
            key: "team" as const,
            label: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.teamTitle",
            }),
            description: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.teamDescription",
            }),
            metric: null,
            metricUnit: null,
            priceState: teamPrice,
            className: TEAM_PLAN_ENTRY_BANNER_CLASS,
            Icon: UsersIcon,
            iconClassName: "text-warning",
            onClick: () => onSelect("team"),
          },
        ]
      : []),
  ];
  return (
    <div className="space-y-3">
      {bannerItems.map((item) => (
        <button
          key={item.key}
          type="button"
          className={item.className}
          disabled={
            !accountDisconnected && item.key !== "startPlan" && entryGate.status === "loading"
          }
          onClick={() => {
            if (!accountDisconnected && item.key !== "startPlan" && entryGate.status !== "ready") {
              entryGate.retry?.();
              return;
            }
            item.onClick?.();
          }}
        >
          <span className="flex min-w-0 items-start gap-3">
            <item.Icon className={`mt-1 size-4 shrink-0 ${item.iconClassName}`} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-ui-lg font-medium leading-6 text-foreground">
                  {!accountDisconnected && item.key !== "startPlan"
                    ? (entryGate.label ?? item.label)
                    : item.label}
                </span>
              </span>
              {item.metric ? (
                <span className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-2xl font-bold leading-none text-foreground">
                    {item.metric}
                  </span>
                  {item.metricUnit ? (
                    <span className="text-ui-base font-medium text-foreground-subtle">
                      {item.metricUnit}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {item.priceState?.kind === "price" ? (
                <PurchaseChoiceBannerPrice
                  price={item.priceState.price}
                  currency={item.priceState.currency}
                  locale={locale}
                />
              ) : item.priceState?.kind === "soldOut" ? (
                <span className="mt-1 block text-lg font-semibold leading-6 text-foreground">
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.purchaseBanner.temporarilySoldOut",
                  })}
                </span>
              ) : null}
              <span className="mt-0.5 block text-ui-base leading-5 text-foreground-subtle">
                {item.description}
              </span>
            </span>
            <span className="flex h-6 shrink-0 items-center">
              <ArrowRightIcon className="size-4 text-foreground-subtle" />
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function resolvePurchaseChoiceBannerProductsProviderId(
  providerId: CodingPlanProviderId,
): CodingPlanProviderId {
  return resolveCodingPlanUpgradeProductsProviderId(providerId) ?? providerId;
}

function resolvePurchaseChoiceBannerPrice({
  providerId,
  audience,
  products,
  soldOutVisible = true,
}: {
  providerId: BuiltinModelProviderId;
  audience: PurchaseAudience;
  products: CodingPlanProductDisplay[];
  soldOutVisible?: boolean;
}): { kind: "price"; price: number; currency: string } | { kind: "soldOut" } | null {
  if (audience === "personal") {
    const product = products
      .map((candidate) => ({
        product: candidate,
        price: pickProductPrice(candidate),
      }))
      .filter(
        (candidate): candidate is { product: CodingPlanProductDisplay; price: number } =>
          candidate.product.soldOut !== true &&
          typeof candidate.price === "number" &&
          candidate.price > 0,
      )
      .sort((left, right) => left.price - right.price)[0];
    if (product) {
      return {
        kind: "price",
        price: product.price,
        // Product price is provider-scoped; with the currency missing, fall back to the current provider's billing domain only.
        // Never let the formatter default to CNY, or the Z.ai Global entry would wrongly show RMB.
        currency:
          product.product.priceCurrency ??
          (providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ? "CNY" : "USD"),
      };
    }
    if (
      soldOutVisible &&
      products.length > 0 &&
      products.every((candidate) => candidate.soldOut === true)
    ) {
      // The personal-plan entry banner is the first price a user sees before the purchase flow.
      // When every personal plan is sold out, front-load "sold out" in the amount slot instead of the static lowest price.
      return { kind: "soldOut" };
    }
  }

  // Never fabricate static prices for missing remote products; a config-key mismatch must not masquerade as a normal plan.

  return null;
}

function resolveEnterprisePurchaseChoiceBannerPrice(
  group: EnterpriseCodingPlanProductGroup,
): { kind: "price"; price: number; currency: string } | null {
  const product = group.products
    .map((candidate) => ({
      product: candidate,
      price: pickProductPrice(candidate),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        product: EnterpriseCodingPlanProductGroup["products"][number];
        price: number;
      } => typeof candidate.price === "number" && candidate.price > 0,
    )
    .sort((left, right) => left.price - right.price)[0];
  if (!product) {
    return null;
  }
  return {
    kind: "price",
    price: product.price,
    currency: product.product.priceCurrency ?? "CNY",
  };
}

function resolveStartPlanPurchaseChoiceBannerTitle({
  fallbackTitle,
  locale,
  remoteTitle,
}: {
  fallbackTitle: string;
  locale: string;
  remoteTitle?: string;
}): string {
  const title = remoteTitle?.trim() || fallbackTitle;
  if (locale.startsWith("zh") && /^start\s+plan$/i.test(title)) {
    // The Start Plan banner name comes from remote preview, whose default is currently English-only.
    // Localize only this known default so real remote custom names are never overridden.
    return fallbackTitle;
  }
  return title;
}

function PurchaseChoiceBannerPrice({
  price,
  currency,
  locale,
}: {
  price: number;
  currency: string | null;
  locale: string;
}) {
  const { intl } = useZCodeIntl();
  const formattedAmount = formatCodingPlanAmount(price, currency, locale);
  const isChineseLocale = locale.toLowerCase().startsWith("zh");
  if (!isChineseLocale) {
    return (
      <span className="mt-1 block text-lg font-semibold leading-6 text-foreground">
        {intl.formatMessage(
          { id: "settings.modelProvider.codingPlan.purchase.fromPrice" },
          { price: formattedAmount },
        )}
      </span>
    );
  }

  const [amount, ...labelParts] = formattedAmount.split(" ");
  const label = labelParts.join(" ").trim();
  return (
    <span className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span className="text-lg font-semibold leading-6 text-foreground">{amount}</span>
      <span className="text-ui-base font-medium text-foreground-subtle">
        {[
          label,
          intl.formatMessage({
            id: "settings.modelProvider.codingPlan.purchase.fromPriceSuffix",
          }),
        ]
          .filter(Boolean)
          .join(" ")}
      </span>
    </span>
  );
}

function CodingPlanAccessBanner({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-ui-base font-medium text-foreground">{title}</div>
      <p className="mt-1 text-ui-sm leading-6 text-foreground-subtle">{description}</p>
    </div>
  );
}

function resolveCodingPlanAccessBanner(
  status: CodingPlanStatus,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  reloginOnFailure = false,
): { title: string; description: string } | null {
  if (
    status !== "disconnected" &&
    status !== "notPurchased" &&
    !(status === "unavailable" && reloginOnFailure)
  ) {
    return null;
  }
  return {
    title: intl.formatMessage({
      id: `settings.modelProvider.codingPlan.status.${status}`,
    }),
    description: intl.formatMessage({
      id:
        status === "unavailable" && reloginOnFailure
          ? "settings.modelProvider.codingPlan.description.credentialFailed"
          : `settings.modelProvider.codingPlan.description.${status}`,
    }),
  };
}
