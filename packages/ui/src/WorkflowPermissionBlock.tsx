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
  readWorkflowAmendPredecessor,
  readWorkflowAmendScriptInherited,
  readWorkflowAmendTarget,
  readWorkflowMaxConcurrency,
  readWorkflowName,
  readWorkflowSaved,
  readWorkflowScript,
  readWorkflowSubagentModel,
  type WorkflowSavedSource,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  describeWorkflowSubagentModel,
  workflowSubagentModelText,
  workflowSubagentModelTooltip,
} from "@/components/workflow-timeline/subagent-model-label.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isAmendWorkflowToolCall } from "@/lib/workflowToolNames.js";

/**
 * saved-source badge: this run's script comes from a file in the project, not model-written ad hoc.
 *
 * Deliberately one line plus an arguments table, placed ABOVE the timeline: the graph remains the
 * decision subject; provenance and args are the "which script, which params" precondition read
 * first. The badge expresses no trust — invariant 1: saving does not create trust.
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
 * Run confirmation block for CreateWorkflow / AmendWorkflow: header (question + name, right side
 * only `N phases` — no "compiled" lamp, no subagent/step counts) + lineage (amend only) + concurrency
 * cap (only when the user asked) + saved badge + timeline + collapsed script. Deny/Refine/Run come
 * from PermissionDialog.
 *
 * The amend confirmation appears only when the predecessor run belongs to another session (or was
 * stopped by the user): the question becomes "Amend this workflow?" and the lineage line names the
 * target run and whether it is still running.
 *
 * Permission blocks are usually non-collapsible (see PermissionDialog getPermissionBlockInteraction);
 * timeline and name are decision-critical and never collapsed; the script is the audit layer.
 */
export function WorkflowPermissionBlock({
  request,
  workspacePath,
}: {
  request: ZCodePermissionRequest;
  /** Session model roster scope (from PermissionDialog): only used to map provider id to name. */
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();

  // The v4 ask's raw input IS the tool input (product-projection detail: payload.input); share
  // create-workflow.tsx's parsing rules with the chat card so one input is never parsed twice.
  const scriptText = readWorkflowScript(request.raw);
  const workflowName = readWorkflowName(request.raw);
  const saved = readWorkflowSaved(request.raw);
  // Amend is detected by tool name (kind/title carry the v4-ask tool name); lineage applies to amends only.
  const amend = isAmendWorkflowToolCall(request);
  const amendTarget = amend ? readWorkflowAmendTarget(request.raw) : undefined;
  const predecessor = amend ? readWorkflowAmendPredecessor(request.raw) : undefined;
  // The amend keeps the predecessor's script: the input's script is the CLI-backfilled one. Graph
  // and collapsed view still show the script to be run; lineage adds a "script unchanged" note.
  const scriptInherited = amend && readWorkflowAmendScriptInherited(request.raw);
  // Concurrency cap: Create and Amend share the input field, so do not branch by tool name —
  // what is approved is "run with this cap", and both dialogs must say so. By this point the input
  // is clamped by resolveInput, so the number shown is the effective bound.
  const maxConcurrency = readWorkflowMaxConcurrency(request.raw);
  // Subagent model: same family as the cap — a user-supplied condition, and more important to
  // state: approval covers "running these subagents on another model". By here resolveInput has
  // normalized the input, so the id shown is the one actually used. The main agent is unaffected,
  // hence the copy mentions only subagents.
  const subagentModel = readWorkflowSubagentModel(request.raw);
  // The canonical id goes in the tooltip; on screen show model name (plus thinking level when
  // set), using the same composition rule as the model menu.
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

  // An empty graph (no ask/files.* in the script) does not deserve an empty lane; same check as the chat card.
  const display = request.display?.kind === "create_workflow" ? request.display : null;
  const causalityGraph =
    display?.causalityGraph !== undefined && display.causalityGraph.steps.length > 0
      ? display.causalityGraph
      : undefined;
  const hasGraph = causalityGraph !== undefined;
  const model = useMemo(
    () =>
      causalityGraph === undefined ? undefined : buildWorkflowTimeline(causalityGraph, undefined),
    [causalityGraph],
  );

  // With a graph, the script starts collapsed; a zero-step script has no graph to look at, so the code is the only content and starts expanded.
  const [scriptOpen, setScriptOpen] = useState(!hasGraph);

  // PermissionDialog reuses one component instance across requests (resetting only by requestId);
  // return to collapsed-by-default on a new request or the previous expansion leaks into it.
  useEffect(() => {
    setScriptOpen(!hasGraph);
  }, [hasGraph, request.requestId]);

  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const title = intl.formatMessage({
    id: amend ? "chat.permission.workflow.amend.title" : "chat.permission.workflow.title",
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
      {/* Question first: the dialog's generic "permission required" title sits right above, and
          the two lines read as one decision question; the name follows as the timeline's caption. */}
      <WorkflowCardHeader
        detail={detail}
        expanded
        kind={title}
        name={workflowName ?? fallbackName}
      />

      {/* Lineage row (amend only): directly under the name, together forming the "what is being
          changed" header; when the predecessor still runs, add "will be stopped" — approval covers
          stopping a running run, not just new script. */}
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

      {/* Concurrency cap: the model writes this field only when asked, so its presence IS a
          user-imposed condition — a minor fact in the same family as the lineage row, immediately
          after it and before the source badge. Absent means no slot reserved. */}
      {maxConcurrency === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-max-concurrency"
        >
          {intl.formatMessage(
            { id: "chat.permission.workflow.maxConcurrency" },
            { count: String(maxConcurrency) },
          )}
        </p>
      )}

      {/* Subagent model: same family, immediately after — both are user-set run conditions, and
          this one matters more to state: approval covers subagents running on another model. The
          main agent is unaffected. */}
      {describedSubagentModel === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-subagent-model"
          title={workflowSubagentModelTooltip(
            intl.formatMessage.bind(intl),
            describedSubagentModel,
          )}
        >
          {intl.formatMessage(
            { id: "chat.permission.workflow.subagentModel" },
            {
              model: workflowSubagentModelText(
                intl.formatMessage.bind(intl),
                describedSubagentModel,
              ),
            },
          )}
        </p>
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
            {/* Height-capped scroll: long scripts no longer stretch the dialog. */}
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
