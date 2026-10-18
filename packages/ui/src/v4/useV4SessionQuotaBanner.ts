import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { BUILTIN_MODEL_PROVIDER_IDS, isStartPlanModelProviderId } from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";
import type { SessionErrorInfo, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import {
  resolveGlmQuotaBannerBusinessCode,
  resolveStartPlanConcurrentLimitBannerReason,
  resolveStartPlanConcurrentLimitBusinessCode,
  resolveStartPlanQuotaExhaustedBusinessCode,
} from "@/lib/providerBusinessError.js";
import {
  isMaxCodingPlanSnapshot,
  isTerminalCodingPlanSnapshot,
} from "@/lib/sidebarCodingPlanUpgrade.js";
import {
  buildSessionQuotaBannerDismissKey,
  buildSessionQuotaBannerState,
  resolveQuotaBannerUpgradeProviderId,
  shouldOfferQuotaBannerUpgrade,
} from "@/v4/sessionQuotaBannerState.js";
import type { McpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import { logger } from "@/logger.js";
import { sessionQuotaBannerDismissalStore } from "@/v4/sessionQuotaBannerDismissalStore.js";
import { startPlanQuotaReminderStore } from "@/v4/startPlanQuotaReminderStore.js";

function isGlmQuotaBannerProviderId(providerId: string | null): boolean {
  return (
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

function isRunningPhase(phase: SessionPhase | null): boolean {
  return phase === "prewarming" || phase === "running";
}

/**
 * V4 quota business state: the conversation snapshot carries only current provider/model/error; entitlements remain with
 * the entitlement service. The renderer merges both and never writes purchase/quota state back into the conversation.
 */
export function useV4SessionQuotaBanner(params: {
  sessionId: string | null;
  error: SessionErrorInfo | null;
  errorKey: string | null;
  phase: SessionPhase | null;
  providerId: string | null;
  modelId: string | null;
  usageStatsService?: IUsageStatsService;
  /**
   * The fact that the official Server MCP is unavailable. Parsed by the caller from conversation rows - it is a
   * projection of session events, unrelated to the entitlement service; do not fetch it inside this hook.
   */
  mcpUnavailableNotice?: McpUnavailableNotice | null;
}) {
  const activeProviderId = params.providerId?.trim() || null;
  const modelId = params.modelId?.trim() || null;
  const isStartPlanProvider = Boolean(
    activeProviderId && isStartPlanModelProviderId(activeProviderId),
  );
  const quotaExhaustedCode = resolveStartPlanQuotaExhaustedBusinessCode(
    params.error?.code,
    params.error?.message,
  );
  const concurrentLimitCode = resolveStartPlanConcurrentLimitBusinessCode(
    params.error?.code,
    params.error?.message,
  );
  const providerLimitedCode = resolveGlmQuotaBannerBusinessCode(params.error?.code);
  const serverQuotaExhausted = quotaExhaustedCode === "1005" && isStartPlanProvider;
  const serverConcurrentLimited = Boolean(concurrentLimitCode) && isStartPlanProvider;
  const serverProviderLimited = Boolean(
    providerLimitedCode && isGlmQuotaBannerProviderId(activeProviderId),
  );
  const takesOverError = serverQuotaExhausted || serverConcurrentLimited || serverProviderLimited;

  const settings = useProviderSettingsView();
  const entitlement = useUsageEntitlementWithService(params.usageStatsService, {
    ...buildStartPlanEntitlementOptions(
      settings.state.status === "ready" ? settings.state.view : null,
      isStartPlanProvider ? activeProviderId! : "",
    ),
  });
  const reminderVersion = useSyncExternalStore(
    startPlanQuotaReminderStore.subscribe,
    startPlanQuotaReminderStore.getSnapshot,
    startPlanQuotaReminderStore.getSnapshot,
  );
  // The display instance updates on task/model switch; a balance refresh must not mint a new instance, or the current reminder collapses at once.
  const reminderOwner = useMemo(
    () => ({ sessionId: params.sessionId, activeProviderId, modelId }),
    [params.sessionId, activeProviderId, modelId],
  );
  const state = useMemo(
    () =>
      buildSessionQuotaBannerState({
        activeProviderId,
        snapshot: entitlement.snapshot,
        modelId,
        isReminderHidden: (key, referenceTime) =>
          startPlanQuotaReminderStore.isHidden(key, reminderOwner, referenceTime),
        serverQuotaExhausted,
        serverConcurrentLimited,
        ...(concurrentLimitCode ? { serverConcurrentLimitBusinessCode: concurrentLimitCode } : {}),
        ...(concurrentLimitCode
          ? {
              serverConcurrentLimitReason: resolveStartPlanConcurrentLimitBannerReason(
                params.error?.message,
              ),
            }
          : {}),
        ...(providerLimitedCode ? { serverProviderLimitedBusinessCode: providerLimitedCode } : {}),
        ...(serverProviderLimited
          ? { serverProviderLimitedMessage: params.error?.message ?? null }
          : {}),
        ...(params.mcpUnavailableNotice
          ? { mcpUnavailableNotice: params.mcpUnavailableNotice }
          : {}),
      }),
    [
      activeProviderId,
      reminderOwner,
      reminderVersion,
      concurrentLimitCode,
      entitlement.snapshot,
      modelId,
      params.error?.message,
      params.mcpUnavailableNotice,
      providerLimitedCode,
      serverConcurrentLimited,
      serverProviderLimited,
      serverQuotaExhausted,
    ],
  );

  const dismissKey = buildSessionQuotaBannerDismissKey(
    state,
    takesOverError ? params.errorKey : null,
  );
  const previousReminderKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previousKey = previousReminderKeyRef.current;
    previousReminderKeyRef.current = state.reminderKey;
    // Once shown, leaving ends the display instance, so a rise-then-fall balance cannot re-pop the reminder in the same cycle.
    if (previousKey && previousKey !== state.reminderKey) {
      startPlanQuotaReminderStore.dismiss(previousKey);
    }
  }, [state.reminderKey]);
  useSyncExternalStore(
    sessionQuotaBannerDismissalStore.subscribe,
    sessionQuotaBannerDismissalStore.getSnapshot,
    sessionQuotaBannerDismissalStore.getSnapshot,
  );
  const dismissed = Boolean(
    params.sessionId &&
    dismissKey &&
    sessionQuotaBannerDismissalStore.isDismissed(params.sessionId, dismissKey),
  );
  const restoredDismissalRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dismissed || !params.sessionId || !dismissKey) return;
    const fingerprint = `${params.sessionId}\u0000${dismissKey}`;
    if (restoredDismissalRef.current === fingerprint) return;
    restoredDismissalRef.current = fingerprint;
    logger.debug("session quota banner dismissal restored", {
      dismissKey,
      sessionId: params.sessionId,
    });
  }, [dismissKey, dismissed, params.sessionId]);

  const upgradeProviderId = resolveQuotaBannerUpgradeProviderId(activeProviderId);
  const shouldCheckTerminalPlan =
    state.visible &&
    upgradeProviderId !== null &&
    // Notices without an upgrade entry (e.g. daily MCP quota exhausted) need no top-tier-plan check,
    // saving one refreshOnMount entitlement request.
    shouldOfferQuotaBannerUpgrade(state.kind) &&
    !isStartPlanModelProviderId(upgradeProviderId);
  const upgradeEntitlement = useUsageEntitlementWithService(params.usageStatsService, {
    enabled: shouldCheckTerminalPlan,
    includeSubscription: true,
    preferredProviderId: upgradeProviderId ?? undefined,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    refreshOnMount: true,
  });
  const terminalSnapshot =
    entitlement.snapshot?.provider?.id === upgradeProviderId
      ? entitlement.snapshot
      : upgradeEntitlement.snapshot?.provider?.id === upgradeProviderId
        ? upgradeEntitlement.snapshot
        : null;
  const terminalPlan = terminalSnapshot !== null && isTerminalCodingPlanSnapshot(terminalSnapshot);
  const maxPlan = terminalSnapshot !== null && isMaxCodingPlanSnapshot(terminalSnapshot);

  const previousPhaseRef = useRef<SessionPhase | null>(params.phase);
  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = params.phase;
    if (!isStartPlanProvider || previousPhase === params.phase) return;
    if (isRunningPhase(previousPhase) !== isRunningPhase(params.phase)) {
      // Task start reserves quota; termination deducts or releases. Bypass the normal freshness correction once.
      void entitlement.refresh({ force: true, silent: true, reason: "manual" });
    }
  }, [entitlement.refresh, isStartPlanProvider, params.phase]);

  const modelRefreshInitializedRef = useRef(false);
  const previousModelKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const nextKey = isStartPlanProvider && modelId ? `${activeProviderId}:${modelId}` : null;
    const previousKey = previousModelKeyRef.current;
    previousModelKeyRef.current = nextKey;
    if (!modelRefreshInitializedRef.current) {
      modelRefreshInitializedRef.current = true;
      return;
    }
    if (nextKey && nextKey !== previousKey) {
      void entitlement.refresh({ reason: "initial" });
    }
  }, [activeProviderId, entitlement.refresh, isStartPlanProvider, modelId]);

  const dismiss = useCallback(() => {
    if (state.reminderKey) {
      // Clicking close itself proves the notice was seen, avoiding a no-op close while the visibility callback has not run.
      if (state.reminderExpiresAt !== undefined && state.reminderReferenceTime !== undefined) {
        startPlanQuotaReminderStore.markShown(
          state.reminderKey,
          state.reminderExpiresAt,
          reminderOwner,
          state.reminderReferenceTime,
        );
      }
      startPlanQuotaReminderStore.dismiss(state.reminderKey);
      return;
    }
    if (!params.sessionId || !dismissKey) return;
    sessionQuotaBannerDismissalStore.dismiss(params.sessionId, dismissKey);
  }, [
    dismissKey,
    params.sessionId,
    reminderOwner,
    state.reminderKey,
    state.reminderExpiresAt,
    state.reminderReferenceTime,
  ]);

  const markShown = useCallback(() => {
    if (
      state.reminderKey &&
      state.reminderExpiresAt !== undefined &&
      state.reminderReferenceTime !== undefined
    ) {
      startPlanQuotaReminderStore.markShown(
        state.reminderKey,
        state.reminderExpiresAt,
        reminderOwner,
        state.reminderReferenceTime,
      );
    }
  }, [reminderOwner, state.reminderExpiresAt, state.reminderKey, state.reminderReferenceTime]);

  return {
    state,
    dismissKey,
    dismissed,
    dismiss,
    markShown,
    takesOverError,
    upgradeProviderId:
      terminalPlan || !shouldOfferQuotaBannerUpgrade(state.kind) ? null : upgradeProviderId,
    upgradeActionLabelId: maxPlan ? "chat.quota.action.renew" : "chat.quota.action.upgrade",
  } as const;
}
