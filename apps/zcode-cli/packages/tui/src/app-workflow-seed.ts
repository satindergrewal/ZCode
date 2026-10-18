// Mirror replay, cold seed, and interrupted notice on session start / resume.
//
// Three disciplines:
//   1. Run state comes **only** from replay: `replayWorkflowRuns` yields the same progress envelopes as live,
//      cast from the journal in sequence order, fed one by one into the shared reducer -- an ordered replay of
//      real events cannot phase-regress (the ban targets "synthesizing out-of-order events from summaries";
//      summaries may only fill display names).
//   2. Seeding moves display facts only: label / updatedAt; never fabricate status or guess resumable (state
//      bits are reducer-owned).
//   3. No second clock: query once on mount and once on app replacement; no polling, no setInterval.
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { Message } from "./app-model.js";
import type { TuiListWorkflowRuns, TuiReplayWorkflowRuns, TuiWorkflowRunSummary } from "./types.js";
import type { TuiWorkflowRunSeed } from "./app-workflow-mirror.js";

/** Summary -> seed entry. Carry only server-provided display facts; keep defaults as defaults (never invent a label). */
function workflowRunSeedFromSummary(summary: TuiWorkflowRunSummary): TuiWorkflowRunSeed {
  return {
    runId: summary.runId,
    ...(summary.label === undefined ? {} : { label: summary.label }),
    ...(summary.updatedAt === undefined ? {} : { updatedAt: summary.updatedAt }),
  };
}

/** One notice line. Falls back to runId when the label is missing -- a missing list label is degradation, not an error. */
function workflowInterruptedNoticeText(seed: TuiWorkflowRunSeed, copy: TuiCopy): string {
  return copy.transcript.workflow.interruptedNotice({
    label: seed.label ?? seed.runId,
    runId: seed.runId,
  });
}

/**
 * Append notice rows for resumable runs. Zero output when there are no runs (spec's Excludes).
 *
 * A system row, not a fake user row: this is not something the user said.
 */
function appendWorkflowInterruptedNotices(
  messages: Message[],
  seeds: readonly TuiWorkflowRunSeed[],
  copy: TuiCopy,
): Message[] {
  if (seeds.length === 0) return messages;
  return [
    ...messages,
    ...seeds.map((seed) => ({
      content: workflowInterruptedNoticeText(seed, copy),
      role: "system" as const,
    })),
  ];
}

/**
 * Runs to announce after startup / `/resume`: whichever the server flags `resumable`.
 *
 * **Deliberately unsorted**: `updatedAt` is display-only; the port doc forbids reader-side reordering -- sorting is
 * the store's job (newest first), and re-sorting here would drift from the server's tie-break.
 */
function interruptedWorkflowNotices(
  summaries: readonly TuiWorkflowRunSummary[],
): readonly TuiWorkflowRunSeed[] {
  return summaries.filter((summary) => summary.resumable === true).map(workflowRunSeedFromSummary);
}

/**
 * On mount: replay first, then seed once.
 *
 * Order matters: replay lands first so cards appear with real step counts; seeding afterwards only adds names.
 * If both queries fail the TUI must still boot -- live events still draw in-flight runs.
 *
 * The callback goes through a ref and the deps list only the two query functions' identities: the input object is
 * new every render, and depending on it directly would re-run the queries on every render (a second clock).
 */
export function useWorkflowRunSeeding(input: {
  copy: TuiCopy;
  listWorkflowRuns?: TuiListWorkflowRuns;
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  /** Runs already in the mirror (this process saw their events) -- replay excludes them. */
  knownRunIds: () => ReadonlySet<string>;
  replay: (envelopes: readonly WorkflowRunProgressEnvelope[]) => void;
  seed: (seeds: readonly TuiWorkflowRunSeed[]) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}): void {
  const latest = React.useRef(input);
  latest.current = input;
  const { listWorkflowRuns, replayWorkflowRuns } = input;

  React.useEffect(() => {
    if (!listWorkflowRuns && !replayWorkflowRuns) return;
    let cancelled = false;
    void (async () => {
      if (replayWorkflowRuns) {
        try {
          const envelopes = await replayWorkflowRuns({
            excludeRunIds: latest.current.knownRunIds(),
          });
          if (cancelled) return;
          if (envelopes.length > 0) latest.current.replay(envelopes);
        } catch {
          // Replay failure must not keep the TUI from booting.
        }
      }
      if (!listWorkflowRuns) return;
      let summaries: readonly TuiWorkflowRunSummary[];
      try {
        summaries = await listWorkflowRuns();
      } catch {
        return;
      }
      if (cancelled || summaries.length === 0) return;
      latest.current.seed(summaries.map(workflowRunSeedFromSummary));
      // Order is the server's order (newest first) -- the port doc forbids reader-side re-sorting.
      const resumable = interruptedWorkflowNotices(summaries);
      if (resumable.length === 0) return;
      latest.current.setMessages((current) =>
        appendWorkflowInterruptedNotices(current, resumable, latest.current.copy),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [listWorkflowRuns, replayWorkflowRuns]);
}
