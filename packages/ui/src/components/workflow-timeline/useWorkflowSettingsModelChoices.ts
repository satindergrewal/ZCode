// ============================================================
// The subagent-model chooser: shared by the Configure popover and the confirmation window.
// ============================================================
// docs/dynamic-workflow/presentation.md「The settings popover」「The confirmation window」。
//
// Extracted from WorkflowRunSettingsPopover.tsx: two places choosing the same thing (which model the
// subagents run on) must share one list (the composer's model menu, session model first), one trigger copy,
// and one take-the-default-level-on-switch rule. Duplicated copies would eventually diverge between
// window and popover.

import { useCallback, useMemo } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import { ZCODE_AGENT_PROVIDER, type ZCodeConfigOption } from "@zcode/shared";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import { formatProviderModelLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { describeWorkflowSubagentModel } from "./subagent-model-label.js";
import {
  workflowRunSettingsModelCanonical,
  type WorkflowRunSettingsModel,
} from "./workflowRunSettings.js";

/** Value of the menu's session-model entry: outside encodeCustomModelValue's range, so it cannot collide with a real model. */
const SESSION_MODEL_VALUE = "workflow-settings:session-model";

/** Model catalog scope and session model: provided by the host. */
export interface WorkflowSettingsModelScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** The session's current model (first entry and trigger use its name); absent, the first entry just reads "session model". */
  sessionModel?: { providerId: string; modelId: string };
}

/** A model choice as it appears on screen. */
export interface WorkflowSettingsModelFace {
  /** Menu value (the session model is a sentinel). */
  value: string;
  /** Name on the trigger: the session model's name, or a human reading of the canonical string. */
  triggerLabel: string;
  /** The loaded catalog does not contain it: deleted or disabled. */
  unavailable: boolean;
  /** Its thinking level; null with no levels (or none usable). */
  thoughtOption: ZCodeConfigOption | null;
}

export function useWorkflowSettingsModelChoices(scope: WorkflowSettingsModelScope) {
  const { intl } = useZCodeIntl();
  const format = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const modelRead = useModelSelectionView(
    scope.workspacePath,
    scope.remoteSessionId,
    scope.workspaceIdentity,
  );
  const view = modelRead.state.status === "ready" ? modelRead.state.view : null;
  const groups: ModelSelectGroup[] = useMemo(
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

  const sessionModel = scope.sessionModel;
  const sessionModelName =
    sessionModel === undefined
      ? format("chat.toolCall.workflow.run.settings.model.sessionFallback")
      : formatProviderModelLabel(
          sessionModel.providerId,
          providerName(sessionModel.providerId),
          sessionModel.modelId,
        );
  const sessionBadge = format("chat.toolCall.workflow.run.settings.model.session");
  // Both fields are strings, so the entry gets a new reference only when the copy changes; the downstream model selector is memoized.
  const sessionModelItem: ModelSelectGroupItem = useMemo(
    () => ({
      key: "workflow-settings:session-model",
      value: SESSION_MODEL_VALUE,
      name: sessionModelName,
      badgeLabel: sessionBadge,
    }),
    [sessionModelName, sessionBadge],
  );

  const describe = useCallback(
    (model: WorkflowRunSettingsModel): WorkflowSettingsModelFace => {
      const value =
        model.kind === "session"
          ? SESSION_MODEL_VALUE
          : encodeCustomModelValue(model.providerId, model.modelId);
      const listed = groups.some((group) => group.items.some((item) => item.value === value));
      // The catalog loaded but does not contain this model: deleted or disabled. Wait for the user to pick
      // another — carrying it forward only earns a model_unavailable from the agent (the same tool failure
      // "carried-over model unavailable", surfaced before the click).
      const unavailable = model.kind === "model" && view !== null && groups.length > 0 && !listed;
      const canonical = workflowRunSettingsModelCanonical(model);
      const triggerLabel =
        model.kind === "session" || canonical === undefined
          ? sessionModelName
          : describeWorkflowSubagentModel(canonical, {
              formatMessage: intl.formatMessage.bind(intl),
              providerName,
            }).name;
      const thoughtOption =
        model.kind === "model" && view !== null && !unavailable
          ? resolveModelThoughtOption({
              modelSelectionView: view,
              providerId: model.providerId,
              modelId: model.modelId,
              ...(model.level === undefined ? {} : { currentValue: model.level }),
            })
          : null;
      return { value, triggerLabel, unavailable, thoughtOption };
    },
    [groups, intl, providerName, sessionModelName, view],
  );

  /** Menu selection to a new model choice. A new model takes the registry default level; the same model keeps the current one. */
  const pick = useCallback(
    (value: string, current: WorkflowRunSettingsModel): WorkflowRunSettingsModel => {
      if (value === SESSION_MODEL_VALUE) return { kind: "session" };
      const picked = parseModelPickerValue(value);
      const same =
        current.kind === "model" &&
        current.providerId === picked.providerId &&
        current.modelId === picked.modelId;
      const level = same
        ? current.level
        : view === null
          ? undefined
          : completeNewModelSelection(view, picked)?.options?.reasoningLevel;
      return {
        kind: "model",
        providerId: picked.providerId,
        modelId: picked.modelId,
        ...(level === undefined ? {} : { level }),
      };
    },
    [view],
  );

  return {
    /** Catalog not loaded yet (fields stay disabled until it is). */
    loading: view === null,
    /** Catalog loaded but empty: the model field degrades to a sentence. */
    noCatalog: view !== null && groups.length === 0,
    groups,
    providerName,
    sessionBadge,
    sessionModelItem,
    sessionModelName,
    describe,
    pick,
  };
}
