// Read cache for "which saved workflow this run used" (docs/dynamic-workflow/transcript-and-notifications.md,
// "Which workflow a run is saved as").
//
// The verdict lives in the agent (`workflows/forRun`): both facts, the run's journal entry and the
// on-disk definition, live there; the card stores nothing. This is a pure cache: completion cards
// remount on every scroll. Hub-cache discipline (savedWorkflowStore): disk is truth; changes invalidate.
import { create } from "zustand";
import type {
  ZCodeSavedWorkflowEntry,
  ZCodeWorkflowsForRunCandidate,
  ZCodeWorkflowsForRunResult,
} from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * `unsupported` is a capability, not an error: older agents lack the method (JSON-RPC -32601), so
 * the card keeps only "let ZCode summarize and save". Every other failure is `error`; lookup
 * failure is not "unsaved", so no chip and no "run again", while "save" stays clickable.
 */
export type WorkflowRunSavedStatus = "loading" | "ready" | "unsupported" | "error";

export interface WorkflowRunSavedState {
  status: WorkflowRunSavedStatus;
  /** The matching definition; absent means this run has no saved workflow yet. */
  entry?: ZCodeSavedWorkflowEntry;
  match?: ZCodeWorkflowsForRunResult["match"];
  /** The args this run used, prefilling the "run again" dialog. */
  runArgs?: Record<string, unknown>;
}

/** JSON-RPC "method not found": the old-agent capability probe (the hub uses -32602 for old scopes; same precedent). */
const METHOD_NOT_FOUND = -32601;

interface WorkflowRunSavedStoreState {
  /** Invalidation epoch (incremented by invalidate); hooks depend on it, one bump requeries every mounted card. */
  generation: number;
  byKey: Record<string, WorkflowRunSavedState>;
  load: (key: string, loader: () => Promise<ZCodeWorkflowsForRunResult>) => Promise<void>;
  /**
   * The entry written by this very call: flip that card at once (keeping found args) and invalidate
   * the rest; a same-name overwrite can change other runs' answers (the by-name rule).
   */
  applySaved: (key: string, entry: ZCodeSavedWorkflowEntry) => void;
  /** Invalidate after save/delete/hub refresh; the next render requeries. */
  invalidate: () => void;
  reset: () => void;
}

const inFlight = new Map<string, Promise<void>>();

function extractErrorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

export const useWorkflowRunSavedStore = create<WorkflowRunSavedStoreState>((set, get) => ({
  generation: 0,
  byKey: {},
  async load(key, loader) {
    const current = inFlight.get(key);
    if (current) return current;
    // With a verdict, do not re-ask: the row window rebuilds the candidate table (new array, same
    // content) on every projection update, re-running card effects; ungated, every stream tick
    // would RPC per visible card. Only invalidate (save/delete/hub refresh) requeries; a real candidate change is another key.
    if (get().byKey[key] !== undefined) return;
    set((state) => ({
      byKey: { ...state.byKey, [key]: { ...state.byKey[key], status: "loading" } },
    }));
    // Epoch at send time: if invalidation lands in flight, the response is pre-invalidation fact;
    // drop it and requery on the next render (a late reply must not rewrite a just-deleted card).
    const issuedAt = get().generation;
    const request = loader()
      .then((result) => {
        if (get().generation !== issuedAt) return;
        set((state) => ({
          byKey: {
            ...state.byKey,
            [key]: {
              status: "ready",
              ...(result.entry === undefined ? {} : { entry: result.entry }),
              ...(result.match === undefined ? {} : { match: result.match }),
              ...(result.runArgs === undefined ? {} : { runArgs: result.runArgs }),
            },
          },
        }));
      })
      .catch((error: unknown) => {
        if (get().generation !== issuedAt) return;
        const unsupported = extractErrorCode(error) === METHOD_NOT_FOUND;
        if (!unsupported) {
          logger.warn("[workflowRunSavedStore] failed to load saved workflow for run", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        set((state) => ({
          byKey: { ...state.byKey, [key]: { status: unsupported ? "unsupported" : "error" } },
        }));
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  },
  applySaved(key, entry) {
    inFlight.clear();
    // Writing after invalidate would lose the entry (invalidate clears the table), flashing the
    // card back to "save". One set does both: bump the epoch for other cards, keep this one's answer.
    set((state) => ({
      generation: state.generation + 1,
      byKey: { [key]: { ...state.byKey[key], status: "ready", entry } },
    }));
  },
  invalidate() {
    inFlight.clear();
    // Clear the whole table, not one key: a save can affect other same-name runs (by-name rule),
    // and the table holds at most visible cards; requerying is cheaper than a wrong card.
    set((state) => ({ generation: state.generation + 1, byKey: {} }));
  },
  reset() {
    inFlight.clear();
    useWorkflowRunSavedStore.setState({ generation: 0, byKey: {} });
  },
}));

/** Cache key: workspace + run + candidate signature. A candidate change (just saved in-chat) is a different question; requery. */
export function workflowRunSavedKey(
  workspaceKey: string,
  runId: string,
  candidates: readonly ZCodeWorkflowsForRunCandidate[] | undefined,
): string {
  const signature = (candidates ?? [])
    .map((candidate) => `${candidate.scope ?? ""}:${candidate.name}`)
    .join(",");
  return `${workspaceKey}\u0000${runId}\u0000${signature}`;
}

export function selectWorkflowRunSavedState(
  state: WorkflowRunSavedStoreState,
  key: string | null,
): WorkflowRunSavedState | undefined {
  return key === null ? undefined : state.byKey[key];
}

/** Test-only. */
export function resetWorkflowRunSavedStoreForTests(): void {
  useWorkflowRunSavedStore.getState().reset();
}
