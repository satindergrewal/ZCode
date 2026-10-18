import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";
import type {
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";
import { workflowCardDetail } from "@/components/workflow-timeline/timeline-summary.js";
import {
  WORKFLOW_CARD_ICON,
  WorkflowCardFooter,
  WorkflowCardHeader,
  WorkflowRunStatus,
  WorkflowStaticStatus,
  workflowRunKindMessageId,
} from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { isAmendWorkflowToolCall } from "@/lib/workflowToolNames.js";
import {
  useWorkflowCardModel,
  useWorkflowHoleRow,
  useWorkflowRowPrimaryText,
} from "@/ToolCallBlocks/renderers/workflow-fill-row.js";
import {
  isPlainRecord,
  readWorkflowAmendTarget,
  readWorkflowCardKeptScript,
  readWorkflowKindMessageId,
  readWorkflowName,
  readWorkflowPrelaunchKindMessageId,
  readWorkflowRetuneCall,
  readWorkflowSaved,
  readWorkflowScript,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
export { readWorkflowKindMessageId } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  readFallbackOutputText,
  readWorkflowDisplay,
} from "@/ToolCallBlocks/renderers/createWorkflowDisplay.js";
import {
  WorkflowAmendsLine,
  WorkflowCardMetaLine,
} from "@/ToolCallBlocks/renderers/WorkflowCardMetaLine.js";
import { WorkflowDiagnosticsSection } from "@/ToolCallBlocks/renderers/workflow-diagnostics.js";
import {
  useWorkflowDraftRowSlots,
  WorkflowFeedbackContent,
} from "@/ToolCallBlocks/renderers/workflow-draft-row.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

/** Empty diagnostics for the draft slot when display is absent: module-level constant, so a per-render array cannot thrash memoization. */
const NO_DIAGNOSTICS: readonly never[] = [];

/** Expanded state remembered per toolId (same pattern as ToolLayout's toolLayoutOpenState); expanded by default. */
const workflowCardOpenState = new Map<string, boolean>();

/**
 * The chat CreateWorkflow / AmendWorkflow tool card.
 *
 * While writing, a non-expandable ToolLayout with a permanent draft stage line under the row (sites stream in with the script); awaiting confirmation, a ToolLayout with expandable script; compile errors render the
 * compile-feedback row (workflow draft, draft n, n fixes pending, not run) -- not a failure: nothing ran yet.
 * Rows with a linked v4 run are carried by WorkflowToolSummary; this component keeps the legacy-host running card.
 *
 * AmendWorkflow rows share the **same** renderer (display kind is also `create_workflow`; graph, draft pen and diagnostics card have one
 * implementation), swap in the amend wording, and add one card row, amended from run X -- decided by tool name, not family.
 */
export function CreateWorkflowToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const amend = isAmendWorkflowToolCall(toolCall);
  const amendTarget = amend ? readWorkflowAmendTarget(toolCall.input) : undefined;
  // Hole-fill rows (docs/dynamic-workflow/presentation.md "The fill row"): same renderer, hole vocabulary (workflow-fill-row.tsx).
  const { fill, holeTarget, vocabulary } = useWorkflowHoleRow(toolCall, amend);

  const display = useMemo(() => readWorkflowDisplay(toolCall.raw), [toolCall.raw]);
  // In-flight wording (docs/dynamic-workflow/concurrency.md): a cap-only call writes no script and compiles nothing, so
  // validating-the-workflow does not apply. Collapsing into a settings row is a **post-settlement** concern, shaped by the wiring layer from the same input
  // (ConversationRowView); this row owns only the in-flight wording.
  const retuning = amend && readWorkflowRetuneCall(toolCall.input) !== undefined;
  const scriptText = useMemo(() => readWorkflowScript(toolCall.input), [toolCall.input]);
  const workflowName = readWorkflowName(toolCall.input);
  const saved = useMemo(() => readWorkflowSaved(toolCall.input), [toolCall.input]);
  const fallbackOutputText = display ? null : readFallbackOutputText(toolCall.output);
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const name = fill
    ? (holeTarget?.name ?? holeTarget?.holeId ?? fallbackName)
    : (workflowName ?? fallbackName);

  const workflowRun = context.workflowRun;
  const run = workflowRun?.run;
  const hasCompileErrors = display?.ok === false;
  const showFailureStatus = hasCompileErrors || (!display && toolCall.status === "failed");
  const draft = context.workflowDraft;

  // An empty graph (no ask / files.* anywhere in the script) does not deserve an empty track; build the model only once a step exists.
  const graph =
    display?.causalityGraph !== undefined && display.causalityGraph.steps.length > 0
      ? display.causalityGraph
      : undefined;
  const v4Status = isPlainRecord(toolCall.raw) ? toolCall.raw.v4Status : undefined;
  const writing = context.isRunning && v4Status === "inputStreaming";
  // Amend inheriting the predecessor's script: the row input is the model-sent
  // copy; neither `script` nor `path` means the script is omitted (a `path` amend carries no `script` yet is a changed script)
  // -- only say so once the input is complete; the script may still be streaming. A missing script is this
  // call's intent: the lineage row says the script is unchanged, so no no-script-provided notice appears.
  const keptScript = amend && !writing && readWorkflowCardKeptScript(toolCall);
  const inFlight = context.isRunning && workflowRun === undefined;
  const draftSlots = useWorkflowDraftRowSlots({
    draft,
    compileErrors: hasCompileErrors,
    inFlight,
    errorCount: display?.errorCount ?? 0,
    diagnostics: display?.diagnostics ?? NO_DIAGNOSTICS,
    saved: saved !== undefined,
  });

  // Graph when present (fill rows narrowed to their segment), draft scan while streaming; display replaces the whole model on arrival.
  const model = useWorkflowCardModel({ graph, holeTarget, run, scriptText, writing });

  const [isOpen, setIsOpen] = useState(() => workflowCardOpenState.get(toolCall.toolId) ?? true);
  const forceOpen = context.forceOpen ?? false;
  const canToggle = context.canToggle ?? true;
  const expanded = forceOpen || !canToggle || isOpen;
  const handleToggle = useCallback(() => {
    setIsOpen((previous) => {
      workflowCardOpenState.set(toolCall.toolId, !previous);
      return !previous;
    });
  }, [toolCall.toolId]);
  const [scriptOpen, setScriptOpen] = useState(false);

  const onOpenWorkflowRun = context.onOpenWorkflowRun;
  const named = useMemo(() => (workflowName === undefined ? {} : { workflowName }), [workflowName]);
  const handleOpenRunDetails = useCallback(
    () => onOpenWorkflowRun?.(named),
    [onOpenWorkflowRun, named],
  );
  // The site header and the n-more row hand out the site id: the detail page lands on that site with the list expanded.
  const handleSelectStation = useCallback(
    (station: TimelineStation) => onOpenWorkflowRun?.({ ...named, phaseId: station.id }),
    [onOpenWorkflowRun, named],
  );
  const onResumeWorkflowRun = context.onResumeWorkflowRun;
  const handleResume = useCallback(() => {
    onResumeWorkflowRun?.(workflowName === undefined ? {} : { workflowName });
  }, [onResumeWorkflowRun, workflowName]);
  // Clicking a pill opens that subagent's transcript. The card hands over slot identity only
  // (not-yet-started pills open too, session id when known); session and workspace identity are completed by the host.
  const onOpenWorkflowActor = context.onOpenWorkflowActor;
  const onOpenWorkflowWorkspace = context.onOpenWorkflowWorkspace;
  const onOpenWorkflowArtifact = context.onOpenWorkflowArtifact;
  const runId = workflowRun?.runId;
  // Script pill: hands over this site's phase id; run and session
  // identity are host-bound (same path as onOpenWorkflowRun).
  const handleOpenWorkspace = useCallback(
    (pill: TimelinePill) => {
      const phaseId = pill.workspace?.phaseId;
      if (phaseId === undefined) return;
      onOpenWorkflowWorkspace?.({
        phaseId,
        ...(workflowName === undefined ? {} : { workflowName }),
      });
    },
    [onOpenWorkflowWorkspace, workflowName],
  );
  const handleOpenPill = useCallback(
    (pill: TimelinePill) => {
      const slot = pill.slot;
      if (runId === undefined || slot === undefined) return;
      const sessionId = pill.instance?.sessionId;
      const actorName = pill.runtimeName ?? pill.lane.name;
      onOpenWorkflowActor?.({
        ordinal: slot.ordinal,
        runId,
        siteId: slot.siteId,
        ...(sessionId === undefined ? {} : { actorSessionId: sessionId }),
        ...(actorName === undefined ? {} : { actorName }),
      });
    },
    [onOpenWorkflowActor, runId],
  );

  // ToolLayout is memoized: nodes and callbacks handed to it must be referentially stable (reactStableReferences guard).
  const diagnosticsPrimaryText = useWorkflowRowPrimaryText(fill, name);
  const renderDiagnosticsContent = useCallback(
    () => (
      <WorkflowFeedbackContent
        display={display}
        fallbackOutputText={fallbackOutputText}
        saved={saved !== undefined}
        scriptText={scriptText}
      />
    ),
    [display, fallbackOutputText, saved, scriptText],
  );

  const snapshotNotice = (
    <ToolSnapshotFieldNotice
      refs={toolCall.snapshotRefs ?? []}
      onLoadFullToolCallFields={
        context.onLoadFullToolCallFields
          ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
          : undefined
      }
    />
  );

  // Compile errors: the compile-feedback row. Failure without display: the failure summary. On the compile-error path the handler returns diagnostics directly instead of starting the engine,
  // so there should be no run at all -- even a host-joined one stays on the feedback row; diagnostics-first is pinned here, not left to callers.
  // Pre-launch reuses the plain summary: no partial script while writing; the final script is expandable once awaiting confirmation.
  const prelaunch = workflowRun === undefined && (writing || v4Status === "pendingApproval");
  const summaryOnly = writing && !showFailureStatus;
  // The writing row is not expandable, but the draft stage line stays under the row (not expandable content, no collapse entry):
  // sites are written verbatim by the pen; once display arrives the model becomes the analyzer's sites and this block leaves with the writing phase.
  const draftTimelineBlock =
    summaryOnly && model?.draft !== undefined ? (
      <div className="pt-2" data-testid="workflow-draft-timeline">
        <WorkflowTimeline className="py-1" model={model} />
      </div>
    ) : null;
  if (showFailureStatus || prelaunch) {
    return (
      <>
        <ToolLayout
          toolId={toolCall.toolId}
          icon={WORKFLOW_CARD_ICON}
          showIcon={context.showIcon !== false}
          canToggle={!summaryOnly && canToggle}
          forceOpen={!summaryOnly && forceOpen}
          kindLabel={
            context.kindLabelOverride ??
            intl.formatMessage({
              id: readWorkflowPrelaunchKindMessageId(
                {
                  compileErrors: hasCompileErrors,
                  failed: showFailureStatus,
                  writing,
                  revising: (draft?.ordinal ?? 1) >= 2,
                },
                vocabulary,
              ),
            })
          }
          sourceLabel={context.sourceLabel}
          primaryText={diagnosticsPrimaryText}
          // The draft number stays on the row while expanded: it states which draft this is, not a collapsed summary.
          secondaryText={draftSlots.secondaryText}
          statusLabel={draftSlots.statusLabel ?? context.statusLabel}
          statusIndicator={draftSlots.statusIndicator}
          statusTooltip={draftSlots.statusTooltip ?? context.errorText}
          showFailureStatus={showFailureStatus}
          // Awaiting confirmation is still inside the launch flow; share the sweep with the writing state so it does not look finished.
          isRunning={showFailureStatus ? context.isRunning : prelaunch}
          title={toolCall.title}
          renderContent={summaryOnly ? undefined : renderDiagnosticsContent}
        />
        {draftTimelineBlock}
        {snapshotNotice}
      </>
    );
  }

  // With a run linked, the kind wording follows the run state (legacy-host running card); amend rows keep amend wording until the run appears.
  const kindId =
    workflowRun !== undefined
      ? workflowRunKindMessageId(workflowRun)
      : readWorkflowKindMessageId(toolCall.raw, context.isRunning, vocabulary, retuning);
  const kindText = context.kindLabelOverride ?? intl.formatMessage({ id: kindId });
  // Kind wording follows the copy (writing, awaiting, running); the swap animation is wrapped by the header itself, see WorkflowCardHeader.
  const live = workflowRun !== undefined ? workflowRun.status === "running" : context.isRunning;
  const status =
    workflowRun !== undefined ? (
      <WorkflowRunStatus run={workflowRun} testId="workflow-card-status" />
    ) : display?.ok === true ? (
      <WorkflowStaticStatus word={intl.formatMessage({ id: "chat.toolCall.workflow.compiled" })} />
    ) : undefined;
  // The detail string, its tooltip (incl. subagent model names) and the v4 round-tail summary share one implementation. This render path has no
  // session model list (the tool-card layer does not touch stores), so custom provider names cannot be resolved -- fall back
  // to the bare modelId per the same rule, never the providerId.
  const cardDetail = workflowCardDetail(intl.formatMessage.bind(intl), model, graph, run);
  // While validating (in flight, no graph yet) the detail slot shows the draft number from the second draft on, so the validating hop between writing and feedback never flashes empty.
  const headerDetail = cardDetail?.detail ?? draftSlots.inFlightOrdinalText;
  const terminal = run !== undefined && (run.status === "errored" || run.status === "stopped");
  const resume =
    workflowRun?.resumable === true && onResumeWorkflowRun !== undefined ? (
      <Button
        className="ml-auto"
        data-testid="workflow-card-resume"
        onClick={handleResume}
        size="sm"
        type="button"
        variant="outline"
      >
        <RotateCcwIcon className="size-3.5" />
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.resume" })}
      </Button>
    ) : undefined;
  const savedSourceLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.badge" });
  const savedScopeProjectLabel = intl.formatMessage({
    id: "chat.permission.workflow.saved.scope.project",
  });
  const showScriptFold = workflowRun === undefined && !writing && scriptText !== undefined;

  return (
    <>
      <section
        aria-label={typeof kindText === "string" ? kindText : undefined}
        className="wf-motion flex w-full min-w-0 flex-col gap-2"
        data-testid="workflow-card"
        data-workflow-card-state={workflowRun?.status ?? (writing ? "writing" : "static")}
        {...(workflowRun === undefined
          ? {}
          : {
              "data-workflow-run-id": workflowRun.runId,
              "data-workflow-run-status": workflowRun.status,
            })}
      >
        <WorkflowCardHeader
          detail={headerDetail}
          {...(cardDetail?.title === undefined ? {} : { detailTitle: cardDetail.title })}
          expanded={expanded}
          kind={kindText}
          live={live}
          name={name}
          status={status}
          {...(onOpenWorkflowRun === undefined ? {} : { onOpenDetails: handleOpenRunDetails })}
          {...(forceOpen || !canToggle ? {} : { onToggle: handleToggle })}
        />

        {expanded ? (
          <div className="wf-unfold flex min-w-0 flex-col gap-2" data-testid="workflow-card-body">
            {amendTarget === undefined ? null : (
              <WorkflowAmendsLine runId={amendTarget} scriptInherited={keptScript} />
            )}
            {saved ? (
              <WorkflowCardMetaLine
                marker="saved-source"
                label={
                  saved.scope === "project"
                    ? `${savedSourceLabel} · ${savedScopeProjectLabel}`
                    : savedSourceLabel
                }
                value={saved.name}
                title={saved.path ?? saved.name}
              />
            ) : null}

            {model === undefined ? null : (
              <WorkflowTimeline
                className="py-1"
                model={model}
                {...(onOpenWorkflowRun === undefined
                  ? {}
                  : { onOpenMore: handleSelectStation, onSelectStation: handleSelectStation })}
                {...(onOpenWorkflowActor === undefined || run === undefined
                  ? {}
                  : { onOpenPill: handleOpenPill })}
                {...(onOpenWorkflowWorkspace === undefined || run === undefined
                  ? {}
                  : { onOpenWorkspace: handleOpenWorkspace })}
              />
            )}

            {/* Artifact strip (the artifact pills): what the run delivered, up to 3 + N; the full list on the detail side pane. */}
            {run?.artifacts !== undefined && run.artifacts.length > 0 ? (
              <WorkflowArtifactStrip
                artifacts={run.artifacts}
                className="px-1 pb-0.5"
                moreTestId="workflow-card-artifacts-more"
                pillTestId="workflow-card-artifact"
                testId="workflow-card-artifacts"
                {...(onOpenWorkflowArtifact === undefined
                  ? {}
                  : { onOpenArtifact: onOpenWorkflowArtifact })}
              />
            ) : null}

            {graph?.truncated === true ? (
              <p className="text-ui-xs text-foreground-subtlest">
                {intl.formatMessage({ id: "chat.toolCall.workflow.graph.truncated" })}
              </p>
            ) : null}

            {display && display.diagnostics.length > 0 ? (
              <WorkflowDiagnosticsSection
                count={display.errorCount}
                diagnostics={display.diagnostics}
                saved={saved !== undefined}
                truncated={display.truncated}
              />
            ) : null}

            {!display && fallbackOutputText ? (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-panel px-3 py-2 font-mono text-ui-base text-foreground-subtle">
                {fallbackOutputText}
              </pre>
            ) : null}

            {!scriptText && !keptScript && !display && !fallbackOutputText && !context.isRunning ? (
              <p className="font-mono text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "chat.toolCall.workflow.noScript" })}
              </p>
            ) : null}

            {showScriptFold ? (
              // No run means no detail-page Script section; the script text is readable only here. Collapsed by default, matching the approval dialog.
              <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
                <CollapsibleTrigger
                  className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle"
                  data-testid="workflow-card-script-toggle"
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 shrink-0 transition-transform",
                      scriptOpen && "rotate-90",
                    )}
                  />
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({
                      id: scriptOpen
                        ? "chat.permission.workflow.hideScript"
                        : "chat.permission.workflow.showScript",
                    })}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-1.5">
                  <div className="max-h-72 overflow-auto">
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
        ) : null}

        {/* Footer: always present expanded; collapsed, only terminal states (failed / cancelled) leave one -- Resume must stay reachable. */}
        {/* The footer used to be the summary row (subagents, steps, tokens, rounds, artifacts); since 2026-09-09 the card states phase and
            subagents in the header -- the footer is only the Resume anchor; no Resume, no footer. */}
        {resume !== undefined && run !== undefined && (expanded || terminal) ? (
          <WorkflowCardFooter status={run.status} trailing={resume} />
        ) : null}
      </section>
      {snapshotNotice}
    </>
  );
}
