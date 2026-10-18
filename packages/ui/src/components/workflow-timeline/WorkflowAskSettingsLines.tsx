// ============================================================
// The two run settings in the confirmation window (docs/dynamic-workflow/presentation.md "The confirmation window")
// ============================================================
// Two sentences whose values are the controls: subagents run on [model] [thinking high]; at most [− 4 +]
// subagents at once, default 13. With the script pinning models for some subagents the first sentence
// becomes run-by-default-on; those names are not listed (the author model's choice).
// Untouched values sit quietly in their sentence; a changed line bolds its value and trails a was-X-reset.
//
// Without the block (older agents never send `adjustable_settings`) render `WorkflowAskPlainSettings`
// (WorkflowAskSettingsParts.tsx): caller-set fields only, plain text, not adjustable — changes the agent
// would not apply get no controls here.
//
// The draft lives here; edits reach PermissionDialog event-style via `onContentChange` (it puts them
// into the response's `content` on Allow). A new request remounts by requestId key from the parent, no
// effect chasing. The single effect is selected-model-unavailable: it depends on the asynchronously
// loaded catalog, not one user action, so it can only be reported once the catalog lands.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MODEL_CONFIG_SELECT_BADGE_CLASS_NAME, ModelConfigSelect } from "@/ModelConfigSelect.js";
import {
  workflowScriptNamesModels,
  type WorkflowAdjustableSettings,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  describeWorkflowSubagentModel,
  workflowSubagentModelText,
  workflowSubagentModelTooltip,
} from "./subagent-model-label.js";
import {
  WORKFLOW_ASK_CHIP_CLASS_NAME,
  WORKFLOW_ASK_LINE_CLASS_NAME,
  WORKFLOW_ASK_TAIL_CLASS_NAME,
  WorkflowAskBoundLine,
  WorkflowAskWasTail,
} from "./WorkflowAskSettingsParts.js";
import {
  useWorkflowSettingsModelChoices,
  type WorkflowSettingsModelScope,
} from "./useWorkflowSettingsModelChoices.js";
import {
  initialWorkflowAskSettingsDraft,
  workflowAskSettingsChangedLines,
  workflowAskSettingsContent,
  type WorkflowAskSettingsContent,
} from "./workflowAskSettings.js";
import {
  workflowRunSettingsModelCanonical,
  type WorkflowRunSettingsDraft,
  type WorkflowRunSettingsModel,
} from "./workflowRunSettings.js";

export function WorkflowAskSettings({
  adjustable,
  disabled,
  input,
  onBlockedChange,
  onContentChange,
  scope,
}: {
  adjustable: WorkflowAdjustableSettings;
  disabled: boolean;
  /** The tool input for the confirmation window (as normalized by the CLI's resolveInput). */
  input: unknown;
  onContentChange?: (content: WorkflowAskSettingsContent | undefined) => void;
  /** Selection still unavailable once the catalog loads: Allow waits for a different pick (the popover Apply's rule). */
  onBlockedChange?: (blocked: boolean) => void;
  scope: WorkflowSettingsModelScope;
}) {
  const defaultConcurrency = adjustable.defaultConcurrency;
  // The starting point fixes at mount: the parent remounts by requestId, so one request's input never changes.
  const [initial] = useState(() => initialWorkflowAskSettingsDraft(input, defaultConcurrency));
  const [draft, setDraft] = useState<WorkflowRunSettingsDraft>(initial);
  const update = (next: WorkflowRunSettingsDraft) => {
    setDraft(next);
    onContentChange?.(workflowAskSettingsContent(initial, next, defaultConcurrency));
  };
  const changed = workflowAskSettingsChangedLines(initial, draft, defaultConcurrency);

  return (
    <div className="space-y-1" data-testid="workflow-permission-settings">
      <WorkflowAskModelLine
        adjustable={adjustable.subagentModel}
        changed={changed.model}
        disabled={disabled}
        initial={initial.model}
        model={draft.model}
        onChange={(model) => update({ ...draft, model })}
        onReset={() => update({ ...draft, model: initial.model })}
        scope={scope}
        scriptNamesModels={workflowScriptNamesModels(input)}
        {...(onBlockedChange === undefined ? {} : { onBlockedChange })}
      />
      <WorkflowAskBoundLine
        bound={draft.bound}
        changed={changed.bound}
        defaultConcurrency={defaultConcurrency}
        disabled={disabled}
        initial={initial.bound}
        onChange={(bound) => update({ ...draft, bound })}
        onReset={() => update({ ...draft, bound: initial.bound })}
      />
    </div>
  );
}

