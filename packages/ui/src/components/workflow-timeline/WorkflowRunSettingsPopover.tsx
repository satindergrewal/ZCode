// ============================================================
// The Configure popover
// ============================================================
// The run card's Configure, the detail page's Configure, and the detail summary's model
// segment all open one popover: two fields, one consequence line, Apply. Apply is a GUI
// amendment — the `amendWorkflowRunSettings` command, no model round, no confirm dialog;
// the click itself is consent, the hub's Run rule again.
//
// One popover, many triggers: the anchor is whichever element opened it (virtual), so the detail page's two entries each align to their own.
// The form mounts only while open — the model-list subscription lives exactly that long.

import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { CommandAck, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from "@/components/ui/popover.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { logger } from "@/logger.js";
import { formatProviderModelLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { describeWorkflowSubagentModel } from "./subagent-model-label.js";
import {
  WorkflowRunSettingsBoundField,
  WorkflowRunSettingsModelField,
} from "./WorkflowRunSettingsFields.js";
import {
  describeWorkflowRunSettingsRejection,
  initialWorkflowRunSettingsDraft,
  workflowRunSettingsCeiling,
  workflowRunSettingsChange,
  workflowRunSettingsConsequenceId,
  workflowRunSettingsModelCanonical,
  workflowRunSettingsRejectionDetail,
  workflowRunSettingsRejectionMessageId,
  type WorkflowRunSettingsChange,
  type WorkflowRunSettingsDraft,
  type WorkflowRunSettingsRejection,
} from "./workflowRunSettings.js";

/** Value of the menu's Session-model item: outside encodeCustomModelValue's domain, cannot collide with a real model. */
const SESSION_MODEL_VALUE = "workflow-settings:session-model";

/** Everything the host hands the popover: the model list's scope, the session model, and the command sender. */
export interface WorkflowRunSettingsHost {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** The session's current model (first item and trigger use its name); absent, the item reads just "Session model". */
  sessionModel?: { providerId: string; modelId: string };
  /** Sends `amendWorkflowRunSettings` (host fills workId/session); resolves the ACK. */
  apply: (change: WorkflowRunSettingsChange) => Promise<CommandAck>;
}

/** The new run's two keys after acceptance (ACK.result). */
export interface WorkflowRunSettingsAccepted {
  runId: string;
  toolCallId: string;
}

/** Per-trigger toggle and anchor: clicking the same trigger again closes; another trigger moves and reopens. */
export function useWorkflowRunSettingsPopoverState() {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const toggleFrom = useCallback(
    (element: HTMLElement) => {
      if (open && anchorRef.current === element) {
        setOpen(false);
        return;
      }
      anchorRef.current = element;
      setOpen(true);
    },
    [open],
  );
  return { anchorRef, open, setOpen, toggleFrom };
}

export function WorkflowRunSettingsPopover({
  anchorRef,
  host,
  onAccepted,
  onOpenChange,
  open,
  run,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  host: WorkflowRunSettingsHost;
  onAccepted?: (accepted: WorkflowRunSettingsAccepted) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  run: WorkflowRunState;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        align="end"
        className="gap-2.5"
        data-testid="workflow-run-settings-popover"
        // The popover portals out, but React events still bubble up the component tree:
        // unhandled, a click on popover blank space reads as a card-body click and collapses
        // it (the whole card is the toggle), and Enter in the number box toggles too.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        // The trigger that opened it does not count as an outside click: otherwise it closes, then that same click reopens.
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault();
        }}
      >
        <WorkflowRunSettingsForm
          host={host}
          onClose={() => onOpenChange(false)}
          run={run}
          {...(onAccepted === undefined ? {} : { onAccepted })}
        />
      </PopoverContent>
    </Popover>
  );
}

