/* eslint-disable max-lines -- the scheduled-task editor keeps Settings/History tabs, the cron builder, project/model pickers and run history in one place for interaction consistency. */
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  MessageCircle,
  X,
} from "lucide-react";
import {
  resolveWorkspaceKey,
  testId,
  TID_AUTOMATION_CUSTOM_CONFIRM,
  TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_SELECT,
  TID_AUTOMATION_CUSTOM_REPEAT_EDIT,
  TID_AUTOMATION_CUSTOM_UNIT_OPTION,
  TID_AUTOMATION_CUSTOM_UNIT_SELECT,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_FREQUENCY_SELECT,
  TID_AUTOMATION_RUN_NOW,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_DELETE,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  TID_AUTOMATION_YEAR_DAY_OPTION,
  TID_AUTOMATION_YEAR_MONTH_OPTION,
  TID_AUTOMATION_YEAR_MONTHDAY,
  ZCODE_AGENT_PROVIDER,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationScheduleRule,
} from "@zcode/shared";
import {
  AutomationAddScheduleIcon,
  AutomationChevronDownIcon,
  AutomationContinueIcon,
  AutomationExternalLinkIcon,
  AUTOMATION_FORM_FIELD_CLASSNAME,
  AutomationHistoryEmptyState,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationRunNowIcon,
  AutomationSettingsHistoryTabs,
  AutomationTrashIcon,
  type AutomationSettingsHistoryTab,
} from "@/settings/AutomationDesignPrimitives.js";
import {
  AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
  AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
  AutomationInstructionsComposer,
  AutomationInstructionsTextarea,
  AutomationInstructionsToolbar,
} from "@/settings/AutomationInstructionsComposer.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { cn } from "@/components/lib/utils.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { resolveLocalizedAutomationCreateTitle } from "@/settings/automationEditLocalizedTitle.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { ConfigSelect } from "@/chat-input-toolbar/display.js";
import { ChatEmptyWorkspacePreviewMenu, type ChatEmptyWorkspaceMenuTab } from "@/ChatEmptyState.js";
import {
  AUTOMATION_DEFAULT_MODE,
  buildAutomationModelSelectGroups,
  buildAutomationModeOption,
  buildAutomationThoughtLevelOption,
  resolveAutomationModelItem,
  resolveAutomationModelTriggerLabel,
  resolveAutomationPreferredModelValue,
} from "@/settings/automationAgentConfigOptions.js";
import {
  resolveChangedAutomationEditFields,
  type AutomationEditDirtyField,
  type AutomationEditFieldSignatures,
} from "@/settings/automationEditDirtyState.js";
import {
  clearAutomationEditRequiredFieldError,
  resolveAutomationEditRequiredFieldErrors,
  type AutomationEditRequiredField,
} from "@/settings/automationEditValidation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useAutomationProjectOptions } from "@/hooks/useAutomationProjectOptions.js";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import {
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import {
  buildCronExpr,
  canVisualizeCronInAutomationEditor,
  describeCronBuilder,
  formatDateTime,
  formatDuration,
  formatGmtOffset,
  isSessionCreatedAutomation as resolveIsSessionCreatedAutomation,
  parseCronToBuilder,
  resolveAutomationStatusKind,
  WEEKDAY_ORDER,
  type AutomationStatusKind,
  type CronBuilderState,
  type CronFrequency,
  type CustomRepeatUnit,
} from "@/settings/automationFormat.js";
import type {
  AutomationRunsEntry,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "@/store/automationManagementStore.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;
const FREQUENCIES: CronFrequency[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"];
const isCronFrequency = (value: string): value is CronFrequency =>
  FREQUENCIES.includes(value as CronFrequency);
/** Run-history page size. */
const RUNS_PAGE_SIZE = 8;
/** Visual span allowed in the custom-repeat frequency input. */
const CUSTOM_REPEAT_INTERVAL_INPUT_MIN = 0;
/** A cron step must be a positive integer; 0 cannot form a valid schedule. */
const CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN = 1;
const CUSTOM_REPEAT_INTERVAL_MAX = 200;

/**
 // Page-number sequence for the pagination control: keep 3 at each end, 1 each side of current, fold the rest into ellipses.
 // E.g. current=1,total=10 -> [1,2,3,"ellipsis",8,9,10].
 */
function buildRunsPageItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>([
    1,
    2,
    3,
    total - 2,
    total - 1,
    total,
    current - 1,
    current,
    current + 1,
  ]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const items: Array<number | "ellipsis"> = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) {
      items.push("ellipsis");
    }
    items.push(page);
    previous = page;
  }
  return items;
}

function workspaceLabelFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

const CUSTOM_REPEAT_SELECT_CONTENT_CLASS =
  "w-[var(--radix-select-trigger-width)] px-0 py-1.5 [&_[data-position=popper]]:px-1 [&_[data-slot=select-scroll-up-button]]:hidden [&_[data-slot=select-scroll-down-button]]:hidden";
const CUSTOM_REPEAT_SELECT_ITEM_CLASS =
  "min-h-8 rounded-[8px] px-2 py-1.5 pr-8 text-ui-base leading-5 text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-[state=checked]:bg-menu-hover data-[state=checked]:text-foreground";

function CustomRepeatSelectIndicator() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
      <ChevronDown className="size-4" strokeWidth={2} />
    </span>
  );
}

function CustomRepeatCalendarIcon({ className }: { className?: string }) {
  return <CalendarDays className={className} strokeWidth={2} />;
}

/**
 // Single-column scroll list for time (hour or minute); auto-scrolls the selected item into view when opened.
 // Time options are common interactive controls and must not reuse the minimum-size token meant for badges and compact tags.
 // The selected time is a menu-selected state, not a primary button; use menu hover semantics to avoid harsh black blocks in Light.
 */
