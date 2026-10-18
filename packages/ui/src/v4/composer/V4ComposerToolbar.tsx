/* oxlint-disable eslint(max-lines) -- V4ComposerToolbar concentrates model/reasoning/context-usage; further splits would break the toolbar hotkey and model-catalog memo shared state. */
/**
 * V4 composer toolbar.
 *
 * Presentational pieces reuse the old chat-input-toolbar props-only components (ModelConfigSelect /
 * ChatModeSwitchControl / ThoughtLevelCycleControl / ChatContextUsage) with visuals matching the old
 * ChatInputToolbar; state orchestration is brand-new v4 wiring -- none of the old ChatInputToolbar
 * effect chains / legacy protocol write paths:
 * - current model/level come from the Composer; live-session usage from snapshot.usage.contextWindow
 * - model/reasoning/mode only update the Composer intent for the next Submission
 * - model static facts come from the target Host ModelSelectionView; workspace configOptions supply only
 *   non-model presentation such as mode
 *
 * New tasks and live sessions share the same Composer display facts; prewarm fills neither model nor level.
 * At submit the host (SessionPane) sends the frozen choices with the Submission.
 * The trio must not all gate on config!==null -- drafts would render nothing at all.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlarmClockIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  getModelProviderFamilySpec,
  resolveModelProviderFamilySpecByProviderId,
  TID_V4_MODEL_CONFIG,
  TID_V4_COMPOSER_INPUT,
  ZCODE_AGENT_PROVIDER,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type UsageEntitlementSnapshot,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
  type ZCodeConfigOption,
  type ZCodeProvider,
} from "@zcode/shared";
import type {
  SessionConfigState,
  SessionPhase,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { Button } from "@/components/ui/button.js";
import { HighspeedModelIndicator } from "@/highspeed/HighspeedModelIndicator.js";
import { formatHighspeedRemainingTime } from "@/highspeed/highspeedTime.js";
import { ChatContextUsage } from "@/chat-input-toolbar/display.js";
import {
  hasChatCodingPlanUsageRemaining,
  type ChatCodingPlanUsageRemainingConfig,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import {
  hasChatStartPlanBalance,
  type ChatStartPlanBalanceConfig,
} from "@/chat-input-toolbar/StartPlanContextBalance.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { getNextThoughtLevelValue } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import { useToolbarShortcutBindings } from "@/v4/composer/toolbarShortcuts.js";
import {
  resolveModelSelectTriggerDisplay,
  shouldShowManageModelsAction,
} from "@/chat-input-toolbar/modelSelection.js";
import { resolveV4ModelTriggerDisplay } from "@/v4/composer/modelTriggerDisplay.js";
import {
  setPendingSettingsSectionIntent,
  setPendingSettingsUsageCodingPlanIntent,
} from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  useUsageEntitlement,
  type UsageEntitlementRefreshOptions,
} from "@/hooks/useUsageEntitlement.js";
import { useToolbarConfigOptions } from "@/hooks/useZCodeConfig.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import {
  buildCodingPlanUsageSources,
  type CodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";
import {
  type SidebarUsageCodingPlanProviderId,
  type SidebarUsageCodingPlanSourceId,
  writeSidebarUsageCodingPlanProviderPreference,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import {
  resolveDraftDisplayedConfig,
  resolveDraftModelThoughtOption,
  resolveDraftThoughtCurrentValue,
} from "@/v4/composer/draftWorkspaceDefaults.js";

// Re-export the split-out pieces (mode selection moved to V4ComposerModeControls in the line-count split):
// existing consumers (ConversationComposer) keep importing from this module; the surface is unchanged.
export { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";

const V4_COMPOSER_INPUT_SELECTOR = `[data-testid="${TID_V4_COMPOSER_INPUT}"]`;
const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

/** Stable no-op callback (the hotkey hook singleton handles only this component's options; other actions placeholder). */
function noop(): void {}

function HighspeedCountdown({ expiresAt }: { expiresAt: number }) {
  const { intl, locale } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingTime = formatHighspeedRemainingTime(expiresAt, now);
  const absoluteExpiryLabel = intl.formatMessage(
    { id: "chat.highspeed.expiresAt" },
    {
      time: new Date(expiresAt).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    },
  );
  const remainingTimeLabel = intl.formatMessage(
    { id: "chat.highspeed.remainingTime" },
    { time: remainingTime },
  );

  // Root cause: the countdown collapsed after Think, keeping a fixed 82px in medium-narrow windows;
  // narrow windows collapse the value but keep the hoverable clock entry.
  return (
    <span
      aria-label={absoluteExpiryLabel}
      title={remainingTimeLabel}
      data-highspeed-countdown="true"
      className="highspeed-inline-countdown inline-flex h-7 w-[82px] shrink-0 items-center justify-center gap-1 rounded-md p-1 text-ui-caption @max-xl/composer:w-7 @max-xl/composer:gap-0 @max-xl/composer:p-0"
    >
      <AlarmClockIcon className="size-4 shrink-0" aria-hidden="true" />
      <span
        data-highspeed-countdown-value="true"
        className="relative h-[18px] w-[54px] shrink-0 leading-4 tabular-nums @max-xl/composer:hidden"
      >
        <span className="absolute left-0 top-0.5">{remainingTime}</span>
      </span>
    </span>
  );
}

export interface ModelSelectionSource {
  provider: string;
  model: string;
}

