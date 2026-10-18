import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORKFLOW_ARTIFACT_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/index.js";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Data plumbing for the preset dashboard.
 *
 * Invariant: the dashboard is a projection of the journal. Journal rows with
 * `kind = "report"` and matching `artifact_id` are folded by the pure `applyArtifactItems` into
 * chart/table/tile/board, so every surface (side card, full tab, cold restore) draws the same picture.
 *
 * ```
 * projected artifacts[id].itemCount bump
 *        │  (refresh signal; may overcount by one, see 3a)
 *        ▼
 *  workflowRunArtifactData({ afterSequence: sequence of the last row received })
 *        │
 *        ▼  keep paging while hasMore, until drained
 *   items[] appended  ──▶  applyArtifactItems  ──▶  one more chart point
 * ```
 */

/**
 * Catch-up rounds allowed before settling when itemCount rises mid-fetch (see `pendingRef`).
 * Each round resumes from the local tail; the normal case drains in one.
 */
const MAX_FOLLOW_UP_ROUNDS = 8;

interface WorkflowRunArtifactDataState {
  items: readonly ArtifactItem[];
  loading: boolean;
  /** The session cannot fetch artifacts (old CLI): no dashboard, distinct from no-data-yet. */
  unavailable: boolean;
  error: string | null;
}

/**
 * Old CLIs reject `fields`: the strict schema fails the whole request and, across JSON-RPC, only
 * zod's message (`unrecognized_keys` plus key names) survives. Detect and retry with full items.
 */
function isFieldsParamUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("unrecognized_keys") && message.includes("fields");
}

/**
 * Sessions known to reject `fields` (remote CLIs can lag desktop), module-level so each
 * dashboard/fetch of the same session skips the repeat rejection. Keyed by sessionId: one CLI per session.
 */
const sessionsWithoutFieldReads = new Set<string>();

/** Stable key for the field-path list; a fresh array per render must not refetch. */
const FIELD_KEY_SEPARATOR = "\u0000";

/** Same absence test as `useWorkflowRunArtifacts`: across JSON-RPC only message survives. */
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
   * Refresh signal = projected `itemCount` for the id; a bump triggers the incremental fetch. It may
   * overcount by one (deliberate, 3a), so treat it as maybe-more, never as a count.
   * `items.length`。
   */
  itemCount?: number;
  enabled?: boolean;
  /**
   * Field paths the dashboard reads (`artifactPresetFieldPaths`). When set, the CLI fetches only
   * those fields, keeping 1 MiB items out of the renderer; default fetches the whole item.
   */
  fields?: readonly string[];
}): WorkflowRunArtifactDataState {
  const { workflowRunArtifactData } = useV4Conversation();
  const [state, setState] = useState<WorkflowRunArtifactDataState>(emptyState);
  const requestVersionRef = useRef(0);
  const inFlightRef = useRef(false);
  /** A new refresh signal mid-fetch: catch up before settle, or the last point never appears. */
  const pendingRef = useRef(false);
  /**
   * `sequence` of the last row received: the incremental-read cursor.
   *
   * A ref, not re-read from `state.items`: after `setState` state updates only on the next render,
   * while the catch-up runs inside the same async function; reading state would take the previous
   * tail and append the same sequence twice.
   */
  const cursorRef = useRef<number | undefined>(undefined);
  /**
   * The `itemCount` the last resume baselined on. `undefined` = no baseline yet (mount/switch):
   * that frame's fetch belongs to the full refetch; the incremental effect records the baseline
   * and exits, or every mounted dashboard fires one guaranteed-empty incremental query.
   */
  const lastDrainedCountRef = useRef<number | undefined>(undefined);

  const { artifactId, runId, sessionId } = options;
  const fieldsKey = options.fields?.join(FIELD_KEY_SEPARATOR);
  const fields = useMemo(() => fieldsKey?.split(FIELD_KEY_SEPARATOR), [fieldsKey]);
  const enabled =
    options.enabled !== false && sessionId.length > 0 && runId.length > 0 && artifactId.length > 0;

  /**
   * Page from the cursor to drained. `replace` = full refetch (artifact/run switch); `append` = incremental.
   *
   * Single-flight gate (`inFlightRef`): a mid-fetch bump is normal (per-round report), and
   * reentry would append the same sequence twice. The blocked call is remembered in `pendingRef`,
   * and the running fetch catches up before settle, or a run's final report never draws
   * (nothing raises `itemCount` after it to trigger another fetch).
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
          // Page until the store says dry. The old 16-page cap (3,200 rows) guarded against loops
          // when reports capped at 256; at 65,536 it silently truncates: a finished run tagged
          // 5,000 times draws only its first 3,200 points, with no later itemCount bump
          // to resume from. Loop safety = the cursor must advance; stop when a page does not.
          for (;;) {
            const request = {
              sessionId,
              runId,
              artifactId,
              ...(cursor === undefined ? {} : { afterSequence: cursor }),
              limit: WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
            };
            const withFields = fields !== undefined && !sessionsWithoutFieldReads.has(sessionId);
            let result;
            try {
              result = await workflowRunArtifactData(withFields ? { ...request, fields } : request);
            } catch (caught) {
              if (!withFields || !isFieldsParamUnsupported(caught)) throw caught;
              sessionsWithoutFieldReads.add(sessionId);
              logger.info(
                "[workflow-artifacts] CLI lacks field selection; retrying with full items",
                { sessionId },
              );
              result = await workflowRunArtifactData(request);
            }
            if (requestVersion !== requestVersionRef.current) return;
            collected.push(...result.items);
            const lastSequence = result.items.at(-1)?.sequence;
            const advanced =
              lastSequence !== undefined && (cursor === undefined || lastSequence > cursor);
            if (lastSequence !== undefined) cursor = lastSequence;
            if (!result.hasMore || !advanced) break;
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
        logger.warn("[workflow-artifacts] failed to load dashboard items", {
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
    [artifactId, enabled, fields, runId, sessionId, workflowRunArtifactData],
  );

  // Artifact/run switch or closed->open: clear, then refetch fully; no other dashboard's points here.
  useEffect(() => {
    requestVersionRef.current += 1;
    cursorRef.current = undefined;
    lastDrainedCountRef.current = undefined;
    setState(emptyState());
    if (!enabled) return;
    void drain("replace");
  }, [drain, enabled]);

  // Incremental: an itemCount bump resumes fetching.
  //
  // No empty-local skip: a dashboard declared at the top and reported only in later rounds
  // is empty at mount; an empty-check would permanently hide its first point.
  // The mount-time duplicate fire is absorbed by the single-flight gate (refetch runs first).
  const itemCount = options.itemCount ?? 0;
  useEffect(() => {
    if (!enabled) return;
    // First frame: the refetch is in flight; record the baseline only. Declaration order runs it first.
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
