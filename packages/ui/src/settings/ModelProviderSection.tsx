/* eslint-disable max-lines -- The Model Provider settings page must centralize navigation, forms and OAuth; converge again when it is split up. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { marketingNavigation, finishMarketingNavigation } from "@/lib/marketingNavigation.js";
import {
  getProviderFormApiKey,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  DesktopCommandIds,
  isStartPlanModelProviderId,
  type BuiltinModelProviderId,
  type ModelConnectivityResult,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type OAuthProviderId,
  resolveModelProviderFamilyIdByProviderId,
  resolveModelProviderFamilySpecByProviderId,
  resolveProviderFamilyDomainFromOAuthProvider,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { logger } from "@/logger.js";
import {
  PRESET_PROVIDER_SPECS,
  PRESET_SUBSCRIPTION_TIMEOUT_MS,
  BIGMODEL_REGISTRATION_URL,
  type CodingPlanStatus,
  type ModelProviderNavGroup,
} from "./model-provider-section/constants.js";
import { ModelProviderSectionDetail } from "./model-provider-section/Detail.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import type { CodingPlanLoginOptions } from "./model-provider-section/codingPlanPricingCards.js";
import { useModelProviderNavigation } from "./model-provider-section/useModelProviderNavigation.js";
import { reportPresetSubscriptionSuccess } from "./model-provider-section/oauthActions.js";
import {
  createCodingPlanProviderNodeKey,
  createCustomProviderNodeKey,
  createPresetProviderNodeKey,
} from "./model-provider-section/utils.js";
import {
  confirmAndDeleteModelProvider,
  refreshModelProviderSection,
  refreshProviderPanelAfterAuthChange as refreshModelProviderPanelAfterAuthChange,
} from "./model-provider-section/modelProviderActions.js";
import {
  useCodingPlanAccessRefresh,
  useCodingPlanEntitlements,
} from "./model-provider-section/useCodingPlanEntitlements.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

type CodingPlanConnectionNavItem = Extract<
  ModelProviderNavGroup["items"][number],
  { type: "codingPlan" | "teamPlan" }
>;

export function resolveCodingPlanProviderSyncAttemptKey({
  activeOAuthProvider,
  oauthProviderId,
  providerId,
}: {
  activeOAuthProvider: OAuthProviderId | null;
  oauthProviderId: OAuthProviderId;
  providerId: BuiltinModelProviderId;
}): string | null {
  if (activeOAuthProvider !== oauthProviderId) {
    return null;
  }
  // Operation identity is built from stable provider/auth facts only; never put display states such as checking into the key.
  return `${providerId}:${activeOAuthProvider}`;
}

export function shouldRetryUnchangedCodingPlanProviderSync({
  attemptKey,
  attemptStatus,
  modeUnchanged,
  selectedKeyUnchanged,
}: {
  attemptKey: string | null;
  attemptStatus: "inFlight" | "succeeded" | "failed" | undefined;
  modeUnchanged: boolean;
  selectedKeyUnchanged: boolean;
}): boolean {
  return modeUnchanged && selectedKeyUnchanged && attemptKey !== null && attemptStatus === "failed";
}

function resolveCodingPlanIntentProviderId(
  target: SettingsModelProviderTarget | undefined,
): BuiltinModelProviderId | null {
  switch (target?.providerId) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      return target.providerId;
    default:
      return null;
  }
}

function shouldRefreshCodingPlanEntitlementsAfterSave(
  previousProvider: ProviderSettingsFormProvider | undefined,
  nextProvider: ProviderSettingsFormProvider,
): boolean {
  const isCodingPlanProvider =
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
  if (!isCodingPlanProvider) {
    return false;
  }

  // Compare manual key configs only; OAuth account access ignores old keys and refreshes via account/entitlement events.
  // Bugfix: UI-only config such as enabled/name/models does not change entitlement-query credentials.
  // Saving any Coding Plan field used to refresh the state, flashing the sidebar into loading and wiping the selection.
  return (
    (previousProvider ? getProviderFormApiKey(previousProvider).trim() : "") !==
    getProviderFormApiKey(nextProvider).trim()
  );
}

function resolveBuiltinPresetOAuthProvider(
  presetId: BuiltinModelProviderId,
): OAuthProviderId | null {
  if (
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  ) {
    return ZAI_PROVIDER_ID;
  }
  if (
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  ) {
    return BIGMODEL_PROVIDER_ID;
  }
  return null;
}

function shouldShowPresetProviderForActiveOAuth(
  presetId: BuiltinModelProviderId,
  providerFamilyDomain: ProviderFamilyDomain | null | undefined,
): boolean {
  const presetOAuthProvider = resolveBuiltinPresetOAuthProvider(presetId);
  if (!providerFamilyDomain || !presetOAuthProvider) {
    return true;
  }
  return resolveModelProviderFamilyIdByProviderId(presetId) === providerFamilyDomain;
}

function clearPendingProviderFamilyConnectionSelection(
  selections: ProviderFamilyConnectionSelectionSettings,
  familyId: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
): ProviderFamilyConnectionSelectionSettings {
  if (JSON.stringify(selections[familyId]) !== JSON.stringify(selection)) {
    return selections;
  }
  const { [familyId]: _removed, ...rest } = selections;
  return rest;
}

function resolveProviderFamilySideNodeKey(providerId: BuiltinModelProviderId): string | null {
  if (isStartPlanModelProviderId(providerId)) return createCodingPlanProviderNodeKey(providerId);
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  return familySpec ? createPresetProviderNodeKey(familySpec.startPlanProviderId) : null;
}

function resolveConnectionSelectionForNavItem(
  item: Extract<
    ModelProviderNavGroup["items"][number],
    { type: "preset" | "codingPlan" | "teamPlan" }
  >,
): ProviderFamilyConnectionSelection | null {
  if (item.type === "preset") return null;
  if (item.type === "teamPlan") {
    const productId = item.currentProductId?.trim() ?? "";
    const organizationId = item.organizationId?.trim() ?? "";
    const projectId = item.projectId?.trim() ?? "";
    return productId && organizationId && projectId
      ? { kind: "team-coding-plan", productId, organizationId, projectId }
      : null;
  }
  return isStartPlanModelProviderId(item.presetId) ? null : { kind: "individual-coding-plan" };
}

export function resolveModelProviderSideSelectionKey(
  item: ModelProviderNavGroup["items"][number],
): string {
  if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
    return item.key;
  }
  if (
    item.type === "preset" ||
    (item.type === "codingPlan" && isStartPlanModelProviderId(item.presetId))
  )
    return item.key;
  return resolveProviderFamilySideNodeKey(item.presetId) ?? item.key;
}

/**
 * Model Provider settings are injected by SettingsPage with the Local Host only; no workspaceIdentity here,
 * so remote workspaces cannot route provider-settings reads/writes to the remote environment.
 */
