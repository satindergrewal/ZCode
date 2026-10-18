import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkflowRunArtifact,
  WorkflowRunArtifactKind,
  WorkflowRunArtifactSummary,
  WorkflowRunArtifactVersion,
} from "@zcode/shared/zcode-protocol-v4";
import { orderArtifactsPrimaryFirst } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Terminology: an artifact in this module is a **user-facing output published by the script via
 * `artifact.*`**, not a synonym for the engine-internal "script top-level return value".
 */

/**
 * Merged view of one artifact: the live projection's **fresh metadata** plus the journal's
 * **complete metadata** (version history and spec).
 *
 * Both sources are required, so this type is their union rather than either-or:
 * - The live projection (`workflowRuns[].artifacts`) deliberately carries only latest-version
 *   metadata -- it is a high-frequency state key, and including spec plus all versions would
 *   re-ship unchanged data on every frame.
 * - The journal query carries `versions` and `spec`, and **preset boards cannot render without
 *   spec**, so the journal is queried even when the run is in the live projection.
 */
export interface WorkflowRunArtifactView {
  id: string;
  kind: WorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  /** Byte size of the latest version (content artifacts only). */
  bytes?: number;
  /** Workspace-relative source path (`file` only) -- "reveal in workspace" locates by it. */
  sourcePath?: string;
  /** Latest version number. */
  version: number;
  /** Version-ascending; absent when the journal query is (old CLI / read failure), degenerating the version stepper to latest-only. */
  versions?: readonly WorkflowRunArtifactVersion[];
  /** Preset-board spec; likewise absent when the journal query is, and the board card falls back to "details unavailable". */
  spec?: unknown;
  /** Count of report entries tagged with this id -- the board data hook's **refresh signal**. */
  itemCount: number;
  /** The run's deliverable; counts when either source flags it. */
  primary?: true;
}

interface WorkflowRunArtifactsViewState {
  artifacts: readonly WorkflowRunArtifactView[];
  /**
   * The **primary** metadata source. `live` = the run is still in the live projection (journal
   * only backfills spec/versions); `journal` = cold recovery or evicted by the 8-run cap, with
   * the entire list from the journal.
   *
   * This is not a "journal was queried" flag -- both cases query -- but an observable criterion
   * for readers and tests: did this list grow with the live run, or was it read back from the
   * log after the fact?
   */
  source: "live" | "journal";
  loading: boolean;
  /** The session does not support artifact queries (old CLI): content artifacts still list; preset boards cannot render. */
  unavailable: boolean;
  error: string | null;
  /**
   * This list is **complete**: the live projection is present (its cap of 32 equals the
   * engine's per-run cap, so never truncated), or the journal has answered. The completion card
   * uses it to choose `+N` vs an ellipsis -- notification payloads truncate at 8, but that is a
   * **payload** fact, not a fact about this list; with the capability missing (old CLI) the list
   * may genuinely be incomplete, so it stays false.
   */
  complete: boolean;
}

/**
 * "Capability missing" (the CLI lacks the `listArtifacts` host queries) and "this run has no
 * artifacts" must be distinguishable: the former makes preset cards say "details unavailable",
 * the latter is a whole-section absence. Same reading as `useWorkflowRunJournalSummaries` --
 * after crossing JSON-RPC only the message is reliable, so match both the reasonCode and the
 * capability-name patterns.
 */
function isWorkflowRunArtifactsCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("ArtifactRows");
}

/**
 * Shape signature of the live-projection summaries: `id:kind:version` joined per entry.
 *
 * Journal re-queries key on this, not on the array reference: every incoming `report` builds a
 * new array (`itemCount` changed), but entry-count changes **do not** change any artifact's
 * version or spec -- keying on the reference would re-query the journal once per report for a
 * report-driven board. Conversely, a new artifact or a new version under the same id both change
 * this signature, and those two events **must** re-query (new artifacts need spec, new versions
 * need versions).
 */
function summariesSignature(summaries: readonly WorkflowRunArtifactSummary[] | undefined): string {
  if (summaries === undefined) return "";
  return summaries.map((summary) => `${summary.id}:${summary.kind}:${summary.version}`).join("|");
}

function viewFromJournal(record: WorkflowRunArtifact): WorkflowRunArtifactView {
  return {
    id: record.id,
    kind: record.kind,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.contentType === undefined ? {} : { contentType: record.contentType }),
    ...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
    ...(record.spec === undefined ? {} : { spec: record.spec }),
    // journal entries carry no bytes (bytes hang off versions), so take it from the latest.
    ...(() => {
      const latest = record.versions.at(-1);
      return latest?.bytes === undefined ? {} : { bytes: latest.bytes };
    })(),
    version: record.version,
    versions: record.versions,
    itemCount: record.itemCount,
    ...(record.primary === true ? { primary: true as const } : {}),
  };
}

function viewFromSummary(summary: WorkflowRunArtifactSummary): WorkflowRunArtifactView {
  return {
    id: summary.id,
    kind: summary.kind,
    ...(summary.title === undefined ? {} : { title: summary.title }),
    ...(summary.contentType === undefined ? {} : { contentType: summary.contentType }),
    ...(summary.bytes === undefined ? {} : { bytes: summary.bytes }),
    version: summary.version,
    itemCount: summary.itemCount ?? 0,
    ...(summary.primary === true ? { primary: true as const } : {}),
  };
}

