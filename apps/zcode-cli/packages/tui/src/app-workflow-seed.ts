// Mirror replay, reseeding, and the interrupted notice on cold start / session resume.
//
// Three disciplines:
//   1. Runtime state comes only from replay: `replayWorkflowRuns` hands over journal-cast-in-sequence-order envelopes
//      identical to the live ones, fed one by one into the shared reducer -- an ordered replay of real events never regresses phase (the
//      synthesis-ban targets summary-built out-of-order events and still holds: summaries only reseed display names).
//   2. Reseeding carries display facts only: label / updatedAt; no status, no resumable guesses (state bits come from the reducer).
//   3. No second clock: query once on mount and once on app replacement; no polling, no setInterval.
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { Message } from "./app-model.js";
import type { TuiListWorkflowRuns, TuiReplayWorkflowRuns, TuiWorkflowRunSummary } from "./types.js";
import type { TuiWorkflowRunSeed } from "./app-workflow-mirror.js";

/** Summary -> reseed entry. Carries only server-provided display facts; absent stays absent (no label invention). */
export function workflowRunSeedFromSummary(summary: TuiWorkflowRunSummary): TuiWorkflowRunSeed {
  return {
    runId: summary.runId,
    ...(summary.label === undefined ? {} : { label: summary.label }),
    ...(summary.updatedAt === undefined ? {} : { updatedAt: summary.updatedAt }),
  };
}

/** One notice line. Falls back to runId when the label is absent -- a degraded list, not an error. */
export function workflowInterruptedNoticeText(seed: TuiWorkflowRunSeed, copy: TuiCopy): string {
  return copy.transcript.workflow.interruptedNotice({
    label: seed.label ?? seed.runId,
    runId: seed.runId,
  });
}

/**
 * Appends a notice line per resumable run. Zero output when there are none (the spec's Excludes).
 *
 * A system line, not a fake user line: the user did not say this.
 */
export function appendWorkflowInterruptedNotices(
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
 * Runs to announce after startup / `/resume`: those the server marks `resumable`.
 *
 * Deliberately unsorted: `updatedAt` is display-only, and the port notes forbid reader-side reordering -- sorting belongs to the store
 * (most recently updated first); sorting again reader-side would drift from the server's tie-break.
 */
export function interruptedWorkflowNotices(
  summaries: readonly TuiWorkflowRunSummary[],
): readonly TuiWorkflowRunSeed[] {
  return summaries.filter((summary) => summary.resumable === true).map(workflowRunSeedFromSummary);
}

/**
 * On mount: replay first, then one reseed pass.
 *
 * The order matters: replay lands first so the card shows real counts from the start; reseeding then adds names only. If both queries
 * fail, the TUI must still boot -- live events will draw in-flight runs regardless.
 *
 * The callbacks go through a ref and the deps hold only the two fetcher identities: the props object is fresh every render, and
 * depending on it directly would re-run the queries each render -- a second clock.
 */
export function useWorkflowRunSeeding(input: {
  copy: TuiCopy;
  listWorkflowRuns?: TuiListWorkflowRuns;
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  /** Runs already in the mirror (events seen in this process) -- replay excludes them. */
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
          // A replay failure must not keep the TUI from booting.
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
      // Order is the server's (most recently updated first) -- the port notes forbid reader-side reordering.
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
