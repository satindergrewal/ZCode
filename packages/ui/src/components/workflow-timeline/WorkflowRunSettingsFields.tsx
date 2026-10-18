// ============================================================
// The Configure popover's two fields.
// ============================================================
// Split from WorkflowRunSettingsPopover.tsx: that side owns form state, the command and the consequence
// line; this only draws two controlled fields — subagent model (composer menu plus thinking level) and
// the max-concurrency stepper. Every prop arrives cooked.

import { useMemo, useRef, useState } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { ZCODE_AGENT_PROVIDER, type ZCodeConfigOption } from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { cn } from "@/components/lib/utils.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MODEL_CONFIG_SELECT_BADGE_CLASS_NAME,
  ModelConfigSelect,
  type ModelSelectGroup,
  type ModelSelectGroupItem,
} from "@/ModelConfigSelect.js";
import { clampWorkflowRunSettingsBound } from "./workflowRunSettings.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

/** Field label: 12px, secondary color, 4px above its control. */
function FieldLabel({ children }: { children: string }) {
  return <div className="text-ui-sm text-foreground-subtle">{children}</div>;
}

/**
 * Subagent model: the composer's very model menu, session model first; when the selection has thinking
 * levels, the settings page subagent row's own level control sits beside the trigger. An empty catalog
 * replaces the field with a sentence (the limit stays adjustable).
 */
export function WorkflowRunSettingsModelField({
  badge,
  disabled,
  groups,
  leadingItem,
  noCatalog,
  onLevelChange,
  onValueChange,
  thoughtOption,
  triggerLabel,
  value,
}: {
  /** Badge in the trigger: session-model or unavailable; absent when none. */
  badge?: { text: string; tone: "subtle" | "warning" };
  disabled: boolean;
  groups: readonly ModelSelectGroup[];
  leadingItem: ModelSelectGroupItem;
  /** The agent has no pickable model: the field degrades to a sentence. */
  noCatalog: boolean;
  onLevelChange: (level: string) => void;
  onValueChange: (value: string) => void;
  /** The selection's thinking level; absent, no level control renders. */
  thoughtOption: ZCodeConfigOption | null;
  triggerLabel: string;
  value: string;
}) {
  const { intl } = useZCodeIntl();
  const levelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const [levelOpen, setLevelOpen] = useState(false);
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.model" });
  // ModelConfigSelect is memoized: an inline array is a fresh reference per render and voids the memo.
  const leadingItems = useMemo(() => [leadingItem], [leadingItem]);
  if (noCatalog) {
    return (
      <div className="flex flex-col gap-1" data-testid="workflow-run-settings-model">
        <FieldLabel>{label}</FieldLabel>
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.model.noCatalog" })}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="workflow-run-settings-model">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="inline-flex min-w-0 flex-1" data-model-current-value={value}>
          <ModelConfigSelect
            modelGroups={groups}
            normalizedValue={value}
            triggerLabel={triggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_ITEM_NEVER_LOCKED}
            onValueChange={onValueChange}
            leadingItems={leadingItems}
            contentSide="bottom"
            contentAlign="start"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName="h-7 w-full min-w-0 justify-between rounded-md border border-input-border bg-input px-2 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
            triggerLabelClassName="inline-flex min-w-0 flex-1 truncate text-left"
            triggerTestId="workflow-run-settings-model-trigger"
            {...(badge === undefined
              ? {}
              : {
                  triggerBadge: (
                    <span
                      className={cn(
                        MODEL_CONFIG_SELECT_BADGE_CLASS_NAME,
                        badge.tone === "warning" && "text-warning",
                      )}
                      data-testid="workflow-run-settings-model-badge"
                    >
                      {badge.text}
                    </span>
                  ),
                })}
            disabled={disabled}
          />
        </span>
        {thoughtOption === null ? null : (
          <ThoughtLevelCycleControl
            intl={intl}
            option={thoughtOption}
            provider={ZCODE_AGENT_PROVIDER}
            onCurrentValueCommit={onLevelChange}
            showInvalidCurrentValue
            disabled={disabled}
            open={disabled ? false : levelOpen}
            onOpenChange={setLevelOpen}
            triggerRef={levelTriggerRef}
            restoreFocusSelector={null}
            labelVisibilityClassName="inline-flex"
            triggerClassName="h-7 shrink-0 rounded-md border border-input-border bg-input px-2 text-foreground hover:border-input-border-hover hover:bg-input"
            onValueChange={onLevelChange}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The max-concurrency stepper: minus, mono digits, plus; from 1, no ceiling — default concurrency D is
 * a starting point, not a cap (docs/dynamic-workflow/presentation.md "The settings popover"). The hint
 * reads default-N; resting on D means this run has no limit of its own and the hint becomes = default.
 * With D unknown (older CLIs) there is no hint, and the number stays typable.
 */
export function WorkflowRunSettingsBoundField({
  bound,
  defaultConcurrency,
  disabled,
  onChange,
}: {
  bound: number | null;
  defaultConcurrency: number | undefined;
  disabled: boolean;
  onChange: (bound: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const hint =
    defaultConcurrency === undefined
      ? undefined
      : bound === defaultConcurrency
        ? intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit.atDefault" })
        : intl.formatMessage(
            { id: "chat.toolCall.workflow.run.settings.limit.default" },
            { n: defaultConcurrency },
          );
  return (
    <div className="flex flex-col gap-1" data-testid="workflow-run-settings-bound">
      <FieldLabel>
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit" })}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <InputGroup className="w-auto shrink-0">
          <InputGroupAddon align="inline-start">
            <InputGroupButton
              aria-label={intl.formatMessage({
                id: "chat.toolCall.workflow.run.settings.limit.decrease",
              })}
              data-testid="workflow-run-settings-bound-decrease"
              disabled={disabled || bound === null || bound <= 1}
              onClick={() => bound !== null && onChange(clampWorkflowRunSettingsBound(bound - 1))}
              size="icon-xs"
            >
              <MinusIcon className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
          <InputGroupInput
            aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit" })}
            className="h-7 w-9 px-0 text-center font-mono tabular-nums"
            data-testid="workflow-run-settings-bound-value"
            disabled={disabled}
            inputMode="numeric"
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(parsed)) onChange(clampWorkflowRunSettingsBound(parsed));
            }}
            placeholder="—"
            value={bound === null ? "" : String(bound)}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label={intl.formatMessage({
                id: "chat.toolCall.workflow.run.settings.limit.increase",
              })}
              data-testid="workflow-run-settings-bound-increase"
              disabled={disabled || bound === null}
              onClick={() => bound !== null && onChange(clampWorkflowRunSettingsBound(bound + 1))}
              size="icon-xs"
            >
              <PlusIcon className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {hint === undefined ? null : (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{hint}</span>
        )}
      </div>
    </div>
  );
}
