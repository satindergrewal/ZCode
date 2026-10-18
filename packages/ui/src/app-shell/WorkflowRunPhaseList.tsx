import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, CircleHelpIcon } from "lucide-react";
import type { WorkflowRunPendingQuestion, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowTimelineModel } from "@/components/workflow-timeline/timeline-model.js";
import {
  ROSTER_PINS_PANE,
  pillInstanceKey,
  rosterMore,
  rosterRestCounts,
  rosterRoll,
  stationRosterOf,
} from "@/components/workflow-timeline/roster-model.js";
import { WorkflowAgentPill } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowMoreRow } from "@/components/workflow-timeline/WorkflowMoreRow.js";
import { WorkflowRoll } from "@/components/workflow-timeline/WorkflowRoll.js";
import { RosterMeter } from "@/components/workflow-timeline/WorkflowRosterParts.js";
import { WorkflowRunQuestionRow } from "@/app-shell/WorkflowRunQuestionRow.js";
import {
  AvatarCluster,
  Rounds,
  SpineJointRow,
  SpineLamp,
  SpinePieces,
  useWorkflowActorModelLabels,
} from "@/app-shell/WorkflowRunSpineParts.js";
import { phasePillRenderers } from "@/app-shell/WorkflowRunPhasePills.js";
import { spineLayout } from "@/app-shell/workflowRunSpine.js";
import {
  FillHeadingRow,
  HoleWaitingBody,
  SpineHoleLamp,
} from "@/app-shell/WorkflowRunHoleParts.js";
import { useSpineFillFrames } from "@/app-shell/WorkflowRunFillFrames.js";
import { HoleFillMark } from "@/components/workflow-timeline/WorkflowHoleParts.js";
import type { WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * The run detail's spine: the card's horizontal timeline read vertically. One rail hugs the left edge top to
 * bottom, phases are lamps on it, rail ink darkens as control flow passes and marches through the segment
 * entering the running phase; subagents are full-column pills right of the lamp (the card's own), escalation
 * questions hang under their asker's row, one step further in. Loop-back edges are NOT drawn: that is the
 * card's job, the header's retry-N already says how many rounds this site ran.
 *
 * Rail segment and lamp ink/state all read the one model from buildWorkflowTimeline (invariant 1: one model,
 * three consumers). Segments draw only between adjacent sites whose model edge carries rails, same rule as the
 * card: adjacent without an edge stays blank.
 *
 * Parallel phases (the model's bands) read as the commit graph here: branch rails right of the mainline, lamps
 * on their own track, while headers, pills and questions all start at the same text column (39 + gutter); rails
 * and text never share a column. Fork and join each take one joint row between sections, present only when the
 * predecessor/sink site exists. Which rails and joints each section draws is precomputed by workflowRunSpine.ts;
 * this only places them. Loop-backs not drawn, as above.
 *
 * Collapsed phases carry an avatar cluster on the header (3 max + more): collapsing must not hide who is at
 * the site. Running phases expand themselves: EVERY running site opens (two tracks of a band can run at once);
 * already-open ones stay.
 *
 * Sites past the participant threshold become rosters (see phase-roster notes): five pinned pills (asking,
 * running, failed, backfill), the sixth is the gate (closed, with a count row for the rest), behind it the
 * roster of everyone else, once each, grouped by state, as two columns of row pills; collapsed headers swap the
 * avatar cluster for a mini meter. Subagents beyond the cap (station.unlisted) count toward the gate, the count
 * row and the meter but have no row, so a faded line at the roster's end accounts for the difference.
 *
 * Landing: the card's more-n row or the site header hands the site id to the host and the tab arrives with
 * focusPhaseId; here that means expand the site, open the gate, scroll the header to top, flash the background
 * and fade back. One landing per open (the key carries openedAt; clicking the same site again lands again);
 * afterwards user scrolling is never chased.
 */
const QUESTION_TICK_MS = 30_000;
/** Landing flash timing: hold 400ms then fade 800ms (.wf-landed). */
const LANDING_MS = 1200;

function questionKey(question: WorkflowRunPendingQuestion): string | undefined {
  return question.actorSiteId === undefined || question.actorOrdinal === undefined
    ? undefined
    : `${question.actorSiteId}@${question.actorOrdinal}`;
}

const pillKey = pillInstanceKey;

export const WorkflowRunPhaseList = memo(function WorkflowRunPhaseList({
  graph,
  landing,
  model,
  onOpenActor,
  onOpenWorkspace,
  pendingQuestions,
  run,
  subagentModelProviderName,
}: {
  graph: WorkflowCausalityGraphData;
  model: WorkflowTimelineModel;
  run: WorkflowRunState | undefined;
  pendingQuestions: readonly WorkflowRunPendingQuestion[];
  /** Opens an actor transcript tab (placeholder for session-less slots). Absent = row inert; the callback's existence is the gate. */
  onOpenActor?: (instance: WorkflowActorInstance) => void;
  /** Opens the script transcript tab anchored to this site; absent = script row inert. */
  onOpenWorkspace?: (phaseId: string) => void;
  /** Landing: key differs per open (phaseId@openedAt) so re-clicking the same site lands again. */
  landing?: { phaseId: string; key: string };
  /** providerId to provider display name (names a subagent's own model; same source as the summary row). */
  subagentModelProviderName?: (providerId: string) => string | undefined;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  // Subagents whose persona names a model: the row tail says the model name, the tooltip carries the canonical string (presentation.md The spine).
  const actorModels = useWorkflowActorModelLabels(run?.actors, subagentModelProviderName);
  // Running sites expand themselves: both tracks of a band can run at once, so EVERY one opens, not just the
  // rightmost. Remember the id set under a stable key: each projection tick re-identifies the model, the set rarely changes.
  const runningKey = model.stations
    .filter((station) => station.status === "running")
    .map((station) => station.id)
    .join("\u0000");
  const runningIds = useMemo(
    () => (runningKey === "" ? [] : runningKey.split("\u0000")),
    [runningKey],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(runningIds));
  useEffect(() => {
    setOpen((previous) =>
      runningIds.every((id) => previous.has(id)) ? previous : new Set([...previous, ...runningIds]),
    );
  }, [runningIds]);
  const toggle = useCallback((id: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // Roster gates: open means list the roster; per-site local list state.
  const [listed, setListed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleListed = useCallback((id: string) => {
    setListed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Landing: expand + open gate + flash; scrolling waits for the next commit (the section must be expanded before its header exists to scroll to).
  // landed keys on the landing key, not the site: re-landing the same site gets a fresh key, so scroll and flash both replay.
  const rootRef = useRef<HTMLDivElement>(null);
  const landedOnceRef = useRef<string | undefined>(undefined);
  const [landed, setLanded] = useState<{ phaseId: string; key: string } | undefined>(undefined);
  useEffect(() => {
    if (landing === undefined || landedOnceRef.current === landing.key) return undefined;
    landedOnceRef.current = landing.key;
    const { phaseId } = landing;
    setOpen((previous) => (previous.has(phaseId) ? previous : new Set([...previous, phaseId])));
    setListed((previous) => (previous.has(phaseId) ? previous : new Set([...previous, phaseId])));
    setLanded(landing);
    const timer = setTimeout(
      () => setLanded((current) => (current?.key === landing.key ? undefined : current)),
      LANDING_MS,
    );
    return () => clearTimeout(timer);
  }, [landing]);
  useEffect(() => {
    if (landed === undefined) return;
    const root = rootRef.current;
    if (root === null) return;
    const section = [...root.querySelectorAll<HTMLElement>("[data-phase-id]")].find(
      (candidate) => candidate.getAttribute("data-phase-id") === landed.phaseId,
    );
    const head = section?.querySelector<HTMLElement>('[data-testid="workflow-run-phase-toggle"]');
    if (head === undefined || head === null || typeof head.scrollIntoView !== "function") return;
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    head.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [landed]);

  // Waiting time must tick locally: a run waiting on an answer (or a fill) emits no events precisely then. The timer exists only while someone waits.
  const [now, setNow] = useState(() => Date.now());
  const hasQuestions =
    pendingQuestions.length > 0 ||
    model.stations.some((station) => station.hole?.state === "waiting");
  useEffect(() => {
    if (!hasQuestions) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), QUESTION_TICK_MS);
    return () => clearInterval(timer);
  }, [hasQuestions]);
  // Waiting holes expand themselves (same rule as running sites: it is the current site).
  const waitingHoleKey = model.stations
    .filter((station) => station.hole?.state === "waiting")
    .map((station) => station.id)
    .join("\u0000");
  useEffect(() => {
    if (waitingHoleKey === "") return;
    const ids = waitingHoleKey.split("\u0000");
    setOpen((previous) =>
      ids.every((id) => previous.has(id)) ? previous : new Set([...previous, ...ids]),
    );
  }, [waitingHoleKey]);

  const questionsByInstance = useMemo(() => {
    const byKey = new Map<string, WorkflowRunPendingQuestion[]>();
    for (const question of pendingQuestions) {
      const key = questionKey(question);
      if (key === undefined) continue;
      const list = byKey.get(key) ?? [];
      list.push(question);
      byKey.set(key, list);
    }
    return byKey;
  }, [pendingQuestions]);
  const attachedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const station of model.stations) {
      for (const pill of station.pills) {
        const key = pillKey(pill);
        if (key !== undefined) keys.add(key);
      }
    }
    return keys;
  }, [model]);
  const orphanQuestions = pendingQuestions.filter((question) => {
    const key = questionKey(question);
    return key === undefined || !attachedKeys.has(key);
  });
  // Per-section rails and joint rows (workflowRunSpine.ts); the text column shares one left edge across the spine.
  const spine = spineLayout(model);
  // Completion frames (WorkflowRunFillFrames.tsx): drawn when the head (heading row / pen mark) is hovered or keyboard-focused.
  const fillFrames = useSpineFillFrames(rootRef, model);
  const textColumn = spine.gutter === 0 ? undefined : { paddingLeft: 39 + spine.gutter };
  // Pill naming, opening and tail slot (WorkflowRunPhasePills.tsx).
  const { nameOf, pillProps, renderPill } = phasePillRenderers({
    actorModels,
    format,
    graph,
    model,
    now,
    questionsByInstance,
    run,
    ...(onOpenActor === undefined ? {} : { onOpenActor }),
    ...(onOpenWorkspace === undefined ? {} : { onOpenWorkspace }),
  });

  return (
    <div
      className="wf-motion relative flex min-h-0 flex-1 flex-col overflow-auto pb-3 pt-2.5"
      data-testid="workflow-run-phases"
      ref={rootRef}
      {...fillFrames.handlers}
    >
      {fillFrames.frames}
      {model.stations.map((station, index) => {
        const expanded = open.has(station.id);
        const name = phaseDisplayName(station.naming, format);
        const status = station.status ?? "pending";
        const pending = status === "pending";
        const section = spine.sections[index] ?? { rails: [] };
        const roster = stationRosterOf(station, ROSTER_PINS_PANE);
        // Holes (docs/dynamic-workflow/presentation.md Holes on the timeline, The pane): the header swaps to a dashed lamp and
        // the waiting body says how long. A completion with phases adds a heading before its first written section; those
        // sections are not indented (nesting is expressed by the frames).
        const hole = station.hole;
        // Completions starting at this section each get a heading row, outermost first (model order): the inner frame measures from its own heading.
        const headings = (model.fills ?? []).filter((fill) => fill.from === index);
        const column = textColumn;
        return (
          <Fragment key={station.id}>
            <SpineJointRow joint={section.fork} kind="fork" pitch={spine.pitch} />
            {headings.map((heading) => (
              <FillHeadingRow
                fill={heading}
                fresh={fillFrames.fresh.has(heading.holeId)}
                key={heading.holeId}
                on={fillFrames.active === heading.holeId}
                onSelect={() => toggle(station.id)}
                textColumn={textColumn}
              />
            ))}
            <section
              className="relative"
              data-phase-fill={station.fill}
              data-phase-hole={hole?.state}
              data-phase-id={station.id}
              data-phase-landed={landed?.phaseId === station.id ? "true" : undefined}
              data-phase-open={expanded ? "true" : "false"}
              data-phase-status={status}
              data-phase-track={station.track}
              data-testid="workflow-run-phase"
            >
              <SpinePieces pitch={spine.pitch} section={section} />
              <button
                aria-expanded={expanded}
                aria-label={intl.formatMessage(
                  {
                    id: expanded
                      ? "chat.toolCall.workflow.run.phase.collapse"
                      : "chat.toolCall.workflow.run.phase.expand",
                  },
                  { name },
                )}
                className={cn(
                  "wf-station-open relative flex h-9 w-full items-center gap-2 pl-[39px] pr-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40",
                  landed?.phaseId === station.id && "wf-landed",
                )}
                data-testid="workflow-run-phase-toggle"
                // Re-landing remounts the header under a fresh key: the same class name would not restart the CSS animation.
                key={landed?.phaseId === station.id ? landed.key : "head"}
                onClick={() => toggle(station.id)}
                style={column}
                type="button"
              >
                {hole !== undefined && hole.state !== "filled" ? (
                  <SpineHoleLamp hole={hole} pitch={spine.pitch} track={station.track} />
                ) : (
                  <SpineLamp pitch={spine.pitch} status={status} track={station.track} />
                )}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-ui-base",
                    pending ? "text-foreground-subtle" : "font-medium text-foreground",
                  )}
                >
                  {name}
                </span>
                {hole?.state === "filled" ? <HoleFillMark holeId={hole.siteId} /> : null}
                <span className="flex shrink-0 items-center gap-2.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                  {expanded ? null : roster !== undefined ? (
                    <RosterMeter counts={roster.counts} mini />
                  ) : (
                    <AvatarCluster nameOf={nameOf} pills={station.pills} />
                  )}
                  {station.fraction === undefined ? null : (
                    <span data-testid="workflow-run-phase-fraction">
                      {station.fraction.settled}/{station.fraction.observed}
                    </span>
                  )}
                  <Rounds station={station} />
                  <ChevronRightIcon
                    aria-hidden
                    className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                  />
                </span>
              </button>
              {expanded ? (
                <div
                  className="wf-unfold flex flex-col gap-1.5 pb-3 pl-[39px] pr-3 pt-0.5"
                  data-testid="workflow-run-phase-body"
                  style={column}
                >
                  {hole?.state === "waiting" ? <HoleWaitingBody hole={hole} now={now} /> : null}
                  {roster === undefined ? (
                    station.pills.map(renderPill)
                  ) : (
                    <>
                      <div className="flex flex-col gap-1.5" data-testid="workflow-roster-pins">
                        {roster.pinned.map(renderPill)}
                      </div>
                      <WorkflowMoreRow
                        door={{
                          open: listed.has(station.id),
                          tally: rosterRestCounts(roster),
                        }}
                        more={rosterMore(roster)}
                        onOpen={() => toggleListed(station.id)}
                      />
                      {listed.has(station.id) ? (
                        <WorkflowRoll
                          groups={rosterRoll(roster)}
                          unlisted={roster.unlisted.actors}
                          renderRow={(pill, enterDelayMs) => (
                            <WorkflowAgentPill
                              enterDelayMs={enterDelayMs}
                              key={pill.key}
                              size="row"
                              {...pillProps(pill)}
                            >
                              {/* Askers beyond the fifth land in the roster: one ? in the tail slot; the question itself is not repeated here. */}
                              {pill.asking === true ? (
                                <CircleHelpIcon
                                  aria-hidden
                                  className="size-3 shrink-0 text-warning"
                                  data-testid="workflow-roll-asking"
                                />
                              ) : null}
                            </WorkflowAgentPill>
                          )}
                        />
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </section>
            <SpineJointRow joint={section.merge} kind="merge" pitch={spine.pitch} />
          </Fragment>
        );
      })}
      {orphanQuestions.length === 0 ? null : (
        <div
          className="flex flex-col gap-1 pl-[39px] pr-3 pt-2"
          data-testid="workflow-run-orphan-questions"
          style={textColumn}
        >
          <span className="text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.questions.title" })}
          </span>
          {orphanQuestions.map((question) => (
            <WorkflowRunQuestionRow key={question.qid} now={now} question={question} showAsker />
          ))}
        </div>
      )}
    </div>
  );
});
