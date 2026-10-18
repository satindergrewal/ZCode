import type { MouseEvent, UIEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { CodingPlanResetType } from "@zcode/shared";
import { CheckIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { burstCodingPlanQuotaResetConfetti } from "@/lib/codingPlanQuotaResetConfetti.js";

const SUCCESS_DISPLAY_MS = 600;
const ROW_EXIT_MS = 820;

export interface CodingPlanQuotaResetDialogUsageItem {
  color: string;
  id: string;
  label: string;
  percentage: number | null;
  resetTime?: string;
  value: string;
}

export interface CodingPlanQuotaResetDialogResetItem {
  count: number;
  expiresAt: number | null;
  onReset: () => Promise<void>;
  processing?: boolean;
  resetType: CodingPlanResetType;
}

export interface CodingPlanQuotaResetDialogConfig {
  resetItems: CodingPlanQuotaResetDialogResetItem[];
  usageItems: CodingPlanQuotaResetDialogUsageItem[];
}

function getRemainingSeconds(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

/**
 * Whether the row still holds a redeemable opportunity; same predicate as
 * hasUsableCodingPlanQuotaResetOpportunity but keeping processing rows so the in-flight one keeps its spinner.
 */
function isResetItemUsable(item: CodingPlanQuotaResetDialogResetItem, now: number): boolean {
  return item.count > 0 && item.expiresAt !== null && item.expiresAt > now;
}

export function formatCodingPlanQuotaResetCountdown(
  totalSeconds: number,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const values = {
    days: String(days),
    hours: String(hours),
    minutes: String(minutes),
    seconds: String(seconds),
  };
  if (days > 0) {
    return hours > 0
      ? formatMessage({ id: "codingPlan.quotaReset.countdown.daysHours" }, values)
      : formatMessage({ id: "codingPlan.quotaReset.countdown.daysOnly" }, values);
  }
  if (hours > 0) {
    return minutes > 0
      ? formatMessage({ id: "codingPlan.quotaReset.countdown.hoursMinutes" }, values)
      : formatMessage({ id: "codingPlan.quotaReset.countdown.hoursOnly" }, values);
  }
  return formatMessage({ id: "codingPlan.quotaReset.countdown.minutesSeconds" }, values);
}

function readScrollMasks(viewport: HTMLDivElement) {
  return {
    bottom: viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1,
    top: viewport.scrollTop > 1,
  };
}

function resetTypeLabelId(resetType: CodingPlanResetType) {
  return resetType === "WEEK"
    ? "codingPlan.quotaReset.dialog.week"
    : "codingPlan.quotaReset.dialog.fiveHour";
}

function resetTypeAriaId(resetType: CodingPlanResetType) {
  return resetType === "WEEK"
    ? "codingPlan.quotaReset.resetAriaWeek"
    : "codingPlan.quotaReset.resetAria";
}

export function CodingPlanQuotaResetDialog({
  config,
  open,
  onOpenChange,
}: {
  config: CodingPlanQuotaResetDialogConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  const [resettingType, setResettingType] = useState<CodingPlanResetType | null>(null);
  const [successfulType, setSuccessfulType] = useState<CodingPlanResetType | null>(null);
  const [exitingType, setExitingType] = useState<CodingPlanResetType | null>(null);
  const [scrollMasks, setScrollMasks] = useState({ bottom: false, top: false });
  const resetListRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);
  const wasOpenRef = useRef(false);
  // Whether a row survives is decided against the LATEST config when the success feedback ends; the item in the delayed task is the click-time snapshot.
  const resetItemsRef = useRef(config.resetItems);

  useEffect(() => {
    resetItemsRef.current = config.resetItems;
  }, [config.resetItems]);

  useEffect(() => {
    if (open !== wasOpenRef.current) {
      // Success feedback collapses the row via a delayed task; a stale task would pollute the reopened dialog.
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current = [];
    }
    if (open && !wasOpenRef.current) {
      setResettingType(null);
      setSuccessfulType(null);
      setExitingType(null);
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    },
    [],
  );

  // Bugfix: the dialog kept a local redeemed-count, two sources of truth against the entry's remaining
  // balance. Completed states zeroed it, so after one redemption remaining rows got an empty expiry and
  // rendered as expiring-in-0m-0s until a reopen corrected them from the new status. The completed state now
  // carries remaining chances faithfully and count/expiry/visibility read config alone; rows mid-animation
  // (click, success, collapse) stay temporarily.
  const visibleResetItems = config.resetItems.filter(
    (item) =>
      isResetItemUsable(item, now) ||
      resettingType === item.resetType ||
      successfulType === item.resetType ||
      exitingType === item.resetType,
  );

  useEffect(() => {
    const viewport = resetListRef.current;
    if (viewport) setScrollMasks(readScrollMasks(viewport));
  }, [visibleResetItems.length]);

  const updateScrollMasks = (event: UIEvent<HTMLDivElement>) => {
    const next = readScrollMasks(event.currentTarget);
    setScrollMasks((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  };

  const resetLimit = async (
    item: CodingPlanQuotaResetDialogResetItem,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (resettingType !== null || item.processing) return;
    const origin = event.currentTarget;
    setResettingType(item.resetType);
    try {
      await item.onReset();
      setSuccessfulType(item.resetType);
      burstCodingPlanQuotaResetConfetti(origin);
      // Keep/exit is decided on the latest config at settle: same-type chances remaining means the row stays
      // clickable in place (count and earliest expiry carried by the completed state), else it collapses.
      // onReset resolves only after the status reconciliation writes, so config is already post-redemption.
      const settleTimer = window.setTimeout(() => {
        const latest = resetItemsRef.current.find(
          (candidate) => candidate.resetType === item.resetType,
        );
        if (latest && isResetItemUsable(latest, Date.now())) {
          setResettingType(null);
          setSuccessfulType(null);
          return;
        }
        setExitingType(item.resetType);
        const removeTimer = window.setTimeout(() => {
          setResettingType(null);
          setSuccessfulType(null);
          setExitingType(null);
        }, ROW_EXIT_MS - SUCCESS_DISPLAY_MS);
        timersRef.current.push(removeTimer);
      }, SUCCESS_DISPLAY_MS);
      timersRef.current.push(settleTimer);
    } catch {
      // Failure reason and toast are owned by useCodingPlanQuotaResetUi; the dialog only restores clickability.
      setResettingType(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[min(480px,calc(100vw-2rem))] max-w-none gap-5"
      >
        <DialogTitle className="min-w-0 truncate pr-8 text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "codingPlan.quotaReset.dialog.title" })}
        </DialogTitle>

        <section aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.dialog.remaining" })}>
          <div
            className={`grid gap-2 ${getContextQuotaMeterGridClass(config.usageItems.length)} max-sm:grid-cols-1`}
          >
            {config.usageItems.map((item) => (
              <div key={item.id} className="min-w-0 rounded-lg bg-surface p-3">
                <div className="truncate text-ui-sm text-foreground-subtle">{item.label}</div>
                <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
                  <span className="text-ui-lg font-semibold leading-none text-foreground">
                    {item.value}
                  </span>
                  {item.resetTime ? (
                    <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">
                      {item.resetTime}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/50">
                  <div
                    className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
                    style={{
                      backgroundColor: item.color,
                      width: `${Math.max(0, Math.min(100, item.percentage ?? 0))}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        {visibleResetItems.length > 0 ? (
          <section
            aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.dialog.resettable" })}
          >
            <div className="relative">
              <div
                ref={resetListRef}
                className="max-h-[262px] overflow-y-auto overscroll-contain pr-1"
                onScroll={updateScrollMasks}
              >
                {visibleResetItems.map((item) => {
                  const success = successfulType === item.resetType;
                  const isExiting = exitingType === item.resetType;
                  const effectiveProcessing = item.processing || resettingType === item.resetType;
                  // One type may hold several chances, but the server /use cannot target one, so the entry keeps
                  // only count and earliest expiry (the completed state carries the remainder after one redemption).
                  // With several, label count and soonest explicitly so the earliest expiry is not misread as a
                  // deadline for all chances.
                  const hasMultipleOpportunities = item.count > 1;
                  return (
                    <div
                      key={item.resetType}
                      className={`grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out last:[&>div]:pb-0 motion-reduce:transition-none ${
                        isExiting
                          ? "pointer-events-none grid-rows-[0fr] opacity-0"
                          : "grid-rows-[1fr] opacity-100"
                      }`}
                    >
                      <div className="min-h-0 overflow-hidden pb-2">
                        <div className="flex min-w-0 items-center gap-3 rounded-lg bg-surface p-3 transition-colors hover:bg-surface-hover">
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-ui-base text-foreground">
                                {intl.formatMessage({ id: resetTypeLabelId(item.resetType) })}
                              </span>
                              {hasMultipleOpportunities ? (
                                <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-interaction-confirmation-surface px-1.5 text-ui-sm text-interaction-confirmation-foreground">
                                  {intl.formatMessage(
                                    { id: "codingPlan.quotaReset.dialog.itemCount" },
                                    { count: item.count },
                                  )}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle tabular-nums">
                              {/* Bugfix: after redeeming the last chance the row still plays success/collapse with no
                                  expiry left; it used to render as expiring-in-0m-0s. A no-break space holds the line height. */}
                              {item.expiresAt === null
                                ? "\u00a0"
                                : intl.formatMessage(
                                    {
                                      id: hasMultipleOpportunities
                                        ? "codingPlan.quotaReset.dialog.expiresInSoonest"
                                        : "codingPlan.quotaReset.dialog.expiresIn",
                                    },
                                    {
                                      time: formatCodingPlanQuotaResetCountdown(
                                        getRemainingSeconds(item.expiresAt, now),
                                        intl.formatMessage,
                                      ),
                                    },
                                  )}
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            aria-label={
                              success
                                ? intl.formatMessage({ id: "codingPlan.quotaReset.success" })
                                : intl.formatMessage({ id: resetTypeAriaId(item.resetType) })
                            }
                            className="bg-success text-success-foreground hover:bg-success/80"
                            disabled={Boolean(
                              success ||
                              effectiveProcessing ||
                              (resettingType !== null && resettingType !== item.resetType),
                            )}
                            onClick={(event) => void resetLimit(item, event)}
                          >
                            {success ? (
                              <>
                                <CheckIcon className="size-3.5" aria-hidden="true" />
                                {intl.formatMessage({ id: "codingPlan.quotaReset.completed" })}
                              </>
                            ) : effectiveProcessing ? (
                              <Loader2
                                className="size-3.5 animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                              />
                            ) : (
                              intl.formatMessage({ id: "codingPlan.quotaReset.reset" })
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-popover to-transparent transition-opacity duration-150 ${
                  scrollMasks.top ? "opacity-100" : "opacity-0"
                }`}
              />
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-popover to-transparent transition-opacity duration-150 ${
                  scrollMasks.bottom ? "opacity-100" : "opacity-0"
                }`}
              />
            </div>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
