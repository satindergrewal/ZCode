import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORKFLOW_ARTIFACT_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/index.js";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Data fetching for preset boards.
 *
 * Invariant: **the board is a projection of the journal.** This reads journal rows with
 * `kind = "report"` and a matching `artifact_id`; the pure `applyArtifactItems` then folds them
 * into charts / tables / tiles / boards -- every surface (side-pane card, full tab, cold
 * recovery) derives the same picture from the same rows.
 *
 * ```
 * projection artifacts[id].itemCount rises
 *        │  (refresh signal, may overcount by one -- see the 3a note)
 *        ▼
 *  workflowRunArtifactData({ afterSequence: sequence of last received item })
 *        │
 *        ▼  keep paging while hasMore, until drained
 *   items[] appended  ──▶  applyArtifactItems  ──▶  one more point on the line
 * ```
 */

/**
 * Max pages per drain. `REPORT_CAPS` is 256 items per run with page size 200, so normally two
 * pages at most; this cap only stops an implementation that never returns `hasMore: false` from
 * locking up the renderer thread.
 */
const MAX_PAGES_PER_DRAIN = 16;

/**
 * Max follow-up rounds before settling when `itemCount` rises mid-drain (see `pendingRef`).
 * Each round is an incremental read resuming from the local tail; normally one round drains.
 */
const MAX_FOLLOW_UP_ROUNDS = 8;

interface WorkflowRunArtifactDataState {
  items: readonly ArtifactItem[];
  loading: boolean;
  /** The session does not support artifact data queries (old CLI): boards cannot render. Distinct from "no data yet". */
  unavailable: boolean;
  error: string | null;
}

/** Same capability-missing test as `useWorkflowRunArtifacts`: past JSON-RPC only the message is reliable. */
function isWorkflowRunArtifactDataCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("ArtifactItems");
}

function emptyState(): WorkflowRunArtifactDataState {
  return { items: [], loading: false, unavailable: false, error: null };
}

export function useWorkflowRunArtifactData(options: {
  sessionId: string;
  runId: string;
  artifactId: string;
  /**
   * Refresh signal = the id's `itemCount` in the projection. A rise triggers an incremental
   * fetch; it may **overcount by one** (the deliberate trade-off recorded in 3a), so treat it
   * only as "maybe more", never as a count -- the real count is `items.length`.
   */
  itemCount?: number;
  enabled?: boolean;
}): WorkflowRunArtifactDataState {
  const { workflowRunArtifactData } = useV4Conversation();
  const [state, setState] = useState<WorkflowRunArtifactDataState>(emptyState);
  const requestVersionRef = useRef(0);
  const inFlightRef = useRef(false);
  /** A new refresh signal arrived mid-drain: a follow-up round is required before settling, or the final point never appears. */
  const pendingRef = useRef(false);
  /**
   * `sequence` of the last received item -- the incremental-read cursor.
   *
   * Deliberately a ref instead of reading the tail of `state.items`: after `setState`, `state`
   * only updates on the next render, and the follow-up runs inside the **same async function**,
   * where reading state would yield the previous round's tail and append the same sequence
   * range twice.
   */
  const cursorRef = useRef<number | undefined>(undefined);
  /**
   * The `itemCount` the previous append resumed from. `undefined` = no baseline yet this round
   * (mount / artifact switch); that frame's fetch is handled by the full refetch, and the
   * incremental effect just records the baseline and exits -- otherwise every mounted board
   * would fire one guaranteed-empty incremental query for nothing.
   */
  const lastDrainedCountRef = useRef<number | undefined>(undefined);

  const { artifactId, runId, sessionId } = options;
  const enabled =
    options.enabled !== false && sessionId.length > 0 && runId.length > 0 && artifactId.length > 0;

  /**
   * Page from the cursor until drained. `replace` is a full refetch (artifact/run switch);
   * `append` is an incremental tail append.
   *
   * Single-flight gate (`inFlightRef`): `itemCount` rising mid-drain is normal (one report per
   * script round); re-entry would append the same sequence range twice. A blocked call is not
   * dropped -- it is recorded in `pendingRef` and the running drain repeats before settling.
   * Otherwise a run's **final** report would never render (no later `itemCount` change remains
   * to trigger another fetch).
   */
  const drain = useCallback(
    async (mode: "replace" | "append") => {
      if (!enabled) return;
      if (inFlightRef.current) {
        pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      const requestVersion = ++requestVersionRef.current;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        let round = 0;
        let currentMode = mode;
        for (;;) {
          pendingRef.current = false;
          const collected: ArtifactItem[] = [];
          let cursor = currentMode === "append" ? cursorRef.current : undefined;
          for (let page = 0; page < MAX_PAGES_PER_DRAIN; page += 1) {
            const result = await workflowRunArtifactData({
              sessionId,
              runId,
              artifactId,
              ...(cursor === undefined ? {} : { afterSequence: cursor }),
              limit: WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
            });
            if (requestVersion !== requestVersionRef.current) return;
            collected.push(...result.items);
            const lastSequence = result.items.at(-1)?.sequence;
            if (lastSequence !== undefined) cursor = lastSequence;
            if (!result.hasMore || result.items.length === 0) break;
          }
          if (requestVersion !== requestVersionRef.current) return;
          cursorRef.current = cursor;
          const settledMode = currentMode;
          setState((current) => ({
            items: settledMode === "replace" ? collected : [...current.items, ...collected],
            loading: false,
            unavailable: false,
            error: null,
          }));
          round += 1;
          if (!pendingRef.current || round >= MAX_FOLLOW_UP_ROUNDS) break;
          currentMode = "append";
        }
      } catch (caught) {
        if (requestVersion !== requestVersionRef.current) return;
        if (isWorkflowRunArtifactDataCapabilityMissing(caught)) {
          setState((current) => ({
            items: mode === "replace" ? [] : current.items,
            loading: false,
            unavailable: true,
            error: null,
          }));
          return;
        }
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.warn("[workflow-artifacts] Failed to load board items", {
          artifactId,
          error: message,
          runId,
          sessionId,
        });
        setState((current) => ({ ...current, loading: false, error: message }));
      } finally {
        inFlightRef.current = false;
        pendingRef.current = false;
      }
    },
    [artifactId, enabled, runId, sessionId, workflowRunArtifactData],
  );

  // Artifact/run switch or disabled->enabled: clear first, then refetch in full. Another
  // board's points must never remain on this canvas.
  useEffect(() => {
    requestVersionRef.current += 1;
    cursorRef.current = undefined;
    lastDrainedCountRef.current = undefined;
    setState(emptyState());
    if (!enabled) return;
    void drain("replace");
  }, [drain, enabled]);

  // Incremental: an `itemCount` rise triggers the append.
  //
  // The gate deliberately has no "skip while the local list is empty" rule: a board declared at
  // the top of the script and fed by later reports is empty at mount, and gating on emptiness
  // would prevent its first point from ever rendering. The duplicate trigger at mount is absorbed
  // by the single-flight gate (the refetch effect runs first and holds it).
  const itemCount = options.itemCount ?? 0;
  useEffect(() => {
    if (!enabled) return;
    // First frame of this round: the full refetch is running; record the baseline only. Effect
    // declaration order guarantees the refetch effect runs first.
    if (lastDrainedCountRef.current === undefined) {
      lastDrainedCountRef.current = itemCount;
      return;
    }
    if (itemCount === lastDrainedCountRef.current) return;
    lastDrainedCountRef.current = itemCount;
    void drain("append");
  }, [drain, enabled, itemCount]);

  return useMemo(() => state, [state]);
}
