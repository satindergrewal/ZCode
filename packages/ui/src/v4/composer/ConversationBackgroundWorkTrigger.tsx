import { memo, useMemo } from "react";
import { ActivityIcon, BotIcon, SquareTerminalIcon, Workflow } from "lucide-react";
import { TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER } from "@zcode/shared";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ComposerBackgroundWorkCounts {
  bashCount: number;
  workflowCount: number;
  subagentCount: number;
  totalCount: number;
}

export function getComposerBackgroundWorkCounts(
  backgroundWorks: readonly BackgroundWorkSummary[],
  runningSubagentCount = 0,
): ComposerBackgroundWorkCounts {
  let bashCount = 0;
  let workflowCount = 0;
  for (const work of backgroundWorks) {
    if (work.status !== "running") continue;
    if (work.kind === "bash") {
      bashCount += 1;
    } else if (work.kind === "workflow") {
      // Workflow runs count separately, never into bashCount. totalCount sums the three background kinds,
      // so a workflow-run-only state still shows the badge and keeps the panel stop reachable.
      workflowCount += 1;
    }
  }
  const subagentCount = Math.max(0, runningSubagentCount);
  return {
    bashCount,
    workflowCount,
    subagentCount,
    totalCount: bashCount + workflowCount + subagentCount,
  };
}

export interface ConversationBackgroundWorkTriggerProps {
  backgroundWorks: readonly BackgroundWorkSummary[];
  runningSubagentCount?: number;
  onOpen?: () => void;
  /**
   * Where onOpen lands:
   * `workflow-run` tooltip says open workflow details; otherwise the per-kind open-running copy.
   * The host decides (needs toolCallId + host callbacks, invisible to the badge); the badge only tells the truth about itself.
   */
  openTarget?: "panel" | "workflow-run";
}

function ConversationBackgroundWorkTriggerImpl({
  backgroundWorks,
  runningSubagentCount = 0,
  onOpen,
  openTarget = "panel",
}: ConversationBackgroundWorkTriggerProps) {
  const { intl } = useZCodeIntl();
  const counts = useMemo(
    () =>
      getComposerBackgroundWorkCounts(backgroundWorks, runningSubagentCount),
    [backgroundWorks, runningSubagentCount],
  );

  if (!onOpen || counts.totalCount === 0) return null;

  // With exactly one kind, use its copy, else the mixed one: pairwise combos would mint six synonym tooltips,
  // and the badge only means live activity, click to look - never precise enumeration.
  const activeKindCount = [counts.bashCount, counts.workflowCount, counts.subagentCount].filter(
    (count) => count > 0,
  ).length;
  const tooltip = intl.formatMessage({
    id:
      openTarget === "workflow-run"
        ? "chat.composer.backgroundWorks.tooltipWorkflowDetails"
        : activeKindCount > 1
          ? "chat.composer.backgroundWorks.tooltipMixed"
          : counts.bashCount > 0
            ? "chat.composer.backgroundWorks.tooltipTerminal"
            : counts.workflowCount > 0
              ? "chat.composer.backgroundWorks.tooltipWorkflow"
              : "chat.composer.backgroundWorks.tooltipAgent",
  });
  const ariaLabel = intl.formatMessage(
    { id: "chat.composer.backgroundWorks.ariaLabel" },
    {
      bashCount: String(counts.bashCount),
      workflowCount: String(counts.workflowCount),
      subagentCount: String(counts.subagentCount),
      count: String(counts.totalCount),
    },
  );

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER}
        data-background-bash-count={counts.bashCount}
        data-background-workflow-count={counts.workflowCount}
        data-background-subagent-count={counts.subagentCount}
        data-background-total-count={counts.totalCount}
        data-background-open-target={openTarget}
        aria-label={ariaLabel}
        onClick={onOpen}
        className="rounded-lg px-1.5 text-ui-base text-[var(--color-foreground-subtle)] tabular-nums"
      >
        <span
          data-composer-background-layout="typed"
          className="inline-flex items-center gap-1 @max-[480px]/composer:hidden"
          aria-hidden
        >
          {/* Terminals first, keeping the pre-workflow-split order; workflow sits between terminals and agents. */}
          {counts.bashCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <SquareTerminalIcon className="size-3.5" />
              <span>{counts.bashCount}</span>
            </span>
          ) : null}
          {counts.workflowCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <Workflow className="size-3.5" />
              <span>{counts.workflowCount}</span>
            </span>
          ) : null}
          {counts.subagentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <BotIcon className="size-3.5" />
              <span>{counts.subagentCount}</span>
            </span>
          ) : null}
        </span>
        <span
          data-composer-background-layout="compact"
          className="hidden items-center gap-0.5 @max-[480px]/composer:inline-flex"
          aria-hidden
        >
          <ActivityIcon className="size-3.5" />
          <span>{counts.totalCount}</span>
        </span>
      </Button>
    </ControlHintTooltip>
  );
}

export const ConversationBackgroundWorkTrigger = memo(
  ConversationBackgroundWorkTriggerImpl,
);