type V4ContextPlanConnection =
  | { kind: "none" }
  | {
      family: ProviderFamilyDomain;
      kind: "personalCoding";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    }
  | {
      family: ProviderFamilyDomain;
      kind: "teamCoding";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
      selection: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
    }
  | {
      family: ProviderFamilyDomain;
      kind: "start";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
    };

function resolveFamilyForPlanProviderId(providerId: string | null | undefined): {
  family: ProviderFamilyDomain;
  kind: "personalCoding" | "teamCoding" | "start";
} | null {
  switch (providerId?.trim()) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
      return { family: "zai", kind: "personalCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
      return { family: "zai", kind: "teamCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
      return { family: "zai", kind: "start" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
      return { family: "bigmodel", kind: "personalCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
      return { family: "bigmodel", kind: "teamCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      return { family: "bigmodel", kind: "start" };
    default:
      return null;
  }
}

function resolveV4ContextPlanConnection(params: {
  connectionSelections?: ProviderFamilyConnectionSelectionSettings | null;
  providerId?: string | null;
}): V4ContextPlanConnection {
  const providerFamily = resolveFamilyForPlanProviderId(params.providerId);
  if (!providerFamily) {
    return { kind: "none" };
  }

  // Start quota belongs to the input's effective model; a global paid connection must not gate its queries.
  if (providerFamily.kind === "start") {
    const providerId = params.providerId?.trim();
    if (
      providerId !== BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan &&
      providerId !== BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
    ) {
      return { kind: "none" };
    }
    return {
      family: providerFamily.family,
      kind: "start",
      providerId,
    };
  }

  const selection = params.connectionSelections?.[providerFamily.family];
  if (!selection) return { kind: "none" };

  const providerId = params.providerId?.trim();
  if (providerFamily.kind === "teamCoding" && selection.kind === "team-coding-plan") {
    return {
      family: providerFamily.family,
      kind: "teamCoding",
      providerId: providerId as
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      selection,
    };
  }
  if (providerFamily.kind !== "personalCoding" || selection.kind !== "individual-coding-plan") {
    return { kind: "none" };
  }

  return {
    family: providerFamily.family,
    kind: "personalCoding",
    providerId: providerId as
      | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
      | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  };
}

function resolveContextTeamUsageSourceFromEntitlementSnapshot({
  accountAccess,
  snapshot,
}: {
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  snapshot?: UsageEntitlementSnapshot | null;
}): CodingPlanUsageSource | null {
  if (snapshot?.context?.scope !== "team") {
    return null;
  }
  const organizationId = snapshot.context.organizationId?.trim() ?? "";
  const projectId = snapshot.context.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return null;
  }
  const subscription = snapshot.subscription?.details[0] ?? null;
  const productId =
    snapshot.context.productId?.trim() || subscription?.productId?.trim() || "current";
  // The old createBigModelTeamPlanConnectionKey + bigmodelCodingPlan providerId hardcode made
  // zai team snapshots emit bigmodel-prefixed sourceIds (inconsistent with settings/usage
  // sources). Look the family up from snapshot.provider.id and use the matching prefix.
  const familySpec = resolveModelProviderFamilySpecByProviderId(snapshot.provider?.id ?? "");
  const family: ProviderFamilyDomain = familySpec?.id ?? "bigmodel";
  if (!accountAccess) {
    return null;
  }
  if ("mode" in accountAccess && accountAccess.mode !== "team-coding-plan") {
    return null;
  }
  if (
    "planKind" in accountAccess &&
    (accountAccess.planKind !== "team-coding-plan" ||
      accountAccess.productId !== productId ||
      accountAccess.organizationId !== organizationId ||
      accountAccess.projectId !== projectId)
  ) {
    return null;
  }
  const codingPlanProviderId = getModelProviderFamilySpec(family).teamCodingPlanProviderId;
  const sourceId = ["team", family, productId, organizationId, projectId]
    .map(encodeURIComponent)
    .join(":") as SidebarUsageCodingPlanSourceId;
  const displayName =
    snapshot.context.displayName?.trim() || subscription?.productName?.trim() || "Team";

  return {
    id: sourceId,
    providerId: codingPlanProviderId,
    accountAccess: {
      type: "zhipu-account",
      family,
      planKind: "team-coding-plan",
      productId,
      organizationId,
      projectId,
    },
    label: `${familySpec?.id === "zai" ? "ZAI" : "BigModel"} - ${displayName}`,
  };
}

function resolveContextCodingPlanUsageSource(params: {
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  cachedTeamSources?: readonly CodingPlanUsageSource[];
  entitlementSnapshot?: UsageEntitlementSnapshot | null;
  // The old type/guard hardbound bigmodelCodingPlan, so zai team contexts always returned
  // null. Open it to both zai/bigmodel codingPlan provider ids.
  providerId?:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan;
  teamSelection?: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
  subscribedTeamProducts: Parameters<
    typeof buildCodingPlanUsageSources
  >[0]["subscribedTeamProducts"];
}): CodingPlanUsageSource | null {
  if (!params.teamSelection) return null;
  if (!params.accountAccess) return null;

  return (
    buildCodingPlanUsageSources({
      accountAccesses: {
        [resolveModelProviderFamilySpecByProviderId(params.providerId ?? "")?.id ?? "bigmodel"]:
          params.accountAccess,
      },
      subscribedTeamProducts: params.subscribedTeamProducts,
    }).find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.productId === params.teamSelection?.productId &&
        source.accountAccess.organizationId === params.teamSelection?.organizationId &&
        source.accountAccess.projectId === params.teamSelection?.projectId,
    ) ??
    params.cachedTeamSources?.find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.productId === params.teamSelection?.productId &&
        source.accountAccess.organizationId === params.teamSelection?.organizationId &&
        source.accountAccess.projectId === params.teamSelection?.projectId,
    ) ??
    resolveContextTeamUsageSourceFromEntitlementSnapshot({
      accountAccess: params.accountAccess,
      snapshot: params.entitlementSnapshot,
    })
  );
}

export interface V4ComposerToolbarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  modelSelectionReload?: () => void;
  sessionId: string | null;
  phase: SessionPhase | null;
  provider?: ZCodeProvider;
  /** Whether this toolbar runs in the web remote-control shell. */
  isWebRemoteControl?: boolean;
  /** Whether the viewport is the mobile input layout. */
  isMobileViewport?: boolean;
  /** Draft state (sessionId=null); distinguishes the new-task presentation only, never the selection source. */
  draftMode?: boolean;
  /** The scope's Composer selection; both new tasks and existing sessions display only this state. */
  draftConfig?: Partial<SessionConfigState>;
  usage: SessionUsageState | null;
  disabled: boolean;
  /** While a Highspeed card is active the turn's model is locked; no picker or shortcut switching. */
  modelLocked?: boolean;
  /** Show the Highspeed model and countdown once the diffusion tail starts (immediately on restore entrances). */
  highspeedPresented?: boolean;
  /** Whether this entrance is a fresh-draw activation; restore entrances never flip the model page. */
  highspeedEntranceAnimated?: boolean;
  /** One sweep after the model flip settles. */
  highspeedSweepActive?: boolean;
  /** Highspeed card expiry; when set, a countdown shows between model and Think. */
  highspeedExpiresAt?: number;
  /** Model bound by the draw response; overrides the trigger copy only while locked. */
  highspeedModel?: string;
  // Exclusive owner of config pickers within one composer; renderer-local presentation only.
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  /**
   * Selected model (providerId/modelId decoded from the catalog value); updated and persisted by the Composer owner.
   * sourceModel only tags this interaction's origin -- never backfill CAS or reasoning levels from the Session projection.
   */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
  ) => void;
  /** Selected reasoning depth; modelContext pins the model targeted by this interaction. */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** On prepare/configOptions failure, custom-provider choices enter the workspace recovery chain. */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  onSendCompressionCommand?: (command: string) => void;
}

