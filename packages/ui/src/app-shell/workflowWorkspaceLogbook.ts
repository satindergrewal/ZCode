// ============================================================
// The script transcript's "logbook" shape: cards organized into chapters (phases), a time
// ruler, and command-output tails. No React, no DOM, no fetching.
// ============================================================
// Chapters split by execution order: consecutive cards of one phase are one chapter;
// re-entering a phase starts a new chapter and bumps the round — the same counting as the
// side spine's ⟳n (entries), not per-site call counts.

import type { PhaseNaming } from "@/components/workflow-graph/phase-name.js";
import type { WorkspaceCardModel } from "@/app-shell/workflowWorkspaceTranscript.js";

export interface WorkspaceChapter {
  key: string;
  /** Cards with no graph (or site off-graph) have no phase: the chapter gets no header. */
  phase: PhaseNaming | undefined;
  /** Which entry into this phase; > 1 renders ⟳n in the chapter header. */
  round: number;
  cards: WorkspaceCardModel[];
  startedAt: number;
  endedAt: number;
}

export function buildWorkspaceChapters(cards: readonly WorkspaceCardModel[]): WorkspaceChapter[] {
  const chapters: WorkspaceChapter[] = [];
  const entries = new Map<string, number>();
  for (const card of cards) {
    const last = chapters.at(-1);
    const phaseId = card.phase?.id;
    if (last !== undefined && last.phase?.id === phaseId) {
      last.cards.push(card);
      last.startedAt = Math.min(last.startedAt, card.node.createdAt);
      last.endedAt = Math.max(last.endedAt, card.node.updatedAt);
      continue;
    }
    const round = phaseId === undefined ? 1 : (entries.get(phaseId) ?? 0) + 1;
    if (phaseId !== undefined) entries.set(phaseId, round);
    chapters.push({
      key: `${phaseId ?? "-"}#${chapters.length}`,
      phase: card.phase,
      round,
      cards: [card],
      startedAt: card.node.createdAt,
      endedAt: card.node.updatedAt,
    });
  }
  return chapters;
}

/** Time-ruler zero: the first card's admission instant (the run's own start is not on the list). */
export function transcriptOrigin(cards: readonly WorkspaceCardModel[]): number | undefined {
  let origin: number | undefined;
  for (const card of cards) {
    if (origin === undefined || card.node.createdAt < origin) origin = card.node.createdAt;
  }
  return origin;
}

/** `+0:00` / `+1:12` / `+1:02:05`: a card's instant relative to the origin. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mmss = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return hours > 0
    ? `+${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `+${mmss}`;
}

/** `6s` / `2m 05s`: how long ago the running card started. */
export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

interface TranscriptSummary {
  phases: number;
  steps: number;
  /** First card admission to last card settlement (or `now` while still running). */
  durationMs: number;
}

export function transcriptSummary(
  cards: readonly WorkspaceCardModel[],
  now: number,
): TranscriptSummary {
  const phases = new Set<string>();
  let start: number | undefined;
  let end = 0;
  let running = false;
  for (const card of cards) {
    if (card.phase !== undefined) phases.add(card.phase.id);
    if (start === undefined || card.node.createdAt < start) start = card.node.createdAt;
    end = Math.max(end, card.node.updatedAt);
    if (card.node.status === "running") running = true;
  }
  const durationMs = start === undefined ? 0 : Math.max(0, (running ? now : end) - start);
  return { phases: phases.size, steps: cards.length, durationMs };
}

interface PeekLine {
  text: string;
  /** Reads as an error line (× / ✗ / FAIL / Error...): destructive color in the peek. */
  error: boolean;
}

export function isErrorLine(line: string): boolean {
  const trimmed = line.trim();
  return /^([×✗✖]|x\s|FAIL\b|ERR(OR)?\b|Error\b|error:)/i.test(trimmed) || /Error:/.test(trimmed);
}

/** Command-output tail: the last non-empty stdout lines; stderr if stdout is empty; string bodies likewise; otherwise no peek. */
export function peekLinesOf(result: unknown, max = 3): PeekLine[] {
  let text: string | undefined;
  if (typeof result === "string") text = result;
  else if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const fields = result as Record<string, unknown>;
    const stdout = typeof fields.stdout === "string" ? fields.stdout : "";
    const stderr = typeof fields.stderr === "string" ? fields.stderr : "";
    text = stdout.trim().length > 0 ? stdout : stderr;
  }
  if (text === undefined) return [];
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-max).map((line) => ({ text: line, error: isErrorLine(line) }));
}

// Expanded state remembered per card (same trick as ToolLayout's module-level map): survives
// collapse/re-expand and tab switches.
const openState = new Map<string, boolean>();

export function rememberedOpen(key: string): boolean {
  return openState.get(key) ?? false;
}

export function setRememberedOpen(key: string, open: boolean): void {
  openState.set(key, open);
}

/** 测试用：清空展开态记忆。 */
export function resetWorkspaceEntryOpenState(): void {
  openState.clear();
}
