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
import { draftTimeline, scanWorkflowDraft } from "@/components/workflow-timeline/draft-scan.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";
import {
  buildWorkflowTimeline,
  type TimelinePill,
  type TimelineStation,
  type WorkflowTimelineModel,
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

/** Empty diagnostics for the draft slots when display is absent: module-level constant so a fresh array never breaks memoization. */
const NO_DIAGNOSTICS: readonly never[] = [];

/** Collapsed state keyed by toolId (same pattern as ToolLayout's toolLayoutOpenState); expanded by default. */
const workflowCardOpenState = new Map<string, boolean>();

/**
 * The CreateWorkflow / AmendWorkflow chat-card renderer.
 *
 * While writing: non-expandable ToolLayout with a permanent draft stage line under the row
 * (stations stream out with the script). Awaiting confirmation: ToolLayout with expandable script.
 * Compile failure: the compile-feedback row ("workflow draft - draft n - n fixes - not run") -
 * not a failure; nothing ran yet. For v4 runs already joined, the row above is owned by
 * WorkflowToolSummary; this component keeps the legacy-host run card.
 *
 * AmendWorkflow rows run through the **same** renderer (same `create_workflow` display kind; one
 * implementation for graph, draft pen and diagnostics card), with revision vocabulary and one extra
 * body line "retuned from run X" - decided by tool name, never by family.
 */
export function CreateWorkflowToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const amend = isAmendWorkflowToolCall(toolCall);
  const amendTarget = amend ? readWorkflowAmendTarget(toolCall.input) : undefined;

  const display = useMemo(() => readWorkflowDisplay(toolCall.raw), [toolCall.raw]);
  // In-flight wording: a limit-only retune writes no script and compiles nothing, so "validating
  // workflow" is false for it. Collapsing the row into a settings row happens **after** settlement,
  // cut by the wiring layer from the same input shape (ConversationRowView); here only the
  // in-flight words matter.
  const retuning = amend && readWorkflowRetuneCall(toolCall.input) !== undefined;
  const scriptText = useMemo(() => readWorkflowScript(toolCall.input), [toolCall.input]);
  const workflowName = readWorkflowName(toolCall.input);
  const saved = useMemo(() => readWorkflowSaved(toolCall.input), [toolCall.input]);
  const fallbackOutputText = display ? null : readFallbackOutputText(toolCall.output);
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const name = workflowName ?? fallbackName;

  const workflowRun = context.workflowRun;
  const run = workflowRun?.run;
  const hasCompileErrors = display?.ok === false;
  const showFailureStatus = hasCompileErrors || (!display && toolCall.status === "failed");
  const draft = context.workflowDraft;

  // An empty graph (no ask / files.* at all in the script) deserves no empty track; build the model only with steps.
  const graph =
    display?.causalityGraph !== undefined && display.causalityGraph.steps.length > 0
      ? display.causalityGraph
      : undefined;
  const v4Status = isPlainRecord(toolCall.raw) ? toolCall.raw.v4Status : undefined;
  const writing = context.isRunning && v4Status === "inputStreaming";
  // Amend inheriting the predecessor script: the row's input is the model-emitted copy; with both
  // `script` and `path` absent the script was omitted (a `path` amend carries no `script` yet is a
  // changed script). Say this only once input completes - while streaming it may not have arrived.
  // A missing script is this call's intent: the lineage row says "script unchanged", and the
  // "no script provided" notice never appears.
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

  const model = useMemo<WorkflowTimelineModel | undefined>(() => {
    if (graph !== undefined) return buildWorkflowTimeline(graph, run);
    // Streaming draft: display not here yet, so stations are scanned from the partial script; the whole model is replaced once display arrives.
    if (writing && scriptText !== undefined) return draftTimeline(scanWorkflowDraft(scriptText));
    return undefined;
  }, [graph, run, scriptText, writing]);

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
  // The station header and the n-more line hand out the station id: the detail page lands on that station and expands the list.
  const handleSelectStation = useCallback(
    (station: TimelineStation) => onOpenWorkflowRun?.({ ...named, phaseId: station.id }),
    [onOpenWorkflowRun, named],
  );
  const onResumeWorkflowRun = context.onResumeWorkflowRun;
  const handleResume = useCallback(() => {
    onResumeWorkflowRun?.(workflowName === undefined ? {} : { workflowName });
  }, [onResumeWorkflowRun, workflowName]);
  // Clicking a pill opens that subagent's transcript directly. The card hands over only the slot
  // identity (unstarted pills are clickable too, session id attached when present); session and
  // workspace identities are completed by the host.
  const onOpenWorkflowActor = context.onOpenWorkflowActor;
  const onOpenWorkflowWorkspace = context.onOpenWorkflowWorkspace;
  const onOpenWorkflowArtifact = context.onOpenWorkflowArtifact;
  const runId = workflowRun?.runId;
  // Script pill: hands out the stage id of that station; run and session binding is the host's job
  // (same path as onOpenWorkflowRun).
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

  // ToolLayout is memoized: nodes and callbacks handed to it must be reference-stable (reactStableReferences guard).
  const diagnosticsPrimaryText = useMemo(
    () => <span className="truncate text-foreground-subtlest">{name}</span>,
    [name],
  );
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

  // No-compile: compile-feedback row; failed without display: failure summary. On the no-compile
  // path the handler returns diagnostics directly without starting the engine, so no run should
  // exist - even if the host joins one, stay on the feedback row; diagnostics-first is hard-coded
  // here rather than delegated to callers. Pre-launch reuses the plain summary: no partial script
  // while writing; the final script is expandable once awaiting confirmation.
  const prelaunch = workflowRun === undefined && (writing || v4Status === "pendingApproval");
  const summaryOnly = writing && !showFailureStatus;
  // The writing row is not expandable, but the draft stage line stays under it (not expandable
  // content, no collapse entry): stations are written verbatim by the pen, and once display arrives
  // the whole model switches to the analyzer's stations; this block leaves with writing.
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
                amend,
              ),
            })
          }
          sourceLabel={context.sourceLabel}
          primaryText={diagnosticsPrimaryText}
          // The draft ordinal stays on the row even expanded: it states which draft this is, not a collapsed-state summary.
          secondaryText={draftSlots.secondaryText}
          statusLabel={draftSlots.statusLabel ?? context.statusLabel}
          statusIndicator={draftSlots.statusIndicator}
          statusTooltip={draftSlots.statusTooltip ?? context.errorText}
          showFailureStatus={showFailureStatus}
          // Awaiting-confirmation is still inside the launch flow: share the writing shimmer so it never looks finished.
          isRunning={showFailureStatus ? context.isRunning : prelaunch}
          title={toolCall.title}
          renderContent={summaryOnly ? undefined : renderDiagnosticsContent}
        />
        {draftTimelineBlock}
        {snapshotNotice}
      </>
    );
  }

  // With a run joined, the kind word follows run status (legacy-host run card); revision vocabulary until the run appears.
  const kindId =
    workflowRun !== undefined
      ? workflowRunKindMessageId(workflowRun)
      : readWorkflowKindMessageId(toolCall.raw, context.isRunning, amend, retuning);
  const kindText = context.kindLabelOverride ?? intl.formatMessage({ id: kindId });
  // The kind word phases by copy (writing -> awaiting -> running); the header owns the swap animation, see WorkflowCardHeader.
  const live = workflowRun !== undefined ? workflowRun.status === "running" : context.isRunning;
  const status =
    workflowRun !== undefined ? (
      <WorkflowRunStatus run={workflowRun} testId="workflow-card-status" />
    ) : display?.ok === true ? (
      <WorkflowStaticStatus word={intl.formatMessage({ id: "chat.toolCall.workflow.compiled" })} />
    ) : undefined;
  // The detail string and its tooltip (subagent model name included) share one implementation with
  // the v4 round-end summary. This render path cannot reach the session's model catalog (the tool
  // card layer never touches stores), so custom-provider names are unresolvable - fall back to the
  // bare modelId per the same rule; providerId is never rendered.
  const cardDetail = workflowCardDetail(intl.formatMessage.bind(intl), model, graph, run);
  // While validating (in flight, no graph yet) the details slot carries the draft ordinal from the 2nd on, so the modifying -> validating -> feedback hand-off never flashes empty.
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

            {/* Artifact strip: what the run delivered, <= 3 pills + N; the full set lives in the detail side panel. */}
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
              // No run means no Script section on the detail page; the raw script is readable only here. Collapsed by default, mirroring the confirmation dialog.
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

        {/* Footer: always present expanded; collapsed, only terminal states (failed / canceled) keep it - Resume must stay reachable. */}
        {/* The footer used to be a summary row (subagents - steps - tokens - rounds - artifacts);
            the card now states stage and subagents in the header, so the footer is only the Resume
            anchor: no Resume, no footer. */}
        {resume !== undefined && run !== undefined && (expanded || terminal) ? (
          <WorkflowCardFooter status={run.status} trailing={resume} />
        ) : null}
      </section>
      {snapshotNotice}
    </>
  );
}