function WorkflowAskModelLine({
  adjustable,
  changed,
  disabled,
  initial,
  model,
  onBlockedChange,
  onChange,
  onReset,
  scope,
  scriptNamesModels,
}: {
  adjustable: boolean;
  changed: boolean;
  disabled: boolean;
  initial: WorkflowRunSettingsModel;
  model: WorkflowRunSettingsModel;
  onBlockedChange?: (blocked: boolean) => void;
  onChange: (model: WorkflowRunSettingsModel) => void;
  onReset: () => void;
  scope: WorkflowSettingsModelScope;
  /**
   * The script pins models for some subagents (`model_bindings`): the window does not name them — that
   * was the author model's choice; it rewords to by-default-on, which no longer speaks for every subagent.
   */
  scriptNamesModels: boolean;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const choices = useWorkflowSettingsModelChoices(scope);
  const levelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const [levelOpen, setLevelOpen] = useState(false);
  // ModelConfigSelect is memoized: an inline array is a new reference every render (reactStableReferences.test.ts).
  const leadingItems = useMemo(() => [choices.sessionModelItem], [choices.sessionModelItem]);
  const selectable = adjustable && !choices.noCatalog;
  const face = choices.describe(model);
  const blocked = selectable && face.unavailable;
  // ModelConfigSelect is memoized: the callback must not be inline either.
  const { pick } = choices;
  const handleValueChange = useCallback(
    (value: string) => onChange(pick(value, model)),
    [model, onChange, pick],
  );
  useEffect(() => {
    onBlockedChange?.(blocked);
  }, [blocked, onBlockedChange]);

  const labelOf = (choice: WorkflowRunSettingsModel) => {
    const canonical = workflowRunSettingsModelCanonical(choice);
    if (choice.kind === "session" || canonical === undefined) {
      // When the session model's name is unreadable the name is session-model itself; no duplicate badge on top.
      const text =
        scope.sessionModel === undefined
          ? choices.sessionModelName
          : `${choices.sessionModelName} · ${choices.sessionBadge}`;
      return { text, tooltip: undefined };
    }
    const label = describeWorkflowSubagentModel(canonical, {
      formatMessage: format,
      providerName: choices.providerName,
    });
    return {
      text: workflowSubagentModelText(format, label),
      tooltip: workflowSubagentModelTooltip(format, label),
    };
  };

  const lead = format({
    id: scriptNamesModels
      ? "chat.permission.workflow.settings.model.leadDefault"
      : "chat.permission.workflow.settings.model.lead",
  });
  // No model can be picked (no host catalog, or the local list is empty): the sentence loses its
  // controls. Name an input-carried model as carried over; only otherwise does the session model carry
  // — the window must never say the opposite of what will happen.
  if (!selectable) {
    const current = labelOf(model);
    return (
      <div
        className={WORKFLOW_ASK_LINE_CLASS_NAME}
        data-testid="workflow-permission-settings-model"
      >
        {model.kind === "session" ? (
          <>
            <span>
              {format({
                id: scriptNamesModels
                  ? "chat.permission.workflow.settings.model.noCatalogDefault"
                  : "chat.permission.workflow.settings.model.noCatalog",
              })}
            </span>
            <span className={WORKFLOW_ASK_TAIL_CLASS_NAME}>
              · {format({ id: "chat.permission.workflow.settings.model.noCatalogReason" })}
            </span>
          </>
        ) : (
          <span title={current.tooltip}>
            {lead} {current.text}
          </span>
        )}
      </div>
    );
  }

  const tooltip = labelOf(model).tooltip;
  return (
    <div
      className={WORKFLOW_ASK_LINE_CLASS_NAME}
      data-changed={changed ? "true" : undefined}
      data-testid="workflow-permission-settings-model"
    >
      <span>{lead}</span>
      <ModelConfigSelect
        contentAlign="start"
        contentSide="bottom"
        disabled={disabled || choices.loading}
        focusSelectorOnClose={null}
        indicatorClassName="size-3"
        isItemLocked={MODEL_ITEM_NEVER_LOCKED}
        labelVisibilityClassName="inline-flex min-w-0"
        leadingItems={leadingItems}
        lockReasonMessage=""
        modelGroups={choices.groups}
        normalizedValue={face.value}
        onValueChange={handleValueChange}
        showManageModelsAction={false}
        triggerClassName={WORKFLOW_ASK_CHIP_CLASS_NAME}
        triggerLabel={face.triggerLabel}
        triggerLabelClassName={cn("min-w-0 truncate", changed && "font-medium")}
        triggerTestId="workflow-permission-settings-model-trigger"
        {...(tooltip === undefined ? {} : { tooltipTitle: tooltip })}
        {...(model.kind === "session"
          ? {
              triggerBadge: (
                <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>{choices.sessionBadge}</span>
              ),
            }
          : face.unavailable
            ? {
                triggerBadge: (
                  <span
                    className={cn(MODEL_CONFIG_SELECT_BADGE_CLASS_NAME, "text-warning")}
                    data-testid="workflow-permission-settings-model-unavailable"
                  >
                    {format({ id: "chat.toolCall.workflow.run.settings.model.unavailable" })}
                  </span>
                ),
              }
            : {})}
      />
      {face.thoughtOption === null || model.kind !== "model" ? null : (
        <ThoughtLevelCycleControl
          disabled={disabled}
          intl={intl}
          labelVisibilityClassName="inline-flex"
          onCurrentValueCommit={(level) => {
            if (level !== model.level) onChange({ ...model, level });
          }}
          onOpenChange={setLevelOpen}
          onValueChange={(level) => {
            if (level !== model.level) onChange({ ...model, level });
          }}
          open={disabled ? false : levelOpen}
          option={face.thoughtOption}
          provider={ZCODE_AGENT_PROVIDER}
          restoreFocusSelector={null}
          showInvalidCurrentValue
          triggerClassName={cn(WORKFLOW_ASK_CHIP_CLASS_NAME, changed && "font-medium")}
          triggerRef={levelTriggerRef}
        />
      )}
      {changed ? (
        <WorkflowAskWasTail
          disabled={disabled}
          onReset={onReset}
          testId="workflow-permission-settings-model"
          value={labelOf(initial).text}
        />
      ) : null}
    </div>
  );
}

const MODEL_ITEM_NEVER_LOCKED = () => false;