export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = usePlatform();
  const { modelSelectionService, oauthService, credentialService } = useServices();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing: modelProvidersRefreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    providerSettingsView,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const entitledAccountProviderIds = useMemo<ReadonlySet<string>>(() => {
    return new Set(
      (providerSettingsView?.providers ?? [])
        .filter(
          (provider) =>
            provider.effectiveConfig.access?.type === "zhipu-account" &&
            provider.effectiveConfig.access.entitled === true,
        )
        .map((provider) => provider.providerId),
    );
  }, [providerSettingsView]);
  const providerConnectionRefreshSignal = providerSettingsView?.revision;
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [invalidProviderTarget, setInvalidProviderTarget] = useState(() =>
    Boolean(
      initialModelProviderTarget && !resolveCodingPlanIntentProviderId(initialModelProviderTarget),
    ),
  );
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(() => {
    const providerId = resolveCodingPlanIntentProviderId(initialModelProviderTarget);
    return providerId ? resolveProviderFamilySideNodeKey(providerId) : null;
  });
  const [presetSubscriptionProviderId, setPresetSubscriptionProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  const [codingPlanStatusSyncProviderId, setCodingPlanStatusSyncProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  const [codingPlanDisconnectProviderId, setCodingPlanDisconnectProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  // Dead-code cleanup: refreshToken was consumed only by the retired native purchase panel; keep the setter for
  // the post-login/unbind refreshCodingPlanProducts contract (shared helper signature unchanged).
  const [, setCodingPlanProductsRefreshToken] = useState(0);
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);

  useEffect(() => {
    if (
      !pendingCreatedProviderId ||
      !modelProviders.some((provider) => provider.providerId === pendingCreatedProviderId)
    ) {
      return;
    }
    // saveProvider publishes the shared snapshot before the async persist; under load React may commit
    // selectedNodeKey before the provider list. Navigation correction would then revert a not-yet-existing custom key,
    // and the new provider would never auto-select. Complete selection and draft cleanup only once the list is visible.
    setSelectedNodeKey(createCustomProviderNodeKey(pendingCreatedProviderId));
    setPendingCreatedProviderId(null);
  }, [modelProviders, pendingCreatedProviderId]);

  const applyModelProviderTarget = useCallback(
    (target: SettingsModelProviderTarget | undefined) => {
      if (!target) return false;
      const providerId = resolveCodingPlanIntentProviderId(target);
      if (!providerId) {
        // An unknown id must not be dropped silently: an unconsumed pending directive traps navigation on bad input.
        // Show the error, keep the current page and persistent connection; later valid navigation or manual selection recovers.
        logger.warn("[ModelProviderSection] Failed to open target provider", {
          providerId: target.providerId,
        });
        setInvalidProviderTarget(true);
        setTemplatePickerOpen(false);
        return true;
      }

      setInvalidProviderTarget(false);
      setTemplatePickerOpen(false);
      setSelectedNodeKey(resolveProviderFamilySideNodeKey(providerId));
      return true;
    },
    [],
  );

  useEffect(() => {
    if (!pendingModelProviderTarget) {
      return;
    }
    if (applyModelProviderTarget(pendingModelProviderTarget)) {
      onConsumePendingModelProviderTarget?.();
    }
  }, [applyModelProviderTarget, onConsumePendingModelProviderTarget, pendingModelProviderTarget]);

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        if (section !== "modelProvider") {
          return;
        }
        applyModelProviderTarget(
          detail?.modelProviderId
            ? {
                providerId: detail.modelProviderId,
              }
            : undefined,
        );
      }),
    [applyModelProviderTarget],
  );
  const [
    codingPlanPurchaseTokenAuthenticatedByProviderId,
    setCodingPlanPurchaseTokenAuthenticatedByProviderId,
  ] = useState<Partial<Record<BuiltinModelProviderId, boolean>>>({});
  const [activeOAuthProvider, setActiveOAuthProvider] = useState<OAuthProviderId | null>(null);
  const [pendingConnectionSelections, setPendingConnectionSelections] =
    useState<ProviderFamilyConnectionSelectionSettings>({});
  const presetSubscriptionCompletionProviderIdRef = useRef<BuiltinModelProviderId | null>(null);
  const codingPlanStatusSyncAttemptsRef = useRef(
    new Map<string, "inFlight" | "succeeded" | "failed">(),
  );
  const requestLoginEntry = useZCodeStore((state) => state.requestLoginEntry);
  const setUser = useZCodeStore((state) => state.setUser);
  const oauthError = useZCodeStore((state) => state.oauthError);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const {
    settings: sharedSettings,
    loading: sharedSettingsLoading,
    error: sharedSettingsError,
    update: updateSharedSettings,
  } = useSettings();
  const authenticatedEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      codingPlanPurchaseTokenAuthenticatedByProviderId[
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
      ] === true,
    authenticated: true,
    family: "bigmodel",
  });
  // zai/bigmodel Team Plan symmetry. Previously only bigmodel ran the hook,
  // so zai team subscriptions were never fetched or displayed.
  // zai calls the hook itself (zai family via the zai provider); downstream merges both families' subscribed products.
  const authenticatedZaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      codingPlanPurchaseTokenAuthenticatedByProviderId[
        BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
      ] === true,
    authenticated: true,
    family: "zai",
  });
  const refreshAuthenticatedEnterpriseProducts = useCallback(async () => {
    await Promise.all([
      authenticatedEnterpriseProducts.refresh(),
      authenticatedZaiEnterpriseProducts.refresh(),
    ]);
  }, [authenticatedEnterpriseProducts, authenticatedZaiEnterpriseProducts]);
  const subscribedTeamProducts = useMemo(
    () => [
      ...(authenticatedEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(authenticatedZaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [
      authenticatedEnterpriseProducts.snapshot?.productList,
      authenticatedZaiEnterpriseProducts.snapshot?.productList,
    ],
  );
  const connectionSelections = sharedSettings?.providerFamilyConnectionSelections ?? {};
  const familyConnectionSettingsFailed = sharedSettingsError !== null && sharedSettings === null;
  const effectiveConnectionSelections = useMemo(
    () => ({
      ...connectionSelections,
      ...pendingConnectionSelections,
    }),
    [connectionSelections, pendingConnectionSelections],
  );
  // Only the bigmodel selectedKey was checked for team plan, so zai team keys
  // never triggered the purchased-team fallback (broken). Now any family with a persisted team key shows it.
  const showPurchasedTeamPlanFallback = Boolean(
    effectiveConnectionSelections.bigmodel?.kind === "team-coding-plan" ||
    effectiveConnectionSelections.zai?.kind === "team-coding-plan",
  );
  const effectiveProviderFamilyDomain =
    sharedSettings?.providerFamilyDomain ??
    resolveProviderFamilyDomainFromOAuthProvider(activeOAuthProvider);
  const { entitlements: codingPlanEntitlements, refresh: refreshCodingPlanEntitlements } =
    useCodingPlanEntitlements({
      providerSettingsView,
      connectionSelections: effectiveConnectionSelections,
      suppressProviderFingerprintAutoRefresh: codingPlanStatusSyncProviderId !== null,
    });
  useEffect(() => {
    setPendingConnectionSelections((current) => {
      let next = current;
      for (const [familyId, selection] of Object.entries(current) as Array<
        [ProviderFamilyDomain, ProviderFamilyConnectionSelection]
      >) {
        if (JSON.stringify(connectionSelections[familyId]) !== JSON.stringify(selection)) {
          continue;
        }
        // After a tab click, the settings persist and the hook refresh are both async.
        // Clear pending only once the persisted snapshot catches up, or the stale mode re-corrects the selection and it flickers.
        next = clearPendingProviderFamilyConnectionSelection(next, familyId, selection);
      }
      return next;
    });
  }, [connectionSelections]);

  const refreshCodingPlanProducts = useCallback(() => {
    setCodingPlanProductsRefreshToken((current) => current + 1);
  }, []);

  const refreshCodingPlanPurchaseTokenState = useCallback(
    async (
      options: {
        clearUserWhenLoggedOut?: boolean;
        shouldApply?: () => boolean;
      } = {},
    ) => {
      const [activeProvider, zaiToken, bigmodelToken] = await Promise.all([
        credentialService.load("oauth:active_provider"),
        credentialService.load(`oauth:${ZAI_PROVIDER_ID}:access_token`),
        credentialService.load(`oauth:${BIGMODEL_PROVIDER_ID}:access_token`),
      ]);
      if (options.shouldApply && !options.shouldApply()) {
        return null;
      }
      const normalizedActiveProvider =
        activeProvider === ZAI_PROVIDER_ID || activeProvider === BIGMODEL_PROVIDER_ID
          ? activeProvider
          : null;
      setActiveOAuthProvider(normalizedActiveProvider);
      setCodingPlanPurchaseTokenAuthenticatedByProviderId({
        [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
      });
      if (!normalizedActiveProvider && options.clearUserWhenLoggedOut) {
        // Provider unlink is now equivalent to App logout.
        // Once the server token is cleared, settings must clear the Zustand user too, or the sidebar shows the stale login until restart.
        setUser(null);
        setOAuthError(null);
      }
      return normalizedActiveProvider;
    },
    [credentialService, setOAuthError, setUser],
  );

  const refreshProviderPanelAfterAuthChange = useCallback(
    async ({
      refreshPlanSnapshots = true,
      refreshReason = "auth",
    }: {
      refreshPlanSnapshots?: boolean;
      refreshReason?: "auth" | "purchase";
    }) => {
      await refreshModelProviderPanelAfterAuthChange({
        refreshModelProviders: refresh,
        refreshCodingPlanEntitlements: () =>
          refreshCodingPlanEntitlements({ force: true, reason: refreshReason }),
        refreshTeamPlanProducts: refreshAuthenticatedEnterpriseProducts,
        refreshCodingPlanProducts,
        refreshPurchaseTokenState: refreshCodingPlanPurchaseTokenState,
        refreshPlanSnapshots,
      });
    },
    [
      refresh,
      refreshAuthenticatedEnterpriseProducts,
      refreshCodingPlanEntitlements,
      refreshCodingPlanProducts,
      refreshCodingPlanPurchaseTokenState,
      refreshModelProviderPanelAfterAuthChange,
    ],
  );

  const syncCodingPlanProviderOnce = useCallback(
    async (
      item: CodingPlanConnectionNavItem,
      options: { userTransition?: boolean; refreshPlanSnapshots?: boolean } = {},
    ) => {
      const attemptKey = resolveCodingPlanProviderSyncAttemptKey({
        activeOAuthProvider,
        oauthProviderId: item.oauthProviderId,
        providerId: item.presetId,
      });
      if (!attemptKey) {
        return;
      }
      if (
        options.userTransition !== true &&
        codingPlanStatusSyncAttemptsRef.current.has(attemptKey)
      ) {
        return;
      }
      codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "inFlight");
      setCodingPlanStatusSyncProviderId(item.presetId);
      try {
        await refreshProviderPanelAfterAuthChange({
          refreshPlanSnapshots: options.refreshPlanSnapshots,
        });
        codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "succeeded");
      } catch (error) {
        // The failed state must be kept explicitly. Auto-hydration does not loop-retry after seeing failed,
        // while clicking the same connection item again may recover from the failed state.
        codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "failed");
        throw error;
      } finally {
        setCodingPlanStatusSyncProviderId((current) =>
          current === item.presetId ? null : current,
        );
      }
    },
    [activeOAuthProvider, refreshProviderPanelAfterAuthChange],
  );

  useEffect(() => {
    let disposed = false;

    void refreshCodingPlanPurchaseTokenState({
      shouldApply: () => !disposed,
    });

    return () => {
      disposed = true;
    };
  }, [providerConnectionRefreshSignal, refreshCodingPlanPurchaseTokenState]);

  const presetProviders = useMemo(
    () =>
      PRESET_PROVIDER_SPECS.filter((preset) =>
        shouldShowPresetProviderForActiveOAuth(preset.id, effectiveProviderFamilyDomain),
      ).map((preset) => ({
        ...preset,
        provider: modelProviders.find((provider) => provider.providerId === preset.id) ?? null,
      })),
    [effectiveProviderFamilyDomain, modelProviders],
  );

  useEffect(() => {
    if (!presetSubscriptionProviderId) {
      return;
    }

    const accountEntitled = Boolean(
      resolveEntitledAccountProviderAccess(providerSettingsView, presetSubscriptionProviderId),
    );
    if (accountEntitled) {
      if (presetSubscriptionCompletionProviderIdRef.current === presetSubscriptionProviderId) {
        return;
      }

      presetSubscriptionCompletionProviderIdRef.current = presetSubscriptionProviderId;
      void (async () => {
        void reportPresetSubscriptionSuccess({
          platform,
          presetId: presetSubscriptionProviderId,
        });
        try {
          // Bugfix: after connect/reauth, account connection state settles before this round's entitlement result.
          // Clear pending only after this entitlement refresh completes, or the Plan Card briefly shows the old plan or a non-loading state.
          await refreshProviderPanelAfterAuthChange({});
        } finally {
          presetSubscriptionCompletionProviderIdRef.current = null;
          setCodingPlanStatusSyncProviderId((current) =>
            current === presetSubscriptionProviderId ? null : current,
          );
          setPresetSubscriptionProviderId((current) =>
            current === presetSubscriptionProviderId ? null : current,
          );
        }
      })();
    }
  }, [
    platform,
    presetSubscriptionProviderId,
    providerSettingsView,
    refreshProviderPanelAfterAuthChange,
  ]);

  useEffect(() => {
    if (!presetSubscriptionProviderId) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setCodingPlanStatusSyncProviderId((current) =>
        current === presetSubscriptionProviderId ? null : current,
      );
      setPresetSubscriptionProviderId((current) => {
        if (current !== presetSubscriptionProviderId) {
          return current;
        }
        return null;
      });
    }, PRESET_SUBSCRIPTION_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [presetSubscriptionProviderId]);

  const { navigationGroups, navigationItems, selectedNavItem, navigationUnavailable } =
    useModelProviderNavigation({
      presetProviders,
      modelProviders,
      entitledAccountProviderIds,
      modelProvidersLoading: loading,
      displayOrder,
      codingPlanEntitlements,
      subscribedTeamProducts,
      providerFamilyDomain: effectiveProviderFamilyDomain,
      connectionSelections: effectiveConnectionSelections,
      pendingConnectionSelections,
      showPurchasedTeamPlanFallback,
      familyConnectionSettingsLoading: sharedSettingsLoading && sharedSettings === null,
      familyConnectionSettingsFailed,
      selectedNodeKey,
      setSelectedNodeKey,
      intl,
    });
  const selectedPlanAccessKey =
    selectedNavItem?.type === "codingPlan" || selectedNavItem?.type === "teamPlan"
      ? selectedNavItem.key
      : null;
  // The plan card is corrected on each user open; the shared freshness window keeps sub-minute round trips
  // from amplifying quota requests. An entitlement display refresh is not a re-open.
  useCodingPlanAccessRefresh({
    refresh: refreshCodingPlanEntitlements,
    selectedPlanKey: selectedPlanAccessKey,
  });

  useEffect(() => {
    if (selectedNavItem?.type !== "codingPlan" && selectedNavItem?.type !== "teamPlan") {
      return;
    }
    if (
      activeOAuthProvider !== selectedNavItem.oauthProviderId ||
      presetSubscriptionProviderId === selectedNavItem.presetId ||
      codingPlanDisconnectProviderId === selectedNavItem.presetId
    ) {
      return;
    }

    const accountEntitled = selectedNavItem.accountEntitled === true;
    if (accountEntitled) {
      return;
    }

    // This is the first-hydration correction, not a status-driven state machine.
    // Runs once per provider/OAuth pair; checking-to-final flips must not restart the refresh.
    void syncCodingPlanProviderOnce(selectedNavItem).catch((error) => {
      logger.warn("[ModelProviderSection] Failed to auto-sync Coding Plan provider", {
        providerId: selectedNavItem.presetId,
        error,
      });
    });
  }, [
    activeOAuthProvider,
    codingPlanDisconnectProviderId,
    presetSubscriptionProviderId,
    selectedNavItem,
    syncCodingPlanProviderOnce,
  ]);

  const handleSave = useCallback(
    async (config: ProviderSettingsFormProvider) => {
      try {
        const previousProvider = modelProviders.find(
          (provider) => provider.providerId === config.providerId,
        );
        // A non-executable config is not a logout; saving must not clear the account domain, or no plan reselection can succeed.
        await saveProvider(config);
        if (shouldRefreshCodingPlanEntitlementsAfterSave(previousProvider, config)) {
          refreshCodingPlanEntitlements();
        }
      } catch (error) {
        logger.error("[ModelProviderSection] Failed to save model provider", error);
        throw error;
      }
    },
    [modelProviders, refreshCodingPlanEntitlements, saveProvider],
  );

  const handleDelete = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await confirmAndDeleteModelProvider({
        provider,
        confirmDialog,
        intl,
        deleteProvider,
      });
    },
    [confirmDialog, deleteProvider, intl],
  );

  const handleOpenApiKeyUrl = useCallback(
    (url: string) => {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        return;
      }
      platform.openExternal(normalizedUrl);
    },
    [platform],
  );

  const handleCodingPlanLogin = useCallback(
    (
      presetId: BuiltinModelProviderId,
      providerId: OAuthProviderId,
      providerName: string,
      status: CodingPlanStatus,
      options?: CodingPlanLoginOptions,
    ) => {
      setPresetSubscriptionProviderId(presetId);
      setCodingPlanStatusSyncProviderId(presetId);
      logger.info(
        "[ModelProviderSection] Coding Plan connect requested via the unified login entry",
        {
          presetId,
          providerId,
          providerName,
          status,
          forceOAuth: options?.forceOAuth === true,
        },
      );
      if (activeOAuthProvider === providerId && options?.forceOAuth !== true) {
        void refreshProviderPanelAfterAuthChange({}).finally(() => {
          setPresetSubscriptionProviderId((current) => (current === presetId ? null : current));
          setCodingPlanStatusSyncProviderId((current) => (current === presetId ? null : current));
        });
        return;
      }
      // ZAI/BigModel providers no longer have a separate connection; Connect must switch the App active provider.
      return requestLoginEntry(providerId);
    },
    [activeOAuthProvider, refreshProviderPanelAfterAuthChange, requestLoginEntry],
  );

  const handleCodingPlanDisconnect = useCallback(
    async (presetId: BuiltinModelProviderId, providerId: OAuthProviderId, providerName: string) => {
      if (providerId !== BIGMODEL_PROVIDER_ID && providerId !== ZAI_PROVIDER_ID) {
        return;
      }

      setCodingPlanDisconnectProviderId(presetId);
      setCodingPlanStatusSyncProviderId(presetId);
      try {
        logger.info("[ModelProviderSection] Coding Plan provider unbind requested", {
          presetId,
          providerId,
          providerName,
        });
        // ZAI/BigModel providers are back to being App-login mirrors.
        // Unlink here must go through provider logout: exit the active provider and let the other one show Connect again.
        const nextProviderFamilyDomain = resolveLogoutProviderFamilyDomain({
          currentDomain: sharedSettings?.providerFamilyDomain,
        });
        await oauthService.logout(providerId);
        // The Coding Plan webview uses a dedicated persistent partition; provider unlink is an account boundary too.
        if (typeof platform.executeDesktopCommand === "function") {
          await platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);
        }
        await updateSharedSettings({
          providerFamilyDomain: (nextProviderFamilyDomain ?? "") as never,
          providerFamilyDomainUpdatedAt: Date.now(),
          providerFamilyDomainMigrated: true,
        });
        await refreshCodingPlanPurchaseTokenState({ clearUserWhenLoggedOut: true });
        await refresh();
        // After unbind, batch-preview subscription/auth state is stale; the plan card's inner cache must refresh,
        // or buttons keep the pre-unlink purchased/authenticated state.
        refreshCodingPlanProducts();
        // React closures from before the unlink may still hold old Start/Coding provider keys.
        // Unlink awaits only the local logout and provider-list refresh; the entitlement hook clears old state once the new snapshot lands.
      } catch (error) {
        logger.error("[ModelProviderSection] Failed to unbind Coding Plan provider", {
          presetId,
          providerId,
          providerName,
          error,
        });
      } finally {
        setCodingPlanDisconnectProviderId((current) => (current === presetId ? null : current));
        setCodingPlanStatusSyncProviderId((current) => (current === presetId ? null : current));
      }
    },
    [
      oauthService,
      platform,
      updateSharedSettings,
      sharedSettings?.providerFamilyDomain,
      modelSelectionService,
      refresh,
      refreshCodingPlanEntitlements,
      refreshCodingPlanProducts,
      refreshCodingPlanPurchaseTokenState,
    ],
  );

  const persistProviderFamilyModeForNavItem = useCallback(
    async (item: (typeof navigationItems)[number]) => {
      if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
        return;
      }
      const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
      if (!familySpec) {
        return;
      }
      const selection = resolveConnectionSelectionForNavItem(item);
      if (!selection) return;
      const selectionUnchanged =
        JSON.stringify(connectionSelections[familySpec.id]) === JSON.stringify(selection);
      // The same plan may still lack a persisted account domain; reselection must complete it, never dedupe against a page-display fallback.
      const modeUnchanged = sharedSettings?.providerFamilyDomain === familySpec.id;
      const selectedKeyUnchanged = selectionUnchanged;
      const planSyncAttemptKey =
        item.type === "codingPlan" || item.type === "teamPlan"
          ? resolveCodingPlanProviderSyncAttemptKey({
              activeOAuthProvider,
              oauthProviderId: item.oauthProviderId,
              providerId: item.presetId,
            })
          : null;
      if (modeUnchanged && selectedKeyUnchanged) {
        const isPlanItem = item.type === "codingPlan" || item.type === "teamPlan";
        const planSyncAttemptStatus = planSyncAttemptKey
          ? codingPlanStatusSyncAttemptsRef.current.get(planSyncAttemptKey)
          : undefined;
        if (
          isPlanItem &&
          shouldRetryUnchangedCodingPlanProviderSync({
            attemptKey: planSyncAttemptKey,
            attemptStatus: planSyncAttemptStatus,
            modeUnchanged,
            selectedKeyUnchanged,
          })
        ) {
          try {
            await syncCodingPlanProviderOnce(item, {
              userTransition: true,
              refreshPlanSnapshots: false,
            });
          } catch (error) {
            logger.warn("[ModelProviderSection] Failed to retry Coding Plan provider sync", {
              providerId: item.presetId,
              error,
            });
          }
        }
        return;
      }
      setPendingConnectionSelections((current) => ({
        ...current,
        [familySpec.id]: selection,
      }));
      if (planSyncAttemptKey) {
        // The pending state renders first; reserve the slot so the hydration effect does not re-sync before settings persist.
        codingPlanStatusSyncAttemptsRef.current.set(planSyncAttemptKey, "inFlight");
      }
      try {
        await updateSharedSettings({
          providerFamilyDomain: familySpec.id,
          providerFamilyDomainUpdatedAt: Date.now(),
          providerFamilyDomainMigrated: true,
          providerFamilyConnectionSelections: {
            ...connectionSelections,
            [familySpec.id]: selection,
          },
        });
        if (item.type === "codingPlan" || item.type === "teamPlan") {
          // User actions own the connection-mode transition: after persist, refresh the target Plan provider exactly once.
          await syncCodingPlanProviderOnce(item, {
            userTransition: true,
            refreshPlanSnapshots: false,
          });
        }
      } catch (error) {
        if (planSyncAttemptKey) {
          // On persist or later provider-sync failure, the same item must stay retryable.
          codingPlanStatusSyncAttemptsRef.current.set(planSyncAttemptKey, "failed");
        }
        logger.warn("[ModelProviderSection] Failed to save model provider connection mode", {
          familyId: familySpec.id,
          error,
        });
        setPendingConnectionSelections((current) =>
          clearPendingProviderFamilyConnectionSelection(current, familySpec.id, selection),
        );
      }
    },
    [
      activeOAuthProvider,
      connectionSelections,
      sharedSettings?.providerFamilyDomain,
      syncCodingPlanProviderOnce,
      updateSharedSettings,
    ],
  );

  const handleSelectNavItem = useCallback(
    (item: (typeof navigationItems)[number]) => {
      setInvalidProviderTarget(false);
      setSelectedNodeKey(resolveModelProviderSideSelectionKey(item));
      setTemplatePickerOpen(false);
      void persistProviderFamilyModeForNavItem(item);
    },
    [persistProviderFamilyModeForNavItem],
  );

  const handleCreateProvider = useCallback(
    async (input: { templateId?: string; providerName?: string }) => {
      setCreatingProvider(true);
      try {
        const created = await createPersonalProvider({ ...input, locale });
        setPendingCreatedProviderId(created.providerId);
        setSelectedNodeKey(createCustomProviderNodeKey(created.providerId));
        setTemplatePickerOpen(false);
      } catch (error) {
        setPendingCreatedProviderId(null);
        throw error;
      } finally {
        setCreatingProvider(false);
      }
    },
    [createPersonalProvider, locale],
  );

  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  useEffect(() => {
    if (marketingRequest?.target.page !== "settings" || !marketingRequest.target.provider_id)
      return;
    if (
      loading ||
      modelProvidersRefreshing ||
      sharedSettingsLoading ||
      navigationItems.some((item) => item.type === "codingPlanLoading")
    )
      return;
    const providerId = marketingRequest.target.provider_id;
    const item = navigationItems.find((item) =>
      item.type === "custom"
        ? // The current form contract uses providerId; legacy ids misclassify every custom provider as missing.
          item.provider.providerId === providerId
        : "presetId" in item &&
          item.presetId === providerId &&
          (!isStartPlanModelProviderId(providerId) || item.type === "codingPlan"),
    );
    if (!item) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_provider_unavailable"));
      return;
    }
    const key = resolveModelProviderSideSelectionKey(item);
    if (selectedNodeKey !== key) {
      // Locate the sidebar node only; never reuse the mode-aware selection path, or marketing navigation mutates the plan connection.
      setSelectedNodeKey(key);
    } else if (selectedNavItem) {
      finishMarketingNavigation(marketingRequest.id);
    }
  }, [
    marketingRequest,
    loading,
    modelProvidersRefreshing,
    sharedSettingsLoading,
    navigationItems,
    selectedNodeKey,
    selectedNavItem,
  ]);

  const handleReorderProviderIds = useCallback(
    async (orderedGroupProviderIds: string[]) => {
      const groupProviderIdSet = new Set(orderedGroupProviderIds);
      const currentProviderIds = sortModelProvidersForDisplay(modelProviders, displayOrder).map(
        (provider) => provider.providerId,
      );
      const insertionIndex = currentProviderIds.findIndex((providerId) =>
        groupProviderIdSet.has(providerId),
      );
      if (insertionIndex < 0) {
        return;
      }
      const nextProviderIds = currentProviderIds.filter(
        (providerId) => !groupProviderIdSet.has(providerId),
      );
      nextProviderIds.splice(insertionIndex, 0, ...orderedGroupProviderIds);
      await saveDisplayOrder({
        providerIds: nextProviderIds,
      });
    },
    [displayOrder, modelProviders, saveDisplayOrder],
  );

  const handleTestModel = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      return testModelConnectivity(providerId, modelId);
    },
    [testModelConnectivity],
  );

  // On a slow first paint this used to return null, blanking the whole model provider page while
  // neither the per-group loading nor the refresh-button loading ever got a chance to render.
  // Always render the layout shell first, then per-group loading, so the page never looks broken.
  const presetLoading = loading || modelProvidersRefreshing;
  const customLoading = loading || modelProvidersRefreshing;

  if (loadError) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-ui-base">
        <p className="text-destructive">{loadError.message}</p>
        <Button type="button" variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  }

  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={presetLoading}
      customLoading={customLoading}
      onRefresh={() => {
        void refreshModelProviderSection({
          refresh,
          // A manual settings refresh must also refresh the Z.ai / BigModel Team Plan snapshots;
          // previously only BigModel refreshed, leaving stale Z.ai projects after purchases or subscription changes.
          refreshTeamPlanProducts: refreshAuthenticatedEnterpriseProducts,
        });
        refreshCodingPlanEntitlements();
      }}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNodeKey}
      onSelectNavItem={handleSelectNavItem}
      onReorderProviderIds={handleReorderProviderIds}
      reorderableProviderIds={reorderableProviderIds}
    >
      {(invalidProviderTarget || navigationUnavailable) && !templatePickerOpen ? (
        <p role="alert" className="mb-3 text-ui-base text-destructive">
          {intl.formatMessage({
            id: invalidProviderTarget
              ? "settings.modelProvider.navigationUnavailable"
              : "settings.modelProvider.connectionUnavailable",
          })}
        </p>
      ) : null}
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => {
            return handleCreateProvider({ templateId });
          }}
          onCreateCustom={(label) => {
            return handleCreateProvider({ providerName: label });
          }}
        />
      ) : (
        <ModelProviderSectionDetail
          connectionSelections={effectiveConnectionSelections}
          providerSettingsView={providerSettingsView}
          selectedNavItem={selectedNavItem}
          navigationItems={navigationItems}
          connectionSettingsFailed={familyConnectionSettingsFailed}
          startPlanSubscriptionCount={(() => {
            const providerId =
              selectedNavItem && "presetId" in selectedNavItem ? selectedNavItem.presetId : null;
            const family = providerId
              ? resolveModelProviderFamilySpecByProviderId(providerId)
              : null;
            const entitlement = family ? codingPlanEntitlements[family.startPlanProviderId] : null;
            // Show only entitlements already queried for the current family; never substitute the current Start selection for owned counts.
            return entitlement?.error
              ? 0
              : (entitlement?.snapshot?.subscription?.details.length ?? 0);
          })()}
          presetLoading={presetLoading}
          codingPlanAuthError={oauthError}
          codingPlanPurchaseTokenAuthenticatedByProviderId={
            codingPlanPurchaseTokenAuthenticatedByProviderId
          }
          presetSubscriptionProviderId={presetSubscriptionProviderId}
          codingPlanStatusSyncProviderId={codingPlanStatusSyncProviderId}
          codingPlanDisconnectProviderId={codingPlanDisconnectProviderId}
          onSave={handleSave}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={handleDelete}
          // The provider sidebar's reorder permission was misused as a model-reorder gate, blocking Effective-model
          // order writes for Built-in / Account providers. Model ordering is independent of member source.
          onReorderProviderModels={reorderProviderModels}
          onTestModel={handleTestModel}
          onCodingPlanLogin={handleCodingPlanLogin}
          onRetryCodingPlan={() => {
            // A failed key fetch is not a logout: reuse the host's manual refresh, keep OAuth, no re-login.
            logger.info("[ModelProviderSection] Retrying plan status fetch");
            return refresh().then(() =>
              refreshCodingPlanEntitlements({ force: true, reason: "manual" }),
            );
          }}
          onCodingPlanDisconnect={handleCodingPlanDisconnect}
          onOpenApiKeyUrl={handleOpenApiKeyUrl}
          onSelectNavItem={handleSelectNavItem}
          onOpenBigModelRegistration={() => {
            // The not-registered notice comes from a failed OAuth checking state; restore the normal state after the signup jump so the notice cannot stick.
            setOAuthError(null);
            setPresetSubscriptionProviderId((current) =>
              current === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ? null : current,
            );
            platform.openExternal(BIGMODEL_REGISTRATION_URL);
          }}
          onCodingPlanPurchaseComplete={async () => {
            await refreshProviderPanelAfterAuthChange({ refreshReason: "purchase" });
          }}
        />
      )}
    </ModelProviderSectionLayout>
  );
}
