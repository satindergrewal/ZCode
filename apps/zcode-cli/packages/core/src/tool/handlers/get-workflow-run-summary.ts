// ============================================================
// GetWorkflowRun 's `<summary>`: the situation in one sentence
// ============================================================
//
// The sentence is assembled deterministically from structured fields with no model in the loop: the same snapshot always yields the same sentence,
// so it can be pinned verbatim and never shifts between reads. It answers the three things a reader actually asks —
// where this run is, whether it is moving, and whether anything waits for me — the blocks below expand those three answers.
//
// One discipline runs throughout: **when unknown, say so**. No timestamp, no age; no phase, no phase position;
// if the pending table is unreadable, say "unknown" — never pass 0 or "unknown" off as a fact.

import type { GetWorkflowRunOutput } from "@zcode/contracts";
import { GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS } from "@zcode/contracts";
import {
  formatRelativeAge,
  formatWorkflowRunCount,
  formatWorkflowRunDuration,
} from "./workflow-run-introspection.js";

/** Facts the summary reads = the whole output minus the summary itself (the handler mints the output first, then composes this sentence from it). */
type WorkflowRunSummaryFacts = Omit<GetWorkflowRunOutput, "summary">;

/** Terminal-state words: the run has no next action left (same set as the port terminal test). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "errored", "stopped"]);

/** Over budget, drop whole sentences; hard-truncate only as a last resort — the ellipsis keeps one character. */
const SUMMARY_ELLIPSIS = "…";