/** Model / reasoning / context-usage cluster (left of the send button, as in the old UI). */
function V4ComposerModelControlsImpl({
  workspacePath,
  workspaceIdentity,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  provider,
  isWebRemoteControl = false,
  isMobileViewport = false,
  draftMode = false,
  draftConfig,
  usage,
  disabled,
  modelLocked = false,
  highspeedPresented = false,
  highspeedEntranceAnimated = false,
  highspeedSweepActive = false,
  highspeedExpiresAt,
  highspeedModel,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectModel,
  onSelectThought,
  onSendCompressionCommand,
  onRecoverCustomModelSelection,
}: V4ComposerToolbarProps) {
  const { intl, locale } = useZCodeIntl();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  // Config-plane read: the workspace default catalog (taskId=null), never legacy session state.
  const { error: configOptionsError } = useToolbarConfigOptions(
    workspacePath,
    null,
    workspaceIdentity,
  );
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  // Config-plane live-service read (interim home: v4-ifying the config plane): the connection selection key feeds the BigModel Team Plan gating exemption.
  const { settings: sharedSettings } = useSettings();
  const {
    entitlements,
    enabledStartPlanProviderIds,
    refresh: refreshCodingPlanEntitlements,
  } = useCodingPlanEntitlements({
    providerSettingsView,
    connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
    // Context refreshes only on user hover/open; never request quota on composer mount.
    suppressProviderFingerprintAutoRefresh: true,
  });
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const modelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // Ctrl+M hotkey: bump openRequestKey to ask ModelConfigSelect to open (old handleOpenModelMenuShortcut semantics).
  const [modelMenuOpenRequestKey, setModelMenuOpenRequestKey] = useState(0);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const handleOpenModelMenuShortcut = useCallback(() => {
    setModelMenuOpenRequestKey((current) => current + 1);
  }, []);
  const handleModelPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("model", open);
    },
    [onConfigPickerOpenChange],
  );
  const handleThoughtPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("thought", open);
    },
    [onConfigPickerOpenChange],
  );

  const modelOption = modelSelectionView?.providers.some((provider) => provider.models.length > 0)
    ? ({
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "",
        options: [],
      } satisfies ZCodeConfigOption)
    : undefined;

  // Empty model/level used to be backfilled from stale Session values, contradicting the actual unsubmittable state.
  // The Composer owner already initialized; display consumes it and must not backfill again.
  const effectiveConfig = useMemo<SessionConfigState | null>(() => {
    return resolveDraftDisplayedConfig(draftConfig ?? {});
  }, [draftConfig]);

  const handleOpenStartPlanUpgrade = useCallback(
    (providerId: string) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext: createCodingPlanFunnelContext({
          providerId,
          upgradeSource: "session_token_usage",
          eventRegion: "app.session",
          eventText: intl.formatMessage({ id: "chat.quota.action.upgrade" }),
          entryPlanState: resolveCodingPlanEntryPlanState({
            providerId,
            displayStatus: "purchased",
            planLevel: "start",
          }),
        }),
      });
    },
    [intl, openCodingPlanUpgrade],
  );
  const handleOpenUsageDetails = useCallback(
    (sourceId?: SidebarUsageCodingPlanSourceId) => {
      if (sourceId) {
        writeSidebarUsageCodingPlanProviderPreference(sourceId);
      }
      // Remaining-quota More goes straight to Coding Plan usage stats (plan preselected via the source preference written above),
      // not app usage; the generic Usage entry still goes through setPendingSettingsUsageIntent.
      setPendingSettingsUsageCodingPlanIntent();
      openSettingsTab();
    },
    [openSettingsTab],
  );

  const contextPlanConnection = useMemo(
    () =>
      resolveV4ContextPlanConnection({
        connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
        providerId: effectiveConfig?.provider,
      }),
    [effectiveConfig?.provider, sharedSettings?.providerFamilyConnectionSelections],
  );
  const contextAccountProviderAccess = useMemo(
    () =>
      contextPlanConnection.kind === "personalCoding" || contextPlanConnection.kind === "teamCoding"
        ? resolveEntitledAccountProviderAccess(
            providerSettingsView,
            contextPlanConnection.providerId,
          )
        : null,
    [contextPlanConnection, providerSettingsView],
  );
  const contextStartPlanBalanceConfig = useMemo<ChatStartPlanBalanceConfig | undefined>(() => {
    if (contextPlanConnection.kind !== "start") {
      return undefined;
    }
    const entitlement = entitlements[contextPlanConnection.providerId];
    // Start Plan mounts the hover query entry only with its own Account Access.
    const startPlanEntitlementEnabled = enabledStartPlanProviderIds.includes(
      contextPlanConnection.providerId,
    );
    return {
      loading: entitlement?.loading ?? providerSourcesLoading,
      // The hover access-refresh hook cannot exist only on the Coding Plan config (onAccess):
      // start-plan users never refresh the daily balance from the context hover, waiting passively for settings/sidebar
      // refreshes. Wire the same silent access refresh as Coding Plan; the 60s access window
      // and in-flight merge come from the refresh-policy layer, so hover spam cannot amplify billing/balance calls.
      ...(startPlanEntitlementEnabled
        ? {
            onAccess: () => refreshCodingPlanEntitlements({ silent: true, reason: "access" }),
          }
        : {}),
      onUpgradeClick: () => handleOpenStartPlanUpgrade(contextPlanConnection.providerId),
      snapshot:
        entitlement?.snapshot?.provider?.id === contextPlanConnection.providerId
          ? entitlement.snapshot
          : null,
    };
  }, [
    contextPlanConnection,
    enabledStartPlanProviderIds,
    entitlements,
    handleOpenStartPlanUpgrade,
    providerSourcesLoading,
    refreshCodingPlanEntitlements,
  ]);
  const contextStartPlanBalance = hasChatStartPlanBalance(contextStartPlanBalanceConfig)
    ? contextStartPlanBalanceConfig
    : undefined;

  // The hook used to omit family and pull bigmodel enterprise pricing only, so zai team plans
  // got no subscription products and the team model group never built. Pass
  // contextPlanConnection.family so the hook pulls that family's team products.
  const enterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      !providerSourcesLoading &&
      contextPlanConnection.kind === "teamCoding" &&
      Boolean(contextAccountProviderAccess),
    authenticated: true,
    family: contextPlanConnection.kind === "teamCoding" ? contextPlanConnection.family : undefined,
  });
  const subscribedTeamProducts = useMemo(
    () =>
      enterpriseProducts.snapshot?.productList.filter((product) => product.subscribed === true) ??
      [],
    [enterpriseProducts.snapshot?.productList],
  );
  const contextTeamUsageSourceCacheRef = useRef<CodingPlanUsageSource[]>([]);
  const contextCodingPlanUsageProviderId =
    contextPlanConnection.kind === "personalCoding" || contextPlanConnection.kind === "teamCoding"
      ? contextPlanConnection.providerId
      : undefined;
  const contextCodingPlanUsageTeamSource = useMemo(
    () =>
      contextPlanConnection.kind === "teamCoding"
        ? resolveContextCodingPlanUsageSource({
            accountAccess: contextAccountProviderAccess?.access,
            cachedTeamSources: contextTeamUsageSourceCacheRef.current,
            // The old code hard-fetched the bigmodelCodingPlan entitlement snapshot, finding no
            // quota for zai team plans; fetch by connection.providerId instead.
            entitlementSnapshot: entitlements[contextPlanConnection.providerId]?.snapshot ?? null,
            providerId: contextPlanConnection.providerId,
            teamSelection: contextPlanConnection.selection,
            subscribedTeamProducts,
          })
        : null,
    [
      contextAccountProviderAccess?.access,
      contextPlanConnection,
      entitlements,
      subscribedTeamProducts,
    ],
  );
  useEffect(() => {
    if (!contextCodingPlanUsageTeamSource) {
      return;
    }
    const cache = contextTeamUsageSourceCacheRef.current;
    const nextCache = cache.filter((source) => source.id !== contextCodingPlanUsageTeamSource.id);
    nextCache.unshift(contextCodingPlanUsageTeamSource);
    // During Team -> Personal(no_plan) -> Team the org product or personal snapshot can briefly vanish.
    // Keep the last resolved team source so the composer context balance does not flicker with hydration order.
    contextTeamUsageSourceCacheRef.current = nextCache.slice(0, 8);
  }, [contextCodingPlanUsageTeamSource]);
  const contextCodingPlanUsageSelectedSourceId: SidebarUsageCodingPlanSourceId | undefined =
    contextPlanConnection.kind === "teamCoding"
      ? contextCodingPlanUsageTeamSource?.id
      : contextCodingPlanUsageProviderId;
  const teamEntitlement = useUsageEntitlement({
    enabled: !providerSourcesLoading && Boolean(contextCodingPlanUsageTeamSource),
    includeSubscription: true,
    // The old hardcode always sent bigmodelCodingPlan: with a zai-family team plan selected,
    // contextCodingPlanUsageTeamSource.providerId is zaiCodingPlan, so the server's
    // pickQuotaProvider exact match found no zai provider, resolveAuthorization returned null,
    // and the zai team plan never showed input context usage. Follow the team source's
    // providerId instead (resolveContextTeamUsageSourceFromEntitlementSnapshot /
    // resolveV4ContextPlanConnection already produce zai/bigmodelCodingPlan by family).
    preferredProviderId:
      contextCodingPlanUsageTeamSource?.providerId ??
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: contextCodingPlanUsageTeamSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: contextCodingPlanUsageTeamSource?.id,
    refreshOnMount: false,
  });
  const refreshTaskEntitlements = useCallback(
    async (options?: UsageEntitlementRefreshOptions) => {
      // The Team Plan context panel isolates its freshness key by sourceId; on task-boundary refresh it publishes
      // alongside the global entitlement, and the request layer merges same-team keys.
      await Promise.all([refreshCodingPlanEntitlements(options), teamEntitlement.refresh(options)]);
    },
    [refreshCodingPlanEntitlements, teamEntitlement.refresh],
  );
  const contextCodingPlanUsageProviders = useMemo(() => {
    if (contextPlanConnection.kind !== "personalCoding" || !contextCodingPlanUsageProviderId) {
      return [];
    }
    const access = contextAccountProviderAccess;
    if (!access) return [];
    return [
      {
        providerId: contextCodingPlanUsageProviderId as SidebarUsageCodingPlanProviderId,
        accountAccess: access.access,
        label:
          access.label ||
          (contextCodingPlanUsageProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
            ? "Z.ai - Coding Plan"
            : "BigModel - Coding Plan"),
      },
    ];
  }, [contextAccountProviderAccess, contextCodingPlanUsageProviderId, contextPlanConnection.kind]);
  const codingPlanUsageEntitlements = useMemo<
    ChatCodingPlanUsageRemainingConfig["entitlements"]
  >(() => {
    if (contextCodingPlanUsageTeamSource) {
      return [
        {
          sourceId: contextCodingPlanUsageTeamSource.id,
          providerId: contextCodingPlanUsageTeamSource.providerId,
          accountAccess: contextCodingPlanUsageTeamSource.accountAccess,
          label: contextCodingPlanUsageTeamSource.label,
          snapshot: teamEntitlement.snapshot,
          loading: teamEntitlement.loading,
          error: teamEntitlement.error,
        },
      ];
    }

    if (
      contextPlanConnection.kind !== "personalCoding" ||
      !contextCodingPlanUsageProviderId ||
      contextCodingPlanUsageProviders.length === 0
    ) {
      return [];
    }
    const providerId = contextCodingPlanUsageProviderId;
    const entitlement = entitlements[providerId];
    return [
      {
        sourceId: providerId,
        providerId,
        accountAccess: contextCodingPlanUsageProviders[0]!.accountAccess,
        snapshot: entitlement?.snapshot ?? null,
        loading: entitlement?.loading ?? providerSourcesLoading,
        error: entitlement?.error ?? null,
      },
    ];
  }, [
    contextCodingPlanUsageProviderId,
    contextCodingPlanUsageProviders.length,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    entitlements,
    providerSourcesLoading,
    teamEntitlement.error,
    teamEntitlement.loading,
    teamEntitlement.snapshot,
  ]);
  const handleUsageClick = useCallback(
    () => handleOpenUsageDetails(contextCodingPlanUsageSelectedSourceId),
    [contextCodingPlanUsageSelectedSourceId, handleOpenUsageDetails],
  );
  const codingPlanUsageRemainingConfig = useMemo<
    ChatCodingPlanUsageRemainingConfig | undefined
  >(() => {
    if (contextPlanConnection.kind !== "personalCoding" && !contextCodingPlanUsageTeamSource) {
      return undefined;
    }
    return {
      availableProviders: contextCodingPlanUsageProviders,
      entitlements: codingPlanUsageEntitlements,
      modelProvidersLoading: providerSourcesLoading,
      onEntitlementRefresh: () => refreshTaskEntitlements({ force: true, silent: true }),
      onAccess: () => refreshTaskEntitlements({ silent: true, reason: "access" }),
      onUsageClick: handleUsageClick,
      selectedProviderId: contextCodingPlanUsageSelectedSourceId,
    };
  }, [
    contextCodingPlanUsageProviders,
    contextCodingPlanUsageSelectedSourceId,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    codingPlanUsageEntitlements,
    handleUsageClick,
    providerSourcesLoading,
    refreshTaskEntitlements,
  ]);
  const codingPlanUsageRemaining =
    codingPlanUsageRemainingConfig &&
    hasChatCodingPlanUsageRemaining(codingPlanUsageRemainingConfig)
      ? codingPlanUsageRemainingConfig
      : undefined;

  // High-frequency interaction diagnostics stay at debug so production log volume does not grow per selection.
  useEffect(() => {
    if (!draftMode) return;
    logger.debug("[v4-toolbar] draft effectiveConfig changed", {
      provider: effectiveConfig?.provider ?? null,
      model: effectiveConfig?.model ?? null,
      thought: effectiveConfig?.thought ?? null,
      modelSelectionRevision: modelSelectionView?.revision ?? null,
    });
  }, [draftMode, effectiveConfig, modelSelectionView?.revision]);

  const modelSelectGroups = useMemo<ModelSelectGroup[]>(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(displayProvider, modelSelectionView, {
      apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
      apiKeyBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.apiKeyBadge",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
      codingPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlanBadge",
      }),
      startPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlan",
      }),
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      teamPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlanBadge",
      }),
      teamPlanFallbackLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlan",
      }),
    });
  }, [displayProvider, intl, modelSelectionView]);

  // Fix: restore the Manage Models entry (old onManageModels = open settings at the model providers section).
  const handleOpenModelProviderSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const showManageModelsAction = shouldShowManageModelsAction(handleOpenModelProviderSettings);
  const manageModelsLabel = intl.formatMessage({
    id: "chat.toolbar.model.manageModels",
  });

  // Encoded value of the current projected model: custom-model encoding when the provider is in the catalog, else the bare model id.
  const rawModelValue = useMemo(() => {
    if (!effectiveConfig || !effectiveConfig.model) return "";
    const providerExists = modelSelectionView?.providers.some(
      (candidate) => candidate.providerId === effectiveConfig.provider,
    );
    if (providerExists) {
      return encodeCustomModelValue(effectiveConfig.provider, effectiveConfig.model);
    }
    return effectiveConfig.model;
  }, [effectiveConfig, modelSelectionView]);

  // Trigger display fallback -- a `<synthetic>` model (SDK-restore placeholder) or a current model
  // missing from selectable groups (invalid/offline/signed-out) -> fall back to the placeholder/default Select-model copy
  // instead of leaking protocol placeholders or dead ids. Reuse the surviving resolveModelSelectTriggerDisplay.
  const triggerDisplay = useMemo(
    () =>
      resolveModelSelectTriggerDisplay(
        rawModelValue,
        modelSelectGroups,
        showManageModelsAction,
        manageModelsLabel,
      ),
    [manageModelsLabel, modelSelectGroups, rawModelValue, showManageModelsAction],
  );
  const normalizedModelValue = triggerDisplay.value ?? "";

  const modelTriggerDisplay = useMemo(() => {
    // Non-selectable value (unset/synthetic/unavailable): placeholder copy or the default Select a model.
    const fallbackLabel =
      triggerDisplay.placeholder ?? intl.formatMessage({ id: "chat.toolbar.model.label" });
    const providerName =
      modelSelectionView?.providers.find(
        (candidate) => candidate.providerId === effectiveConfig?.provider,
      )?.providerName ?? undefined;
    return resolveV4ModelTriggerDisplay({
      modelGroups: modelSelectGroups,
      normalizedValue: normalizedModelValue,
      fallbackLabel,
      providerId: effectiveConfig?.provider,
      providerName,
    });
  }, [
    effectiveConfig?.provider,
    intl,
    modelSelectionView,
    modelSelectGroups,
    normalizedModelValue,
    triggerDisplay.placeholder,
  ]);
  const handleModelValueChange = useCallback(
    (value: string) => {
      if (modelLocked) return;
      const decoded = decodeCustomModelValue(value);
      // A draft's at-click visible model may exist only in the catalog, or was already overridden by the newest draft
      // intent -- SessionPane must not re-derive it from a late prewarm projection.
      const sourceModel =
        effectiveConfig?.provider && effectiveConfig.model
          ? {
              provider: effectiveConfig.provider,
              model: effectiveConfig.model,
            }
          : null;
      // Debug log (draft model-switch diagnostics): clicked value + decode branch.
      logger.debug("[v4-toolbar] model select onValueChange", {
        value,
        decodedProviderId: decoded?.providerId ?? null,
        decodedModelName: decoded?.modelName ?? null,
        draftMode,
      });
      const selectedRegistryProvider = decoded?.providerId
        ? modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )
        : undefined;
      const customRecoveryEligible = isApiKeyAccess(selectedRegistryProvider?.config.access);
      if (
        configOptionsError &&
        decoded?.providerId &&
        customRecoveryEligible &&
        onRecoverCustomModelSelection
      ) {
        setRecoveryPending(true);
        void Promise.resolve(onRecoverCustomModelSelection(value, sourceModel))
          .catch((error) => {
            logger.warn("[v4-toolbar] custom provider recovery failed", {
              error: error instanceof Error ? error.message : String(error),
              providerId: decoded.providerId,
            });
          })
          .finally(() => {
            setRecoveryPending(false);
          });
        return;
      }
      if (decoded) {
        onSelectModel(decoded.providerId, decoded.modelName ?? "", sourceModel);
        return;
      }
      const slashIndex = value.indexOf("/");
      if (slashIndex > 0) {
        onSelectModel(value.slice(0, slashIndex), value.slice(slashIndex + 1), sourceModel);
        return;
      }
      // Bare model id: keep the current provider (host backfills from the latest projection).
      onSelectModel("", value, sourceModel);
    },
    [
      configOptionsError,
      displayProvider,
      draftMode,
      effectiveConfig?.model,
      effectiveConfig?.provider,
      onRecoverCustomModelSelection,
      onSelectModel,
      modelLocked,
      modelSelectionView,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const draftModelThoughtOption = useMemo(
    () =>
      effectiveConfig
        ? resolveDraftModelThoughtOption(
            effectiveConfig.provider,
            effectiveConfig.model,
            modelSelectionView,
          )
        : null,
    [effectiveConfig, modelSelectionView],
  );

  // Candidate tiers come only from the target Host ModelSelectionView; the selected tier only from the Composer.
  const thoughtOption = useMemo<ZCodeConfigOption | null>(() => {
    if (!effectiveConfig) return null;
    if (!draftModelThoughtOption) return null;
    return {
      ...draftModelThoughtOption,
      currentValue: resolveDraftThoughtCurrentValue({
        thought: effectiveConfig.thought,
        thoughtLevels: draftModelThoughtOption.options?.map((option) => option.value) ?? [],
      }),
    };
  }, [draftModelThoughtOption, effectiveConfig]);

  const handleThoughtValueChange = useCallback(
    (value: string) => {
      if (!effectiveConfig) return;
      if (!value.trim()) {
        // A controlled Select rebuilt across models can fire once with an empty value; that is not a user choice --
        // propagating it would mark the model intent superseded and block the accepted model from the global tuple.
        logger.debug("[v4-toolbar] ignore synthetic empty thought change", {
          model: effectiveConfig.model,
          provider: effectiveConfig.provider,
        });
        return;
      }
      onSelectThought(value, {
        provider: effectiveConfig.provider,
        model: effectiveConfig.model,
      });
    },
    [effectiveConfig, onSelectThought],
  );

  // Ctrl+T hotkey: cycle the next Submission's reasoning depth in catalog order.
  const handleCycleThoughtLevel = useCallback(() => {
    if (!thoughtOption || thoughtOption.type !== "select") {
      return;
    }
    const nextValue = getNextThoughtLevelValue(thoughtOption);
    if (nextValue == null) {
      return;
    }
    if (!effectiveConfig) return;
    onSelectThought(nextValue, {
      provider: effectiveConfig.provider,
      model: effectiveConfig.model,
    });
  }, [effectiveConfig, onSelectThought, thoughtOption]);

  const taskUsage = useMemo(() => {
    const contextWindow = usage?.contextWindow;
    if (!contextWindow) return null;
    return {
      used: contextWindow.usedTokens,
      size: contextWindow.maxTokens,
      ...(contextWindow.cache ? { cache: contextWindow.cache } : {}),
      ...(contextWindow.breakdown ? { breakdown: contextWindow.breakdown } : {}),
    };
  }, [usage?.contextWindow]);
  // Toolbar hotkeys are now first-class command-table commands: tooltip shortcut copy reads
  // the effective table, so button hints follow rebinding live (no hardcoded copy).
  const modelShortcutLabel = useShortcutCommandLabel("openModelMenu");
  const thoughtShortcutLabel = useShortcutCommandLabel("cycleThoughtLevel");
  const isModelOptionLocked = useCallback(() => false, []);

  // Keyboard shortcuts (old useToolbarShortcutBindings): Ctrl+M model menu, Ctrl+T cycle reasoning depth.
  // Mode cycling (Ctrl+Shift+M) binds in V4ComposerModeSwitch (modeOption lives there).
  // An empty model is a normal awaiting-choice state, live sessions included; never hide the picker for it.
  // Show normally with selectable groups; also show with none but a Manage-models entry, so zero-model users keep an entry.
  const modelMenuVisible = modelSelectGroups.length > 0 || showManageModelsAction;
  // Root cause: mobile's fixed-width submenus ignored Radix's measured available width per side,
  // and shared min-w-32 blocked shrinking further. Keep the submenu; clamp hard at the window edge.
  const providerSubmenuClassName =
    isWebRemoteControl && isMobileViewport
      ? "w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)"
      : undefined;
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(modelOption) || Boolean(thoughtOption),
    toolbarDisabled: disabled || recoveryPending,
    modelMenuDisabled: disabled || recoveryPending || modelLocked || !modelMenuVisible,
    modelOption,
    thoughtOption: thoughtOption ?? undefined,
    onOpenModelMenu: handleOpenModelMenuShortcut,
    onCycleThoughtLevel: handleCycleThoughtLevel,
    onCycleSessionMode: noop,
  });

  return (
    <>
      {/*
                e2e contract (TID_V4_MODEL_CONFIG): data-* anchors for composer/usage state.
                Cause: cross-model switches clear the source model's explicit thought; the visible control already shows the target
           // model's Option Spec default, while the stale anchor exposed the empty raw projection. data-thought must match the
           // controlled value the user actually sees -- no parallel draft state.
      */}
      <span
        data-testid={TID_V4_MODEL_CONFIG}
        data-source={effectiveConfig || draftConfig?.mode ? "composer" : ""}
        data-provider={effectiveConfig?.provider ?? ""}
        data-model={effectiveConfig?.model ?? ""}
        data-thought={
          thoughtOption?.type === "select"
            ? String(thoughtOption.currentValue ?? "")
            : (effectiveConfig?.thought ?? "")
        }
        data-thought-levels={
          thoughtOption?.type === "select"
            ? (thoughtOption.options ?? []).map((option) => option.value).join(",")
            : ""
        }
        data-mode={draftConfig?.mode ?? ""}
        data-plan-enabled={draftConfig?.planEnabled ?? false}
        data-usage-used={usage?.contextWindow?.usedTokens ?? ""}
        data-usage-max={usage?.contextWindow?.maxTokens ?? ""}
        className="hidden"
      />
      {/* A Highspeed card locks the model on activation; hide before the handoff completes or the usage spinner flashes. */}
      {!modelLocked ? (
        <ChatContextUsage
          codingPlanUsageRemaining={codingPlanUsageRemaining}
          taskUsage={taskUsage}
          startPlanBalance={contextStartPlanBalance}
          selectedProvider={displayProvider}
          intl={intl}
          locale={locale}
          onSendCompressionCommand={onSendCompressionCommand}
          compressionDisabled={disabled || recoveryPending}
        />
      ) : null}
      {/* The boost turn's model is decided by this card and the picker is unavailable -- the indicator outranks picker loading. */}
      {highspeedPresented && highspeedModel ? (
        <HighspeedModelIndicator
          model={highspeedModel}
          originalModel={modelTriggerDisplay.fullLabel}
          sweepActive={highspeedSweepActive}
          animateEntrance={highspeedEntranceAnimated}
        />
      ) : modelSelectionState.status === "error" && modelSelectionReload ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-sm text-destructive"
          onClick={modelSelectionReload}
        >
          {intl.formatMessage({ id: "chat.toolbar.model.loadFailedRetry" })}
        </Button>
      ) : modelSelectionState.status === "unavailable" ? (
        <span className="px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id:
              modelSelectionState.reason === "remote-waiting"
                ? "chat.toolbar.model.remoteWaiting"
                : "chat.toolbar.model.targetMissing",
          })}
        </span>
      ) : modelMenuVisible ? (
        <ModelConfigSelect
          modelGroups={modelSelectGroups}
          normalizedValue={normalizedModelValue}
          triggerLabel={modelTriggerDisplay.fullLabel}
          triggerLabelPrefix={modelTriggerDisplay.providerPrefix}
          triggerLabelValue={modelTriggerDisplay.modelLabel}
          triggerLabelPrefixClassName="composer-provider-prefix inline group-data-[composer-provider-compact=true]/toolbar:hidden"
          showManageModelsAction={showManageModelsAction}
          manageModelsLabel={manageModelsLabel}
          onManageModels={handleOpenModelProviderSettings}
          lockReasonMessage={intl.formatMessage({
            id: modelLocked
              ? "chat.highspeed.modelLocked"
              : "chat.toolbar.modelSwitch.lockedByRunningTask",
          })}
          isItemLocked={isModelOptionLocked}
          onValueChange={handleModelValueChange}
          disabled={
            disabled || recoveryPending || modelLocked || modelSelectionState.status !== "ready"
          }
          tooltipTitle={modelTriggerDisplay.fullLabel}
          shortcutLabel={modelShortcutLabel}
          triggerRef={modelTriggerRef}
          open={!modelLocked && activeConfigPicker === "model"}
          onOpenChange={handleModelPickerOpenChange}
          openRequestKey={modelMenuOpenRequestKey}
          labelVisibilityClassName="hidden @sm/composer:inline-flex"
          indicatorClassName="block group-data-[composer-model-icon=true]/toolbar:hidden"
          triggerLabelClassName="block min-w-0 text-left group-data-[composer-model-icon=true]/toolbar:hidden [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
          triggerClassName="composer-model-trigger group-data-[composer-model-icon=true]/toolbar:size-7 group-data-[composer-model-icon=true]/toolbar:p-0 group-data-[composer-model-icon=true]/toolbar:gap-0 group-data-[composer-model-icon=true]/toolbar:justify-center"
          triggerIconClassName="hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
          focusSelectorOnClose={V4_COMPOSER_INPUT_SELECTOR}
          providerSubmenuClassName={providerSubmenuClassName}
        />
      ) : null}
      {highspeedPresented && highspeedExpiresAt !== undefined ? (
        <HighspeedCountdown expiresAt={highspeedExpiresAt} />
      ) : null}
      {thoughtOption ? (
        <ThoughtLevelCycleControl
          composerCollapsePriority={3}
          labelVisibilityClassName="inline-flex"
          indicatorClassName="block"
          triggerClassName={cn(highspeedPresented && "text-ui-caption")}
          option={thoughtOption}
          onValueChange={handleThoughtValueChange}
          disabled={disabled || recoveryPending}
          intl={intl}
          provider={displayProvider}
          shortcutLabel={thoughtShortcutLabel}
          triggerRef={thoughtTriggerRef}
          open={activeConfigPicker === "thought"}
          onOpenChange={handleThoughtPickerOpenChange}
          restoreFocusSelector={V4_COMPOSER_INPUT_SELECTOR}
        />
      ) : null}
    </>
  );
}

export const V4ComposerModelControls = memo(V4ComposerModelControlsImpl);
import { isApiKeyAccess } from "@zcode/provider";
