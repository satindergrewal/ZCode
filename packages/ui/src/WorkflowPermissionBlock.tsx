import { ChevronRightIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowPhasesDetail } from "@/components/workflow-timeline/timeline-summary.js";
import { WorkflowCardHeader } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import {
  formatWorkflowArgValue,
  isWorkflowAmendPredecessorLive,
  readWorkflowAdjustableSettings,
  readWorkflowAmendPredecessor,
  readWorkflowAmendScriptInherited,
  readWorkflowAmendTarget,
  readWorkflowMaxConcurrency,
  readWorkflowName,
  readWorkflowSaved,
  readWorkflowScript,
  readWorkflowSubagentModel,
  workflowScriptNamesModels,
  type WorkflowSavedSource,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  describeWorkflowSubagentModel,
  workflowSubagentModelText,
  workflowSubagentModelTooltip,
} from "@/components/workflow-timeline/subagent-model-label.js";
import { WorkflowAskSettings } from "@/components/workflow-timeline/WorkflowAskSettingsLines.js";
import { WorkflowAskPlainSettings } from "@/components/workflow-timeline/WorkflowAskSettingsParts.js";
import type { WorkflowAskSettingsContent } from "@/components/workflow-timeline/workflowAskSettings.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isAmendWorkflowToolCall, isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";
import { readWorkflowHoleTarget } from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { narrowTimelineToFill } from "@/components/workflow-timeline/timeline-holes.js";
import { WorkflowPermissionHoles } from "@/WorkflowPermissionHoles.js";

/**
 * Saved-source badge: this run's script comes from a file in the repo, not model-written inline.
 *
 * Deliberately one line plus an args table, above the timeline: the graph is the decision; source and args are the
 * prerequisite facts (which script, which args) read before it. The badge expresses no trust -- invariant 1: saving grants none.
 */