export function buildWorkflowRunSummary(run: WorkflowRunSummaryFacts): string {
  const now = run.generatedAt;
  const terminal = TERMINAL_STATUSES.has(run.status);

  // The first two sentences are the skeleton (where the run is + which step it reached); kept under any budget.
  const required = [
    `${statusClause(run, now, terminal)}${phaseClause(run)}.`,
    `${stepsClause(run, terminal)}.`,
  ];
  const optional = [
    failureClause(run),
    questionsClause(run),
    progressClause(run, now, terminal),
    deliverableClause(run),
    ownershipClause(run),
  ].filter((clause): clause is string => clause !== undefined);

  const sentences = [...required, ...optional];
  while (
    sentences.length > required.length &&
    sentences.join(" ").length > GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS
  ) {
    sentences.pop();
  }
  const text = sentences.join(" ");
  if (text.length <= GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS - SUMMARY_ELLIPSIS.length)}${SUMMARY_ELLIPSIS}`;
}

/** Status + how long it has run / how long since it ended. */
function statusClause(run: WorkflowRunSummaryFacts, now: number, terminal: boolean): string {
  const elapsed = formatWorkflowRunDuration(run.updatedAt - run.createdAt);
  if (!terminal) {
    return run.status === "pending"
      ? "Pending, not dispatched yet"
      : `Running for ${formatWorkflowRunDuration(now - run.createdAt)}`;
  }
  if (run.status === "completed") return `Completed in ${elapsed}`;
  if (run.status === "errored") return `Errored after ${elapsed}`;
  // stopped: first how long ago it stopped (the reader is judging freshness), then how long it ran in total.
  const reason = run.stopReason === undefined ? "stopped" : run.stopReason;
  const endedAge = formatRelativeAge(now, run.updatedAt);
  const ended = endedAge === undefined ? "" : ` ${endedAge}`;
  return `Stopped (${reason})${ended} after ${elapsed}`;
}

/**
 * Phase position. A live run (or terminal with phases still open) reports "n of total"; a fully completed run reports only the total —
 * for a finished run, "in phase 4" carries no information. The whole sentence is omitted when the script has no phases.
 */
function phaseClause(run: WorkflowRunSummaryFacts): string {
  const phases = run.phases;
  if (phases === undefined || phases.length === 0) return "";
  const index = phases.findIndex(
    (phase) => phase.state === "current" || phase.state === "unfinished",
  );
  if (index < 0) return `, across ${phases.length} phase${phases.length === 1 ? "" : "s"}`;
  return `, in phase ${index + 1} of ${phases.length} (${phases[index]!.name})`;
}

/** Step count. `nodesObserved` is the number of persisted node rows, never posed as a total — dynamic workflows have no static total. */
function stepsClause(run: WorkflowRunSummaryFacts, terminal: boolean): string {
  const settled = run.usage.nodesCompleted + run.usage.nodesFailed;
  const leftover = run.health.leftoverRunning;
  if (terminal && leftover !== undefined && leftover > 0) {
    // The processes under these steps died: they are not running but markers on a corpse — the reader learns recovery will redispatch them.
    return `${settled} of ${run.usage.nodesObserved} dispatched steps settled; ${leftover} ${
      leftover === 1 ? "was" : "were"
    } still running when the owning process exited and will be re-dispatched on resume`;
  }
  if (terminal) {
    const failed = run.usage.nodesFailed > 0 ? `, ${run.usage.nodesFailed} failed` : "";
    return `${settled} step${settled === 1 ? "" : "s"} settled${failed}, ${formatWorkflowRunCount(
      run.usage.spentTokens,
    )} tokens`;
  }
  const running =
    run.usage.nodesRunning > 0 ? `, ${run.usage.nodesRunning} running${runningBreakdown(run)}` : "";
  return `${settled} of ${run.usage.nodesObserved} dispatched steps settled${running}`;
}

/**
 * What the in-flight steps are doing (roster phase counts). The whole parenthesis is omitted when the roster is unreadable.
 *
 * **Invariant**: a subagent in a live phase (`executing` / `waiting` / `parked`) has exactly one ask line still marked
 * `running` — `waiting` means that ask is queued or backing off, `parked` means it stopped on a question;
 * neither line has settled. These three counts therefore partition `usage.nodesRunning` and must sum to it.
 * If the numbers inside and outside the parens disagree, a hand-crafted journal that cannot exist is the only cause.
 */
function runningBreakdown(run: WorkflowRunSummaryFacts): string {
  const counts = { executing: 0, waiting: 0, parked: 0 };
  for (const subagent of run.subagents) {
    if (subagent.state === "executing") counts.executing += 1;
    else if (subagent.state === "waiting") counts.waiting += 1;
    else if (subagent.state === "parked") counts.parked += 1;
  }
  const parts = (Object.keys(counts) as (keyof typeof counts)[])
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/**
 * Pending questions. **"Unknown" is a sentence that must be spoken**: when reading a run owned by another process, "nobody is waiting"
 * and "not queryable" look identical, yet they imply completely different next steps for the model.
 */
function questionsClause(run: WorkflowRunSummaryFacts): string | undefined {
  if (!run.health.pendingQuestionsKnown) return "Pending questions are unknown from this session.";
  const count = run.pendingQuestions?.length ?? 0;
  if (count === 0) return undefined;
  return `${count} question${count === 1 ? "" : "s"} awaiting your answer.`;
}

/** When activity was last observed; if stalled, say the word. */
function progressClause(
  run: WorkflowRunSummaryFacts,
  now: number,
  terminal: boolean,
): string | undefined {
  if (terminal) return undefined;
  const age = formatRelativeAge(now, run.health.lastProgressAt);
  if (age === undefined) return undefined;
  return run.health.stalledSince === undefined
    ? `Last progress ${age}.`
    : `Stalled, last progress ${age}.`;
}

/** Failure code in the summary: the model uses it to tell a dead process from a real script failure, which selects its next route. */
function failureClause(run: WorkflowRunSummaryFacts): string | undefined {
  if (run.error === undefined) return undefined;
  if (run.status !== "errored" && run.stopReason !== "provider") return undefined;
  return `Failure: ${run.error.code}.`;
}

/**
 * Deliverable (completed only): point the reader at the one thing, not an artifact inventory.
 *
 * The title gets **no quotes**: the sentence ends up XML-ish-escaped into `<summary>`, and that table turns `"` into
 * `&quot;` — a pair of quotes added for readability becomes two entities before the model. The kind in parens already brackets the title.
 */
function deliverableClause(run: WorkflowRunSummaryFacts): string | undefined {
  if (run.status !== "completed") return undefined;
  const primary = run.artifacts?.find((artifact) => artifact.primary === true);
  if (primary === undefined) return undefined;
  return `Deliverable: ${primary.title ?? primary.id} (${primary.kind}, primary).`;
}

/** Run not owned by this session: no notifications will come and TaskOutput cannot see it — the first summary sentence must state ownership. */
function ownershipClause(run: WorkflowRunSummaryFacts): string | undefined {
  return run.ownedByThisSession ? undefined : "Owned by another session.";
}
