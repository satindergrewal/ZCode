import type { TimelineStation, WorkflowTimelineModel } from "./timeline-model.js";

/**
 * The streaming draft: the model is still
 * writing the script and the analyzer has not run, yet the card already draws the **phase line** — stations and faint rail segments only; no pills, no arcs, no
 * status; subagents count only (the header's `N phases · M agents`), the picture left to the analyzer. This is a **regex-grade scanner**,
 * not a parser — it only knows `phase("…")` and `agent("…")`; false positives are fine: once display arrives the whole model is
 * replaced by the analyzer's (invariant 10).
 *
 * A second same-named `phase("implement")` is a return to that station (the analyzer folds it into a back edge), not a new station — the draft
 * only ever adds, so station counts match the analyzer's and no station vanishes at the handover. The last unclosed `phase("ver` feeds the last station
 * `typing`。
 */
export interface WorkflowDraftPhase {
  name: string;
  typing?: true;
}

export interface WorkflowDraft {
  phases: WorkflowDraftPhase[];
  //** Subagent names deduped in appearance order (counted, not drawn). */
  agents: string[];
}

const TOKEN = /\b(phase|agent)\(\s*(?:(["'`])([^"'`\n]*)(\2)?)?/gu;

export function scanWorkflowDraft(script: string): WorkflowDraft {
  const phases: WorkflowDraftPhase[] = [];
  const agents: string[] = [];
  for (const match of script.matchAll(TOKEN)) {
    const [, kind, quote, body, closing] = match;
    if (quote === undefined) continue;
    // Interpolation in template literals keeps only the head: `Researcher${i}` records as Researcher — a shaped name beats an empty one.
    const name = (body ?? "").split("${")[0]!.trim();
    const closed = closing !== undefined;
    if (kind === "phase") {
      // A station already typing is this very marker: the same spot is scanned repeatedly in a stream; name it, do not open a new station.
      const last = phases[phases.length - 1];
      if (last?.typing === true) {
        last.name = name;
        if (closed) delete last.typing;
        continue;
      }
      if (closed && phases.some((phase) => phase.name === name)) continue;
      phases.push({ name, ...(closed ? {} : { typing: true }) });
      continue;
    }
    if (!closed || name.length === 0) continue;
    if (!agents.includes(name)) agents.push(name);
  }
  return { agents, phases };
}

/** Draft -> timeline model: stations and faint rail segments only; no pills, no arcs, no status. */
export function draftTimeline(draft: WorkflowDraft): WorkflowTimelineModel {
  const stations: TimelineStation[] = draft.phases.map((phase, i) => ({
    id: `draft:${i}`,
    naming: { id: `draft:${i}`, name: phase.name },
    onLoop: false,
    pills: [],
    rounds: 0,
    status: undefined,
    track: 0,
    visited: false,
    ...(phase.typing === true ? { typing: true as const } : {}),
  }));
  return {
    arcs: [],
    bands: [],
    draft: { agents: draft.agents.length },
    live: false,
    rails: stations.slice(1).map((_, i) => ({ from: i, ink: "faint" as const, to: i + 1 })),
    runningIndex: undefined,
    stations,
  };
}
