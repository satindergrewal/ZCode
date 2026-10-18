import { useState } from "react";
import type { ZCodePlanStep } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
} from "@/components/ai-elements/plan.js";
import {
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
} from "@/components/ai-elements/queue.js";
import { ChevronsUpDownIcon, ListTodo, LoaderIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "./components/lib/utils.js";

const todoStatusIndicatorClasses: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtlest",
  in_progress: "text-foreground",
  completed: "text-success",
};

const todoStatusContentClassesStreaming: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtle",
  in_progress: "animated-gradient-text",
  completed: "text-foreground-subtlest line-through",
};

// Bugfix: after stop/exit a plan can keep in_progress items; animated text would
// read as eternal loading. Degrade to plain text with status color when idle.
const todoStatusContentClassesIdle: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtle",
  in_progress: "text-foreground",
  completed: "text-foreground-subtlest line-through",
};

export function TodoPanel({
  plan,
  isStreaming,
}: {
  plan: ZCodePlanStep[] | null;
  isStreaming: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [isOpen, setIsOpen] = useState(false);

  if (!plan || plan.length === 0) {
    return null;
  }

  const completedCount = plan.filter((step) => step.status === "completed").length;
  const isAllCompleted = completedCount === plan.length;
  // Bugfix: providers mark all todos completed before task_complete clears the store;
  // that gap reads as pending work. Hide the panel once everything is done.
  if (isAllCompleted) {
    return null;
  }

  // Bugfix: expanded view kept completed rows (strikethrough); the panel grew and grew.
  // Keep open items only; the panel is for remaining work.
  const visiblePlan = plan.filter((step) => step.status !== "completed");
  const activeStep =
    plan.find((step) => step.status === "in_progress") ??
    plan.find((step) => step.status !== "completed") ??
    plan[plan.length - 1];
  // Bugfix: loading chrome only while the task runs; done/failed/stopped plans
  // never spin or animate, even with stale in_progress rows.
  const showLoadingState = isStreaming && !isAllCompleted;
  const todoStatusContentClasses = isStreaming
    ? todoStatusContentClassesStreaming
    : todoStatusContentClassesIdle;
  const toggleLabel = intl.formatMessage({ id: "todo.panel.toggle" });
  const toggleOpen = () => setIsOpen((current) => !current);

  return (
    <Plan
      className="gap-0 overflow-hidden rounded-none border-0 bg-popover py-0"
      open={isOpen}
      onOpenChange={setIsOpen}
      isStreaming={isStreaming}
    >
      {/* Fix: PlanHeader fills the layout and must not be the click target.
          Toggle lives on the content-width button and the icon; a11y states kept. */}
      <PlanHeader className={cn("group flex items-center gap-3 px-4 !py-3", isOpen && "!pb-1")}>
        <div className="flex min-w-0 flex-1 items-center">
          <button
            type="button"
            aria-expanded={isOpen}
            className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-3 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            onClick={toggleOpen}
          >
            {isOpen ? (
              <>
                <ListTodo className="size-4 shrink-0 text-foreground" />
                <PlanTitle className="min-w-0 truncate text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "todo.panel.title" })}
                </PlanTitle>
                <PlanDescription className="shrink-0 text-ui-base font-mono text-foreground-subtlest">
                  {`${completedCount}/${plan.length}`}
                </PlanDescription>
              </>
            ) : showLoadingState ? (
              <>
                <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground" />
                <PlanTitle className="animated-gradient-text min-w-0 truncate text-ui-base font-medium">
                  {activeStep?.title ?? intl.formatMessage({ id: "todo.panel.currentTask" })}
                </PlanTitle>
              </>
            ) : (
              <>
                <ListTodo className="size-4 shrink-0 text-foreground" />
                <PlanTitle className="min-w-0 truncate text-ui-base font-medium text-foreground">
                  {activeStep?.title ?? intl.formatMessage({ id: "todo.panel.currentTask" })}
                </PlanTitle>
              </>
            )}
            {!isOpen ? (
              <PlanDescription className="shrink-0 text-ui-base font-mono text-foreground-subtle">
                {`${completedCount}/${plan.length}`}
              </PlanDescription>
            ) : null}
          </button>
        </div>
        <PlanAction className="shrink-0">
          <ControlHintTooltip
            title={intl.formatMessage({
              id: isOpen ? "chat.longRunning.collapse" : "chat.longRunning.expand",
            })}
          >
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-expanded={isOpen}
              aria-label={toggleLabel}
              onClick={(event) => {
                event.stopPropagation();
                toggleOpen();
              }}
            >
              <ChevronsUpDownIcon className="size-4" />
              <span className="sr-only">{toggleLabel}</span>
            </Button>
          </ControlHintTooltip>
        </PlanAction>
      </PlanHeader>
      <PlanContent className="p-1">
        <QueueList className="mt-0">
          {visiblePlan.map((step) => (
            <QueueItem
              key={step.id}
              className="gap-0 w-full rounded-xl px-3 py-2 hover:bg-hover/30"
            >
              <div className="flex min-w-0 items-center gap-3">
                <QueueItemIndicator
                  className={todoStatusIndicatorClasses[step.status]}
                  status={step.status}
                />
                <QueueItemContent
                  className={`min-w-0 line-clamp-none ${todoStatusContentClasses[step.status]}`}
                  completed={false}
                >
                  {step.title}
                </QueueItemContent>
              </div>
            </QueueItem>
          ))}
        </QueueList>
      </PlanContent>
    </Plan>
  );
}
