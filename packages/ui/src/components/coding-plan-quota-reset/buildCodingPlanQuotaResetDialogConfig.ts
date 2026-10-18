import type { CodingPlanResetType } from "@zcode/shared";
import type {
  CodingPlanQuotaResetDialogConfig,
  CodingPlanQuotaResetDialogResetItem,
  CodingPlanQuotaResetDialogUsageItem,
} from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import type { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import type { CodingPlanQuotaResetUiEntry } from "@/lib/codingPlanQuotaResetUi.js";

type CodingPlanQuotaResetUi = ReturnType<typeof useCodingPlanQuotaResetUi>;

function createResetItem(params: {
  enabled: boolean;
  entry: CodingPlanQuotaResetUiEntry | null;
  onReset: () => Promise<void>;
  opportunityVisible: boolean;
  processing: boolean;
  resetType: CodingPlanResetType;
}): CodingPlanQuotaResetDialogResetItem | null {
  const { enabled, entry, opportunityVisible, processing } = params;
  // Bugfix: an extra gate once hid the whole row while remaining quota read 100% ("a reset earns
  // nothing"). But redemption rewrites the remainder to 100%, and while the same type still has
  // chances left the entry returns to available — so a fresh reset hid the remaining cards and the
  // user thought the chances were gone. Chances are user property: show whenever opportunityVisible
  // (unexpired usable grants) and leave full-quota redemption to the user.
  if (!enabled || !entry || (!processing && entry.status !== "completed" && !opportunityVisible)) {
    return null;
  }
  return {
    count: entry.opportunityCount,
    expiresAt: entry.opportunityExpiresAt,
    onReset: params.onReset,
    processing,
    resetType: params.resetType,
  };
}

export function buildCodingPlanQuotaResetDialogConfig(params: {
  fiveHourEnabled: boolean;
  resetUi: CodingPlanQuotaResetUi;
  usageItems: CodingPlanQuotaResetDialogUsageItem[];
  weekEnabled: boolean;
}): CodingPlanQuotaResetDialogConfig {
  const { resetUi } = params;
  const resetItems = [
    createResetItem({
      enabled: params.fiveHourEnabled,
      entry: resetUi.entry,
      onReset: resetUi.reset,
      opportunityVisible: resetUi.opportunityVisible,
      processing: resetUi.processing,
      resetType: "FIVE_HOUR",
    }),
    createResetItem({
      enabled: params.weekEnabled,
      entry: resetUi.week.entry,
      onReset: resetUi.week.reset,
      opportunityVisible: resetUi.week.opportunityVisible,
      processing: resetUi.week.processing,
      resetType: "WEEK",
    }),
  ].filter((item): item is CodingPlanQuotaResetDialogResetItem => item !== null);
  return { resetItems, usageItems: params.usageItems };
}
