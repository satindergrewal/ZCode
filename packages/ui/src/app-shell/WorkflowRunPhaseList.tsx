import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, CircleHelpIcon } from "lucide-react";
import type { WorkflowRunPendingQuestion, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import {
  pillActivity,
  type TimelinePill,
  type WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";
import {
  ROSTER_PINS_PANE,
  pillInstanceKey,
  rosterMore,
  rosterRestCounts,
  rosterRoll,
  stationRosterOf,
} from "@/components/workflow-timeline/roster-model.js";
import {
  WorkflowAgentPill,
  type WorkflowAgentPillOpen,
} from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowMoreRow } from "@/components/workflow-timeline/WorkflowMoreRow.js";
import { WorkflowRoll } from "@/components/workflow-timeline/WorkflowRoll.js";
import { RosterMeter } from "@/components/workflow-timeline/WorkflowRosterParts.js";
import { WorkflowRunQuestionRow } from "@/app-shell/WorkflowRunQuestionRow.js";
import {
  AvatarCluster,
  Rounds,
  SpineLamp,
  SpinePieces,
} from "@/app-shell/WorkflowRunSpineParts.js";
import { spineSections } from "@/app-shell/workflowRunSpine.js";
import type { WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * The run detail page's spine: the card's horizontal timeline, read vertically here. One track hugs
 * the left edge top to bottom; phases are lamps on the track, whose ink darkens as control flow
 * passes and marches through the segment entering the running phase; subagents are pills hung right
 * of the lamp, full column width (the same pill as on the card); escalated questions hang under the
 * asker's row, one step further in. **No back-edges**: that is the card's business -- the header's
 * `⟳ n` already says how many rounds this station ran.
 *
 * Rail ink and lamp status both read the same `buildWorkflowTimeline` model (invariant 1: one
 * model, three consumers). Rail segments draw only between adjacent stations where the model has
 * `rails` -- the card's rule too; adjacent without an edge stays blank.
 *
 * Parallel phases (the model's **band**) read as indentation here: the branch track leaves the main
 * rail with a curve above the band's first section, runs vertically section by section, and returns
 * at the merge station's section top; the branch station's header and pills shift right 12px
 * together while the main rail passes by as usual. Which rails and curves each section draws is
 * computed by `workflowRunSpine.ts`; this file only places them. **No back-edges** (as above).
 *
 * Collapsed phases carry an avatar cluster on the header (3 + `+n` at most): folding must not hide
 * "who is at this station". Running phases expand themselves: **every** running station opens
 * (both tracks of a band can run at once); already-open ones stay.
 *
 * Stations past the participant threshold become rosters (see "phase roster", "a door and a
 * roll"): 5 pinned pills (asking -> running -> failed -> backfill), the sixth is the door (closed,
 * with a count row for the rest), behind it the roll of everyone else -- once each, grouped by
 * status, two columns of `row` pills; collapsed headers swap the avatar cluster for a mini meter.
 * Subagents the bounds cannot list (`station.unlisted`) are counted in the door, count row, and
 * meter but have no row to land on, so a faint line at the roll's end accounts for the difference.
 *
 * Landing: the card's "n more" row or the station header hands the station id to the host; the tab
 * arrives here with `focusPhaseId` -- expanding the station, opening the door, scrolling the header
 * to the top, flashing the background and fading back. One landing per open (the key includes
 * openedAt; clicking the same station again lands again); afterwards scrolling away does not
 * re-trigger.
 */
const QUESTION_TICK_MS = 30_000;
/** Landing flash duration: hold 400 ms then fade back over 800 ms (`.wf-landed`). */
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
}: {
  graph: WorkflowCausalityGraphData;
  model: WorkflowTimelineModel;
  run: WorkflowRunState | undefined;
  pendingQuestions: readonly WorkflowRunPendingQuestion[];
  /** Open the actor transcript tab (slots without a session open a placeholder). Absent means the row is not clickable -- the callback's existence is the gate. */
  onOpenActor?: (instance: WorkflowActorInstance) => void;
  /** Open the script transcript tab, landed on this station; absent means the script row is not clickable. */
  onOpenWorkspace?: (phaseId: string) => void;
  /** Landing: `key` differs per open (`phaseId@openedAt`), so re-clicking the same station lands again. */
  landing?: { phaseId: string; key: string };
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  // Running stations expand themselves -- both tracks of a band can run at once, so **every** one
  // opens, not just the right-most. Remember the id set under a stable key: the projection changes
  // the model's identity on every tick, but this set rarely changes.
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
  // Roster stations' door: open means the roll is listed; local list state, per station.
  const [listed, setListed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleListed = useCallback((id: string) => {
    setListed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Landing: expand + open door + flash; scrolling happens after the next commit (the section must
  // expand first for its header to exist and scroll).
  // `landed` keys on the landing key (not the station): re-landing the same station changes the
  // key, so the scroll and flash both replay.
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

  // Waiting time must tick by itself: a run awaiting an answer emits no events. The timer exists
  // only while questions are pending.
  const [now, setNow] = useState(() => Date.now());
  const hasQuestions = pendingQuestions.length > 0;
  useEffect(() => {
    if (!hasQuestions) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), QUESTION_TICK_MS);
    return () => clearInterval(timer);
  }, [hasQuestions]);

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
  // Rails and curves to draw per section (`workflowRunSpine.ts`): segments are looked up by
  // **pair**, not by from -- within a band one station can be the left end of both a double-line
  // segment and the main-line segment.
  const sections = spineSections(model);
  const nameOf = (pill: TimelinePill) => pill.runtimeName ?? laneDisplayName(pill.lane, format);
  const phaseNameOf = (phaseId: string) => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };

  // The row yields the slot identity: session id rides along when present, otherwise a placeholder
  // tab opens.
  const openActor = (pill: TimelinePill) => {
    const slot = pill.slot;
    if (onOpenActor === undefined || slot === undefined) return;
    const sessionId = pill.instance?.sessionId;
    onOpenActor({
      ordinal: slot.ordinal,
      ...(sessionId === undefined ? {} : { sessionId }),
      siteId: slot.siteId,
      status:
        pill.status === "running"
          ? "running"
          : pill.status === "done" || pill.status === "failed"
            ? "completed"
            : "waiting",
      ...(pill.runtimeName === undefined ? {} : { name: pill.runtimeName }),
    });
  };

  /** Common pill wiring (name, status, openability); shared by full-width pills and the roll's dense pills. */
  const pillProps = (pill: TimelinePill) => {
    const label = nameOf(pill);
    const openable = onOpenActor !== undefined && pill.slot !== undefined;
    // Same open grammar as the script row: open the whole run's script transcript, landed on this station's first card.
    const workspacePhaseId = onOpenWorkspace === undefined ? undefined : pill.workspace?.phaseId;
    const open: WorkflowAgentPillOpen | undefined = openable
      ? {
          data: {
            "data-agent-key": pillKey(pill) ?? "",
            "data-agent-session-id": pill.instance?.sessionId ?? "",
            "data-agent-status": pill.status ?? "pending",
          },
          label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
          onOpen: () => openActor(pill),
          testId: "workflow-run-agent-open",
        }
      : workspacePhaseId !== undefined
        ? {
            data: { "data-phase-id": workspacePhaseId },
            label: format(
              { id: "chat.toolCall.workflow.timeline.openScript" },
              { phase: phaseNameOf(workspacePhaseId) },
            ),
            onOpen: () => onOpenWorkspace?.(workspacePhaseId),
            testId: "workflow-run-workspace-open",
          }
        : undefined;
    return {
      avatarIndex: pill.avatarIndex,
      laneClass: pill.laneClass,
      name: label,
      status: pill.status,
      title: label,
      ...(open === undefined ? {} : { open }),
    };
  };

  const renderPill = (pill: TimelinePill) => {
    const activity = pillActivity(graph, run, pill);
    const key = pillKey(pill);
    const questions = key === undefined ? [] : (questionsByInstance.get(key) ?? []);
    const counts: string[] = [];
    if (activity.asks > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.tasks" }, { count: activity.asks }),
      );
    }
    if (activity.reads > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.reads" }, { count: activity.reads }),
      );
    }
    // Openable pills are <button>: inside a block parent it only wraps its content, so row width
    // would vary with name length. A vertical flex container stretches every row to the column
    // width (same mechanism as the card's under-station pill column).
    return (
      <div className="flex min-w-0 flex-col" key={pill.key}>
        <WorkflowAgentPill {...pillProps(pill)}>
          {counts.length === 0 ? null : (
            <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
              {counts.join(" · ")}
            </span>
          )}
        </WorkflowAgentPill>
        {/* Questions hang under the asker, one step further in (26px): they belong to the row, not the station. */}
        {questions.map((question) => (
          <WorkflowRunQuestionRow
            className="ml-[26px]"
            key={question.qid}
            now={now}
            question={question}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      className="wf-motion flex min-h-0 flex-1 flex-col overflow-auto pb-3 pt-2.5"
      data-testid="workflow-run-phases"
      ref={rootRef}
    >
      {model.stations.map((station, index) => {
        const expanded = open.has(station.id);
        const name = phaseDisplayName(station.naming, format);
        const status = station.status ?? "pending";
        const pending = status === "pending";
        const spine = sections[index] ?? { curves: [], rails: [] };
        // Branch stations indent a full step: header, pills, and lamp together, 12px per track.
        const indent = station.track === 0 ? undefined : { paddingLeft: 39 + 12 * station.track };
        const roster = stationRosterOf(station, ROSTER_PINS_PANE);
        return (
          <section
            className="relative"
            data-phase-id={station.id}
            data-phase-landed={landed?.phaseId === station.id ? "true" : undefined}
            data-phase-open={expanded ? "true" : "false"}
            data-phase-status={status}
            data-phase-track={station.track}
            data-testid="workflow-run-phase"
            key={station.id}
          >
            <SpinePieces section={spine} />
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
              // Re-landing remounts the header under a new key: the same class name would not
              // restart the CSS animation.
              key={landed?.phaseId === station.id ? landed.key : "head"}
              onClick={() => toggle(station.id)}
              style={indent}
              type="button"
            >
              <SpineLamp status={status} track={station.track} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-ui-base",
                  pending ? "text-foreground-subtle" : "font-medium text-foreground",
                )}
              >
                {name}
              </span>
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
                style={indent}
              >
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
                            {/* The sixth and later askers live in the roll: one ? before the tail slot; the question itself is not repeated here. */}
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
        );
      })}
      {orphanQuestions.length === 0 ? null : (
        <div
          className="flex flex-col gap-1 pl-[39px] pr-3 pt-2"
          data-testid="workflow-run-orphan-questions"
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