function TimeUnitColumn({
  count,
  selected,
  onSelect,
}: {
  count: number;
  selected: number;
  onSelect: (value: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <ScrollArea className="h-52 w-14 shrink-0">
      <div className="flex flex-col gap-0.5 p-1">
        {Array.from({ length: count }, (_, value) => value).map((value) => (
          <button
            key={value}
            ref={value === selected ? selectedRef : undefined}
            type="button"
            onClick={() => onSelect(value)}
            className={cn(
              "rounded-md px-2 py-1 text-center text-ui-base tabular-nums transition-colors",
              value === selected
                ? "bg-menu-hover text-foreground"
                : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground",
            )}
          >
            {pad2(value)}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

/**
 // HH:MM time picker: one pill trigger + hour/minute scroll columns in the popover.
 // A common control; the trigger uses the body base size text-ui-base.
 */
function TimeOfDayPicker({
  hour,
  minute,
  onChange,
  ariaLabel,
}: {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex h-auto items-center gap-1 rounded-full bg-hover py-px pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground transition-colors hover:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {pad2(hour)}:{pad2(minute)}
          <span className="shrink-0 text-foreground-subtle">
            <AutomationChevronDownIcon />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-29 flex-row gap-0 p-0"
      >
        <TimeUnitColumn count={24} selected={hour} onSelect={(value) => onChange(value, minute)} />
        <div className="w-px shrink-0 bg-border" />
        <TimeUnitColumn count={60} selected={minute} onSelect={(value) => onChange(hour, value)} />
      </PopoverContent>
    </Popover>
  );
}

/** Month/day single-column scroll list (1-based), styled after TimeUnitColumn. */
function ScrollNumberColumn({
  values,
  selected,
  onSelect,
  buttonTestIdPrefix,
}: {
  values: number[];
  selected: number;
  onSelect: (value: number) => void;
  /** When provided, each numeric button carries a `${prefix}-${value}` data-testid (for e2e). */
  buttonTestIdPrefix?: string;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <ScrollArea className="h-52 w-14 shrink-0">
      <div className="flex flex-col gap-0.5 p-1">
        {values.map((value) => (
          <button
            key={value}
            ref={value === selected ? selectedRef : undefined}
            type="button"
            data-testid={buttonTestIdPrefix ? testId(buttonTestIdPrefix, String(value)) : undefined}
            onClick={() => onSelect(value)}
            className={cn(
              "rounded-md px-2 py-1 text-center text-ui-sm tabular-nums transition-colors",
              value === selected
                ? "bg-primary text-primary-foreground"
                : "text-foreground-subtle hover:bg-surface-hover",
            )}
          >
            {pad2(value)}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

/** Days in a month (leap-year 2024 as reference so February offers 29); month is 1-12. */
function daysInMonth(month: number): number {
  return new Date(2024, month, 0).getDate();
}

/**
 // Month/day picker (custom -> yearly): one pill trigger + month/day scroll columns in the popover,
 // styled after TimeOfDayPicker. When switching months shrinks below the current day, it auto-normalizes.
 */
function MonthDayPicker({
  month,
  day,
  intl,
  onChange,
}: {
  month: number;
  day: number;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onChange: (month: number, day: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  const days = Array.from({ length: daysInMonth(month) }, (_, index) => index + 1);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={TID_AUTOMATION_YEAR_MONTHDAY}
          aria-label={intl.formatMessage({
            id: "automations.form.schedule.yearDateLabel",
          })}
          className="inline-flex h-auto items-center gap-1 rounded-full bg-hover py-px pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground transition-colors hover:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {intl.formatMessage(
            { id: "automations.form.schedule.monthDayValue" },
            { month: String(month), day: String(day) },
          )}
          <span className="shrink-0 text-foreground-subtle">
            <AutomationChevronDownIcon />
          </span>
        </button>
      </PopoverTrigger>
      {/* Same as TimeOfDayPicker: flex-row overrides PopoverContent's flex-col, month/day side by side. */}
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-29 flex-row gap-0 p-0"
      >
        <ScrollNumberColumn
          values={months}
          selected={month}
          buttonTestIdPrefix={TID_AUTOMATION_YEAR_MONTH_OPTION}
          onSelect={(value) => onChange(value, Math.min(day, daysInMonth(value)))}
        />
        <div className="w-px shrink-0 bg-border" />
        <ScrollNumberColumn
          values={days}
          selected={day}
          buttonTestIdPrefix={TID_AUTOMATION_YEAR_DAY_OPTION}
          onSelect={(value) => onChange(month, value)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Weekday picker: keeps the sentence-style trigger and never clears the last selected day. */
function WeekdayPicker({
  weekdays,
  intl,
  onChange,
}: {
  weekdays: number[];
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onChange: (weekdays: number[]) => void;
}) {
  const label = WEEKDAY_ORDER.filter((day) => weekdays.includes(day))
    .map((day) => intl.formatMessage({ id: `automations.weekday.${day}` }))
    .join(intl.formatMessage({ id: "automations.weekday.separator" }));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "automations.form.schedule.weekdaysLabel",
          })}
          // Weekday multi-select trigger shares the highlight of sibling frequency/time tags, keeping brightness uniform.
          className="inline-flex h-auto max-w-full items-center gap-0.5 rounded-full bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground transition-colors hover:bg-selected data-[state=open]:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          <span className="truncate">{label}</span>
          <AutomationChevronDownIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-40 p-1">
        {WEEKDAY_ORDER.map((day) => {
          const active = weekdays.includes(day);
          return (
            <button
              key={day}
              type="button"
              onClick={() => {
                if (active && weekdays.length === 1) return;
                onChange(
                  active ? weekdays.filter((candidate) => candidate !== day) : [...weekdays, day],
                );
              }}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui-base text-foreground transition-colors hover:bg-menu-hover"
            >
              {/* A leading check column would drift the weekday menu from the standard trailing-status layout. */}
              <span className="min-w-0 flex-1 truncate">
                {intl.formatMessage({ id: `automations.weekday.${day}` })}
              </span>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {active ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function toDateInputValue(timestamp: number | undefined): string {
  const date = timestamp ? new Date(timestamp) : new Date(Date.now() + 24 * 60 * 60 * 1_000);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localDateEndTimestamp(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function parseDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function EndDatePicker({
  disabled,
  intl,
  min,
  onChange,
  value,
}: {
  disabled: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  min: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateInputValue(value);
  const minDate = parseDateInputValue(min);
  const [visibleMonth, setVisibleMonth] = useState(() => selectedDate ?? minDate ?? new Date());

  useEffect(() => {
    if (open && selectedDate) setVisibleMonth(selectedDate);
  }, [open, selectedDate?.getTime()]);

  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayValue = toDateInputValue(Date.now());
  const monthLabel = intl.formatMessage(
    { id: "automations.customRepeat.monthLabel" },
    { year: String(year), month: String(month + 1) },
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-9 w-[135px] items-center justify-center gap-1.5 rounded-lg border border-input-border bg-input pl-3 pr-3.5 text-ui-base font-normal leading-5 tracking-[-0.18px] text-foreground transition-colors hover:border-input-border-hover hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-input-border disabled:hover:bg-input"
        >
          <CustomRepeatCalendarIcon className="size-5 shrink-0 text-foreground-subtle" />
          <span className="tabular-nums">
            {selectedDate
              ? `${selectedDate.getFullYear()}/${pad2(selectedDate.getMonth() + 1)}/${pad2(selectedDate.getDate())}`
              : value}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-3">
        <div className="mb-3 flex h-8 items-center justify-between">
          <span className="text-ui-sm font-medium text-foreground">{monthLabel}</span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisibleMonth(new Date(year, month - 1, 1))}
              aria-label={intl.formatMessage({
                id: "automations.customRepeat.previousMonth",
              })}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisibleMonth(new Date(year, month + 1, 1))}
              aria-label={intl.formatMessage({
                id: "automations.customRepeat.nextMonth",
              })}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {[0, 1, 2, 3, 4, 5, 6].map((day) => (
            <span
              key={day}
              className="flex size-8 items-center justify-center text-ui-sm text-foreground-subtlest"
            >
              {intl.formatMessage({ id: `automations.weekday.${day}` })}
            </span>
          ))}
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span key={`blank-${index}`} className="size-8" />
          ))}
          {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((day) => {
            const dateValue = `${year}-${pad2(month + 1)}-${pad2(day)}`;
            const selected = dateValue === value;
            const isToday = dateValue === todayValue;
            const unavailable = dateValue < min;
            return (
              <button
                key={day}
                type="button"
                disabled={unavailable}
                onClick={() => {
                  onChange(dateValue);
                  setOpen(false);
                }}
                className={cn(
                  "flex size-8 items-center justify-center rounded-[8px] text-ui-base tabular-nums transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-menu-hover",
                  isToday && !selected && "ring-1 ring-inset ring-border-hover",
                  unavailable && "cursor-not-allowed text-foreground-subtlest opacity-35",
                )}
              >
                {day}
              </button>
            );
          })}
          {Array.from({ length: 42 - firstWeekday - daysInMonth }, (_, index) => (
            <span key={`trailing-blank-${index}`} className="size-8" />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CustomRepeatDialog({
  builder,
  endAt,
  intl,
  onConfirm,
  onOpenChange,
  open,
}: {
  builder: CronBuilderState;
  endAt: number | undefined;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onConfirm: (value: {
    interval: number;
    unit: CustomRepeatUnit;
    weekdays: number[];
    monthDays: number[];
    monthlyMode: CronBuilderState["customMonthlyMode"];
    endAt?: number;
  }) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [intervalInput, setIntervalInput] = useState(String(builder.customInterval));
  const [unit, setUnit] = useState<CustomRepeatUnit>(builder.customUnit);
  const [weekdays, setWeekdays] = useState(builder.customWeekdays);
  const [monthDays, setMonthDays] = useState(builder.customMonthDays);
  const [monthlyMode, setMonthlyMode] = useState(builder.customMonthlyMode);
  const [ends, setEnds] = useState(endAt !== undefined);
  const [endDate, setEndDate] = useState(toDateInputValue(endAt));

  useEffect(() => {
    if (!open) return;
    setIntervalInput(String(builder.customInterval));
    setUnit(builder.customUnit);
    setWeekdays(builder.customWeekdays);
    setMonthDays(builder.customMonthDays);
    setMonthlyMode(builder.customMonthlyMode);
    setEnds(endAt !== undefined);
    setEndDate(toDateInputValue(endAt));
  }, [builder, endAt, open]);

  const interval = Number(intervalInput);
  const isIntervalValid =
    /^\d+$/.test(intervalInput) &&
    Number.isInteger(interval) &&
    interval >= CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN &&
    interval <= CUSTOM_REPEAT_INTERVAL_MAX;
  const canIncrementInterval = intervalInput === "" || interval < CUSTOM_REPEAT_INTERVAL_MAX;
  const canDecrementInterval = intervalInput !== "" && interval > CUSTOM_REPEAT_INTERVAL_INPUT_MIN;
  const stepInterval = (delta: 1 | -1) => {
    const currentInterval = /^\d+$/.test(intervalInput)
      ? interval
      : CUSTOM_REPEAT_INTERVAL_INPUT_MIN;
    const nextInterval = Math.min(
      CUSTOM_REPEAT_INTERVAL_MAX,
      Math.max(CUSTOM_REPEAT_INTERVAL_INPUT_MIN, currentInterval + delta),
    );
    setIntervalInput(String(nextInterval));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] w-[400px] gap-0 overflow-y-auto border-border bg-card p-0 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.1),0_8px_10px_-6px_rgba(0,0,0,0.1)]"
        aria-describedby={undefined}
        showCloseButton={false}
      >
        <DialogHeader className="px-5 pb-5 pt-5">
          <DialogTitle className="text-ui-xl font-medium leading-[26px] tracking-[-0.12px]">
            {intl.formatMessage({ id: "automations.customRepeat.title" })}
          </DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute right-5 top-5 flex size-6 items-center justify-center rounded-[6px] opacity-80 transition-colors hover:bg-surface-hover hover:opacity-100"
            >
              <X className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
          </DialogClose>
        </DialogHeader>

        <div className="space-y-5 px-5">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-custom-interval"
              className="text-ui-base leading-5 tracking-[-0.18px] text-foreground"
            >
              {intl.formatMessage({ id: "automations.customRepeat.frequency" })}
            </label>
            <div className="grid grid-cols-2 gap-4">
              <div className="relative">
                <Input
                  id="automation-custom-interval"
                  type="number"
                  min={CUSTOM_REPEAT_INTERVAL_INPUT_MIN}
                  max={CUSTOM_REPEAT_INTERVAL_MAX}
                  step={1}
                  inputMode="numeric"
                  value={intervalInput}
                  aria-invalid={!isIntervalValid}
                  className="h-9 rounded-lg px-3 pr-10 text-mobile-input-safe leading-6 tracking-[-0.18px] [appearance:textfield] md:text-ui-base md:leading-5 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_SELECT}
                  onChange={(event) => {
                    const value = event.target.value;
                    // The number input allows empty and scientific notation; keep empty for editing,
                    // but accept only non-negative integer text, keeping invalid values out of cron / scheduleRule.
                    if (value === "" || /^\d+$/.test(value)) setIntervalInput(value);
                  }}
                />
                {/* Native number spinners vary in size and theme feedback across browsers and WebViews;
                    controlled stepper buttons unify desktop and mobile-web press styles. */}
                <div className="absolute inset-y-px right-px flex w-8 flex-col overflow-hidden rounded-r-[7px] border-l border-input-border bg-input">
                  <button
                    type="button"
                    aria-label="+1"
                    title="+1"
                    data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT}
                    disabled={!canIncrementInterval}
                    onClick={() => stepInterval(1)}
                    className="flex flex-1 items-center justify-center border-b border-input-border text-foreground-subtle transition-colors hover:bg-input-focused hover:text-foreground focus-visible:z-10 focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronUp className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="-1"
                    title="-1"
                    data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT}
                    disabled={!canDecrementInterval}
                    onClick={() => stepInterval(-1)}
                    className="flex flex-1 items-center justify-center text-foreground-subtle transition-colors hover:bg-input-focused hover:text-foreground focus-visible:z-10 focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronDown className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <Select
                value={unit}
                onValueChange={(value) => {
                  const nextUnit = value as CustomRepeatUnit;
                  setUnit(nextUnit);
                  if (nextUnit === "yearly") setMonthDays([new Date().getDate()]);
                }}
              >
                <SelectTrigger
                  className="h-9 w-full rounded-[8px] px-3 text-ui-base leading-5 tracking-[-0.18px] hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
                  data-testid={TID_AUTOMATION_CUSTOM_UNIT_SELECT}
                  indicator={<CustomRepeatSelectIndicator />}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  collisionPadding={8}
                  className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
                >
                  <SelectItem
                    value="minute"
                    className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "minute")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.minute",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="hourly"
                    className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "hourly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.hour",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="daily"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "daily")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.day",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="weekly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "weekly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.week",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="monthly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "monthly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.month",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="yearly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "yearly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.year",
                    })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {unit === "weekly" ? (
            <div className="grid grid-cols-7 gap-2">
              {WEEKDAY_ORDER.map((day) => {
                const active = weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => {
                      if (active && weekdays.length === 1) return;
                      setWeekdays(
                        active
                          ? weekdays.filter((candidate) => candidate !== day)
                          : [...weekdays, day],
                      );
                    }}
                    className={cn(
                      "flex h-9 items-center justify-center rounded-md border text-ui-base",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-surface-hover",
                    )}
                  >
                    {intl.formatMessage({ id: `automations.weekday.${day}` })}
                  </button>
                );
              })}
            </div>
          ) : null}

          {unit === "monthly" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ui-base text-foreground">
                  {intl.formatMessage({ id: "automations.customRepeat.rule" })}
                </span>
                <Select
                  value={monthlyMode}
                  onValueChange={(value) =>
                    setMonthlyMode(value as CronBuilderState["customMonthlyMode"])
                  }
                >
                  <SelectTrigger
                    className="h-9 w-32 rounded-[8px] px-3 text-ui-base hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
                    indicator={<CustomRepeatSelectIndicator />}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="start"
                    side="bottom"
                    sideOffset={4}
                    collisionPadding={8}
                    className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
                  >
                    <SelectItem value="date" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
                      {intl.formatMessage({
                        id: "automations.customRepeat.byDate",
                      })}
                    </SelectItem>
                    <SelectItem value="weekday" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
                      {intl.formatMessage({
                        id: "automations.customRepeat.byWeekday",
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {monthlyMode === "date" ? (
                <div className="grid grid-cols-10 gap-2.5">
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => {
                    const active = monthDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => {
                          if (active && monthDays.length === 1) return;
                          setMonthDays(
                            active
                              ? monthDays.filter((candidate) => candidate !== day)
                              : [...monthDays, day],
                          );
                        }}
                        className={cn(
                          "flex h-7 w-full items-center justify-center rounded-[8px] border text-ui-sm",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-surface-hover",
                        )}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-7 gap-2">
                  {WEEKDAY_ORDER.map((day) => {
                    const active = weekdays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => setWeekdays([day])}
                        className={cn(
                          "flex h-9 items-center justify-center rounded-md border text-ui-base",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-surface-hover",
                        )}
                      >
                        {intl.formatMessage({
                          id: `automations.weekday.${day}`,
                        })}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-base leading-5 tracking-[-0.18px] text-foreground">
              {intl.formatMessage({ id: "automations.customRepeat.ends" })}
            </span>
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => setEnds(false)}
                className="flex h-9 items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 tracking-[-0.18px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex size-5 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-[1.33px]",
                      !ends ? "border-[#4099FF] bg-[#4099FF]" : "border-border",
                    )}
                  >
                    {!ends ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  </span>
                </span>
                {intl.formatMessage({
                  id: "automations.customRepeat.neverEnds",
                })}
              </button>
              <button
                type="button"
                onClick={() => setEnds(true)}
                className="flex h-9 items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 tracking-[-0.18px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex size-5 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-[1.33px]",
                      ends ? "border-[#4099FF] bg-[#4099FF]" : "border-border",
                    )}
                  >
                    {ends ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  </span>
                </span>
                {intl.formatMessage({
                  id: "automations.customRepeat.endsOption",
                })}
              </button>
            </div>
            {/* Native date inputs pop an uncontrollable white system calendar in dark themes.*/}
            <EndDatePicker
              value={endDate}
              min={toDateInputValue(Date.now())}
              disabled={!ends}
              intl={intl}
              onChange={setEndDate}
            />
          </div>
        </div>

        <DialogFooter className="gap-3 px-5 pb-5 pt-5">
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-[8px] px-4 text-ui-base font-medium leading-5 tracking-[-0.18px] hover:border-border-hover hover:bg-input/50"
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </DialogClose>
          <Button
            type="button"
            className="h-9 rounded-[8px] px-4 text-ui-base font-medium leading-5 tracking-[-0.18px] hover:bg-primary/80"
            data-testid={TID_AUTOMATION_CUSTOM_CONFIRM}
            disabled={!isIntervalValid || (ends && !localDateEndTimestamp(endDate))}
            onClick={() => {
              onConfirm({
                interval,
                unit,
                weekdays,
                monthDays,
                monthlyMode,
                ...(ends ? { endAt: localDateEndTimestamp(endDate) } : {}),
              });
              onOpenChange(false);
            }}
          >
            {intl.formatMessage({ id: "common.confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface AutomationEditSubmit {
  input: CreateAutomationInput | UpdateAutomationInput;
  /** Target project (may differ from the list's project at creation). */
  workspacePath: string;
  workspaceIdentity?: string;
}

interface AutomationEditViewProps {
  /** null = create; otherwise edit. */
  editing: ZCodeAutomation | null;
  /** Create prefill (from a More ideas template). */
  initialDraft?: { title: string; cronExpr: string; prompt: string } | null;
  /** The current list's project, the default target for creation. */
  defaultWorkspacePath: string;
  defaultWorkspaceIdentity?: string;
  onManageModels?: () => void;
  saving: boolean;
  onSubmit: (params: AutomationEditSubmit) => Promise<boolean>;
  onBack: () => void;
  /** Edit mode: run now / start-stop / delete. */
  onRunNow?: (automation: ZCodeAutomation) => Promise<void> | void;
  onToggle?: (automation: ZCodeAutomation, enabled: boolean) => void;
  onDelete?: (automation: ZCodeAutomation) => void;
  /** History tab run log. */
  runsEntry?: AutomationRunsEntry;
  onLoadRuns?: () => void;
  onDeleteRun?: (runId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

async function saveAndRunAutomation(
  save: () => Promise<boolean>,
  run: () => Promise<void> | void,
): Promise<boolean> {
  if (!(await save())) return false;
  await run();
  return true;
}

function defaultBuilder(): CronBuilderState {
  return {
    frequency: "daily",
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    rawExpr: "0 9 * * *",
    customInterval: 1,
    customUnit: "daily",
    customWeekdays: [1],
    customMonthDays: [1],
    customMonth: new Date().getMonth() + 1,
    customMonthlyMode: "date",
  };
}

function initialBuilder(
  editing: ZCodeAutomation | null,
  initialDraft?: { title: string; cronExpr: string; prompt: string } | null,
): CronBuilderState {
  if (!editing) {
    return initialDraft ? parseCronToBuilder(initialDraft.cronExpr) : defaultBuilder();
  }

  const parsedBuilder = parseCronToBuilder(editing.cronExpr);
  if (!editing.scheduleRule) return parsedBuilder;

  return {
    ...parsedBuilder,
    frequency: "custom",
    hour: editing.scheduleRule.hour,
    minute: editing.scheduleRule.minute,
    customInterval: editing.scheduleRule.interval,
    customUnit: editing.scheduleRule.unit,
    customWeekdays: editing.scheduleRule.weekdays ?? [1],
    customMonthDays: editing.scheduleRule.monthDays ?? [1],
    customMonth:
      editing.scheduleRule.months?.[0] ?? new Date(editing.scheduleRule.anchorAt).getMonth() + 1,
    customMonthlyMode: editing.scheduleRule.monthlyMode ?? "date",
  };
}

// ---- Run-history status mapping (kept in sync with AutomationRunsDialog) ----
type RunStatusKind = "running" | "succeeded" | "failed" | "stopped" | "skipped";
function resolveRunStatus(run: ZCodeAutomationRun): RunStatusKind {
  if (run.dispatchStatus === "skipped") return "skipped";
  if (run.dispatchStatus === "failed_to_dispatch") return "failed";
  switch (run.outcome) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "running";
  }
}
// Status renders as dot + colored text (scheduled history table density spec).
const RUN_STATUS_DOT_CLASS: Record<RunStatusKind, string> = {
  running: "bg-primary",
  succeeded: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-foreground-subtlest",
  skipped: "bg-warning",
};
const RUN_STATUS_TEXT_CLASS: Record<RunStatusKind, string> = {
  running: "text-primary",
  succeeded: "text-success",
  failed: "text-destructive",
  stopped: "text-foreground-subtle",
  skipped: "text-warning",
};

const AUTOMATION_STATUS_DOT_CLASS: Record<AutomationStatusKind, string> = {
  active: "bg-success",
  paused: "bg-warning",
  failed: "bg-destructive",
  completed: "bg-foreground-subtlest",
};

function normalizeAutomationScheduleRule(
  rule: ZCodeAutomationScheduleRule | null | undefined,
): Record<string, unknown> | null {
  if (!rule) return null;
  return {
    unit: rule.unit,
    interval: rule.interval,
    hour: rule.hour,
    minute: rule.minute,
    anchorAt: rule.anchorAt,
    weekdays: rule.weekdays ?? [],
    monthDays: rule.monthDays ?? [],
    months: rule.months ?? [],
    monthlyMode: rule.monthlyMode ?? "date",
  };
}

export function AutomationEditView({
  editing,
  initialDraft,
  defaultWorkspacePath,
  defaultWorkspaceIdentity,
  onManageModels,
  saving,
  onSubmit,
  onBack,
  onRunNow,
  onToggle,
  onDelete,
  runsEntry,
  onLoadRuns,
  onDeleteRun,
  onOpenSession,
}: AutomationEditViewProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const [tab, setTab] = useState<AutomationSettingsHistoryTab>("settings");
  const [runsPage, setRunsPage] = useState(1);
  const onLoadRunsRef = useRef(onLoadRuns);
  const saveAndRunPendingRef = useRef(false);
  const [saveAndRunPending, setSaveAndRunPending] = useState(false);
  const localizedDefaultCreateTitle = intl.formatMessage({
    id: "automations.edit.titlePlaceholder",
  });
  const previousLocalizedDefaultTitleRef = useRef(localizedDefaultCreateTitle);
  const titleTouchedRef = useRef(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>("");
  const modelSelection = useRef("");
  const [mode, setMode] = useState<string>(AUTOMATION_DEFAULT_MODE);
  const modeRef = useRef(AUTOMATION_DEFAULT_MODE);
  const [thoughtLevel, setThoughtLevel] = useState<string>("");
  const thoughtLevelRef = useRef("");
  const modelManuallyChangedRef = useRef(false);
  const thoughtManuallyChangedRef = useRef(false);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // Never render the default "every day 09:00" on first frame and backfill the persisted schedule via effect:
  // child schedule controls register value callbacks first and would record the default as the dirty baseline; edit must use the real value on frame one.
  const [builder, setBuilder] = useState<CronBuilderState>(() =>
    initialBuilder(editing, initialDraft),
  );
  // New tasks start unscheduled; add one explicitly via "Add schedule"; after removal the red missing-schedule hint shows.
  const [scheduleRemoved, setScheduleRemoved] = useState(!editing && !initialDraft);
  const [validationErrors, setValidationErrors] = useState<
    ReadonlySet<AutomationEditRequiredField>
  >(() => new Set());
  const [customRepeatOpen, setCustomRepeatOpen] = useState(false);
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<AutomationEditDirtyField>>(
    () => new Set(),
  );
  const currentEditSignaturesRef = useRef<AutomationEditFieldSignatures | null>(null);
  const touchedFieldBaselinesRef = useRef<Partial<AutomationEditFieldSignatures>>({});
  const [endAt, setEndAt] = useState<number | undefined>(() => editing?.endAt);
  // Target project key (editable only on create; edit locks to the automation's project).
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);

  const localWorkspaceOptions = useAutomationProjectOptions({
    includeConversationWorkspace: true,
  });
  const editingWorkspaceOption = editing
    ? findAutomationWorkspaceOptionByKey(localWorkspaceOptions, editing.workspaceKey)
    : undefined;
  const workspaceOptions = useMemo<AutomationWorkspaceOption[]>(
    () =>
      editing
        ? [
            {
              workspacePath: editing.workspacePath,
              workspaceIdentity: editing.workspaceIdentity,
              label: workspaceLabelFromPath(editing.workspacePath),
              ...(editingWorkspaceOption?.remoteSessionId
                ? { remoteSessionId: editingWorkspaceOption.remoteSessionId }
                : {}),
              ...(editingWorkspaceOption?.remoteTarget
                ? { remoteTarget: editingWorkspaceOption.remoteTarget }
                : {}),
              ...(editingWorkspaceOption?.workspacePurpose
                ? { workspacePurpose: editingWorkspaceOption.workspacePurpose }
                : {}),
            },
          ]
        : localWorkspaceOptions,
    [editing, editingWorkspaceOption, localWorkspaceOptions],
  );
  const workspaceOptionsRef = useRef(workspaceOptions);
  workspaceOptionsRef.current = workspaceOptions;

  // Reset the form when opening or switching the edited object.
  useEffect(() => {
    setTab("settings");
    setRunsPage(1);
    setTouchedFields(new Set());
    setValidationErrors(new Set());
    touchedFieldBaselinesRef.current = {};
    if (editing) {
      setScheduleRemoved(false);
      titleTouchedRef.current = false;
      modelManuallyChangedRef.current = false;
      thoughtManuallyChangedRef.current = false;
      setTitle(editing.title);
      setPrompt(editing.prompt);
      const editingModel = editing.modelSelection
        ? encodeCustomModelValue(editing.modelSelection.providerId, editing.modelSelection.modelId)
        : "";
      const editingThoughtLevel = editing.modelSelection?.options?.reasoningLevel?.trim() ?? "";
      modelSelection.current = editingModel;
      thoughtLevelRef.current = editingThoughtLevel;
      setModel(editingModel);
      const editingMode = editing.mode?.trim() || AUTOMATION_DEFAULT_MODE;
      modeRef.current = editingMode;
      setMode(editingMode);
      setThoughtLevel(editingThoughtLevel);
      setBuilder(initialBuilder(editing, initialDraft));
      setEndAt(editing.endAt);
      setWorkspaceKey(
        resolveWorkspaceKey({
          workspacePath: editing.workspacePath,
          workspaceIdentity: editing.workspaceIdentity,
        }),
      );
    } else {
      setScheduleRemoved(!initialDraft);
      // The create page's default title may follow locale; a template title is content the user explicitly chose.
      titleTouchedRef.current = false;
      modelManuallyChangedRef.current = false;
      thoughtManuallyChangedRef.current = false;
      setTitle(initialDraft?.title ?? localizedDefaultCreateTitle);
      setPrompt(initialDraft?.prompt ?? "");
      modelSelection.current = "";
      setModel("");
      modeRef.current = AUTOMATION_DEFAULT_MODE;
      thoughtLevelRef.current = "";
      setMode(AUTOMATION_DEFAULT_MODE);
      setThoughtLevel("");
      setBuilder(initialBuilder(editing, initialDraft));
      setEndAt(undefined);
      setWorkspaceKey(
        reconcileAutomationWorkspaceSelectionKey(workspaceOptionsRef.current, null, {
          workspacePath: defaultWorkspacePath,
          workspaceIdentity: defaultWorkspaceIdentity,
        }),
      );
    }
  }, [editing, initialDraft, defaultWorkspacePath, defaultWorkspaceIdentity]);

  useEffect(() => {
    const nextTitle = resolveLocalizedAutomationCreateTitle({
      currentTitle: title,
      hasInitialDraft: Boolean(initialDraft),
      isEditing: Boolean(editing),
      nextDefaultTitle: localizedDefaultCreateTitle,
      previousDefaultTitle: previousLocalizedDefaultTitleRef.current,
      titleTouched: titleTouchedRef.current,
    });
    previousLocalizedDefaultTitleRef.current = localizedDefaultCreateTitle;
    if (nextTitle !== title) {
      setTitle(nextTitle);
    }
  }, [editing, initialDraft, localizedDefaultCreateTitle, title]);

  useEffect(() => {
    if (editing) return;
    // With no candidates or a dead default project, do not keep the default workspace and allow persisting.
    // Every tab change re-converges the selection to a currently valid project; with none, clear it explicitly.
    setWorkspaceKey((currentWorkspaceKey) =>
      reconcileAutomationWorkspaceSelectionKey(workspaceOptions, currentWorkspaceKey, {
        workspacePath: defaultWorkspacePath,
        workspaceIdentity: defaultWorkspaceIdentity,
      }),
    );
  }, [defaultWorkspaceIdentity, defaultWorkspacePath, editing, workspaceOptions]);

  const markFieldTouched = useCallback((field: AutomationEditDirtyField) => {
    if (touchedFieldBaselinesRef.current[field] === undefined) {
      touchedFieldBaselinesRef.current[field] = currentEditSignaturesRef.current?.[field];
    }
    setTouchedFields((previous) => {
      if (previous.has(field)) return previous;
      const next = new Set(previous);
      next.add(field);
      return next;
    });
  }, []);

  const clearRequiredFieldValidation = useCallback((field: AutomationEditRequiredField) => {
    setValidationErrors((current) => clearAutomationEditRequiredFieldError(current, field));
  }, []);

  const handleRemoveSchedule = useCallback(() => {
    markFieldTouched("schedule");
    setScheduleRemoved(true);
    // Delete-schedule once flipped straight into the destructive validation state, misreading normal edits as submit failures.
    clearRequiredFieldValidation("schedule");
    logger.debug("[AutomationEditView] delete schedule draft", {
      automationId: editing?.automationId ?? null,
      validationVisible: false,
    });
  }, [clearRequiredFieldValidation, editing?.automationId, markFieldTouched]);

  useEffect(() => {
    onLoadRunsRef.current = onLoadRuns;
  }, [onLoadRuns]);

  // Entering the History tab (edit mode) loads run history and lightly refreshes while it stays visible.
  // cron run/outcome rows are written asynchronously by scheduler/host; a single load leaves history empty though the session ended.
  // onLoadRuns is passed inline by the parent and must not be a dependency, or every runsCache update restarts the effect into a request loop.
  useEffect(() => {
    if (tab !== "history" || !editing) {
      return;
    }
    onLoadRunsRef.current?.();
    const timer = window.setInterval(() => {
      onLoadRunsRef.current?.();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [tab, editing?.automationId]);

  const isSessionCreatedAutomation = resolveIsSessionCreatedAutomation(editing);
  // Legacy session-born crons the UI cannot safely echo stay read-only; an explicit re-set exits that path with the persisted marker.
  const preserveSessionCreatedSchedule =
    isSessionCreatedAutomation &&
    !editing?.scheduleEditedByUser &&
    Boolean(editing && !canVisualizeCronInAutomationEditor(editing.cronExpr)) &&
    !touchedFields.has("schedule");
  const cronExpr = useMemo(
    () =>
      scheduleRemoved
        ? ""
        : preserveSessionCreatedSchedule
          ? (editing?.cronExpr ?? "")
          : buildCronExpr(builder),
    [builder, editing?.cronExpr, preserveSessionCreatedSchedule, scheduleRemoved],
  );
  const schedulePreview = useMemo(
    () => (cronExpr ? describeCronBuilder(builder, intl) : ""),
    [builder, cronExpr, intl],
  );
  const selectedWorkspace =
    findAutomationWorkspaceOptionByKey(workspaceOptions, workspaceKey) ??
    (editing
      ? {
          workspacePath: editing.workspacePath,
          workspaceIdentity: editing.workspaceIdentity,
          label: workspaceLabelFromPath(editing.workspacePath),
        }
      : null);
  // Reuse the input-empty project menu: map the form's candidates onto its tab structure.
  const workspaceMenuTabs = useMemo<ChatEmptyWorkspaceMenuTab[]>(
    () =>
      workspaceOptions.map((option) => ({
        workspacePath: option.workspacePath,
        label: option.label,
        ...(option.workspaceIdentity ? { workspaceIdentity: option.workspaceIdentity } : {}),
        ...(option.workspacePurpose ? { workspacePurpose: option.workspacePurpose } : {}),
      })),
    [workspaceOptions],
  );
  // Keep an empty target on create with no valid project, so model config reads do not silently fall back to conversation/default workspace.
  const selectedWorkspacePath = selectedWorkspace?.workspacePath ?? "";
  const selectedWorkspaceIdentity = selectedWorkspace?.workspaceIdentity;
  const originalSelection = useMemo(() => {
    if (!model) return null;
    const identity = parseModelPickerValue(model);
    return identity
      ? { ...identity, ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}) }
      : null;
  }, [model, thoughtLevel]);
  // Model candidates belong to the form's target Host. Switch the subscription on project change; while a remote target is disconnected
  // useModelSelectionView stays unavailable — never fall back to the settings page's Local Host.
  const modelSelectionRead = useModelSelectionView(
    selectedWorkspacePath || null,
    selectedWorkspace?.remoteSessionId,
    selectedWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
    { selection: originalSelection },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const effectiveSelection = modelSelectionView?.effectiveSelection;
  const effectiveModelValue = effectiveSelection
    ? encodeCustomModelValue(effectiveSelection.providerId, effectiveSelection.modelId)
    : "";
  const effectiveReasoningLevel = effectiveSelection?.options?.reasoningLevel ?? "";
  const modelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildAutomationModelSelectGroups({
      selectedProvider: ZCODE_AGENT_PROVIDER,
      labels: {
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
      },
      registrySelectionView: modelSelectionView,
    });
  }, [intl, modelSelectionView]);
  const isSelectedConversationWorkspace = selectedWorkspace?.workspacePurpose === "conversation";
  // Automation data persists only workspaceKey/path; edit once displayed the conversation backing path as the default project.
  // After matching the current canonical candidate to restore purpose,
  // keep the session-side copy; unmatched historical targets still fall back to the path name.
  const selectedWorkspaceDisplayLabel = isSelectedConversationWorkspace
    ? intl.formatMessage({ id: "chat.empty.workOutsideProject" })
    : (selectedWorkspace?.label ?? workspaceLabelFromPath(defaultWorkspacePath));
  const conversationWorkspace = workspaceOptions.find(
    (option) => option.workspacePurpose === "conversation",
  );
  const handleSelectWorkspace = (workspace: ChatEmptyWorkspaceMenuTab) => {
    modelManuallyChangedRef.current = false;
    thoughtManuallyChangedRef.current = false;
    modelSelection.current = "";
    setModel("");
    // Remote workspaces may share one real path; the old callback passed only path and find always hit the first
    // candidate. Selection events must carry identity so model preview, save and dispatch use the clicked workspaceKey.
    setWorkspaceKey(resolveAutomationWorkspaceSelectionKey(workspace));
  };
  const handleSelectConversationWorkspace = () => {
    if (!conversationWorkspace) return;
    modelManuallyChangedRef.current = false;
    thoughtManuallyChangedRef.current = false;
    modelSelection.current = "";
    setModel("");
    // The conversation backing workspace was once downgraded to a plain project named default,
    // leaking internal directory names and a Folder icon into the menu. Purpose picks the canonical backing;
    // display is left to the session-side fixed "not working in a project" item.
    setWorkspaceKey(resolveAutomationWorkspaceSelectionKey(conversationWorkspace));
  };
  const modelTriggerLabel = resolveAutomationModelTriggerLabel({
    modelGroups: modelSelectGroups,
    modelSelectionView,
    modelValue: effectiveModelValue,
    fallbackLabel: intl.formatMessage({ id: "chat.toolbar.model.label" }),
  });
  // Only an explicit model choice initializes the highest tier; history restore and View refresh keep missing tiers.
  const handleModelValueChange = useCallback(
    (value: string) => {
      modelManuallyChangedRef.current = true;
      thoughtManuallyChangedRef.current = false;
      modelSelection.current = value;
      setModel(value);
      const selection =
        value && modelSelectionView
          ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(value))
          : undefined;
      const level = selection?.options?.reasoningLevel ?? "";
      thoughtLevelRef.current = level;
      setThoughtLevel(level);
      markFieldTouched("model");
    },
    [markFieldTouched, modelSelectionView],
  );
  // The editor keeps a form draft only; it must not call the workspace default-config API to populate options,
  // else merely opening and canceling would change the project's or draft session's model, mode and reasoning level.
  const modeOption = useMemo(() => buildAutomationModeOption(mode), [mode]);
  const selectedModelItem = useMemo(
    () => resolveAutomationModelItem(modelSelectGroups, effectiveModelValue),
    [effectiveModelValue, modelSelectGroups],
  );
  const preferredModelValue = useMemo(
    () => (modelSelectionView ? resolveAutomationPreferredModelValue(modelSelectionView) : null),
    [modelSelectionView],
  );
  const persistedSelectionInvalid = Boolean(
    originalSelection && modelSelectionView && modelSelectionView.selectionIssue,
  );
  const invalidSelectionNoticeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!persistedSelectionInvalid || !editing || !modelSelectionView) return;
    const noticeKey = `${editing.automationId}:${modelSelectionView.revision}`;
    if (invalidSelectionNoticeKeyRef.current === noticeKey) return;
    invalidSelectionNoticeKeyRef.current = noticeKey;
    toast(intl.formatMessage({ id: "modelSelection.invalidated.reselect" }), {
      variant: "warning",
      position: "bottom-center",
      dedupeKey: `automation-model-selection-invalidated:${editing.automationId}`,
    });
  }, [editing, intl, modelSelectionView, persistedSelectionInvalid]);
  useEffect(() => {
    if (
      editing ||
      !preferredModelValue ||
      modelManuallyChangedRef.current ||
      persistedSelectionInvalid
    )
      return;
    if (model) return;
    // The old form saved "default model" as empty while requiring a concrete candidate to submit,
    // leaving create permanently disabled. Once the target Host is ready, select and pin preferredSelection.
    modelSelection.current = preferredModelValue;
    setModel(preferredModelValue);
    thoughtManuallyChangedRef.current = false;
    const preferredReasoning =
      modelSelectionView?.preferredSelection?.options?.reasoningLevel ?? "";
    thoughtLevelRef.current = preferredReasoning;
    setThoughtLevel(preferredReasoning);
  }, [editing, model, modelSelectionView, persistedSelectionInvalid, preferredModelValue]);
  const selectedModelMetadataThoughtOption = useMemo(() => {
    if (!selectedModelItem) return null;
    const decodedModel = decodeCustomModelValue(selectedModelItem.value);
    if (!decodedModel?.modelName) return null;
    // Reuse the session composer's model static facts, so a workspace runtime catalog lacking thought_level
    // does not make reasoning-capable models display as level-less.
    return modelSelectionView
      ? resolveModelThoughtOption({
          modelSelectionView,
          providerId: decodedModel.providerId,
          modelId: decodedModel.modelName,
        })
      : null;
  }, [modelSelectionView, selectedModelItem]);
  // The selected model's Option Specs come only from the target Host View; never create a deferred Session for a preview.
  const activeThoughtOption = selectedModelMetadataThoughtOption ?? undefined;
  const thoughtLevelOption = useMemo(
    () => buildAutomationThoughtLevelOption(activeThoughtOption, effectiveReasoningLevel),
    [activeThoughtOption, effectiveReasoningLevel],
  );

  const requiredFieldErrors = useMemo(
    () =>
      resolveAutomationEditRequiredFieldErrors({
        title,
        cronExpr,
        prompt,
      }),
    [cronExpr, prompt, title],
  );
  const hasValidWorkspace = Boolean(editing || selectedWorkspace);
  const submissionContextReady =
    hasValidWorkspace &&
    (Boolean(editing) || selectedWorkspace !== null) &&
    modelSelectionRead.state.status === "ready" &&
    selectedModelItem !== null &&
    Boolean(effectiveReasoningLevel) &&
    !modelSelectionView?.selectionIssue;
  const canSubmit = submissionContextReady && requiredFieldErrors.length === 0;

  const requestRequiredFieldValidation = useCallback(
    (source: "save" | "run-now") => {
      setValidationErrors(new Set(requiredFieldErrors));
      logger.debug("[AutomationEditView] validate required fields before submit", {
        automationId: editing?.automationId ?? null,
        source,
        invalidFields: requiredFieldErrors,
      });
      return requiredFieldErrors.length === 0;
    },
    [editing?.automationId, requiredFieldErrors],
  );

  const currentScheduleRule = useMemo<ZCodeAutomationScheduleRule | undefined>(
    () =>
      builder.frequency === "custom"
        ? {
            unit: builder.customUnit,
            interval: builder.customInterval,
            hour: builder.hour,
            minute: builder.minute,
            anchorAt: editing?.scheduleRule?.anchorAt ?? Date.now(),
            weekdays: builder.customWeekdays,
            monthDays: builder.customMonthDays,
            // months only means something for yearly; clear it otherwise, JSON.stringify drops undefined.
            months: builder.customUnit === "yearly" ? [builder.customMonth] : undefined,
            monthlyMode: builder.customMonthlyMode,
          }
        : undefined,
    [builder, editing?.scheduleRule?.anchorAt],
  );

  const buildSubmitInput = useCallback(
    ({ modeValue }: { modeValue: string }): CreateAutomationInput | UpdateAutomationInput => {
      if (!effectiveSelection || !effectiveReasoningLevel) {
        throw new Error("Automation model selection is required");
      }
      return {
        title: title.trim(),
        cronExpr,
        prompt: prompt.trim(),
        // Editing a limited-run task created in-session must not silently turn it into a recurring one.
        recurring: editing?.recurring ?? true,
        ...(editing ? { endAt: endAt ?? null } : endAt ? { endAt } : {}),
        ...(editing
          ? preserveSessionCreatedSchedule
            ? {}
            : { scheduleRule: currentScheduleRule ?? null }
          : currentScheduleRule
            ? { scheduleRule: currentScheduleRule }
            : {}),
        ...(editing && touchedFields.has("schedule") ? { scheduleEditedByUser: true } : {}),
        mode: modeValue,
        modelSelection: effectiveSelection,
      };
    },
    [
      cronExpr,
      currentScheduleRule,
      editing,
      endAt,
      preserveSessionCreatedSchedule,
      prompt,
      effectiveSelection,
      effectiveReasoningLevel,
      title,
      touchedFields,
    ],
  );

  const currentEditSignatures = useMemo<AutomationEditFieldSignatures | null>(() => {
    if (!editing) return null;
    return {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule: JSON.stringify({
        cronExpr,
        endAt: endAt ?? null,
        scheduleRule: preserveSessionCreatedSchedule
          ? null
          : normalizeAutomationScheduleRule(currentScheduleRule ?? null),
      }),
      mode,
      thoughtLevel,
      model,
    };
  }, [
    cronExpr,
    currentScheduleRule,
    editing,
    endAt,
    preserveSessionCreatedSchedule,
    mode,
    model,
    prompt,
    thoughtLevel,
    title,
  ]);
  currentEditSignaturesRef.current = currentEditSignatures;

  const changedFields = useMemo(
    () =>
      currentEditSignatures
        ? resolveChangedAutomationEditFields({
            touchedFields,
            current: currentEditSignatures,
            baseline: touchedFieldBaselinesRef.current,
          })
        : [],
    [currentEditSignatures, touchedFields],
  );
  // Model metadata and the cron builder normalize asynchronously after open; only fields the user actually touched
  // may trigger the unsaved hint, else opening a task and returning reads as a modification.
  const hasUnsavedChanges = Boolean(editing) && changedFields.length > 0;

  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  const submitAutomation = useCallback(
    async (options: { validationSource: "save" | "run-now"; returnToList?: boolean }) => {
      if (saving) return false;
      if (!requestRequiredFieldValidation(options.validationSource)) {
        return false;
      }
      if (!canSubmit) return false;
      // Guard fast-save from using the previous input's valid result before the matching View arrives.
      if (modelSelection.current !== model || thoughtLevelRef.current !== thoughtLevel)
        return false;
      const input: CreateAutomationInput | UpdateAutomationInput = {
        // Permission dropdown and save button are separate controls; saving right after picking a Plan may read stale
        // React state in the submit closure; a ref keeps the last selection so it does not persist as the default build.
        ...buildSubmitInput({
          modeValue: modeRef.current,
        }),
      };
      // Edit locks the original project; create uses the selected one.
      const target = editing
        ? {
            workspacePath: editing.workspacePath,
            workspaceIdentity: editing.workspaceIdentity,
          }
        : selectedWorkspace
          ? {
              workspacePath: selectedWorkspace.workspacePath,
              workspaceIdentity: selectedWorkspace.workspaceIdentity,
            }
          : null;
      // A disabled button cannot cover shortcuts or async callbacks; the submit boundary must also reject project-less creates.
      if (!target) return false;
      if (input.modelSelection && (!editing || changedFields.includes("model"))) {
        const chosen = await recommendStartPlan(input.modelSelection);
        if (!chosen) return false;
        input.modelSelection = chosen;
      }
      const trace = startUserAction({
        featureId: "automation.lifecycle",
        action: editing ? "update" : "create",
        trigger: "button",
        workspaceKind: editing?.workspaceIdentity?.trim() ? "remote" : "local",
        automationKind: "scheduled",
      });
      try {
        const ok = await onSubmit({ input, ...target });
        if (ok) {
          trace.complete({ resultSource: "platform_result" });
          if (options?.returnToList !== false) onBack();
        } else {
          trace.reject({ resultSource: "platform_result" });
        }
        return ok;
      } catch (error) {
        trace.fail({ failureStage: "automation_save" });
        throw error;
      }
    },
    [
      buildSubmitInput,
      changedFields,
      recommendStartPlan,
      canSubmit,
      editing,
      onBack,
      onSubmit,
      requestRequiredFieldValidation,
      saving,
      model,
      thoughtLevel,
      selectedWorkspace?.workspaceIdentity,
      selectedWorkspace?.workspacePath,
    ],
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await submitAutomation({ validationSource: "save" });
  };

  const handleSaveAndRun = useCallback(async () => {
    if (!editing || !onRunNow || saveAndRunPendingRef.current) return;
    saveAndRunPendingRef.current = true;
    setSaveAndRunPending(true);
    logger.debug("[AutomationEditView] save and run now start", {
      automationId: editing.automationId,
      changedFields,
    });
    try {
      const completed = await saveAndRunAutomation(
        () =>
          submitAutomation({
            returnToList: false,
            validationSource: "run-now",
          }),
        () => onRunNow(editing),
      );
      logger.debug("[AutomationEditView] save and run now end", {
        automationId: editing.automationId,
        completed,
      });
    } finally {
      saveAndRunPendingRef.current = false;
      setSaveAndRunPending(false);
    }
  }, [changedFields, editing, onRunNow, submitAutomation]);

  const handleBackClick = useCallback(async () => {
    logger.debug("[AutomationEditView] check unsaved changes before leaving", {
      automationId: editing?.automationId ?? null,
      touchedFields: [...touchedFields],
      changedFields,
    });
    if (!hasUnsavedChanges) {
      onBack();
      return;
    }

    // Scheduled tasks once had their own save/discard dialog whose size and actions drifted from the idle task's confirm;
    // both now reuse the shared remote-Automation presentation, keeping only cancel/discard semantics.
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "automations.unsaved.title" }),
      description: intl.formatMessage({
        id: "automations.unsaved.description",
      }),
      confirmLabel: intl.formatMessage({
        id: "automations.unsaved.discard",
      }),
      confirmVariant: "destructive",
      showCloseButton: true,
      showKeyboardHints: false,
      presentation: "automation-confirmation",
    });
    logger.debug("[AutomationEditView] unsaved-changes confirm result", {
      automationId: editing?.automationId ?? null,
      discarded: confirmed,
    });
    if (confirmed) onBack();
  }, [
    changedFields,
    confirmDialog,
    editing?.automationId,
    hasUnsavedChanges,
    intl,
    onBack,
    touchedFields,
  ]);

  const handleTabChange = useCallback(
    (nextTab: AutomationSettingsHistoryTab) => {
      // Create once disabled the History trigger, inconsistent with idle tasks' empty-history browsing.
      logger.debug("[AutomationEditView] switch settings tab", {
        automationId: editing?.automationId ?? null,
        nextTab,
        willLoadRuns: nextTab === "history" && Boolean(editing),
      });
      setTab(nextTab);
    },
    [editing],
  );

  const runs = runsEntry?.runs ?? [];
  const runsLoading = runsEntry?.status === "loading";
  // Client-side history paging: data is fully loaded; slice per page. After deletions, clamp the page into range.
  const runsTotalPages = Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE));
  const runsCurrentPage = Math.min(runsPage, runsTotalPages);
  const pagedRuns = runs.slice(
    (runsCurrentPage - 1) * RUNS_PAGE_SIZE,
    runsCurrentPage * RUNS_PAGE_SIZE,
  );
  const runsPageItems = buildRunsPageItems(runsCurrentPage, runsTotalPages);
  const editStatus = editing ? resolveAutomationStatusKind(editing) : null;
  const showEditingSettingsActions = Boolean(editing && tab === "settings");
  const showCreateSettingsAction = !editing && tab === "settings";

  return (
    <>
      <div className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col gap-6")}>
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editing?.title ?? intl.formatMessage({ id: "automations.edit.newTask" }),
            },
          ]}
          onSectionSelect={() => void handleBackClick()}
        />

        <div className="space-y-1.5">
          <h1
            data-testid="automation-edit-title"
            className="text-ui-xl font-semibold text-foreground"
          >
            {intl.formatMessage({
              id: editing ? "automations.form.editTitle" : "automations.form.createTitle",
            })}
          </h1>
          <p data-testid="automation-edit-subtitle" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id: editing ? "automations.edit.editSubtitle" : "automations.edit.createSubtitle",
            })}
          </p>
        </div>

        {/* tab + right-side actions */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AutomationSettingsHistoryTabs
            value={tab}
            settingsLabel={intl.formatMessage({
              id: "automations.edit.tab.settings",
            })}
            historyLabel={intl.formatMessage({
              id: "automations.edit.tab.history",
            })}
            onValueChange={handleTabChange}
          />

          <div className="flex items-center gap-1.5">
            {editing ? (
              <>
                {showEditingSettingsActions ? (
                  <button
                    type="submit"
                    form="automation-edit-form"
                    data-testid={TID_AUTOMATION_FORM_SUBMIT}
                    className="inline-flex h-8 items-center rounded-lg border-0 bg-white px-3 text-ui-base font-medium text-black shadow-none outline-none transition-colors hover:bg-white/90 focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-40"
                    disabled={!submissionContextReady || saving}
                  >
                    {intl.formatMessage({
                      id: saving ? "automations.form.saving" : "automations.form.save",
                    })}
                  </button>
                ) : null}
                {showEditingSettingsActions && onRunNow ? (
                  <button
                    type="button"
                    data-testid={TID_AUTOMATION_RUN_NOW}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border-0 bg-white/[0.06] px-3 text-ui-base font-medium text-foreground shadow-none outline-none transition-colors hover:bg-white/10 focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:text-foreground-subtlest disabled:opacity-40"
                    disabled={!submissionContextReady || saving || saveAndRunPending}
                    onClick={() => void handleSaveAndRun()}
                  >
                    <AutomationRunNowIcon className="size-4" aria-hidden="true" />
                    {intl.formatMessage({ id: "automations.runNow" })}
                  </button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "automations.moreActions",
                      })}
                      className="flex size-8 items-center justify-center rounded-lg border-0 bg-white/[0.06] text-foreground-subtle shadow-none outline-none transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground focus-visible:ring-0"
                    >
                      <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={4} className="min-w-[180px]">
                    {/* Terminal tasks (completed/failed) hide pause/resume: Resume is meaningless there; editing the schedule revives. */}
                    {onToggle &&
                    editing.lifecycleStatus !== "completed" &&
                    editing.lifecycleStatus !== "failed" ? (
                      <DropdownMenuItem
                        className="gap-1"
                        onSelect={() => onToggle(editing, !editing.enabled)}
                      >
                        <span className="flex size-5 items-center justify-center">
                          {editing.enabled ? (
                            <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
                          ) : (
                            <AutomationContinueIcon className="size-4" aria-hidden="true" />
                          )}
                        </span>
                        {intl.formatMessage({
                          id: editing.enabled ? "automations.pause" : "automations.resume",
                        })}
                      </DropdownMenuItem>
                    ) : null}
                    {onDelete ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
                          onSelect={() => onDelete(editing)}
                        >
                          <AutomationTrashIcon />
                          {intl.formatMessage({ id: "automations.delete" })}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : showCreateSettingsAction ? (
              <Button
                type="submit"
                form="automation-edit-form"
                variant="default"
                size="lg"
                data-testid={TID_AUTOMATION_FORM_SUBMIT}
                disabled={!canSubmit || saving}
              >
                {intl.formatMessage({
                  id: saving ? "automations.form.saving" : "automations.edit.createButton",
                })}
              </Button>
            ) : null}
          </div>
        </div>

        {tab === "settings" ? (
          <form
            id="automation-edit-form"
            className="space-y-4"
            onSubmit={(e) => void handleSubmit(e)}
          >
            {editStatus ? (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({ id: "automations.form.status.label" })}
                </div>
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                  {/* Status dot and pill used oversized 8px / 36px, not the 6px glyph + 20px frame spec. */}
                  <span className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg bg-card pl-2 pr-4 text-ui-base leading-5 text-foreground">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          AUTOMATION_STATUS_DOT_CLASS[editStatus],
                        )}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="min-w-0 truncate">
                      {intl.formatMessage({
                        id: `automations.lifecycle.${editStatus}`,
                      })}
                    </span>
                  </span>
                </div>
              </div>
            ) : null}

            {/* Task title */}
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <label
                className="text-ui-base font-normal leading-5 text-foreground-subtle"
                htmlFor="automation-title"
              >
                {intl.formatMessage({ id: "automations.form.title.label" })}
              </label>
              {/* Task title is a standard Input; the global border semantics cannot be stripped locally.*/}
              <Input
                id="automation-title"
                size="lg"
                data-testid={TID_AUTOMATION_FORM_TITLE}
                value={title}
                onChange={(e) => {
                  titleTouchedRef.current = true;
                  markFieldTouched("title");
                  clearRequiredFieldValidation("title");
                  setTitle(e.target.value);
                }}
                placeholder={intl.formatMessage({
                  id: "automations.edit.titlePlaceholder",
                })}
                aria-invalid={validationErrors.has("title") && !title.trim()}
                maxLength={200}
                className={cn(
                  "h-9 rounded-xl bg-input px-3 text-foreground",
                  AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
                )}
              />
            </div>

            {/* Session-born legacy crons cannot be echoed reliably; deleting switches to the standard UI schedule editor. */}
            {preserveSessionCreatedSchedule ? (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <label className="inline-flex items-center gap-1.5 text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: "automations.form.schedule.label",
                  })}
                </label>
                <div
                  data-testid={TID_AUTOMATION_SCHEDULE_PREVIEW}
                  className="relative flex h-9 items-center overflow-hidden rounded-xl border border-input-border bg-input px-2 pr-9 text-ui-base leading-5 text-foreground-subtle transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused"
                >
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({ id: "automations.frequency.custom" })}
                  </span>
                  <button
                    type="button"
                    data-testid={TID_AUTOMATION_SCHEDULE_DELETE}
                    onClick={handleRemoveSchedule}
                    className="absolute right-2 top-2 flex size-5 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
                    aria-label={intl.formatMessage({ id: "common.delete" })}
                  >
                    <AutomationTrashIcon />
                  </button>
                </div>
              </div>
            ) : (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <label className="inline-flex items-center gap-1.5 text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: "automations.form.schedule.label",
                  })}
                </label>
                {scheduleRemoved ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        data-testid={TID_AUTOMATION_SCHEDULE_ADD}
                        aria-invalid={scheduleRemoved && validationErrors.has("schedule")}
                        className={cn(
                          "flex h-9 w-full items-center gap-1 rounded-xl border bg-input px-2 text-ui-base font-normal leading-5 text-foreground-subtle transition-colors hover:border-input-border-hover hover:text-foreground focus-visible:border-input-border-focused focus-visible:bg-input-focused data-[state=open]:border-input-border-focused data-[state=open]:bg-input-focused data-[state=open]:text-foreground",
                          validationErrors.has("schedule")
                            ? "!border-destructive !ring-2 !ring-destructive/20"
                            : "border-input-border",
                        )}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <AutomationAddScheduleIcon aria-hidden="true" />
                        </span>
                        {intl.formatMessage({
                          id: "scheduledPreview.addSchedule",
                        })}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" sideOffset={4} className="w-[148px] p-1.5">
                      {FREQUENCIES.map((frequency) => (
                        <DropdownMenuItem
                          key={frequency}
                          data-testid={testId(TID_AUTOMATION_FREQUENCY_OPTION, frequency)}
                          // raw white 5% reads only on dark menus; on Light the selected state is near invisible.
                          className="min-h-8 px-2 py-2 text-ui-base text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground"
                          onSelect={() => {
                            markFieldTouched("schedule");
                            if (frequency === "custom") {
                              setCustomRepeatOpen(true);
                              return;
                            }
                            setBuilder((previous) => ({
                              ...previous,
                              frequency,
                              ...(frequency === "weekdays" ? { weekdays: [1, 2, 3, 4, 5] } : {}),
                            }));
                            setScheduleRemoved(false);
                            clearRequiredFieldValidation("schedule");
                          }}
                        >
                          {intl.formatMessage({
                            id: `automations.frequency.${frequency}`,
                          })}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <>
                    {/* The schedule bar uses no min-height, no wrap layout, no full-row summary — a second row would grow it once a tag is added.
                        With the global Input 1px border restored, 7px left padding offsets the border so the first tag stays 8px from the edge;
                        tags gain 1px vertical padding and remain centered in the 36px input. */}
                    <div className="relative flex h-9 flex-nowrap items-center gap-1 overflow-hidden rounded-xl border border-input-border bg-input py-1 pl-[7px] pr-9 text-ui-base leading-5 text-foreground transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
                      <Select
                        value={builder.frequency}
                        onValueChange={(value) => {
                          // Radix Select may emit an empty value while registering the legacy-cron controls; do not overwrite the parsed frequency.
                          if (!isCronFrequency(value)) {
                            logger.warn("[AutomationEditView] ignore invalid frequency value", {
                              automationId: editing?.automationId,
                              cronExpr: editing?.cronExpr,
                              value,
                            });
                            return;
                          }
                          markFieldTouched("schedule");
                          if (value === "custom") {
                            setCustomRepeatOpen(true);
                            return;
                          }
                          setBuilder((prev) => ({
                            ...prev,
                            frequency: value,
                            ...(value === "weekdays" ? { weekdays: [1, 2, 3, 4, 5] } : {}),
                          }));
                        }}
                      >
                        {/* The frequency trigger hardcoded dark values, breaking contrast in light themes;
                            use hover/selected semantic tokens and 1px vertical padding around the 20px row. */}
                        <SelectTrigger
                          variant="ghost"
                          data-testid={TID_AUTOMATION_FREQUENCY_SELECT}
                          className="h-auto min-w-24 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 text-foreground hover:bg-selected aria-expanded:bg-selected"
                          indicator={<AutomationChevronDownIcon />}
                        >
                          <SelectValue>
                            {intl.formatMessage({
                              id: `automations.frequency.${builder.frequency}`,
                            })}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {FREQUENCIES.map((freq) => (
                            <SelectItem
                              key={freq}
                              value={freq}
                              data-testid={testId(TID_AUTOMATION_FREQUENCY_OPTION, freq)}
                            >
                              {intl.formatMessage({
                                id: `automations.frequency.${freq}`,
                              })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {builder.frequency === "monthly" ? (
                        <Select
                          value={String(builder.dayOfMonth)}
                          onValueChange={(value) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({
                              ...prev,
                              dayOfMonth: Number(value),
                            }));
                          }}
                        >
                          <SelectTrigger
                            variant="ghost"
                            className="h-auto w-auto rounded-full border-0 bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground hover:bg-selected aria-expanded:bg-selected"
                            indicator={<AutomationChevronDownIcon />}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-60">
                            {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                              <SelectItem key={day} value={String(day)}>
                                {intl.formatMessage(
                                  { id: "automations.form.dayOfMonth" },
                                  { day: String(day) },
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}

                      {builder.frequency === "weekly" ? (
                        <WeekdayPicker
                          weekdays={builder.weekdays}
                          intl={intl}
                          onChange={(weekdays) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({ ...prev, weekdays }));
                          }}
                        />
                      ) : null}

                      {/* The repeat period hardcoded #F8F8F8 with mismatched tag radii; unify semantic text color and pill radius.*/}
                      {builder.frequency === "custom" ? (
                        <button
                          type="button"
                          // A visual refactor dropped the E2E stable selector, so the Custom Repeat value could not be re-verified after save.
                          data-testid={TID_AUTOMATION_CUSTOM_REPEAT_EDIT}
                          onClick={() => setCustomRepeatOpen(true)}
                          className="inline-flex h-auto items-center gap-0.5 rounded-full bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground hover:bg-selected"
                        >
                          <span>
                            {intl.formatMessage(
                              {
                                id: "automations.customRepeat.compactFrequency",
                              },
                              {
                                interval: String(builder.customInterval),
                                unit: intl.formatMessage({
                                  id: `automations.customRepeat.unit.${
                                    builder.customUnit === "minute"
                                      ? "minute"
                                      : builder.customUnit === "daily"
                                        ? "day"
                                        : builder.customUnit === "weekly"
                                          ? "week"
                                          : builder.customUnit === "monthly"
                                            ? "month"
                                            : builder.customUnit === "yearly"
                                              ? "year"
                                              : "hour"
                                  }`,
                                }),
                              },
                            )}
                          </span>
                          <AutomationChevronDownIcon />
                        </button>
                      ) : null}

                      {builder.frequency !== "custom" && builder.frequency !== "hourly" ? (
                        <>
                          {/* The conjunction used the secondary color alone, an inconsistent highlight against adjacent tag text.*/}
                          <span className="text-foreground">
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <TimeOfDayPicker
                            hour={builder.hour}
                            minute={builder.minute}
                            ariaLabel={intl.formatMessage({
                              id: "automations.form.schedule.label",
                            })}
                            onChange={(hour, minute) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({ ...prev, hour, minute }));
                            }}
                          />
                          <span className="whitespace-nowrap text-foreground-subtle">
                            {formatGmtOffset()}
                          </span>
                        </>
                      ) : null}

                      {builder.frequency === "hourly" ? (
                        <div className="flex items-center gap-1 text-ui-base leading-5 text-foreground">
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.minutePrefix",
                            })}
                          </span>
                          <Select
                            value={String(builder.minute)}
                            onValueChange={(value) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({
                                ...prev,
                                minute: Number(value),
                              }));
                            }}
                          >
                            <SelectTrigger
                              variant="ghost"
                              className="h-auto w-14 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 tabular-nums hover:bg-selected"
                            >
                              <SelectValue>{pad2(builder.minute)}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              {Array.from({ length: 60 }, (_, value) => (
                                <SelectItem key={value} value={String(value)}>
                                  {pad2(value)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.minuteSuffix",
                            })}
                          </span>
                        </div>
                      ) : null}

                      {builder.frequency === "custom" && builder.customUnit === "hourly" ? (
                        <div className="flex items-center gap-1 text-ui-base leading-5 text-foreground">
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <Select
                            value={String(builder.minute)}
                            onValueChange={(value) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({
                                ...prev,
                                minute: Number(value),
                              }));
                            }}
                          >
                            <SelectTrigger
                              variant="ghost"
                              className="h-auto w-16 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 tabular-nums hover:bg-selected"
                            >
                              <SelectValue>{pad2(builder.minute)}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              {Array.from({ length: 60 }, (_, value) => (
                                <SelectItem key={value} value={String(value)}>
                                  {pad2(value)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span>
                            {intl.formatMessage({
                              id: "automations.customRepeat.minutes",
                            })}
                          </span>
                        </div>
                      ) : null}

                      {builder.frequency === "custom" && builder.customUnit === "yearly" ? (
                        <MonthDayPicker
                          month={builder.customMonth}
                          day={builder.customMonthDays[0] ?? 1}
                          intl={intl}
                          onChange={(month, day) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({
                              ...prev,
                              customMonth: month,
                              customMonthDays: [day],
                            }));
                          }}
                        />
                      ) : null}

                      {builder.frequency === "custom" &&
                      builder.customUnit !== "hourly" &&
                      builder.customUnit !== "minute" ? (
                        <>
                          <span className="text-foreground">
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <TimeOfDayPicker
                            hour={builder.hour}
                            minute={builder.minute}
                            onChange={(hour, minute) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({ ...prev, hour, minute }));
                            }}
                          />
                          <span className="text-foreground-subtle">{formatGmtOffset()}</span>
                        </>
                      ) : null}

                      {schedulePreview ? (
                        <span
                          data-testid={TID_AUTOMATION_SCHEDULE_PREVIEW}
                          className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle sm:ml-1"
                        >
                          {schedulePreview}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        data-testid={TID_AUTOMATION_SCHEDULE_DELETE}
                        onClick={handleRemoveSchedule}
                        className="absolute right-2 top-2 flex size-5 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
                        aria-label={intl.formatMessage({ id: "common.delete" })}
                      >
                        <AutomationTrashIcon />
                      </button>
                    </div>
                  </>
                )}

                <CustomRepeatDialog
                  builder={builder}
                  endAt={endAt}
                  intl={intl}
                  open={customRepeatOpen}
                  onOpenChange={setCustomRepeatOpen}
                  onConfirm={({
                    interval,
                    unit,
                    weekdays,
                    monthDays,
                    monthlyMode,
                    endAt: nextEndAt,
                  }) => {
                    markFieldTouched("schedule");
                    setScheduleRemoved(false);
                    clearRequiredFieldValidation("schedule");
                    setBuilder((prev) => ({
                      ...prev,
                      frequency: "custom",
                      customInterval: interval,
                      customUnit: unit,
                      customWeekdays: weekdays,
                      customMonthDays: monthDays,
                      customMonthlyMode: monthlyMode,
                    }));
                    setEndAt(nextEndAt);
                  }}
                />
              </div>
            )}

            {/* Instructions + bottom project/model pickers */}
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <label
                className="text-ui-base font-normal leading-5 text-foreground-subtle"
                htmlFor="automation-prompt"
              >
                {intl.formatMessage({ id: "automations.form.prompt.label" })}
              </label>
              <AutomationInstructionsComposer
                invalid={validationErrors.has("prompt") && !prompt.trim()}
              >
                <AutomationInstructionsTextarea
                  id="automation-prompt"
                  data-testid={TID_AUTOMATION_FORM_PROMPT}
                  value={prompt}
                  onChange={(event) => {
                    markFieldTouched("prompt");
                    clearRequiredFieldValidation("prompt");
                    setPrompt(event.target.value);
                  }}
                  placeholder={intl.formatMessage({
                    id: "automations.edit.promptPlaceholder",
                  })}
                  aria-invalid={validationErrors.has("prompt") && !prompt.trim()}
                />
                <AutomationInstructionsToolbar>
                  <div className="flex min-w-0 flex-wrap items-center gap-0 text-foreground-subtle">
                    {/* Project picker: create reuses the input-empty project menu; edit locks to the automation's project */}
                    {editing ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled
                        className="h-auto min-h-7 gap-1 rounded-full px-2 py-1 text-ui-base font-normal leading-normal"
                      >
                        {isSelectedConversationWorkspace ? (
                          <MessageCircle className="size-3.5" aria-hidden="true" />
                        ) : (
                          <FolderOpen className="size-3.5" aria-hidden="true" />
                        )}
                        <span className="max-w-40 truncate">{selectedWorkspaceDisplayLabel}</span>
                      </Button>
                    ) : workspaceMenuTabs.length > 0 ? (
                      // Automations toolbar and session composer controls share rounded-lg; regular session chips unchanged.
                      <ChatEmptyWorkspacePreviewMenu
                        workspacePath={selectedWorkspacePath}
                        workspaceTabs={workspaceMenuTabs}
                        // Scheduled tasks may pick the canonical conversation backing, but no quick X on the chip;
                        // the menu reuses the session-side "not working in a project" copy and MessageCircle icon.
                        allowConversationWorkspaceSelection={Boolean(conversationWorkspace)}
                        allowConversationWorkspaceDetach={false}
                        onSelectWorkspace={handleSelectWorkspace}
                        onSelectConversationWorkspace={handleSelectConversationWorkspace}
                        allowOpenWorkspace={false}
                        allowRemoteWorkspace={false}
                        onOpenFolder={() => {}}
                        onConnectRemote={async () => ""}
                        onSelectRemoteProject={async () => {}}
                        onCancelRemoteProject={async (_sessionId) => {}}
                        containerClassName="contents"
                        triggerClassName={cn(
                          AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                          "min-w-0 gap-1 px-2",
                        )}
                      />
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled
                        className="h-auto min-h-7 gap-1 rounded-full px-2 py-1 text-ui-base font-normal leading-normal text-foreground-subtlest"
                      >
                        <FolderOpen className="size-3.5" aria-hidden="true" />
                        {intl.formatMessage({
                          id: "automations.form.project.localRequired",
                        })}
                      </Button>
                    )}

                    {/* Automations once copied the home permission menu, drifting icons, sizes and selected states.
                        Reuse the home ConfigSelect directly, overriding only the compact trigger layout. */}
                    <ConfigSelect
                      option={modeOption}
                      onValueChange={(value) => {
                        markFieldTouched("mode");
                        modeRef.current = value;
                        setMode(value);
                      }}
                      tooltipTitle={intl.formatMessage({
                        id: "chat.toolbar.mode.label",
                      })}
                      triggerVariant="ghost"
                      triggerSize="default"
                      triggerClassName={cn(
                        AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                        "w-fit max-w-56 min-w-0 shrink justify-start gap-1 px-2",
                      )}
                      labelVisibilityClassName="inline-flex min-w-0 truncate text-left"
                      provider={ZCODE_AGENT_PROVIDER}
                      restoreFocusSelector={null}
                    />
                  </div>

                  {/* Model / reasoning level group on the right, a clear partition from workspace/permission on the left. */}
                  <div className="flex min-w-0 flex-wrap items-center justify-end gap-0 text-foreground-subtle">
                    <ModelConfigSelect
                      modelGroups={modelSelectGroups}
                      normalizedValue={selectedModelItem?.value ?? ""}
                      triggerLabel={modelTriggerLabel}
                      showManageModelsAction={Boolean(onManageModels)}
                      lockReasonMessage=""
                      isItemLocked={MODEL_ITEM_NEVER_LOCKED}
                      onValueChange={handleModelValueChange}
                      tooltipTitle={intl.formatMessage({
                        id: "chat.toolbar.model.label",
                      })}
                      manageModelsLabel={intl.formatMessage({
                        id: "chat.toolbar.model.manageModels",
                      })}
                      onManageModels={onManageModels}
                      contentSide="top"
                      focusSelectorOnClose={null}
                      labelVisibilityClassName="hidden @sm/composer:inline-flex"
                      indicatorClassName="hidden @sm/composer:block"
                      triggerClassName={cn(
                        AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                        "w-fit max-w-72 min-w-0 shrink @max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:gap-0 @max-sm/composer:p-0",
                      )}
                      triggerIconClassName="inline-flex @sm/composer:hidden"
                      disabled={modelSelectionRead.state.status !== "ready"}
                    />
                    {modelSelectionRead.state.status === "error" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={modelSelectionRead.reload}
                      >
                        {intl.formatMessage({ id: "common.retry" })}
                      </Button>
                    ) : null}
                    {thoughtLevelOption ? (
                      <ThoughtLevelCycleControl
                        intl={intl}
                        option={thoughtLevelOption}
                        provider={ZCODE_AGENT_PROVIDER}
                        triggerRef={thoughtTriggerRef}
                        indicatorClassName="hidden @xl/composer:block"
                        triggerClassName={cn(
                          AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                          "@max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:p-0",
                        )}
                        restoreFocusSelector={null}
                        labelVisibilityClassName="hidden @xl/composer:inline-flex"
                        onValueChange={(value) => {
                          if (!effectiveSelection) return;
                          markFieldTouched("thoughtLevel");
                          // Changing the level forms a new intent under the displayed model's identity; read-only refreshes do not touch the form.
                          modelSelection.current = effectiveModelValue;
                          setModel(effectiveModelValue);
                          thoughtManuallyChangedRef.current = true;
                          thoughtLevelRef.current = value;
                          setThoughtLevel(value);
                        }}
                      />
                    ) : null}
                  </div>
                </AutomationInstructionsToolbar>
              </AutomationInstructionsComposer>
            </div>
          </form>
        ) : (
          // History tab: inline run-history table
          <div>
            {/* Run conditions are explained at the entry; repeating them here crowds the space above the table.*/}
            {runsLoading && runs.length === 0 ? (
              <div className="flex h-32 items-center justify-center">
                <Spinner className="size-5" />
              </div>
            ) : runsEntry?.status === "error" ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
                {runsEntry.error}
              </div>
            ) : runs.length === 0 ? (
              // Scheduled tasks once rendered a transparent py-10 text block, lacking the idle tasks' empty-state surface, border and height.
              <AutomationHistoryEmptyState>
                {intl.formatMessage({ id: "automations.runs.empty" })}
              </AutomationHistoryEmptyState>
            ) : (
              <div className="overflow-x-auto rounded-[8px]">
                {/* Run history uses scalable type; do not bind a fixed 18px line height.*/}
                <table className="w-full text-left text-ui-base font-normal leading-normal tracking-[-0.08px]">
                  <thead className="bg-surface text-foreground-subtle">
                    <tr className="h-[30px] border-b border-border">
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.triggered",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.trigger",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.status",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.duration",
                        })}
                      </th>
                      <th className="px-4 font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRuns.map((run) => {
                      const status = resolveRunStatus(run);
                      const statusLabel = intl.formatMessage({
                        id: `automations.runs.status.${status}`,
                      });
                      const statusBadge = (
                        <span className="flex items-center text-ui-base leading-5 tracking-[-0.18px]">
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            <span
                              className={cn(
                                "inline-block size-1.5 rounded-full",
                                RUN_STATUS_DOT_CLASS[status],
                              )}
                            />
                          </span>
                          <span className={RUN_STATUS_TEXT_CLASS[status]}>{statusLabel}</span>
                        </span>
                      );
                      const canOpenSession = Boolean(run.sessionId && onOpenSession);
                      const hasActions = canOpenSession || Boolean(onDeleteRun);
                      return (
                        <tr
                          key={run.runId}
                          className="h-[46px] border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover"
                        >
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {formatDateTime(run.scheduledAt ?? run.createdAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {intl.formatMessage({
                              id: `automations.trigger.${run.trigger}`,
                            })}
                          </td>
                          <td className="px-4">
                            {status === "failed" ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>{statusBadge}</TooltipTrigger>
                                  <TooltipContent
                                    side="top"
                                    align="start"
                                    sideOffset={6}
                                    className="max-w-96 whitespace-normal break-words"
                                  >
                                    {run.error?.trim() ||
                                      intl.formatMessage({
                                        id: "automations.runs.errorUnavailable",
                                      })}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              statusBadge
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {formatDuration(run.createdAt, run.updatedAt)}
                          </td>
                          <td className="px-4">
                            <div className="flex items-center justify-end">
                              {hasActions ? (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={intl.formatMessage({
                                        id: "automations.moreActions",
                                      })}
                                      className="flex size-6 items-center justify-center rounded-[6px] text-foreground-subtle transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground"
                                    >
                                      <AutomationMoreHorizontalIcon
                                        className="size-4"
                                        aria-hidden="true"
                                      />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    align="end"
                                    sideOffset={4}
                                    className="min-w-[160px]"
                                  >
                                    {canOpenSession ? (
                                      <DropdownMenuItem
                                        onSelect={() => onOpenSession?.(run.sessionId!)}
                                      >
                                        <AutomationExternalLinkIcon
                                          className="size-3.5"
                                          aria-hidden="true"
                                        />
                                        {intl.formatMessage({
                                          id: "automations.runs.openSession",
                                        })}
                                      </DropdownMenuItem>
                                    ) : null}
                                    {onDeleteRun ? (
                                      <>
                                        {canOpenSession ? <DropdownMenuSeparator /> : null}
                                        <DropdownMenuItem
                                          variant="destructive"
                                          onSelect={() => onDeleteRun(run.runId)}
                                        >
                                          <AutomationTrashIcon />
                                          {intl.formatMessage({
                                            id: "automations.runs.delete",
                                          })}
                                        </DropdownMenuItem>
                                      </>
                                    ) : null}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {runs.length > 0 && runsTotalPages > 1 ? (
              <nav className="mt-4 flex items-center justify-between text-ui-base">
                <button
                  type="button"
                  disabled={runsCurrentPage <= 1}
                  onClick={() => setRunsPage(Math.max(1, runsCurrentPage - 1))}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <ArrowLeft className="size-3.5" aria-hidden="true" />
                  {intl.formatMessage({ id: "automations.runs.prevPage" })}
                </button>
                <div className="flex items-center gap-1">
                  {runsPageItems.map((item, index) =>
                    item === "ellipsis" ? (
                      <span
                        key={`ellipsis-${index}`}
                        className="flex size-7 items-center justify-center text-foreground-subtlest"
                        aria-hidden="true"
                      >
                        …
                      </span>
                    ) : (
                      <button
                        key={item}
                        type="button"
                        aria-current={item === runsCurrentPage ? "page" : undefined}
                        onClick={() => setRunsPage(item)}
                        className={cn(
                          "inline-flex size-7 items-center justify-center rounded-[6px] transition-colors",
                          item === runsCurrentPage
                            ? "bg-surface text-foreground"
                            : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                        )}
                      >
                        {item}
                      </button>
                    ),
                  )}
                </div>
                <button
                  type="button"
                  disabled={runsCurrentPage >= runsTotalPages}
                  onClick={() => setRunsPage(Math.min(runsTotalPages, runsCurrentPage + 1))}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  {intl.formatMessage({ id: "automations.runs.nextPage" })}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </button>
              </nav>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