function WorkflowSavedSourceBadge({ saved }: { saved: WorkflowSavedSource }) {
  const { intl } = useZCodeIntl();

  const savedLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.badge" });
  const scopeLabel =
    saved.scope === "project"
      ? intl.formatMessage({ id: "chat.permission.workflow.saved.scope.project" })
      : saved.scope;
  const argsLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.args" });
  const argEntries = Object.entries(saved.args);

  return (
    <div
      className="space-y-1.5 rounded-lg border border-border bg-surface px-2.5 py-2"
      data-workflow-saved-source="true"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 text-ui-sm font-medium text-foreground-subtle">
          {scopeLabel === undefined ? savedLabel : `${savedLabel} · ${scopeLabel}`}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtlest"
          data-workflow-saved-name="true"
          title={saved.path ?? saved.name}
        >
          {saved.name}
        </span>
      </div>

      {saved.path === undefined ? null : (
        <p
          className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
          data-workflow-saved-path="true"
          title={saved.path}
        >
          {saved.path}
        </p>
      )}

      {argEntries.length === 0 ? null : (
        <dl
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 pt-0.5"
          data-workflow-saved-args="true"
          aria-label={argsLabel}
        >
          {argEntries.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="font-mono text-ui-sm text-foreground-subtlest">{key}</dt>
              <dd className="min-w-0 break-words font-mono text-ui-sm text-foreground-subtle">
                {formatWorkflowArgValue(value)}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * The CreateWorkflow / AmendWorkflow run confirmation block (docs/dynamic-workflow/presentation.md, the confirmation window): header (question +
 * name; trailing N phases only -- no compiled light and no subagent/step counts since 2026-09-09) + lineage (amends only) + two run
 * settings (model above, cap below; values inline-editable when the agent backfilled adjustable_settings) + saved badge + timeline + folded script.
 * Deny / Refine / Stay with PermissionDialog; edited settings return via onSettingsChange and ride the Allow reply.
 *
 * The amend confirmation appears only when the predecessor is another session's run (or one the user stopped): the question becomes amend-this-workflow, and the lineage line names the run and whether it still runs.
 *
 * Permission blocks usually forbid collapsing (see PermissionDialog getPermissionBlockInteraction); timeline and name
 * are decision-critical and uncollapsible; the script is the audit layer.
 */
export function WorkflowPermissionBlock({
  onSettingsBlockedChange,
  onSettingsChange,
  remoteSessionId,
  request,
  sessionModel,
  settingsDisabled = false,
  workspaceIdentity,
  workspacePath,
}: {
  /** The chosen subagent model is unavailable: Allow waits for a swap. */
  onSettingsBlockedChange?: (blocked: boolean) => void;
  /** User-edited settings: changed fields only; all-reverted means undefined. */
  onSettingsChange?: (content: WorkflowAskSettingsContent | undefined) => void;
  remoteSessionId?: string;
  request: ZCodePermissionRequest;
  /** The session model row's name. */
  sessionModel?: { providerId: string; modelId: string };
  /** Reply in flight: controls and options disabled together. */
  settingsDisabled?: boolean;
  workspaceIdentity?: string;
  /** Session model-list scope (from PermissionDialog): source for the model menu and provider name. */
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();

  // The v4 ask's raw input is the tool input (product-projection detail: payload.input),
  // shared with the chat card's create-workflow.tsx readers so the same input is never parsed twice.
  const scriptText = readWorkflowScript(request.raw);
  const workflowName = readWorkflowName(request.raw);
  const saved = readWorkflowSaved(request.raw);
  // Amend by tool name (kind/title carry the v4 ask's tool name); lineage is amend-only.
  const amend = isAmendWorkflowToolCall(request);
  // Hole-fill confirmation (docs/dynamic-workflow/launch.md, Approval): the question becomes fill-this-hole; the timeline
  // draws the fill's draft stage line (new site between ghosted neighbors). Name/type arrive in the input's hole block.
  const fill = isFillWorkflowHoleToolCall(request);
  const holeTarget = fill ? readWorkflowHoleTarget(request.raw) : undefined;
  const amendTarget = amend ? readWorkflowAmendTarget(request.raw) : undefined;
  const predecessor = amend ? readWorkflowAmendPredecessor(request.raw) : undefined;
  // This amend inherits the predecessor's script:
  // the input's script is the CLI-backfilled copy -- graph and fold still show the would-run script; lineage adds script-unchanged.
  const scriptInherited = amend && readWorkflowAmendScriptInherited(request.raw);
  // Concurrency cap: Create and Amend share one input field, so no per-tool split --
  // approval means run-with-this-cap and both windows must say it. The value here
  // is post-resolveInput clamp: the number on the window is the effective bound.
  const maxConcurrency = readWorkflowMaxConcurrency(request.raw);
  // Subagent model: a user-stated condition like the cap,
  // and more worth stating -- approval means these subagents run on another model. resolveInput
  // already canonicalized it, so the id shown is the one used. The lead agent is untouched, hence subagents-only copy.
  const subagentModel = readWorkflowSubagentModel(request.raw);
  // The agent says which adjustments this host applies (docs/dynamic-workflow/launch.md, adjusting
  // settings in the window); absent (old agent) renders only caller-set fields as text -- no editable fields the agent would drop.
  const adjustable = readWorkflowAdjustableSettings(request.raw);
  // The model list needs its scope to read; without it the model row degrades to text, the cap stays editable.
  const hasModelScope = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  // Canonical ids stay in the tooltip: on-screen shows the model name (plus thinking level when needed), same rules as the model menu.
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(workspacePath);
  const describedSubagentModel = useMemo(
    () =>
      subagentModel === undefined
        ? undefined
        : describeWorkflowSubagentModel(subagentModel, {
            formatMessage: intl.formatMessage.bind(intl),
            ...(subagentModelProviderName === undefined
              ? {}
              : { providerName: subagentModelProviderName }),
          }),
    [intl, subagentModel, subagentModelProviderName],
  );

  // An empty graph (no ask / files.* in the script) earns no empty track; same rule as the chat card.
  const display = request.display?.kind === "create_workflow" ? request.display : null;
  const causalityGraph =
    display?.causalityGraph !== undefined && display.causalityGraph.steps.length > 0
      ? display.causalityGraph
      : undefined;
  const hasGraph = causalityGraph !== undefined;
  const holeId = holeTarget?.holeId;
  const holeName = holeTarget?.name;
  const model = useMemo(() => {
    if (causalityGraph === undefined) return undefined;
    if (holeId === undefined) return buildWorkflowTimeline(causalityGraph, undefined);
    const labels = new Map(holeName === undefined ? [] : [[holeId, { name: holeName }]]);
    const whole = buildWorkflowTimeline(causalityGraph, undefined, labels);
    return narrowTimelineToFill(whole, holeId) ?? whole;
  }, [causalityGraph, holeId, holeName]);

  // With a graph the script starts collapsed; a zero-step script has no graph, the code is the whole content: expanded.
  const [scriptOpen, setScriptOpen] = useState(!hasGraph);

  // PermissionDialog reuses one component instance across requests (resetting state per requestId),
  // so a new request must return to the default fold, or the last expansion leaks into the next workflow.
  useEffect(() => {
    setScriptOpen(!hasGraph);
  }, [hasGraph, request.requestId]);

  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const title = intl.formatMessage({
    id: fill
      ? "chat.permission.workflow.hole.title"
      : amend
        ? "chat.permission.workflow.amend.title"
        : "chat.permission.workflow.title",
  });
  const amendsLabel = intl.formatMessage({ id: "chat.permission.workflow.amends" });
  const stillRunningLabel = intl.formatMessage({ id: "chat.permission.workflow.amends.running" });
  const scriptUnchangedLabel = intl.formatMessage({
    id: "chat.permission.workflow.amends.scriptUnchanged",
  });
  const scriptToggleLabel = intl.formatMessage({
    id: scriptOpen ? "chat.permission.workflow.hideScript" : "chat.permission.workflow.showScript",
  });
  const detail =
    model === undefined
      ? undefined
      : workflowPhasesDetail(intl.formatMessage.bind(intl), model, causalityGraph);

  return (
    <div className="space-y-3" data-workflow-permission-block="true">
      {/* The question leads: the dialog's Needs-permission title sits directly above; the two lines read as one decision ask.
          The name follows as the title of the timeline below. */}
      <WorkflowCardHeader
        detail={detail}
        expanded
        kind={title}
        name={fill ? (holeName ?? holeId ?? fallbackName) : (workflowName ?? fallbackName)}
      />

      {/* Hole row (docs/dynamic-workflow/presentation.md, holes on the timeline): open holes and their types,
          plus one line: running pauses at holes. */}
      <WorkflowPermissionHoles holes={causalityGraph?.holes} />

      {/* Lineage row (amends only): glued to the name, together the what-changes header; while the predecessor
          still runs it adds will-be-stopped -- approval covers stopping a live run, not just new script. */}
      {amendTarget === undefined ? null : (
        <div
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
          data-workflow-amends="true"
          {...(isWorkflowAmendPredecessorLive(predecessor)
            ? { "data-workflow-amends-live": "true" }
            : {})}
          {...(scriptInherited ? { "data-workflow-amends-script-inherited": "true" } : {})}
        >
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">{amendsLabel}</span>
          <span
            className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
            title={amendTarget}
          >
            {amendTarget}
          </span>
          {scriptInherited ? (
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">
              · {scriptUnchangedLabel}
            </span>
          ) : null}
          {isWorkflowAmendPredecessorLive(predecessor) ? (
            <span className="shrink-0 text-ui-xs text-warning">· {stillRunningLabel}</span>
          ) : null}
        </div>
      )}

      {/* Two run settings: kin to the lineage row, what constrains this run; immediately after, before the saved badge.
          When adjustable both sentences always show (unstated edits still say what will happen); remount per requestId resets to the new input. */}
      {adjustable === undefined ? (
        <WorkflowAskPlainSettings
          maxConcurrency={maxConcurrency}
          scriptNamesModels={workflowScriptNamesModels(request.raw)}
          subagentModel={
            describedSubagentModel === undefined
              ? undefined
              : {
                  text: workflowSubagentModelText(
                    intl.formatMessage.bind(intl),
                    describedSubagentModel,
                  ),
                  tooltip: workflowSubagentModelTooltip(
                    intl.formatMessage.bind(intl),
                    describedSubagentModel,
                  ),
                }
          }
        />
      ) : (
        <WorkflowAskSettings
          key={request.requestId}
          adjustable={{
            ...adjustable,
            subagentModel: adjustable.subagentModel && hasModelScope,
          }}
          disabled={settingsDisabled}
          input={request.raw}
          scope={{
            workspacePath: workspacePath ?? "",
            ...(workspaceIdentity === undefined ? {} : { workspaceIdentity }),
            ...(remoteSessionId === undefined ? {} : { remoteSessionId }),
            ...(sessionModel === undefined ? {} : { sessionModel }),
          }}
          {...(onSettingsChange === undefined ? {} : { onContentChange: onSettingsChange })}
          {...(onSettingsBlockedChange === undefined
            ? {}
            : { onBlockedChange: onSettingsBlockedChange })}
        />
      )}

      {saved ? <WorkflowSavedSourceBadge saved={saved} /> : null}

      {model === undefined ? null : <WorkflowTimeline className="py-1" model={model} />}

      {scriptText ? (
        <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
          <CollapsibleTrigger className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle">
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 transition-transform", scriptOpen && "rotate-90")}
            />
            <span className="min-w-0 truncate">{scriptToggleLabel}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            {/* Height-capped scroll: long scripts no longer inflate the dialog. */}
            <div className="max-h-72 overflow-auto" data-testid="workflow-script-scroll">
              <CodeBlock
                code={scriptText}
                language="typescript"
                renderMermaid={false}
                showLineNumbers
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
