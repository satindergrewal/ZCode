import { useCallback, type KeyboardEvent } from "react";
import { TID_AUTOMATIONS_PAGE_TAB, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** The automations page's two top-level tabs. */
export type AutomationsPageTab = "automation" | "workflow";

export const AUTOMATIONS_PAGE_TABS: readonly AutomationsPageTab[] = ["automation", "workflow"];

/**
 * The automations page title. Without the dynamic-workflows flag the page has only "Automations", so
 * the title regresses to the flat h1 from before the "Workflows" tab — no single-item tablist, no
 * orphaned arrow-key handling.
 */
export function AutomationsPageTitle({
  workflowTabEnabled,
  value,
  onValueChange,
}: {
  workflowTabEnabled: boolean;
  value: AutomationsPageTab;
  onValueChange: (tab: AutomationsPageTab) => void;
}) {
  const { intl } = useZCodeIntl();
  if (!workflowTabEnabled) {
    // Same type scale as the switch state: the 30/34 page-title level; presence of the switch must not change the title's visual hierarchy.
    return (
      <h1 className="text-[30px] font-medium leading-[34px] tracking-[0.114px] text-foreground">
        {intl.formatMessage({ id: "settings.automations.title" })}
      </h1>
    );
  }
  return <AutomationsPageTitleSwitch value={value} onValueChange={onValueChange} />;
}

/**
 * The page title is the switch itself: the two 30px title words "Automations / Workflows" side by side,
 * unselected in the secondary color. No extra tab row below the title — the scheduled/idle-task pills
 * stay inside "Automations", one visual per level. Type scale matches AutomationsSection's original h1.
 */
export function AutomationsPageTitleSwitch({
  value,
  onValueChange,
}: {
  value: AutomationsPageTab;
  onValueChange: (tab: AutomationsPageTab) => void;
}) {
  const { intl } = useZCodeIntl();
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = AUTOMATIONS_PAGE_TABS.indexOf(value);
      const next =
        AUTOMATIONS_PAGE_TABS[
          (index + (event.key === "ArrowRight" ? 1 : -1) + AUTOMATIONS_PAGE_TABS.length) %
            AUTOMATIONS_PAGE_TABS.length
        ]!;
      onValueChange(next);
    },
    [onValueChange, value],
  );

  return (
    <div
      role="tablist"
      aria-label={intl.formatMessage({ id: "automations.pageTab.ariaLabel" })}
      className="flex items-baseline gap-5"
      onKeyDown={handleKeyDown}
    >
      {AUTOMATIONS_PAGE_TABS.map((tab) => {
        const active = tab === value;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-testid={testId(TID_AUTOMATIONS_PAGE_TAB, tab)}
            onClick={() => onValueChange(tab)}
            className={cn(
              "rounded-md text-[30px] font-medium leading-[34px] tracking-[0.114px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              active ? "text-foreground" : "text-foreground-subtle hover:text-foreground",
            )}
          >
            {intl.formatMessage({ id: `automations.pageTab.${tab}` })}
          </button>
        );
      })}
    </div>
  );
}
