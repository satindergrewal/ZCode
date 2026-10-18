// TUI controller for the dwf run-state mirror (same hook conventions as useSidebarController / useInputHistory).
//
// State and derivations only: the mirror, the card join table, the expanded set. Session-event wiring lives in
// app.tsx (the subscription needs applySessionEvent, which in turn needs this hook's setters; co-locating would cycle).
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { Message } from "./app-model.js";
import type { TuiOptions } from "./types.js";
import { useWorkflowRunSeeding } from "./app-workflow-seed.js";
import {
  EMPTY_TUI_WORKFLOW_MIRROR,
  applyWorkflowProgressToMirror,
  buildTuiWorkflowCardIndex,
  type TuiWorkflowCard,
  type TuiWorkflowMirror,
  seedWorkflowMirror,
  type TuiWorkflowRunSeed,
} from "./app-workflow-mirror.js";

/** Expand/collapse surface for `+`/`-`. One object so app.tsx passes a single extra prop. */
export type TuiWorkflowExpansionControls = {
  /** Only eat `+`/`-` when at least one card exists; otherwise both keys keep typing into the draft. */
  hasCards: boolean;
  expandAll: () => void;
  collapseAll: () => void;
};

type TuiWorkflowRunsController = {
  mirror: TuiWorkflowMirror;
  setMirror: React.Dispatch<React.SetStateAction<TuiWorkflowMirror>>;
  cardsByToolCallId: ReadonlyMap<string, TuiWorkflowCard>;
  expandedRunIds: ReadonlySet<string>;
  toggleExpansion: (runId: string) => void;
  seed: (seeds: readonly TuiWorkflowRunSeed[]) => void;
  expansion: TuiWorkflowExpansionControls;
};

export function useTuiWorkflowRuns(input: {
  copy: TuiCopy;
  options: TuiOptions;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}): TuiWorkflowRunsController {
  const [mirror, setMirror] = React.useState<TuiWorkflowMirror>(EMPTY_TUI_WORKFLOW_MIRROR);
  const [expandedRunIds, setExpandedRunIds] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const cardsByToolCallId = React.useMemo(() => buildTuiWorkflowCardIndex(mirror), [mirror]);

  const toggleExpansion = React.useCallback((runId: string) => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  // Cold seeding moves display names (label / updatedAt) only. Run state flows through the replay below: the journal's
  // **real, ordered** events reduce through the same reducer -- the "never feed summary-synthesized events to the
  // reducer" ban targets out-of-order synthesis, not sequence-ordered engine replays.
  const seed = React.useCallback((seeds: readonly TuiWorkflowRunSeed[]) => {
    setMirror((current) => seedWorkflowMirror(current, seeds));
  }, []);
  const replay = React.useCallback((envelopes: readonly WorkflowRunProgressEnvelope[]) => {
    setMirror((current) => envelopes.reduce(applyWorkflowProgressToMirror, current));
  }, []);
  const mirrorRef = React.useRef(mirror);
  mirrorRef.current = mirror;
  const knownRunIds = React.useCallback(
    () => new Set(mirrorRef.current.state.runs.map((run) => run.runId)),
    [],
  );

  // Expand/collapse all: the TUI deliberately has no card selection (no panel, no cursor), so `+`/`-` can only act on the whole set.
  const runIdsKey = [...cardsByToolCallId.values()].map((card) => card.runId).join("\u0000");
  const expandAll = React.useCallback(() => {
    setExpandedRunIds(new Set(runIdsKey.length === 0 ? [] : runIdsKey.split("\u0000")));
  }, [runIdsKey]);
  const collapseAll = React.useCallback(() => setExpandedRunIds(new Set<string>()), []);

  // Seed once on mount and raise the interrupted notice; no polling (a second clock is the legacy panel's anti-pattern).
  useWorkflowRunSeeding({
    copy: input.copy,
    ...(input.options.listWorkflowRuns === undefined
      ? {}
      : { listWorkflowRuns: input.options.listWorkflowRuns }),
    ...(input.options.replayWorkflowRuns === undefined
      ? {}
      : { replayWorkflowRuns: input.options.replayWorkflowRuns }),
    knownRunIds,
    replay,
    seed,
    setMessages: input.setMessages,
  });

  return {
    mirror,
    setMirror,
    cardsByToolCallId,
    expandedRunIds,
    toggleExpansion,
    seed,
    expansion: { hasCards: cardsByToolCallId.size > 0, expandAll, collapseAll },
  };
}
