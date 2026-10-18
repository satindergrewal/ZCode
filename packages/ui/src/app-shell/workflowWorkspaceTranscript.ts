// ============================================================
// Pure model for the script transcript
// ============================================================
// One journal node to one tool card's material: kind (Read / Search / Git / Terminal), primary text,
// command line, owning phase and round, status word, footer numbers. No React, no DOM, no fetching.
//
// Kind dispatches on **op**, not the kind field: kind only splits world-read / world-run, while the cards
// want four verbs, read files / find things / git / run commands, exactly the files/git/world facade split.
// Pre-escalation history rows have no op (input_json NULL); they fall back to the static graph's step label
// with the generic step kind.

import type { WorkflowRunState, WorkflowRunWorkspaceNode } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { PhaseNaming } from "@/components/workflow-graph/phase-name.js";

export type WorkspaceCardKind = "read" | "search" | "git" | "terminal" | "step";

/** One card's static material (no status; status lives in `workspaceCardStatus`, which also overlays the live projection). */
export interface WorkspaceCardModel {
  /** React key plus ToolLayout's toolId / expanded-state memory key. */
  key: string;
  node: WorkflowRunWorkspaceNode;
  kind: WorkspaceCardKind;
  op: string | undefined;
  /** Read: path; Search: pattern (glob/grep); Git: subcommand + args; Terminal: command line; Step: step label. */
  primary: string;
  /** Search's second argument (grep glob scope); Git diff pathspec. */
  secondary?: string;
  /** Terminal: `cmd args` (the line after the prompt in the expanded panel). */
  command?: string;
  /** Owning phase (looked up by site in the static graph); absent when the graph is unavailable or the site is not on it. */
  phase?: PhaseNaming;
  /** Call ordinal for this site (journal index); the source chip shows retry-N when > 1. */
  round: number;
}

interface WorkspaceCardStatus {
  status: WorkflowRunWorkspaceNode["status"];
  /** The live projection says this step was a resume cache hit (the replayed chip). */
  replayed: boolean;
}

function argString(args: readonly unknown[] | undefined, index: number): string | undefined {
  const value = args?.[index];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function argList(args: readonly unknown[] | undefined, index: number): string[] {
  const value = args?.[index];
  if (Array.isArray(value)) return value.map((item) => String(item));
  // In truncated mode array args are already JSON preview text.
  if (typeof value === "string" && value.startsWith("[")) return [value];
  return [];
}

/** argv rendering: quote args containing spaces, matching what one would type in a terminal. */
export function formatCommandLine(cmd: string, args: readonly string[]): string {
  const quote = (part: string) => (/[\s"']/.test(part) ? JSON.stringify(part) : part);
  return [cmd, ...args].map(quote).join(" ");
}

export function workspaceCardKindOf(op: string | undefined): WorkspaceCardKind {
  if (op === undefined) return "step";
  if (op === "read") return "read";
  if (op === "glob" || op === "grep") return "search";
  if (op.startsWith("git-")) return "git";
  if (op === "run") return "terminal";
  return "step";
}

/** git-changed-files to changed-files; used by the source chip and the primary text. */
function gitSubcommand(op: string): string {
  return op.slice("git-".length);
}

/**
 * Site to phase lookup. Static-graph steps carry `phase`; `source ?? id` is the site id (may-set expanded
 * copies carry source). Scripts without phase markers have no phases: the map is empty and no card gets a source chip.
 */
function phaseBySiteId(graph: WorkflowCausalityGraphData | undefined): Map<string, PhaseNaming> {
  const table = new Map<string, PhaseNaming>();
  if (graph === undefined) return table;
  const phases = new Map((graph.phases ?? []).map((phase) => [phase.id, phase] as const));
  for (const step of graph.steps) {
    if (step.phase === undefined) continue;
    const phase = phases.get(step.phase);
    if (phase === undefined) continue;
    table.set(step.source ?? step.id, { id: phase.id, name: phase.name });
  }
  return table;
}

/** Site to static step label (fallback primary text for history rows). */
function stepLabelBySiteId(graph: WorkflowCausalityGraphData | undefined): Map<string, string> {
  const table = new Map<string, string>();
  for (const step of graph?.steps ?? []) table.set(step.source ?? step.id, step.label);
  return table;
}

export function buildWorkspaceCards(
  nodes: readonly WorkflowRunWorkspaceNode[],
  graph: WorkflowCausalityGraphData | undefined,
): WorkspaceCardModel[] {
  const phases = phaseBySiteId(graph);
  const labels = stepLabelBySiteId(graph);
  return nodes.map((node) => {
    const op = node.op;
    const kind = workspaceCardKindOf(op);
    const phase = phases.get(node.siteId);
    const base = {
      key: `${node.siteId}@${node.ordinal}`,
      node,
      kind,
      op,
      round: node.ordinal,
      ...(phase === undefined ? {} : { phase }),
    };
    const fallback = labels.get(node.siteId) ?? node.siteId;
    switch (kind) {
      case "read":
        return { ...base, primary: argString(node.args, 0) ?? fallback };
      case "search": {
        const scope = argString(node.args, 1);
        return {
          ...base,
          primary: argString(node.args, 0) ?? fallback,
          ...(scope === undefined ? {} : { secondary: scope }),
        };
      }
      case "git": {
        const sub = gitSubcommand(op!);
        const target = argString(node.args, 0);
        const shown = node.args?.map((arg) =>
          typeof arg === "string" ? arg : JSON.stringify(arg),
        );
        return {
          ...base,
          primary: `git ${formatCommandLine(sub, shown ?? [])}`,
          ...(target === undefined ? {} : { secondary: target }),
        };
      }
      case "terminal": {
        const cmd = argString(node.args, 0) ?? fallback;
        const command = formatCommandLine(cmd, argList(node.args, 1));
        return { ...base, primary: command, command };
      }
      default:
        return { ...base, primary: fallback };
    }
  });
}

/**
 * Live-projection overlay: only fills cached (the replayed chip). Status follows the journal row. When the
 * projection says settled but the journal still says running, that is query lag and the next
 * lastEventSequence bump catches up; when the journal leads the projection (admission persists before
 * emitting) the node is simply absent from the projection.
 */
export function workspaceCardStatus(
  node: WorkflowRunWorkspaceNode,
  run: WorkflowRunState | undefined,
): WorkspaceCardStatus {
  const live = run?.nodes.find(
    (candidate) => candidate.siteId === node.siteId && candidate.ordinal === node.ordinal,
  );
  return { status: node.status, replayed: live?.cached === true };
}

/** Anchor: index of the phase's first card; -1 when the phase has no cards yet (panel scrolls to the end). */
export function firstCardIndexOfPhase(
  cards: readonly WorkspaceCardModel[],
  phaseId: string,
): number {
  return cards.findIndex((card) => card.phase?.id === phaseId);
}

/** 1.3s / 840ms / 2m 05s: one step's duration. */
export function formatWorkspaceDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** 4.1 KB / 312 B / 1.2 MB: body size. */
export function formatWorkspaceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Status-word rule for failed rows: the driver's timeout code reads as timed out, anything else shows the code. */
export function isTimeoutError(error: { code: string; message: string } | undefined): boolean {
  if (error === undefined) return false;
  return /timeout|timed ?out/i.test(error.code) || /timed out|timeout/i.test(error.message);
}
