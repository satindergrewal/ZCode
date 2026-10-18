// ============================================================
// The Configure popover's two fields
// ============================================================
// Split out of WorkflowRunSettingsPopover.tsx: that side owns form state, the command, and
// the consequence line; this only draws two controlled fields — the subagent model
// (composer's model menu + reasoning level) and the max-concurrent-runs stepper. Props
// arrive fully resolved.

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
 * Subagent model: the composer's exact model menu with Session model first; when the
 * chosen model has reasoning levels, the trigger gets the same level control the settings
 * page's subagent row uses. An empty list collapses the field to one sentence (the cap
 * stays adjustable).
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
  /** Badge in the trigger: "Session model" or "Unavailable"; absent means none. */
  badge?: { text: string; tone: "subtle" | "warning" };
  disabled: boolean;
  groups: readonly ModelSelectGroup[];
  leadingItem: ModelSelectGroupItem;
  /** The agent has no selectable models: the field degrades to one sentence. */
  noCatalog: boolean;
  onLevelChange: (level: string) => void;
  onValueChange: (value: string) => void;
  /** The chosen model's reasoning level; absent hides the level control. */
  thoughtOption: ZCodeConfigOption | null;
  triggerLabel: string;
  value: string;
}) {
  const { intl } = useZCodeIntl();
  const levelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const [levelOpen, setLevelOpen] = useState(false);
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.model" });
  // ModelConfigSelect is memoized: a fresh inline array each render would defeat the memo.
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
 * Max-concurrent-runs stepper: minus, tabular number, plus, from 1 to the machine
 * ceiling. The ceiling itself means "no bound of its own" — copy becomes "= machine
 * limit". Unknown ceiling (old CLI): no cap, no hint, the number is freely typable.
 */
export function WorkflowRunSettingsBoundField({
  bound,
  ceiling,
  disabled,
  onChange,
}: {
  bound: number | null;
  ceiling: number | undefined;
  disabled: boolean;
  onChange: (bound: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const hint =
    ceiling === undefined
      ? undefined
      : bound !== null && bound >= ceiling
        ? intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit.atCeiling" })
        : intl.formatMessage(
            { id: "chat.toolCall.workflow.run.settings.limit.ceiling" },
            { n: ceiling },
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
              onClick={() =>
                bound !== null && onChange(clampWorkflowRunSettingsBound(bound - 1, ceiling))
              }
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
              if (Number.isFinite(parsed)) onChange(clampWorkflowRunSettingsBound(parsed, ceiling));
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
              disabled={disabled || bound === null || (ceiling !== undefined && bound >= ceiling)}
              onClick={() =>
                bound !== null && onChange(clampWorkflowRunSettingsBound(bound + 1, ceiling))
              }
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