function WorkflowRunSettingsForm({
  host,
  onAccepted,
  onClose,
  run,
}: {
  host: WorkflowRunSettingsHost;
  onAccepted?: (accepted: WorkflowRunSettingsAccepted) => void;
  onClose: () => void;
  run: WorkflowRunState;
}) {
  const { intl } = useZCodeIntl();
  const format = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const modelRead = useModelSelectionView(
    host.workspacePath,
    host.remoteSessionId,
    host.workspaceIdentity,
  );
  const view = modelRead.state.status === "ready" ? modelRead.state.view : null;
  const groups = useMemo(
    () =>
      view === null
        ? []
        : buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {
            apiKeyLabel: format("settings.modelProvider.apiKey"),
            apiKeyBadgeLabel: format("settings.modelProvider.connectionMode.apiKeyBadge"),
            codingPlanLabel: format("settings.modelProvider.connectionMode.codingPlan"),
            codingPlanBadgeLabel: format("settings.modelProvider.connectionMode.codingPlanBadge"),
            startPlanLabel: format("settings.modelProvider.connectionMode.startPlan"),
            startPlanBadgeLabel: format("settings.modelProvider.connectionMode.startPlanBadge"),
            teamPlanBadgeLabel: format("settings.modelProvider.connectionMode.teamPlanBadge"),
            teamPlanFallbackLabel: format("settings.modelProvider.connectionMode.teamPlan"),
          }),
    [format, view],
  );
  const providerName = useCallback(
    (providerId: string) =>
      view?.providers.find((provider) => provider.providerId === providerId)?.providerName ??
      undefined,
    [view],
  );

  // The starting point freezes at open: run-state changes while open must not drag the form back.
  const [initial] = useState(() => initialWorkflowRunSettingsDraft(run));
  const [draft, setDraft] = useState<WorkflowRunSettingsDraft>(initial);
  const [pending, setPending] = useState(false);
  const [rejection, setRejection] = useState<WorkflowRunSettingsRejection | undefined>(undefined);
  const ceiling = workflowRunSettingsCeiling(run);
  const change = workflowRunSettingsChange(initial, draft, ceiling);
  const updateDraft = (next: WorkflowRunSettingsDraft) => {
    setDraft(next);
    setRejection(undefined);
  };

  const sessionModelName =
    host.sessionModel === undefined
      ? format("chat.toolCall.workflow.run.settings.model.sessionFallback")
      : formatProviderModelLabel(
          host.sessionModel.providerId,
          providerName(host.sessionModel.providerId),
          host.sessionModel.modelId,
        );
  const sessionBadge = format("chat.toolCall.workflow.run.settings.model.session");
  // Both fields are strings, so this object changes identity only when copy changes; the model selector downstream is memoized.
  const sessionModelItem = useMemo(
    () => ({
      key: "workflow-settings:session-model",
      value: SESSION_MODEL_VALUE,
      name: sessionModelName,
      badgeLabel: sessionBadge,
    }),
    [sessionModelName, sessionBadge],
  );
  const draftModel = draft.model;
  const modelValue =
    draftModel.kind === "session"
      ? SESSION_MODEL_VALUE
      : encodeCustomModelValue(draftModel.providerId, draftModel.modelId);
  const listed = groups.some((group) => group.items.some((item) => item.value === modelValue));
  // The list loaded but this model is gone: deleted or disabled. Apply waits for a new
  // pick — carrying it forward only buys a model_unavailable rejection (the same tool
  // failure, surfaced before the click).
  const unavailable = draftModel.kind === "model" && view !== null && groups.length > 0 && !listed;
  const canonical = workflowRunSettingsModelCanonical(draftModel);
  const triggerLabel =
    draftModel.kind === "session" || canonical === undefined
      ? sessionModelName
      : describeWorkflowSubagentModel(canonical, {
          formatMessage: intl.formatMessage.bind(intl),
          providerName,
        }).name;
  const thoughtOption =
    draftModel.kind === "model" && view !== null && !unavailable
      ? resolveModelThoughtOption({
          modelSelectionView: view,
          providerId: draftModel.providerId,
          modelId: draftModel.modelId,
          ...(draftModel.level === undefined ? {} : { currentValue: draftModel.level }),
        })
      : null;

  const handleModelChange = (value: string) => {
    if (value === SESSION_MODEL_VALUE) {
      updateDraft({ ...draft, model: { kind: "session" } });
      return;
    }
    const picked = parseModelPickerValue(value);
    const same =
      draftModel.kind === "model" &&
      draftModel.providerId === picked.providerId &&
      draftModel.modelId === picked.modelId;
    // Switching models adopts the registry's default level for it (the settings-page subagent rule); the same model keeps the current level.
    const level = same
      ? draftModel.level
      : view === null
        ? undefined
        : completeNewModelSelection(view, picked)?.options?.reasoningLevel;
    updateDraft({
      ...draft,
      model: {
        kind: "model",
        providerId: picked.providerId,
        modelId: picked.modelId,
        ...(level === undefined ? {} : { level }),
      },
    });
  };

  const handleApply = () => {
    if (change === undefined) return;
    setPending(true);
    setRejection(undefined);
    host.apply(change).then(
      (ack) => {
        const next = describeWorkflowRunSettingsRejection(ack);
        if (next !== undefined) {
          logger.warn("[workflow-run] Settings amendment rejected", {
            reasonCode: ack.reasonCode,
            runId: run.runId,
            status: ack.status,
          });
          setRejection(next);
          setPending(false);
          return;
        }
        const result = ack.result;
        if (result?.type === "amendWorkflowRunSettings") {
          onAccepted?.({ runId: result.runId, toolCallId: result.toolCallId });
        }
        onClose();
      },
      (error: unknown) => {
        logger.warn("[workflow-run] Settings amendment failed", { runId: run.runId, error: String(error) });
        setRejection({
          reason: "generic",
          code: error instanceof Error ? error.message : String(error),
        });
        setPending(false);
      },
    );
  };

  const rejectionDetail =
    rejection === undefined ? undefined : workflowRunSettingsRejectionDetail(rejection);
  return (
    <>
      <PopoverTitle>{format("chat.toolCall.workflow.run.settings.title")}</PopoverTitle>
      <WorkflowRunSettingsModelField
        disabled={pending || view === null}
        groups={groups}
        leadingItem={sessionModelItem}
        noCatalog={view !== null && groups.length === 0}
        onLevelChange={(level) => {
          if (draftModel.kind !== "model" || level === draftModel.level) return;
          updateDraft({ ...draft, model: { ...draftModel, level } });
        }}
        onValueChange={handleModelChange}
        thoughtOption={thoughtOption}
        triggerLabel={triggerLabel}
        value={modelValue}
        {...(draftModel.kind === "session"
          ? { badge: { text: sessionBadge, tone: "subtle" as const } }
          : unavailable
            ? {
                badge: {
                  text: format("chat.toolCall.workflow.run.settings.model.unavailable"),
                  tone: "warning" as const,
                },
              }
            : {})}
      />
      <WorkflowRunSettingsBoundField
        bound={draft.bound}
        ceiling={ceiling}
        disabled={pending}
        onChange={(bound) => updateDraft({ ...draft, bound })}
      />
      <p
        className="text-ui-sm text-foreground-subtle"
        data-testid="workflow-run-settings-consequence"
      >
        {format(workflowRunSettingsConsequenceId(run.status, change))}
      </p>
      {rejection === undefined ? null : (
        <div
          className="text-ui-xs text-warning"
          data-testid="workflow-run-settings-rejection"
          role="status"
        >
          <span>
            {format(workflowRunSettingsRejectionMessageId(rejection), {
              code: rejection.code,
              message: rejection.message ?? rejection.code,
            })}
          </span>
          {rejectionDetail === undefined ? null : (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
              {rejectionDetail}
            </pre>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button
          data-testid="workflow-run-settings-apply"
          disabled={change === undefined || pending || unavailable}
          onClick={handleApply}
          size="default"
          type="button"
          variant="default"
        >
          {pending ? <Spinner className="size-3.5" /> : null}
          {format(
            pending
              ? "chat.toolCall.workflow.run.settings.applying"
              : "chat.toolCall.workflow.run.settings.apply",
          )}
        </Button>
      </div>
    </>
  );
}
