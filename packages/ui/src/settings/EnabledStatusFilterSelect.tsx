import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type EnabledStatusFilter = "all" | "enabled" | "disabled";

export function matchesEnabledStatusFilter(enabled: boolean, filter: EnabledStatusFilter): boolean {
  if (filter === "all") {
    return true;
  }
  return filter === "enabled" ? enabled : !enabled;
}

// Enable-state filter dropdown matching the subagent panel: inline right of the search, with all/enabled/disabled.
export function EnabledStatusFilterSelect({
  value,
  onValueChange,
  ariaLabel,
}: {
  value: EnabledStatusFilter;
  onValueChange: (value: EnabledStatusFilter) => void;
  ariaLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as EnabledStatusFilter)}>
      <SelectTrigger
        size="lg"
        className="h-9 w-full justify-between rounded-xl md:w-36"
        aria-label={ariaLabel ?? intl.formatMessage({ id: "settings.resourceFilter.label" })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="all">
          {intl.formatMessage({ id: "settings.resourceFilter.all" })}
        </SelectItem>
        <SelectItem value="enabled">
          {intl.formatMessage({ id: "settings.resourceFilter.enabled" })}
        </SelectItem>
        <SelectItem value="disabled">
          {intl.formatMessage({ id: "settings.resourceFilter.disabled" })}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
