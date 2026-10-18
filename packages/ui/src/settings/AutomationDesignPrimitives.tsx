import { TID_AUTOMATION_CREATE_MANUALLY, TID_AUTOMATION_CREATE_MENU } from "@zcode/shared";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AutomationSwitchToggle } from "@/settings/AutomationSwitchToggle.js";
import { AutomationChevronDownIcon, AutomationInfoIcon } from "@/settings/AutomationIcons.js";
import { Button } from "@/components/ui/button.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";

export {
  AutomationAddScheduleIcon,
  AutomationCancelActionIcon,
  AutomationChevronDownIcon,
  AutomationClockIcon,
  AutomationContinueIcon,
  AutomationEditActionIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationInfoIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationRefreshIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationIcons.js";

/** The settings back entry highlights icon and text only: hit area kept, no hover/focus background. */
export const AUTOMATION_BACK_TRIGGER_CLASSNAME =
  "-m-1 inline-flex w-fit max-w-full min-w-0 items-center gap-1 bg-transparent p-1 text-ui-base leading-5 text-foreground-subtle transition-colors hover:text-foreground active:text-foreground focus-visible:text-foreground focus-visible:outline-none";

// space-y margins on inline labels depend on the font line box, so the visual gap undershoots the designed 6px.
export const AUTOMATION_FORM_FIELD_CLASSNAME = "flex flex-col gap-1.5";

export type AutomationSettingsHistoryTab = "settings" | "history";

/** Scheduled and off-peak share one run-history empty state, so transparent padding and card chrome cannot drift apart. */
export function AutomationHistoryEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[226px] items-center justify-center rounded-xl border border-dashed border-card-border bg-background px-4 text-center text-ui-base text-foreground-subtle">
      {children}
    </div>
  );
}

/** Both automation settings pages reuse the Hooks scope-tab pill look, keeping detail segmentation from drifting. */
export function AutomationSettingsHistoryTabs({
  value,
  settingsLabel,
  historyLabel,
  onValueChange,
}: {
  value: AutomationSettingsHistoryTab;
  settingsLabel: string;
  historyLabel: string;
  onValueChange: (value: AutomationSettingsHistoryTab) => void;
}) {
  return (
    <SettingsSegmentedTabs
      value={value}
      items={[
        { value: "settings", label: settingsLabel },
        { value: "history", label: historyLabel },
      ]}
      onValueChange={onValueChange}
    />
  );
}

/** Keep-awake notice; the switch binds to the global shared setting, not a page-level mock store. */
export function AutomationKeepAwakeNotice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // The desktop breakpoint once cleared the notice's vertical padding, drifting from the 12px spec.
  return (
    <div
      data-automations-keep-awake
      className="flex min-h-11 w-full items-center gap-3 overflow-hidden rounded-[10px] bg-surface px-3 py-3 text-foreground-subtle"
    >
      <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
        <AutomationInfoIcon className="size-4" />
      </span>
      <p className="min-w-0 flex-1 text-ui-base leading-5">
        {intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
      </p>
      <AutomationSwitchToggle
        checked={checked}
        ariaLabel={intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
        onChange={onChange}
        color="blue"
        size="sm"
      />
    </div>
  );
}

export function AutomationCreateDropdown({
  onViaChat,
  onManually,
}: {
  onViaChat: () => void;
  onManually: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <div className="inline-flex h-7 items-center overflow-hidden rounded-lg">
        <Button
          type="button"
          variant="default"
          size="default"
          className="rounded-none border-0"
          data-testid={TID_AUTOMATION_CREATE_MANUALLY}
          onClick={onManually}
        >
          {intl.formatMessage({ id: "automations.createManually" })}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="icon-md"
            data-testid={TID_AUTOMATION_CREATE_MENU}
            aria-label={intl.formatMessage({ id: "automations.create" })}
            className="!w-6 rounded-none border-0"
          >
            <AutomationChevronDownIcon size={14} />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" sideOffset={4} className="w-auto min-w-0">
        <DropdownMenuItem className="pr-6" onSelect={onViaChat}>
          {intl.formatMessage({ id: "automations.createViaChat" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
