/* eslint-disable max-lines -- the context panel aggregates Context windows, Coding Plan, and Start Plan tightly; splitting needs its own popover-state review. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  TID_CHAT_CONTEXT_USAGE_TRIGGER,
  type CodingPlanResetType,
  type ZCodeContextUsageBreakdownItem,
  type ZCodeProvider,
} from "@zcode/shared";
import {
  Context,
  ContextContentBody,
  ContextContent,
  ContextTrigger,
} from "@/components/ai-elements/context.js";
import { cn } from "@/components/lib/utils.js";
import { Progress } from "@/components/ui/progress.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isSettingsTab } from "@/store/tabStore.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { resolveCodingPlanUsageRemainingState } from "@/CodingPlanUsageRemainingPanel.js";
import { CodingPlanQuotaResetStatusContent } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetStatus.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
  CODING_PLAN_QUOTA_RESET_TYPES,
  advanceCodingPlanQuotaResetCelebration,
  pruneCodingPlanQuotaResetConfettiArms,
  resolveCodingPlanQuotaResetAutomaticPhase,
  type CodingPlanQuotaResetAutomaticPhase,
  type CodingPlanQuotaResetCelebrationState,
  type CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  ChatCodingPlanUsageRemainingPanel,
  hasChatCodingPlanUsageRemaining,
  type ChatCodingPlanUsageRemainingConfig,
  type CodingPlanQuotaResetAutoConfettiArms,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import { resolveChatCodingPlanResetOpportunityBadge } from "@/chat-input-toolbar/codingPlanResetOpportunityBadge.js";
import {
  ChatStartPlanBalancePanel,
  hasChatStartPlanBalance,
  type ChatStartPlanBalanceConfig,
} from "@/chat-input-toolbar/StartPlanContextBalance.js";
import { runContextPanelActionWithClose } from "@/chat-input-toolbar/contextPanelAction.js";
import { coordinateCodingPlanQuotaResetAutoPlay } from "@/chat-input-toolbar/codingPlanQuotaResetAutoPlay.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import {
  CONTEXT_QUOTA_RESET_URGENT_SECONDS,
  ContextQuotaResetOpportunityReminderContent,
  contextQuotaResetOpportunityDismissalStore,
  resolveContextQuotaResetOpportunityReminder,
  resolveContextQuotaResetOpportunityTriggerTone,
  resolveContextTriggerTooltipKind,
  shouldDismissContextQuotaResetOpportunityReminder,
} from "@/chat-input-toolbar/contextQuotaResetOpportunityReminder.js";

type ContextUsageBreakdownSource = ZCodeContextUsageBreakdownItem["source"];

interface ContextUsageBreakdownSegment {
  chars: number;
  percent: number;
  source: ContextUsageBreakdownSource;
}

const CONTEXT_PROGRESS_TONE_COLORS = [
  "var(--color-usage-chart-1)",
  "color-mix(in oklab, var(--color-usage-chart-1) 78%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 58%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 42%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 28%, var(--color-surface))",
] as const;
const PERCENT_MAX = 100;
const CACHE_HIT_RATE_DISPLAY_THRESHOLD = 0.78;

export function formatContextUsageTokenCount(
  value: number,
  locale: string,
  options: { maximumFractionDigits?: number } = {},
): string {
  return formatCompactTokenNumber(locale, value, options);
}

export function formatContextUsageSummary({
  locale,
  percent,
  size,
  used,
}: {
  locale: string;
  percent: number;
  size: number;
  used: number;
}): string {
  const percentageFormatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  });
  return `${formatContextUsageTokenCount(used, locale)}/${formatContextUsageTokenCount(
    size,
    locale,
    {
      maximumFractionDigits: 0,
    },
  )} (${percentageFormatter.format(percent)})`;
}

export function formatContextCacheHitRateLabel(
  hitRate: number | null | undefined,
  locale: string,
  options: { showBelowThreshold?: boolean } = {},
): string | null {
  if (hitRate === null || hitRate === undefined || !Number.isFinite(hitRate)) {
    return null;
  }

  // The production panel shows only clear cache gains; low hit rates distract from capacity.
  // Dev needs the provider's true low-hit values, so the 78% display threshold is bypassable there.
  if (!options.showBelowThreshold && hitRate < CACHE_HIT_RATE_DISPLAY_THRESHOLD) {
    return null;
  }

  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(Math.max(0, hitRate));
}

function getBreakdownToneStyle(index: number): CSSProperties {
  return {
    backgroundColor:
      CONTEXT_PROGRESS_TONE_COLORS[Math.min(index, CONTEXT_PROGRESS_TONE_COLORS.length - 1)] ??
      CONTEXT_PROGRESS_TONE_COLORS[0],
  };
}

const BREAKDOWN_SOURCE_LABEL_ID: Record<ContextUsageBreakdownSource, string> = {
  messages: "chat.contextUsage.breakdown.messages",
  system_prompt: "chat.contextUsage.breakdown.systemPrompt",
  meta_user_context: "chat.contextUsage.breakdown.metaUserContext",
  skills: "chat.contextUsage.breakdown.skills",
  tool_prompt: "chat.contextUsage.breakdown.toolPrompt",
  system_tool_schemas: "chat.contextUsage.breakdown.systemTools",
  mcp_tool_schemas: "chat.contextUsage.breakdown.mcpTools",
};

const BREAKDOWN_SOURCE_ORDER: Record<ContextUsageBreakdownSource, number> = {
  messages: 0,
  system_prompt: 1,
  meta_user_context: 2,
  skills: 3,
  tool_prompt: 4,
  system_tool_schemas: 5,
  mcp_tool_schemas: 6,
};

export function buildContextUsageBreakdownSegments(
  breakdown: readonly ZCodeContextUsageBreakdownItem[] | undefined,
): ContextUsageBreakdownSegment[] {
  const charsBySource = new Map<ContextUsageBreakdownSource, number>();
  for (const item of breakdown ?? []) {
    if (!Number.isFinite(item.chars) || item.chars <= 0) {
      continue;
    }
    charsBySource.set(item.source, (charsBySource.get(item.source) ?? 0) + item.chars);
  }

  const totalChars = [...charsBySource.values()].reduce((sum, chars) => sum + chars, 0);
  if (totalChars <= 0) {
    return [];
  }

  return [...charsBySource.entries()]
    .map(([source, chars]) => ({
      chars,
      percent: chars / totalChars,
      source,
    }))
    .sort(
      (left, right) =>
        right.chars - left.chars ||
        BREAKDOWN_SOURCE_ORDER[left.source] - BREAKDOWN_SOURCE_ORDER[right.source],
    );
}

export function buildContextUsageProgressSegments(
  segments: readonly ContextUsageBreakdownSegment[],
) {
  return segments.map((segment, index) => ({
    id: segment.source,
    percent: segment.percent,
    style: getBreakdownToneStyle(index),
  }));
}

export function getRenderableTaskUsage<T extends { used: number; size: number }>(
  taskUsage: T | null,
): T | null {
  if (!taskUsage) {
    return null;
  }

  // The ZCode Protocol migration will add real contextUsed/contextWindow later.
  // used=0 or invalid is not a displayable occupancy; never render init/error fallback as a misleading 0%.
  if (
    !Number.isFinite(taskUsage.used) ||
    !Number.isFinite(taskUsage.size) ||
    taskUsage.used <= 0 ||
    taskUsage.size <= 0
  ) {
    return null;
  }

  return taskUsage;
}

export function getContextCompressionCommand(_provider: ZCodeProvider): string {
  return "/compact";
}

// Auto/ops completions (empty startedAt) with the currently effective used_at; manual ones never reach triggers.
function resolveAutomaticCompletedAt(entry: CodingPlanQuotaResetUiEntry | null): number | null {
  return entry?.status === "completed" && entry.startedAt === null && entry.observedAt !== null
    ? entry.completedAt
    : null;
}

export function refreshContextUsageOnOpen(
  open: boolean,
  onAccess: (() => Promise<void> | void) | undefined,
): void {
  if (open) {
    void onAccess?.();
  }
}

export function ChatContextUsage({
  codingPlanUsageRemaining,
  startPlanBalance,
  taskUsage,
  selectedProvider: _selectedProvider,
  intl,
  locale,
}: {
  codingPlanUsageRemaining?: ChatCodingPlanUsageRemainingConfig;
  startPlanBalance?: ChatStartPlanBalanceConfig;
  taskUsage: {
    used: number;
    size: number;
    cache?: { hitRate: number | null };
    breakdown?: ZCodeContextUsageBreakdownItem[];
  } | null;
  selectedProvider: ZCodeProvider;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  onSendCompressionCommand?: (command: string) => void;
  compressionDisabled?: boolean;
}) {
  const isWorkspaceVisible = useOptionalTabStore(
    (state) => !state.tabs.some((tab) => tab.id === state.activeTabId && isSettingsTab(tab)),
  );
  const [contextOpen, setContextOpen] = useState(false);
  const [contextAccessRefreshing, setContextAccessRefreshing] = useState(false);
  const [quotaResetDialogOpen, setQuotaResetDialogOpen] = useState(false);
  const quotaResetDialogOpenRef = useRef(false);
  const contextUsageTriggerRef = useRef<HTMLElement | null>(null);
  const contextAccessRefreshSeqRef = useRef(0);
  const handleContextOpenChange = useCallback(
    (open: boolean) => {
      // Opening the dialog moves focus off the HoverCard and Radix at once asks to close it;
      // unmounting then would take the portal's reset dialog too, so refuse closes while it lives.
      if (!open && quotaResetDialogOpenRef.current) {
        return;
      }
      setContextOpen(open);
      // Hover refresh must not bind to Coding Plan's onAccess alone: Start Plan (today's balance) and
      // Coding Plan connect exclusively, so Start Plan hovers fired no refresh and the balance only moved
      // via settings/sidebar. Fire the silent refresh when either config has onAccess (only one can exist).
      const accessRefresh = codingPlanUsageRemaining?.onAccess ?? startPlanBalance?.onAccess;
      if (!open || !accessRefresh) {
        return;
      }
      // A silent access refresh with a cached snapshot never sets entitlement.loading.
      // The header spinner follows this hover's promise, not just snapshot loading.
      const refreshSeq = contextAccessRefreshSeqRef.current + 1;
      contextAccessRefreshSeqRef.current = refreshSeq;
      setContextAccessRefreshing(true);
      Promise.resolve(accessRefresh()).finally(() => {
        if (contextAccessRefreshSeqRef.current === refreshSeq) {
          setContextAccessRefreshing(false);
        }
      });
    },
    [codingPlanUsageRemaining?.onAccess, startPlanBalance?.onAccess],
  );
  const handleQuotaResetDialogOpenChange = useCallback((open: boolean) => {
    quotaResetDialogOpenRef.current = open;
    setQuotaResetDialogOpen(open);
    if (!open) {
      setContextOpen(false);
    }
  }, []);
  const renderableTaskUsage = getRenderableTaskUsage(taskUsage);
  const codingPlanUsageRemainingWithClose = useMemo<
    ChatCodingPlanUsageRemainingConfig | undefined
  >(() => {
    if (!codingPlanUsageRemaining) {
      return undefined;
    }
    const base = {
      ...codingPlanUsageRemaining,
      refreshing: contextAccessRefreshing || codingPlanUsageRemaining.refreshing === true,
    };
    if (!codingPlanUsageRemaining.onUsageClick) {
      return base;
    }

    return {
      ...base,
      onUsageClick: () =>
        runContextPanelActionWithClose({
          action: codingPlanUsageRemaining.onUsageClick,
          close: () => setContextOpen(false),
        }),
    };
  }, [codingPlanUsageRemaining, contextAccessRefreshing]);
  const startPlanBalanceWithClose = useMemo<ChatStartPlanBalanceConfig | undefined>(() => {
    if (!startPlanBalance) {
      return undefined;
    }
    const base: ChatStartPlanBalanceConfig = {
      ...startPlanBalance,
      // Silent access refreshes never set entitlement.loading; the balance-header spinner follows
      // this hover's promise (contextAccessRefreshing), matching the Coding Plan section's refreshing.
      refreshing: contextAccessRefreshing || startPlanBalance.refreshing === true,
    };
    if (!startPlanBalance.onUpgradeClick) {
      return base;
    }

    return {
      ...base,
      onUpgradeClick: () => {
        // Clicks inside the HoverCard do not close it the way an external hover-leave does.
        // The upgrade entry navigates to settings; collapse the panel first or the stale overlay follows.
        setContextOpen(false);
        startPlanBalance.onUpgradeClick?.();
      },
    };
  }, [startPlanBalance, contextAccessRefreshing]);
  const hasCodingPlanUsageRemaining = codingPlanUsageRemainingWithClose
    ? hasChatCodingPlanUsageRemaining(codingPlanUsageRemainingWithClose)
    : false;
  const hasStartPlanBalance = hasChatStartPlanBalance(startPlanBalanceWithClose);

  // Auto-reset: trigger and panel share one full Personal/Team scope; a shared in-flight avoids duplicate requests.
  const resetCodingPlanState = useMemo(
    () =>
      codingPlanUsageRemainingWithClose
        ? resolveCodingPlanUsageRemainingState(codingPlanUsageRemainingWithClose)
        : null,
    [codingPlanUsageRemainingWithClose],
  );
  const resetSourceKey = resetCodingPlanState?.displayedProviderId ?? null;
  // MCP sits beside main quotas under three; a fourth main quota wraps full-width; overlay width stays constant.
  const contextPanelWidthClass = "!w-80";
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey: resetSourceKey,
    preferredProviderId: resetCodingPlanState?.displayedEntitlement?.providerId,
    accountAccess: resetCodingPlanState?.displayedEntitlement?.accountAccess,
    onEntitlementRefresh: codingPlanUsageRemainingWithClose?.onEntitlementRefresh,
  });
  const opportunityBadge = resolveChatCodingPlanResetOpportunityBadge(
    resetCodingPlanState,
    resetUi,
  );
  const [opportunityNow, setOpportunityNow] = useState(() => Date.now());
  const opportunityDismissal = useSyncExternalStore(
    contextQuotaResetOpportunityDismissalStore.subscribe,
    contextQuotaResetOpportunityDismissalStore.getSnapshot,
    contextQuotaResetOpportunityDismissalStore.getSnapshot,
  );
  useEffect(() => {
    const now = Date.now();
    if (
      !opportunityBadge.visible ||
      opportunityBadge.expiresAt === null ||
      opportunityBadge.expiresAt <= now
    ) {
      return;
    }
    setOpportunityNow(now);
    let countdownTimer: number | undefined;
    let urgentThresholdTimer: number | undefined;
    const startUrgentCountdown = () => {
      const update = () => {
        const currentNow = Date.now();
        setOpportunityNow(currentNow);
        const expired = (opportunityBadge.expiresAt ?? 0) <= currentNow;
        if (expired && countdownTimer !== undefined) {
          window.clearInterval(countdownTimer);
          countdownTimer = undefined;
        }
        return expired;
      };
      if (!update()) {
        countdownTimer = window.setInterval(update, 1_000);
      }
    };
    const untilUrgent =
      opportunityBadge.expiresAt - now - CONTEXT_QUOTA_RESET_URGENT_SECONDS * 1_000;
    if (untilUrgent <= 0) {
      startUrgentCountdown();
    } else {
      urgentThresholdTimer = window.setTimeout(startUrgentCountdown, untilUrgent);
    }
    return () => {
      if (countdownTimer !== undefined) window.clearInterval(countdownTimer);
      if (urgentThresholdTimer !== undefined) window.clearTimeout(urgentThresholdTimer);
    };
  }, [opportunityBadge.expiresAt, opportunityBadge.visible, resetSourceKey]);
  const opportunityReminder = resolveContextQuotaResetOpportunityReminder({
    dismissal: opportunityDismissal,
    now: opportunityNow,
    opportunity: { ...opportunityBadge, sourceKey: resetSourceKey },
  });
  const opportunityTriggerTone = resolveContextQuotaResetOpportunityTriggerTone({
    now: opportunityNow,
    opportunity: { ...opportunityBadge, sourceKey: resetSourceKey },
  });
  const dismissOpportunityReminder = useCallback(() => {
    if (!opportunityReminder) return;
    contextQuotaResetOpportunityDismissalStore.dismiss(opportunityReminder);
  }, [opportunityReminder?.opportunityKey, opportunityReminder?.phase]);
  useEffect(() => {
    // The settings overlay stays mounted in the workspace; background listeners must not count as read.
    if (!isWorkspaceVisible || !opportunityReminder || contextOpen) return;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (
        shouldDismissContextQuotaResetOpportunityReminder(
          event.target,
          contextUsageTriggerRef.current,
        )
      ) {
        dismissOpportunityReminder();
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [
    isWorkspaceVisible,
    contextOpen,
    dismissOpportunityReminder,
    opportunityReminder?.opportunityKey,
    opportunityReminder?.phase,
  ]);
  // Five-hour and week quotas keep separate confetti trails so one completion never suppresses the other.
  const resetCelebrationStateByTypeRef = useRef<
    Record<CodingPlanResetType, CodingPlanQuotaResetCelebrationState | null>
  >({ FIVE_HOUR: null, WEEK: null });
  const fiveHourEntry = resetUi.entry;
  const weekEntry = resetUi.week.entry;
  // Auto/ops completions (empty startedAt) are play candidates only; status never drives tooltip/confetti directly.
  const automaticCompletionCandidateByType = useMemo<Record<CodingPlanResetType, number | null>>(
    () => ({
      FIVE_HOUR: resolveAutomaticCompletedAt(fiveHourEntry),
      WEEK: resolveAutomaticCompletedAt(weekEntry),
    }),
    [fiveHourEntry, weekEntry],
  );
  const [claimedAutomaticCompletion, setClaimedAutomaticCompletion] = useState<{
    sourceKey: string | null;
    completedAtByType: CodingPlanQuotaResetAutoConfettiArms;
  }>({
    sourceKey: null,
    completedAtByType: { FIVE_HOUR: null, WEEK: null },
  });
  const claimedAutomaticCompletionRef = useRef(claimedAutomaticCompletion);
  claimedAutomaticCompletionRef.current = claimedAutomaticCompletion;
  const latestAutomaticCompletionCandidateRef = useRef({
    sourceKey: resetSourceKey,
    completedAtByType: automaticCompletionCandidateByType,
  });
  latestAutomaticCompletionCandidateRef.current = {
    sourceKey: resetSourceKey,
    completedAtByType: automaticCompletionCandidateByType,
  };
  const [autoPlayReservationRetryTick, setAutoPlayReservationRetryTick] = useState(0);

  // Main may return the claim after this composer unmounted or switched source. Take a token-bearing
  // reservation first; commit played only if component/candidate still match and display is imminent.
  // Invalid winners release; busy losers keep observedAt, retrying on the played broadcast or release.
  useEffect(() => {
    let active = true;
    const retryTimers: Array<ReturnType<typeof setTimeout>> = [];
    const previous = claimedAutomaticCompletionRef.current;
    const sameSource = previous.sourceKey === resetSourceKey;
    const synchronized = {
      sourceKey: resetSourceKey,
      completedAtByType: {
        FIVE_HOUR:
          sameSource &&
          previous.completedAtByType.FIVE_HOUR === automaticCompletionCandidateByType.FIVE_HOUR
            ? previous.completedAtByType.FIVE_HOUR
            : null,
        WEEK:
          sameSource && previous.completedAtByType.WEEK === automaticCompletionCandidateByType.WEEK
            ? previous.completedAtByType.WEEK
            : null,
      },
    };
    if (
      previous.sourceKey !== synchronized.sourceKey ||
      previous.completedAtByType.FIVE_HOUR !== synchronized.completedAtByType.FIVE_HOUR ||
      previous.completedAtByType.WEEK !== synchronized.completedAtByType.WEEK
    ) {
      claimedAutomaticCompletionRef.current = synchronized;
      setClaimedAutomaticCompletion(synchronized);
    }

    for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
      const completedAt = automaticCompletionCandidateByType[resetType];
      if (completedAt === null || synchronized.completedAtByType[resetType] === completedAt) {
        continue;
      }
      void coordinateCodingPlanQuotaResetAutoPlay({
        reserve: () => resetUi.reserveAutomaticCompletion(resetType, completedAt),
        isCurrent: () => {
          const latest = latestAutomaticCompletionCandidateRef.current;
          return (
            active &&
            latest.sourceKey === resetSourceKey &&
            latest.completedAtByType[resetType] === completedAt
          );
        },
        commit: resetUi.commitAutomaticCompletion,
        release: resetUi.releaseAutomaticCompletion,
        onCommitted: () => {
          const current = claimedAutomaticCompletionRef.current;
          const completedAtByType =
            current.sourceKey === resetSourceKey
              ? current.completedAtByType
              : { FIVE_HOUR: null, WEEK: null };
          if (completedAtByType[resetType] === completedAt) {
            return;
          }
          const next = {
            sourceKey: resetSourceKey,
            completedAtByType: {
              ...completedAtByType,
              [resetType]: completedAt,
            },
          };
          claimedAutomaticCompletionRef.current = next;
          setClaimedAutomaticCompletion(next);
        },
      }).then((result) => {
        if (result.status !== "retry" || !active) {
          return;
        }
        const latest = latestAutomaticCompletionCandidateRef.current;
        if (
          latest.sourceKey !== resetSourceKey ||
          latest.completedAtByType[resetType] !== completedAt
        ) {
          return;
        }
        retryTimers.push(
          setTimeout(() => {
            if (active) {
              setAutoPlayReservationRetryTick((tick) => tick + 1);
            }
          }, result.retryAfterMs),
        );
      });
    }

    return () => {
      active = false;
      for (const timer of retryTimers) {
        clearTimeout(timer);
      }
    };
  }, [
    automaticCompletionCandidateByType.FIVE_HOUR,
    automaticCompletionCandidateByType.WEEK,
    autoPlayReservationRetryTick,
    resetSourceKey,
    resetUi.commitAutomaticCompletion,
    resetUi.releaseAutomaticCompletion,
    resetUi.reserveAutomaticCompletion,
  ]);

  // Tooltip/confetti consume only a used_at this window claimed and that still matches the candidate.
  const automaticCompletedAtByType = useMemo<Record<CodingPlanResetType, number | null>>(() => {
    if (claimedAutomaticCompletion.sourceKey !== resetSourceKey) {
      return { FIVE_HOUR: null, WEEK: null };
    }
    return {
      FIVE_HOUR:
        claimedAutomaticCompletion.completedAtByType.FIVE_HOUR ===
        automaticCompletionCandidateByType.FIVE_HOUR
          ? claimedAutomaticCompletion.completedAtByType.FIVE_HOUR
          : null,
      WEEK:
        claimedAutomaticCompletion.completedAtByType.WEEK ===
        automaticCompletionCandidateByType.WEEK
          ? claimedAutomaticCompletion.completedAtByType.WEEK
          : null,
    };
  }, [
    automaticCompletionCandidateByType.FIVE_HOUR,
    automaticCompletionCandidateByType.WEEK,
    claimedAutomaticCompletion,
    resetSourceKey,
  ]);
  const [resetTooltipNow, setResetTooltipNow] = useState(() => Date.now());
  // Auto-complete used_at dismissed via hover (per kind); a new used_at reshows by itself,
  // so one kind's completion never clears the other's dismissed state.
  const [resetTooltipDismissed, setResetTooltipDismissed] =
    useState<CodingPlanQuotaResetAutoConfettiArms>({
      FIVE_HOUR: null,
      WEEK: null,
    });
  // Pending confetti used_at (per kind); on hover-expand each quota row bursts once at its reset spot.
  const [armedAutoConfetti, setArmedAutoConfetti] = useState<CodingPlanQuotaResetAutoConfettiArms>({
    FIVE_HOUR: null,
    WEEK: null,
  });
  const isTypeDismissed = useCallback(
    (resetType: CodingPlanResetType): boolean => {
      const completedAt = automaticCompletedAtByType[resetType];
      return completedAt !== null && resetTooltipDismissed[resetType] === completedAt;
    },
    [automaticCompletedAtByType, resetTooltipDismissed],
  );
  const phaseByType = useMemo<
    Record<CodingPlanResetType, CodingPlanQuotaResetAutomaticPhase | null>
  >(
    () => ({
      FIVE_HOUR:
        automaticCompletedAtByType.FIVE_HOUR === null
          ? null
          : resolveCodingPlanQuotaResetAutomaticPhase(
              fiveHourEntry,
              resetTooltipNow,
              isTypeDismissed("FIVE_HOUR"),
            ),
      WEEK:
        automaticCompletedAtByType.WEEK === null
          ? null
          : resolveCodingPlanQuotaResetAutomaticPhase(
              weekEntry,
              resetTooltipNow,
              isTypeDismissed("WEEK"),
            ),
    }),
    [
      automaticCompletedAtByType.FIVE_HOUR,
      automaticCompletedAtByType.WEEK,
      fiveHourEntry,
      weekEntry,
      resetTooltipNow,
      isTypeDismissed,
    ],
  );
  // With both kinds in auto-notice, show the later-observed one (closest to just now).
  const activeResetType = useMemo<CodingPlanResetType | null>(() => {
    const candidates = CODING_PLAN_QUOTA_RESET_TYPES.filter(
      (resetType) => phaseByType[resetType] !== null,
    );
    if (candidates.length === 0) {
      return null;
    }
    return candidates.reduce((chosen, resetType) => {
      const chosenObserved = (chosen === "WEEK" ? weekEntry : fiveHourEntry)?.observedAt ?? 0;
      const currentObserved = (resetType === "WEEK" ? weekEntry : fiveHourEntry)?.observedAt ?? 0;
      return currentObserved > chosenObserved ? resetType : chosen;
    });
  }, [phaseByType, fiveHourEntry, weekEntry]);
  const resetTooltipPhase = activeResetType ? phaseByType[activeResetType] : null;
  const activeEntry =
    activeResetType === "WEEK" ? weekEntry : activeResetType === "FIVE_HOUR" ? fiveHourEntry : null;
  const triggerTooltipKind = resolveContextTriggerTooltipKind(
    resetTooltipPhase,
    opportunityReminder?.phase ?? null,
  );
  // The tooltip portal mounts on body; workspace opacity/inert cannot hide it, so follow Root's settings tab.
  const resetStatusTooltipOpen = isWorkspaceVisible && triggerTooltipKind !== null && !contextOpen;

  // New auto/ops completion: restart the synthetic resetting timer per kind and arm that row's confetti.
  // Tracked per kind, no cross-blocking; dismissed is per used_at and new ones reshow themselves.
  useEffect(() => {
    const armedByType: Partial<Record<CodingPlanResetType, number>> = {};
    for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
      const entry = resetType === "WEEK" ? weekEntry : fiveHourEntry;
      const automaticCompletedAt = automaticCompletedAtByType[resetType];
      const result = advanceCodingPlanQuotaResetCelebration(
        resetCelebrationStateByTypeRef.current[resetType],
        {
          sourceKey: resetSourceKey,
          completedAt: entry?.completedAt ?? null,
          automaticCompletion: automaticCompletedAt !== null,
        },
      );
      resetCelebrationStateByTypeRef.current[resetType] = result.state;
      if (result.shouldCelebrate && automaticCompletedAt !== null) {
        armedByType[resetType] = automaticCompletedAt;
      }
    }
    if (Object.keys(armedByType).length > 0) {
      setResetTooltipNow(Date.now());
      setArmedAutoConfetti((prev) => ({ ...prev, ...armedByType }));
    }
  }, [automaticCompletedAtByType, fiveHourEntry, weekEntry, resetSourceKey]);

  // Cross-window played broadcasts clear observedAt of a showing auto-complete; armed confetti
  // must clear too, or hover replays here, breaking played-once-per-window.
  useEffect(() => {
    setArmedAutoConfetti((prev) =>
      pruneCodingPlanQuotaResetConfettiArms(prev, automaticCompletedAtByType),
    );
  }, [automaticCompletedAtByType]);

  // When the synthetic resetting phase expires, flip to reset (kept until hover-dismiss).
  useEffect(() => {
    const observedAt = activeEntry?.observedAt ?? null;
    if (resetTooltipPhase !== "processing" || observedAt === null) {
      return;
    }
    const remaining = observedAt + CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS - Date.now();
    const timer = window.setTimeout(() => setResetTooltipNow(Date.now()), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [resetTooltipPhase, activeEntry?.observedAt]);

  // Hover-expand marks every kind in auto-notice dismissed,
  // letting the matching reset row replay confetti in place (both kinds may be noticing).
  useEffect(() => {
    if (!contextOpen) {
      return;
    }
    if (opportunityReminder) {
      dismissOpportunityReminder();
    }
    setResetTooltipDismissed((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
        const completedAt = automaticCompletedAtByType[resetType];
        if (
          phaseByType[resetType] !== null &&
          completedAt !== null &&
          next[resetType] !== completedAt
        ) {
          next[resetType] = completedAt;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [
    contextOpen,
    phaseByType,
    automaticCompletedAtByType,
    opportunityReminder?.opportunityKey,
    opportunityReminder?.phase,
    dismissOpportunityReminder,
  ]);

  const handleAutoResetCelebrated = useCallback((completedAt: number) => {
    setArmedAutoConfetti((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
        if (next[resetType] === completedAt) {
          next[resetType] = null;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const contextUsageLabel = useMemo(() => {
    if (!renderableTaskUsage) {
      return null;
    }

    return intl.formatMessage(
      { id: "chat.contextUsage" },
      {
        used: numberFormatter.format(renderableTaskUsage.used),
        total: numberFormatter.format(renderableTaskUsage.size),
      },
    );
  }, [intl, numberFormatter, renderableTaskUsage]);
  const cacheHitRateLabel = useMemo(() => {
    return formatContextCacheHitRateLabel(renderableTaskUsage?.cache?.hitRate, locale, {
      showBelowThreshold: import.meta.env.DEV,
    });
  }, [locale, renderableTaskUsage]);
  const breakdownSegments = useMemo(
    () => buildContextUsageBreakdownSegments(renderableTaskUsage?.breakdown),
    [renderableTaskUsage?.breakdown],
  );
  const progressSegments = useMemo(
    () => buildContextUsageProgressSegments(breakdownSegments),
    [breakdownSegments],
  );
  const percentageFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        maximumFractionDigits: 1,
        style: "percent",
      }),
    [locale],
  );

  if (
    (!renderableTaskUsage || !contextUsageLabel) &&
    !hasCodingPlanUsageRemaining &&
    !hasStartPlanBalance
  ) {
    return null;
  }

  const usagePercent = renderableTaskUsage
    ? Math.min(Math.max(renderableTaskUsage.used / renderableTaskUsage.size, 0), 1)
    : 0;
  const compactTokenUsageLabel = renderableTaskUsage
    ? formatContextUsageSummary({
        locale,
        percent: usagePercent,
        size: renderableTaskUsage.size,
        used: renderableTaskUsage.used,
      })
    : null;
  const triggerLabel =
    contextUsageLabel ??
    (hasCodingPlanUsageRemaining
      ? intl.formatMessage({ id: "sidebar.usage.plan.title" })
      : intl.formatMessage({
          id: "settings.modelProvider.startPlan.balance.title",
        }));
  const contextUsedTokens = renderableTaskUsage?.used ?? 0;
  const contextMaxTokens = renderableTaskUsage?.size ?? 1;

  return (
    <Context
      usedTokens={contextUsedTokens}
      maxTokens={contextMaxTokens}
      open={contextOpen}
      onOpenChange={handleContextOpenChange}
    >
      <ControlHintTooltip
        className={
          triggerTooltipKind === "reset-status" ? undefined : "bg-background py-0.5 pr-0.5"
        }
        open={resetStatusTooltipOpen}
        side="top"
        standalone
        triggerRef={contextUsageTriggerRef}
        title={
          triggerTooltipKind === "reset-status" && resetTooltipPhase ? (
            <CodingPlanQuotaResetStatusContent
              status={resetTooltipPhase}
              resetType={activeResetType ?? "FIVE_HOUR"}
            />
          ) : opportunityReminder ? (
            <ContextQuotaResetOpportunityReminderContent
              count={opportunityReminder.count}
              intl={intl}
              onDismiss={dismissOpportunityReminder}
              phase={opportunityReminder.phase}
              remainingSeconds={opportunityReminder.remainingSeconds}
            />
          ) : null
        }
      >
        {/* Bugfix: the span anchors ControlHintTooltip asChild while the inner ContextTrigger stays
            the HoverCard trigger, so two Radix overlays never stack refs on one node. Manual-redeem
            processing shows on the dialog's own button; the trigger never spins. */}
        <span className="inline-flex shrink-0">
          <ContextTrigger
            aria-label={triggerLabel}
            className={cn(
              "text-foreground-subtle",
              opportunityTriggerTone === "available" && "text-success",
              opportunityTriggerTone === "urgent" && "bg-warning/10 text-warning",
            )}
            data-chat-toolbar-popover-trigger="true"
            data-testid={TID_CHAT_CONTEXT_USAGE_TRIGGER}
            onPointerDown={(event) => {
              // Radix HoverCard eats the click after touchstart, so phones could not open the panel;
              // open on touch pointerdown; desktop keeps the hover/focus semantics.
              if (
                !event.defaultPrevented &&
                event.pointerType === "touch" &&
                typeof window !== "undefined" &&
                window.matchMedia?.("(hover: none)").matches
              ) {
                // Route through the controlled open handler so touch opens also fire the access refresh.
                if (!contextOpen) {
                  handleContextOpenChange(true);
                }
              }
            }}
          />
        </span>
      </ControlHintTooltip>
      <ContextContent
        className={cn(contextPanelWidthClass, "!rounded-xl !shadow-md")}
        side="top"
        sideOffset={2}
      >
        <ContextContentBody className="space-y-3">
          {/* Bugfix: the default ai-elements Header hardcodes a title and splits the summary out.
          This hover needs one compact panel; summary and breakdown live in the body. */}
          {renderableTaskUsage && compactTokenUsageLabel ? (
            <div className="space-y-2">
              <div className="flex min-w-0 mb-3 items-center gap-3">
                <span className="shrink-0 text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "chat.contextUsage.title" })}
                </span>
                <span className="ml-auto shrink-0 text-right font-mono text-ui-sm text-foreground-subtle">
                  {compactTokenUsageLabel}
                </span>
              </div>
              <Progress
                className="h-2 bg-surface"
                indicatorClassName="min-w-2"
                segments={progressSegments}
                value={usagePercent * PERCENT_MAX}
              />
            </div>
          ) : null}
          {renderableTaskUsage && (breakdownSegments.length > 0 || cacheHitRateLabel) ? (
            <>
              {breakdownSegments.length > 0 ? (
                <div
                  aria-label={intl.formatMessage({
                    id: "chat.contextUsage.breakdown",
                  })}
                  className="space-y-1.5"
                >
                  <div className="grid gap-1.5">
                    {breakdownSegments.map((segment, index) => (
                      <div
                        className="flex min-w-0 items-center gap-2 text-ui-sm"
                        key={segment.source}
                      >
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-sm border border-border"
                          style={getBreakdownToneStyle(index)}
                        />
                        <span className="min-w-0 truncate text-foreground-subtle">
                          {intl.formatMessage({
                            id: BREAKDOWN_SOURCE_LABEL_ID[segment.source],
                          })}
                        </span>
                        {/* Bugfix: breakdown rows show ratios only; per-item tokens next to the top total invite misreads. */}
                        <span className="ml-auto min-w-10 shrink-0 text-right font-mono text-ui-sm tabular-nums text-foreground">
                          {percentageFormatter.format(segment.percent)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {cacheHitRateLabel ? (
                <div
                  className={cn(
                    "flex items-center justify-between gap-3 text-ui-sm",
                    breakdownSegments.length > 0 && "border-t border-border pt-3",
                  )}
                >
                  <span className="text-foreground-subtle">
                    {intl.formatMessage({
                      id: "chat.contextUsage.cacheHitRate",
                    })}
                  </span>
                  <span className="font-mono text-ui-sm text-foreground">{cacheHitRateLabel}</span>
                </div>
              ) : null}
            </>
          ) : null}
          {codingPlanUsageRemainingWithClose && hasCodingPlanUsageRemaining ? (
            <ChatCodingPlanUsageRemainingPanel
              autoCelebrateArm={armedAutoConfetti}
              config={codingPlanUsageRemainingWithClose}
              intl={intl}
              locale={locale}
              quotaResetDialogOpen={quotaResetDialogOpen}
              separated={Boolean(renderableTaskUsage && compactTokenUsageLabel)}
              onAutoCelebrated={handleAutoResetCelebrated}
              onQuotaResetDialogOpenChange={handleQuotaResetDialogOpenChange}
            />
          ) : null}
          {startPlanBalanceWithClose && hasStartPlanBalance ? (
            <ChatStartPlanBalancePanel
              config={startPlanBalanceWithClose}
              intl={intl}
              locale={locale}
              separated={Boolean(
                (renderableTaskUsage && compactTokenUsageLabel) || hasCodingPlanUsageRemaining,
              )}
            />
          ) : null}
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