/**
 * Merge the two sources. **Order and identity are decided by the live projection** (the list
 * growing with the run); the journal only fills fields the projection deliberately omits.
 * ids present in the journal but not the projection are appended -- those are artifacts that
 * really exist after the projection's cap of 32 stopped accepting new ones; dropping them would
 * make a full run's artifacts vanish.
 *
 * Deliverables lead afterwards (the rest keep first-published order): the live projection
 * upserts in publication order and the journal path is pre-sorted, so both paths converge on
 * one order here.
 */
function mergeArtifacts(
  live: readonly WorkflowRunArtifactSummary[] | undefined,
  journal: readonly WorkflowRunArtifact[] | undefined,
): readonly WorkflowRunArtifactView[] {
  return orderArtifactsPrimaryFirst(mergeArtifactSources(live, journal));
}

function mergeArtifactSources(
  live: readonly WorkflowRunArtifactSummary[] | undefined,
  journal: readonly WorkflowRunArtifact[] | undefined,
): readonly WorkflowRunArtifactView[] {
  if (live === undefined) {
    return journal === undefined ? [] : journal.map(viewFromJournal);
  }
  const byId = new Map((journal ?? []).map((record) => [record.id, record] as const));
  const merged = live.map((summary) => {
    const record = byId.get(summary.id);
    if (record === undefined) return viewFromSummary(summary);
    byId.delete(summary.id);
    // The live projection's version is fresher (the journal query may lag one publication);
    // spec/versions exist only in the journal. Take `itemCount` from the live projection too:
    // it is the refresh signal, and lagging one beat underdraws a dot.
    return {
      ...viewFromJournal(record),
      ...viewFromSummary(summary),
      ...(record.versions.length === 0 ? {} : { versions: record.versions }),
      ...(record.spec === undefined ? {} : { spec: record.spec }),
      ...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
      ...(record.description === undefined ? {} : { description: record.description }),
    } satisfies WorkflowRunArtifactView;
  });
  return [...merged, ...[...byId.values()].map(viewFromJournal)];
}

/**
 * Artifact list for one workflow run.
 *
 * ```
 * live projection workflowRuns[].artifacts ─┐
 *   (fresh, no spec, cap 32)                ├─▶ merge ─▶ artifacts[]
 * journal workflowRunArtifacts ────────────┘
 *   (complete, with versions + spec)
 * ```
 *
 * The journal query fires in **both** cases: to backfill spec/versions when the live projection
 * is present (boards cannot render without spec), and as the sole source when it is absent
 * (cold recovery / evicted by the 8-run cap). The re-query trigger is a change in the summary
 * **shape signature**, not the array reference -- see `summariesSignature`.
 */
export function useWorkflowRunArtifacts(options: {
  sessionId: string;
  runId: string;
  /**
   * The run's artifact summaries from the live projection. `undefined` = the run is not in the
   * live projection (`source` becomes journal); an empty array = present with zero artifacts.
   * The two are semantically different -- do not collapse the former into the latter.
   */
  live?: readonly WorkflowRunArtifactSummary[];
  enabled?: boolean;
}): WorkflowRunArtifactsViewState {
  const { workflowRunArtifacts } = useV4Conversation();
  const [journal, setJournal] = useState<readonly WorkflowRunArtifact[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Request version: late responses after a run/session switch must be dropped, not leaked
  // into the new run's list.
  const requestVersionRef = useRef(0);

  const enabled =
    options.enabled !== false && options.sessionId.length > 0 && options.runId.length > 0;
  const signature = summariesSignature(options.live);
  const { sessionId, runId } = options;

  const fetchArtifacts = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await workflowRunArtifacts({ sessionId, runId });
      if (requestVersion !== requestVersionRef.current) return;
      setJournal(result.artifacts);
      setUnavailable(false);
      setLoading(false);
    } catch (caught) {
      if (requestVersion !== requestVersionRef.current) return;
      setLoading(false);
      if (isWorkflowRunArtifactsCapabilityMissing(caught)) {
        // A missing capability is not an error: content-artifact cards still render from the
        // live projection; only boards cannot.
        setJournal(undefined);
        setUnavailable(true);
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.warn("[workflow-artifacts] Failed to list artifacts", { error: message, runId, sessionId });
      setError(message);
    }
  }, [runId, sessionId, workflowRunArtifacts]);

  useEffect(() => {
    // Run/session switch: drop the old run's list before re-querying. A stale list on screen is
    // far worse than a blank one.
    requestVersionRef.current += 1;
    setJournal(undefined);
    setUnavailable(false);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    void fetchArtifacts();
    // `signature` is a deliberate dependency: new artifacts and new versions under the same id
    // must re-query; `itemCount` changes must not.
  }, [enabled, fetchArtifacts, signature]);

  return useMemo(
    () => ({
      artifacts: mergeArtifacts(options.live, journal),
      source: options.live === undefined ? "journal" : "live",
      loading,
      unavailable,
      error,
      complete: options.live !== undefined || journal !== undefined,
    }),
    [error, journal, loading, options.live, unavailable],
  );
}
