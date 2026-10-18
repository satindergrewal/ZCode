import { useMemo, useState } from "react";
import {
  MessageCircleQuestionIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import { TID_CHAT_WORKFLOW_RUN_DIGEST, testId } from "@zcode/shared";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";
import type { HoleLabels } from "./timeline-holes.js";
import { buildWorkflowTimeline, type TimelinePill } from "./timeline-model.js";
import { workflowCardDetail } from "./timeline-summary.js";
import { HolesWaitingChip } from "./WorkflowHoleParts.js";
import {
  WORKFLOW_RUN_ENDED_KIND_ID,
  WorkflowCardHeader,
  workflowRunKindMessageId,
} from "./WorkflowCardChrome.js";
import { WorkflowArtifactStrip } from "./WorkflowArtifactStrip.js";
import {
  useWorkflowRunSettingsPopoverState,
  WorkflowRunSettingsPopover,
  type WorkflowRunSettingsHost,
} from "./WorkflowRunSettingsPopover.js";
import { timelineHeight, WorkflowTimeline } from "./WorkflowTimeline.js";
import { WorkflowTruncatedNotice } from "./WorkflowTruncatedNotice.js";

/** The run card below defaults expanded, no chevron yet still collapsible; the header carries state. */
export interface WorkflowRunDigestProps {
  name: string;
  runId: string;
  /** The run's originating graph (looked up by toolCallId); without it no phase line (the row window lacks the origin row). */
  graph: WorkflowCausalityGraphData | undefined;
  /** Filled holes' name and type (fill-row input); the head's text derives from it when the projection recorded no type. */
  holeLabels?: HoleLabels;
  /**
   * The live projection's join summary. Absent = the run left the projection (evicted by
   * the eight-run cap / cold recovery with no journal hit): the card collapses to one
   * neutral row — kind word "Workflow finished", no light/rail/Cancel/Resume, ⤢ only
   * (the side panel explains it is no longer tracked live).
   */
  summary: WorkflowRunCardSummary | undefined;
  /** Pending questions this run waits on; > 0 adds the warning chip to the header. */
  pendingQuestions?: number;
  /**
   * Opens run details; absent means no ⤴, inert chip, static more-row. With `landing`,
   * details focus that station: only the row carries it — ⤴ and the question chip open
   * the whole run.
   */
  onOpenRun?: (landing?: { phaseId: string }) => void;
  /** Resume the run; rendered only when `summary.resumable` and the callback exist. */
  onResume?: () => void;
  /**
   * Stop the run; rendered only while running with a callback, sharing Resume's slot —
   * mutually exclusive states, both exits visible on the card.
   */
  onCancel?: () => void;
  /** Opens a pill's subagent transcript; absent leaves pills inert. */
  onOpenPill?: (pill: TimelinePill) => void;
  /** Opens the script transcript at that station; absent leaves the script pill inert. */
  onOpenWorkspace?: (pill: TimelinePill) => void;
  /** Opens an artifact pill's tab; absent disables artifact pills. */
  onOpenArtifact?: (artifactId: string) => void;
  /**
   * providerId -> provider name (host supplies it from the session's model list, see
   * useWorkflowSubagentModelProviderName). Missing: labels fall back to the bare modelId —
   * **never render the providerId** (on team plans it is a UUID).
   */
  subagentModelProviderName?: (providerId: string) => string | undefined;
  /**
   * Configure-popover host. Present = the header grows a Configure button — the host
   * supplies it only when a callback exists and the run is configurable.
   */
  settingsHost?: WorkflowRunSettingsHost;
  /** testid suffix (unit.key + toolCallId). */
  testIdKey: string;
}

export function WorkflowRunDigest({
  graph,
  holeLabels,
  name,
  onOpenArtifact,
  onOpenPill,
  onOpenRun,
  onOpenWorkspace,
  onResume,
  onCancel,
  pendingQuestions = 0,
  runId,
  settingsHost,
  subagentModelProviderName,
  summary,
  testIdKey,
}: WorkflowRunDigestProps) {
  const { intl } = useZCodeIntl();
  const run = summary?.run;
  const [expanded, setExpanded] = useState(true);

  // Draw the phase line only with a live projection and a graph: an unprojected graph is all
  // pending lights and would portray a finished run as never-run.
  const model = useMemo(
    () =>
      graph !== undefined && graph.steps.length > 0 && run !== undefined
        ? buildWorkflowTimeline(graph, run, holeLabels)
        : undefined,
    [graph, holeLabels, run],
  );
  const hasRail = model !== undefined && model.stations.length > 0;
  const shown = useMemo(
    () =>
      expanded || !model
        ? model
        : {
            ...model,
            stations: model.stations.map((station) => ({ ...station, pills: [] })),
          },
    [expanded, model],
  );
  // Dropping the chevron does not drop collapsing: blank areas toggle, children keep their own actions.
  const hitsControl = (target: EventTarget | null, root: HTMLElement) => {
    const control =
      target instanceof Element
        ? target.closest("button, a, input, textarea, select, [role='button']")
        : null;
    return control !== null && control !== root;
  };

  const format = intl.formatMessage.bind(intl);
  // The card deliberately does **not** draw lineage: "adjusted from / superseded by"
  // belongs to the detail page and confirm dialog; the card only swaps its kind word —
  // anything more is noise. The detail string's last segment is the subagent model name
  // (absent when never set); level and canonical string live in the tooltip.
  const cardDetail = workflowCardDetail(format, model, graph, run, subagentModelProviderName);
  const live = summary?.status === "running";
  const kind = format({
    id: summary === undefined ? WORKFLOW_RUN_ENDED_KIND_ID : workflowRunKindMessageId(summary),
  });
  const questionsLabel =
    pendingQuestions > 0
      ? format(
          {
            id:
              pendingQuestions === 1
                ? "chat.toolCall.workflow.digest.question"
                : "chat.toolCall.workflow.digest.questions",
          },
          { count: pendingQuestions },
        )
      : undefined;
  const questions =
    questionsLabel === undefined ? undefined : onOpenRun === undefined ? (
      <span
        className="wf-arrive flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning"
        data-testid="workflow-digest-questions"
      >
        <MessageCircleQuestionIcon aria-hidden className="size-3" />
        {questionsLabel}
      </span>
    ) : (
      <button
        className="wf-arrive flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning outline-none transition-colors hover:bg-[color-mix(in_oklab,var(--color-warning)_20%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/40"
        data-testid="workflow-digest-questions"
        onClick={() => onOpenRun()}
        type="button"
      >
        <MessageCircleQuestionIcon aria-hidden className="size-3" />
        {questionsLabel}
      </button>
    );
  // The {n} holes-awaiting-fill chip (docs/dynamic-workflow/presentation.md "Holes on the timeline"): the
  // pen chip in the question chip's slot; both can coexist. Clicking opens the whole run.
  const holesWaiting = (run?.holes ?? []).filter((hole) => hole.state === "waiting").length;
  const leading =
    questions === undefined && holesWaiting === 0 ? undefined : (
      <>
        {questions}
        <HolesWaitingChip
          count={holesWaiting}
          {...(onOpenRun === undefined ? {} : { onOpen: () => onOpenRun() })}
        />
      </>
    );
  const resume =
    summary?.resumable === true && onResume !== undefined ? (
      <Button
        data-testid="workflow-digest-resume"
        onClick={onResume}
        size="default"
        type="button"
        variant="outline"
      >
        <RotateCcwIcon className="size-3.5" />
        {format({ id: "chat.toolCall.workflow.run.resume" })}
      </Button>
    ) : undefined;
  // Stop and Resume are mutually exclusive (running vs stopped) and share the header's
  // right slot, issuing the same command as the detail page. After Stop, the button enters
  // a disabled "Stopping..." state until the projection moves it on: keying by status
  // remounts fresh on any transition (cancelled -> resumed -> running included). The old
  // reset was an effect setState per status — an extra update after each projection-frame
  // commit, the same shape as the workflow-card React #185 crash; keyed remount has no
  // second commit.
  const cancel =
    live && onCancel !== undefined ? (
      <CancelRunButton key={summary?.status} onCancel={onCancel} />
    ) : undefined;
  // Configure sits before Resume / Stop and in the same slot in every state, so whether it appears never moves ⤢.
  const configure =
    settingsHost !== undefined && run !== undefined ? (
      <ConfigureRunButton host={settingsHost} run={run} />
    ) : undefined;

  return (
    <section
      aria-label={kind}
      className={cn(
        "wf-motion wf-arrive flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-2 pt-1.5 outline-none",
        hasRail && "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-expanded={hasRail ? String(expanded) : undefined}
      data-testid={testId(TID_CHAT_WORKFLOW_RUN_DIGEST, testIdKey)}
      data-workflow-run-digest="true"
      data-workflow-run-id={runId}
      data-workflow-run-status={summary?.status ?? "absent"}
      role={hasRail ? "button" : undefined}
      tabIndex={hasRail ? 0 : undefined}
      aria-expanded={hasRail ? expanded : undefined}
      onClick={(event) => {
        if (hasRail && !hitsControl(event.target, event.currentTarget))
          setExpanded((value) => !value);
      }}
      onKeyDown={(event) => {
        if (
          !hasRail ||
          hitsControl(event.target, event.currentTarget) ||
          (event.key !== "Enter" && event.key !== " ")
        )
          return;
        event.preventDefault();
        setExpanded((value) => !value);
      }}
    >
      <WorkflowCardHeader
        detail={cardDetail?.detail}
        {...(cardDetail?.title === undefined ? {} : { detailTitle: cardDetail.title })}
        expanded={expanded}
        kind={kind}
        leading={leading}
        live={live}
        name={name}
        trailing={
          configure === undefined ? (
            (resume ?? cancel)
          ) : (
            <>
              {configure}
              {resume ?? cancel}
            </>
          )
        }
        {...(onOpenRun === undefined ? {} : { onOpenDetails: () => onOpenRun() })}
      />
      {shown === undefined || !hasRail ? null : (
        // Collapsing hides only the agents; the phase line stays as the progress overview.
        <div
          className={cn("wf-digest-plot overflow-hidden")}
          data-testid="workflow-digest-plot"
          style={{ height: timelineHeight(shown) + 8 }}
        >
          <WorkflowTimeline
            className="py-1"
            model={shown}
            {...(onOpenPill === undefined ? {} : { onOpenPill })}
            {...(onOpenWorkspace === undefined ? {} : { onOpenWorkspace })}
            {...(onOpenRun === undefined
              ? {}
              : {
                  onOpenMore: (station) => onOpenRun({ phaseId: station.id }),
                  // Fill head: opens the pane on the first station it wrote (that station's section header is the fill's title).
                  onOpenFill: (fill) => {
                    const first = shown.stations[fill.from];
                    if (first !== undefined) onOpenRun({ phaseId: first.id });
                  },
                })}
          />
        </div>
      )}
      {/* The "showing n/m steps" line under the timeline: the header count is already true,
          this line only says the **details** are what got capped. Present collapsed too —
          it explains the numbers above, not the pills. Cards without a rail (no origin row
          in the window) are single-line by spec with no count to qualify, so the line
          drops with them. */}
      {hasRail ? <WorkflowTruncatedNotice run={run} testId="workflow-digest-truncated" /> : null}
      {/* Artifact strip: the run's deliverable, present collapsed and expanded — the receipt's most useful row. */}
      {run?.artifacts !== undefined && run.artifacts.length > 0 ? (
        <WorkflowArtifactStrip
          artifacts={run.artifacts}
          className="pb-0.5 pt-0.5"
          moreTestId="workflow-digest-artifacts-more"
          pillTestId="workflow-digest-artifact"
          testId="workflow-digest-artifacts"
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        />
      ) : null}
    </section>
  );
}

/**
 * Header Configure: sliders glyph, ghost `icon-md`, shaped like Stop — the header has no
 * room for a labeled button. Opens the Configure popover below itself.
 */
function ConfigureRunButton({
  host,
  run,
}: {
  host: WorkflowRunSettingsHost;
  run: WorkflowRunState;
}) {
  const { intl } = useZCodeIntl();
  const { anchorRef, open, setOpen, toggleFrom } = useWorkflowRunSettingsPopoverState();
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.title" });
  return (
    <>
      <ControlHintTooltip title={label} side="top">
        <Button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={label}
          data-testid="workflow-digest-configure"
          onClick={(event) => toggleFrom(event.currentTarget)}
          size="icon-md"
          type="button"
          variant="ghost"
        >
          <SlidersHorizontalIcon className="size-3.5" />
        </Button>
      </ControlHintTooltip>
      <WorkflowRunSettingsPopover
        anchorRef={anchorRef}
        host={host}
        onOpenChange={setOpen}
        open={open}
        run={run}
      />
    </>
  );
}

/**
 * Header Stop: same style as the ⤴ details button (ghost icon + tooltip, no label — no
 * room for text). "Stopping" is local state; the host keys it by run status so any
 * transition remounts and it resets naturally.
 *
 * Tooltip's second line: "You can resume anytime; finished steps are kept." Since the
 * verb became Stop, the press itself must say this is not a discard (a stopped run is
 * resumable). While stopping, the line withdraws — the decision is made; nothing left to
 * argue.
 */
function CancelRunButton({ onCancel }: { onCancel: () => void }) {
  const { intl } = useZCodeIntl();
  const [cancelling, setCancelling] = useState(false);
  const label = intl.formatMessage({
    id: cancelling ? "chat.toolCall.workflow.run.cancelling" : "chat.toolCall.workflow.run.cancel",
  });
  return (
    <ControlHintTooltip
      title={label}
      side="top"
      {...(cancelling
        ? {}
        : {
            description: intl.formatMessage({ id: "chat.toolCall.workflow.run.stopHint" }),
          })}
    >
      <Button
        aria-label={label}
        data-testid="workflow-digest-cancel"
        disabled={cancelling}
        onClick={() => {
          setCancelling(true);
          onCancel();
        }}
        size="icon-md"
        type="button"
        variant="ghost"
      >
        <SquareIcon className="size-3.5 fill-current" />
      </Button>
    </ControlHintTooltip>
  );
}
