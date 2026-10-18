import { useEffect, useRef, useState } from "react";
import type { V4ConversationWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Discovery query for dwf runs.
 *
 * It no longer serves as the card-join fallback -- after restart the projection is backfilled by
 * the CLI's cold materialization replaying the journal. Remaining consumers are the run directory
 * page and the task list's "finished workflows x N" count: the directory lists the last 64 runs
 * while the projection keeps 8. The cold-open first query can still land before the subscription
 * and fail, so the retry semantics below are kept as-is.
 *
 * This logic used to be inline in `SessionPane`: fired once, silently `null` on failure. Its
 * effect was declared before the lease/subscription effects and the CLI dispatches strictly
 * serially, so on reopening a historical session it always landed before the subscription -- the
 * host record was not registered yet -> `sessionNotFound` -> the fallback block vanished and the
 * card stayed forever in its "compiled but no runs" state (only script and static graph, no
 * detail-page entry). The CLI side added the cold-session prewarm; this adds the second half:
 * the retryable hop actually retries.
 */

/**
 * "Capability missing" (old CLI without the query / dwf journal unavailable, run service never
 * constructed) and ordinary failure must be separated: the former is a stable fact and retrying
 * just adds one doomed RPC per pane switch; the latter (cold session, connection jitter) merits
 * one more ask.
 *
 * Same reading as `isWorkflowRunEventsCapabilityMissing`: past JSON-RPC only the message is
 * reliable, so match both patterns -- the reasonCode if forwarded, otherwise the constructor's
 * hardcoded capability name. `sessionNotFound` is deliberately **not** capability-missing:
 * that is exactly the retryable case.
 */
export function isWorkflowRunsCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("listDynamicWorkflowRuns");
}

/**
 * Journal run summaries for a session; `null` when unavailable (or not yet fetched) -- the
 * fallback is wholly absent and the card keeps its "compiled but no runs" shape, never pretending
 * there is an entry point.
 *
 * `live` is a ready signal that the host record is registered (subscription ACK received). The
 * false->true transition on cold open is the one moment worth retrying, so there is no polling
 * or backoff here: a failure after `live` is a real failure.
 *
 * `refreshKey` is the only gap where a **post-settlement** refetch happens (the freshness source
 * for the run directory page and task-list counters): callers pass a monotonic count of settled
 * runs, so one more paged read occurs only when a run finishes mid-session. Deliberately not the
 * projection's `revision` -- that key rises per node event and would turn one read into a stream.
 */
export function useWorkflowRunJournalSummaries(options: {
  sessionId: string | null;
  live: boolean;
  /**
   * Gate declaring "this query matters for this pane"; defaults to true.
   *
   * The journal is keyed by **parent session**, and the SessionPane of a nested read-only
   * transcript (dwf actor / subagent) used to fire this query with the child session id
   * regardless. An empty result is the lesser issue; the bigger one is that the CLI's cold-session
   * prewarm would materialize a second (ghost) runtime for a **running** detached session --
   * double-writing the same event log, with the live view frozen at "working for xx seconds".
   * The CLI now gates on hasLiveConversation; this is the UI-side half: panes that should not ask
   * do not ask.
   */
  enabled?: boolean;
  /** Optional; when omitted the CLI decides the count (default 16, cap 64). */
  limit?: number;
  refreshKey?: number | string;
}): readonly V4ConversationWorkflowRunSummary[] | null {
  const { workflowRuns } = useV4Conversation();
  const { enabled = true, limit, live, refreshKey, sessionId } = options;
  const [summaries, setSummaries] = useState<readonly V4ConversationWorkflowRunSummary[] | null>(
    null,
  );
  /**
   * The **most recently** settled session and its answer (successful summaries, or `null` on
   * capability-missing).
   *
   * Records "session + answer", not a mere "asked" boolean: the pane's `effectiveSessionId`
   * changes (draft promotion, fork, task switch), and recording only the session id would make
   * returning to an asked session lose both ways -- early-return without re-query, yet forever
   * empty because the switch cleared state. Switching away and back re-reads one journal page,
   * which is cheap; a permanently empty entry point is not.
   *
   * `refreshKey` is recorded too: a rise means "this answer is stale" and triggers a refetch.
   * Capability-missing is **unaffected** by it (see below), so that case is tracked by a separate
   * flag rather than folded into this comparison.
   */
  const settledRef = useRef<{
    sessionId: string;
    refreshKey: number | string | undefined;
    summaries: readonly V4ConversationWorkflowRunSummary[] | null;
  } | null>(null);
  /**
   * Capability-missing is a **per-session** terminal fact: an old CLI / unavailable journal does
   * not change because a run finished. Tracking it apart from the settlement above is exactly so
   * a `refreshKey` rise cannot punch through -- otherwise every finished run would fire one more
   * doomed RPC, the very churn this classification was written to avoid.
   */
  const capabilityMissingSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setSummaries(null);
      return;
    }
    if (capabilityMissingSessionRef.current === sessionId) {
      setSummaries(null);
      return;
    }
    const settled = settledRef.current;
    if (settled?.sessionId === sessionId && settled.refreshKey === refreshKey) {
      // Answer already settled: a `live` rise does not spend another RPC (live runs belong to
      // the projection; the journal only backfills history).
      setSummaries(settled.summaries);
      return;
    }
    // Session switch: joining this session's card with the previous session's runs would be the
    // wrong join. (A `refreshKey` rise takes the same path: clear -> refetch, showing nothing
    // until the new answer lands.)
    setSummaries(null);
    let alive = true;
    workflowRuns({ sessionId, ...(limit === undefined ? {} : { limit }) }).then(
      (result) => {
        if (!alive) return;
        settledRef.current = { sessionId, refreshKey, summaries: result.runs };
        setSummaries(result.runs);
      },
      (error: unknown) => {
        if (!alive) return;
        if (isWorkflowRunsCapabilityMissing(error)) {
          capabilityMissingSessionRef.current = sessionId;
        } else {
          // Cold sessions are the most common case here and retry automatically on a `live`
          // rise; log the rest for triage.
          logger.warn("[workflow-run] Failed to load run summaries (journal fallback absent)", {
            error: error instanceof Error ? error.message : String(error),
            live,
            sessionId,
          });
        }
        setSummaries(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [enabled, limit, live, refreshKey, sessionId, workflowRuns]);

  return summaries;
}
