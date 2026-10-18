import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowRunWorkspaceNode } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * The script transcript listing for one workflow run.
 *
 * ```
 * live projection run.lastEventSequence bump ──┐ (refresh signal: every node event bumps it)
 *                                              ├─▶ workflowRunWorkspace({sessionId, runId}) ─▶ nodes[]
 * tab open / run switch ───────────────────────┘
 * ```
 *
 * The list carries NO bodies, so re-querying is cheap; bodies load on demand in
 * `useWorkflowRunNodeResult`. After a signal bump, coalesce 250ms before querying: one
 * `world.run` settlement emits queued/dispatched/settled, and querying per event would read
 * the same list three times.
 */

const REFRESH_DEBOUNCE_MS = 250;

interface WorkflowRunWorkspaceState {
  nodes: readonly WorkflowRunWorkspaceNode[];
  /** Read successfully at least once (placeholders and landing both wait for it). */
  loaded: boolean;
  loading: boolean;
  /** The gateway truncated the list (over maxNodes). */
  truncated: boolean;
  /** The session does not support workspace queries (older CLI). */
  unavailable: boolean;
  error: string | null;
}

/** Same missing-capability test as the artifacts hook: across JSON-RPC only the message is reliable. */
function isWorkflowRunWorkspaceCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("WorkspaceNodes");
}

export function useWorkflowRunWorkspace(options: {
  sessionId: string;
  runId: string;
  /** Refresh signal: the run's `lastEventSequence` in the live projection; absent while the run is not projected (single query). */
  refreshSignal?: number;
  enabled?: boolean;
}): WorkflowRunWorkspaceState {
  const { workflowRunWorkspace } = useV4Conversation();
  const [nodes, setNodes] = useState<readonly WorkflowRunWorkspaceNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Request version: late responses after a run/session switch must be dropped.
  const requestVersionRef = useRef(0);

  const { runId, sessionId } = options;
  const enabled = options.enabled !== false && sessionId.length > 0 && runId.length > 0;

  const fetchNodes = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    try {
      const result = await workflowRunWorkspace({ sessionId, runId });
      if (requestVersion !== requestVersionRef.current) return;
      setNodes(result.nodes);
      setTruncated(result.truncated === true);
      setUnavailable(false);
      setError(null);
      setLoaded(true);
      setLoading(false);
    } catch (caught) {
      if (requestVersion !== requestVersionRef.current) return;
      setLoading(false);
      if (isWorkflowRunWorkspaceCapabilityMissing(caught)) {
        setUnavailable(true);
        setLoaded(true);
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.warn("[workflow-workspace] failed to load workspace list", {
        error: message,
        runId,
        sessionId,
      });
      setError(message);
    }
  }, [runId, sessionId, workflowRunWorkspace]);

  // Run/session switch: drop the old list, then re-query.
  useEffect(() => {
    requestVersionRef.current += 1;
    setNodes([]);
    setLoaded(false);
    setTruncated(false);
    setUnavailable(false);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    void fetchNodes();
  }, [enabled, fetchNodes]);

  // Signal bump: coalesce, then re-query. The first mount beat belongs to the effect above; skip undefined here.
  const signal = options.refreshSignal;
  const lastSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled || signal === undefined) return;
    if (lastSignalRef.current === undefined) {
      lastSignalRef.current = signal;
      return;
    }
    if (signal <= lastSignalRef.current) return;
    lastSignalRef.current = signal;
    const timer = window.setTimeout(() => {
      void fetchNodes();
    }, REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, fetchNodes, signal]);

  return useMemo(
    () => ({ nodes, loaded, loading, truncated, unavailable, error }),
    [error, loaded, loading, nodes, truncated, unavailable],
  );
}
