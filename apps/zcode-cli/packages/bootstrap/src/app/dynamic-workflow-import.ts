// ============================================================
// amend-resume import construction: predecessor journal -> ImportedRunCache
// ============================================================
//
// This module is amend-resume's ONLY predecessor reader; three call sites share it:
//   1. port.amend's precheck ({@link preflightAmendImport}): decides before stopping the in-flight
//      predecessor -- run_not_found / missing_boundaries; when rejected the predecessor keeps running and no row is created;
//   2. port.amend building the cache after the predecessor settles ({@link buildImportedCache});
//   3. port.resume when record.resumedFrom is present: rebuilds the same table after a crash.
//
// Both paths share one construction rule: a revised run's journal holds only the consumed execution prefix; unconsumed imports must be rebuilt.
// Completed entries come from the journal alone, in journal insertion order; an unfinished ask's boundary also depends on the source transcript.
//
// One exception must be called out: it is this table's FIRST number that is not a pure function of the journal -- the
// boundary of an in-flight ask's continuation (inFlight) is the predecessor session's CURRENT message count, not a journal column.
//
// It is mostly stable across the two constructions, relying on "the predecessor has settled and nobody writes its session":
//   - at commit, {@link AmendImportOptions.quietSessions} guarantees it (the superseded predecessor just aborted; the driver waits for
//     its turn to land; sessions not waited for do not continue);
//   - at rebuild the predecessor is long terminal and has no driver in this process, so nobody is writing; the set is omitted
//     (absent = all quiet).
//
// But "mostly" is not "always", and need not be: two paths let a rebuild compute a LARGER M -- the predecessor was resumed
// again and wrote more turns (a superseded predecessor cannot be resumed, so only "revise a long-stopped run, then
// resume it" constructs this), or a late background notification landed in that session. Both only make M LARGER,
// and correctness never depends on M being stable:
//   - the copied-in side has its gate shut tight: seedActorTranscript writes only into targets that are empty or hold
//     nothing but this session's seed messages (property 2 in workflow-actor-transcript.ts). Once the successor writes its own
//     messages, a larger M coming back is not written by a single byte, so "predecessor messages appended after this session's history"
//     can never silently happen;
//   - while the successor has no own messages, a larger M copies a LATER snapshot of the same ask; order still comes from the index
//     (seed ids are pure over (session, index); recopy is upsert), so it is just extra context, never a corruption.
// This is also the blanket rule for every FUTURE non-journal fact: no need to prove each one cannot grow; the copy point closes it once.
//
// One exception must be called out: it is this table's FIRST number that is not a pure function of the journal -- the
// boundary of an in-flight ask's continuation (inFlight) is the predecessor session's CURRENT message count, not a journal column.
//
// It is mostly stable across the two constructions, relying on "the predecessor has settled and nobody writes its session":
//   - at commit, {@link AmendImportOptions.quietSessions} guarantees it (the superseded predecessor just aborted; the driver waits for
//     its turn to land; sessions not waited for do not continue);
//   - at rebuild the predecessor is long terminal and has no driver in this process, so nobody is writing; the set is omitted
//     (absent = all quiet).
//
// But "mostly" is not "always", and need not be: two paths let a rebuild compute a LARGER M -- the predecessor was resumed
// again and wrote more turns (a superseded predecessor cannot be resumed, so only "revise a long-stopped run, then
// resume it" constructs this), or a late background notification landed in that session. Both only make M LARGER,
// and correctness never depends on M being stable:
//   - the copied-in side has its gate shut tight: seedActorTranscript writes only into targets that are empty or hold
//     nothing but this session's seed messages (property 2 in workflow-actor-transcript.ts). Once the successor writes its own
//     messages, a larger M coming back is not written by a single byte, so "predecessor messages appended after this session's history"
//     can never silently happen;
//   - while the successor has no own messages, a larger M copies a LATER snapshot of the same ask; order still comes from the index
//     (seed ids are pure over (session, index); recopy is upsert), so it is just extra context, never a corruption.
// This is also the blanket rule for every FUTURE non-journal fact: no need to prove each one cannot grow; the copy point closes it once.
//
// The only IO is the journal read and the transcript-count read (both injected via narrow ports); this module never touches session storage.

import type { Logger, SessionId } from "@zcode/contracts";
import type {
  ActorRecord,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedInFlightAsk,
  ImportedRunCache,
  ImportedWorldEntry,
  ListActorsOptions,
  ListNodesOptions,
  NodeKind,
  NodeRecord,
  RunRecord,
} from "@zcode/dynamic-workflow";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";

/**
 * Journal read surface needed to build the import cache: three read methods, all by runId.
 *
 // * Structurally a strict subset of the engine's JournalStorePort (production passes the journal itself). Narrowed for the same reason as
 // * {@link ActorTranscriptStore}: the builder reads only these three; typing the whole port would make "the import build depends on
 // * the journal's full ability set (writes included)" a true statement -- it writes not one byte. Predecessor-read-only is an invariant; let the type say it.
 */
interface ImportedCacheJournalReader {
  getRun(runId: string): RunRecord | undefined;
  listActors(runId: string, opts: ListActorsOptions): ActorRecord[];
  listNodes(runId: string, opts: ListNodesOptions): NodeRecord[];
}

/**
 // * Node kinds the import cache reads: asks (continuation prefix) and world rows (world-read queue). report/artifact rows never
 // * enter the cache, not one is read -- a predecessor may have reported 65,536 items (docs/execution-engine.md, "Reading the journal").
 */
const IMPORTED_NODE_KINDS: readonly NodeKind[] = ["ask", "world-read", "world-run"];

/**
 * The three refusal reasons for import construction. **Discriminant keys, not prose**: the model
 * picks its next move from them (another run / wait for settlement / abandon amendment for a fresh
 *
 * Literally the same set as the port's `DynamicWorkflowRunSubmitRefusalReason` (contracts): the
 * service forwards these reasons verbatim, so drift becomes a compile error rather than a
 * discriminant quietly turning `undefined`. Deliberately not imported from contracts: this is the
 */
type ImportedCacheRefusalReason =
  /** No such predecessor run in the journal. */
  | "run_not_found"
  /** Predecessor still in flight (non-terminal). Amending **any terminal** run is legal, completed included. */
  | "not_amendable"
  /** Predecessor has completed asks without message boundaries: reject wholesale for marker-less predecessors (no fallback degradation). */
  | "missing_boundaries";

/** Build result: success carries the table and lineage pointer; failure only the discriminant. */
type BuildImportedCacheResult =
  | { ok: true; cache: ImportedRunCache; resumedFrom: string }
  | { ok: false; reason: ImportedCacheRefusalReason };

/**
 * The two amend-precheck refusal reasons: literally the same set as the port's
 * `DynamicWorkflowRunAmendRefusalReason`. No `not_amendable` - an in-flight predecessor is stopped
 */
type AmendPreflightRefusalReason = Exclude<ImportedCacheRefusalReason, "not_amendable">;

type AmendPreflightResult =
  | { ok: true; run: RunRecord }
  | { ok: false; reason: AmendPreflightRefusalReason };

/**
 * The amend **precheck**: predecessor exists and every completed ask has a message boundary.
 * **Status-blind** - both are properties of the predecessor journal that stopping cannot change,
 * so they are decidable before stopping; precheck-then-stop is what keeps a refused amend from
 * leaving a needlessly stopped run. A settled ask of an in-flight run is already persisted with
 */
export function preflightAmendImport(
  journal: Pick<ImportedCacheJournalReader, "getRun" | "listNodes">,
  predecessorRunId: string,
): AmendPreflightResult {
  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  // The boundary check reads only an ask row's status and message_boundary, never its answer.
  const asks = journal.listNodes(predecessorRunId, { kinds: ["ask"], withResult: false });
  if (!completedAsksHaveBoundaries(asks)) {
    return { ok: false, reason: "missing_boundaries" };
  }
  return { ok: true, run };
}

/**
 // * Gate 3's predicate, shared by precheck and build: a missing marker has two causes -- a journal written before the marker column
 // * existed, or driver-side accounting failure -- both mean "this run's boundary accounting is untrustworthy", hence strict over the whole
 // * table, not just the rows that would be imported. Unfinished asks lacking boundaries are NORMAL (they never enter the import prefix), so only completed rows count.
 */
function completedAsksHaveBoundaries(nodes: readonly NodeRecord[]): boolean {
  for (const node of nodes) {
    if (node.kind !== "ask" || node.status !== "completed") continue;
    if (node.messageBoundary === undefined) return false;
  }
  return true;
}

/**
 // * The three dependencies the import-cache build needs. Field names match DynamicWorkflowRunServiceDeps verbatim (this interface is a
 // * structural subset), so the run service's two call sites pass deps through untouched -- one more rename layer is one more
 // * wiring that can drift, and drifted wiring reads as silent degradation like "transcript hooked up but honesty check never runs".
 */
interface AmendImportDeps {
  journal: ImportedCacheJournalReader;
  /**
   //   * Session-transcript read side. When present, one extra SOURCE HONESTY check runs ({@link honorsBoundary}); when absent the
   //   * candidate is still accepted -- the driver-side seed fulfillment still fails loudly, which is the corruption-level backstop.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
}

/**
 * **Runtime evidence** visible at build time, as opposed to journal facts. Today exactly one:
 *
 * Deliberately kept out of {@link AmendImportDeps}: deps are the assembly (journal, transcript
 * surface, logger) and stay the same instance for the process lifetime; this object is an
 * observation valid for **this build only** and may differ between the two builds. Folding it
 */
export interface AmendImportOptions {
  /**
   //   * Predecessor session ids that are QUIET (no turn being written). Affects only in-flight-ask continuation: the completed prefix's boundary is a
   //   * journal fact, independent of how long the session is now.
   *
   //   * ABSENT = ALL QUIET, not "none quiet". The two call sites each hold half: amend just aborted the in-flight predecessor whose
   //   * interrupted turn may still be landing its last messages, so it passes the driver-computed set; the resume-side rebuild
   //   * ({@link rebuildImportedCacheForResume}) faces a long-settled predecessor with no driver in this process,
   //   * nothing writing its session -- absence means exactly that. The reverse polarity would make the rebuilt table miss one
   //   * inFlight versus the committed one, and both sides must be the same table (see the file header).
   */
  quietSessions?: ReadonlySet<string>;
}

/**
 // * Reads the predecessor journal and builds an {@link ImportedRunCache}. PURELY DETERMINISTIC: the same journal state always yields the same table.
 *
 * Three gates in order (gate before build: a failed gate reads nothing):
 *   1. predecessor missing -> `run_not_found`;
 *   2. predecessor non-terminal -> `not_amendable`;
 *   3. predecessor has completed asks without `messageBoundary` -> `missing_boundaries`. *
 *
 * has two causes - journals written before the marker column existed, and driver-side accounting
 * failures - both meaning "this run's boundary accounting is untrustworthy", not "this one row
 * slipped". Row-by-row admission would let a half-broken ledger produce a plausible-looking table
 * that truncates at the wrong place on disagreement (model-visible context quietly diverging from
 * the journal boundary). A journal missing completed-ask boundaries is rejected wholesale; no
 * possibly-wrong transcript boundaries are synthesized. Unfinished asks without boundaries are
 */
export async function buildImportedCache(
  deps: AmendImportDeps,
  predecessorRunId: string,
  options?: AmendImportOptions,
): Promise<BuildImportedCacheResult> {
  const { actorTranscriptStore: transcripts, journal, logger } = deps;

  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  // The amendable set = any terminal state, deliberately NOT reusing plain resume's isResumableRecord: that predicate gates
  // byte-identical resume (stopped), while amendment is most useful for exactly the two it excludes:
  // real script failures (fix the bug, keep the cache) and completed (warm-start an extension). The two sets differ on purpose.
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return { ok: false, reason: "not_amendable" };

  const nodes = journal.listNodes(predecessorRunId, {
    kinds: IMPORTED_NODE_KINDS,
    withResult: true,
  });
  if (!completedAsksHaveBoundaries(nodes)) return { ok: false, reason: "missing_boundaries" };

  // Ask rows grouped by actor ONCE: previously every candidate actor scanned the whole node table (O(actors x rows)).
  const asksByActor = groupAsksByActor(nodes);
  const actors = new Map<string, ImportedActorCandidate>();
  const records = journal.listActors(predecessorRunId, { withPersona: true });
  for (const record of namedUniqueActors(records, logger)) {
    const name = record.name!;
    const candidate = await buildActorCandidate({
      actor: record,
      journal,
      ...(logger === undefined ? {} : { logger }),
      asks: asksByActor.get(actorKey(record.siteId, record.ordinal)) ?? [],
      predecessorRunId,
      ...(options?.quietSessions === undefined ? {} : { quietSessions: options.quietSessions }),
      ...(transcripts === undefined ? {} : { transcripts }),
    });
    if (candidate !== undefined) actors.set(name, candidate);
  }

  return {
    ok: true,
    cache: { actors, world: buildWorldQueues(nodes) },
    resumedFrom: predecessorRunId,
  };
}

/**
 * Actor rows in the predecessor eligible as candidates: non-empty name and unique within the run. *
 *
 * compare). Duplicate names skip **both**: the engine's `DuplicateActorName` is a later runtime
 * invariant, so journals written before it can genuinely hold duplicate-name rows, and
 * by-name candidate pickup on such a predecessor is a dice roll. Skipping both beats picking one:
 * the cost is both actors rerunning fresh, versus the wrong pick serving another actor's session
 */
function namedUniqueActors(records: ActorRecord[], logger?: Logger): ActorRecord[] {
  const byName = new Map<string, ActorRecord[]>();
  for (const record of records) {
    const name = record.name;
    if (name === undefined || name === "") continue;
    const bucket = byName.get(name);
    if (bucket === undefined) byName.set(name, [record]);
    else bucket.push(record);
  }
  const unique: ActorRecord[] = [];
  for (const [name, bucket] of byName) {
    if (bucket.length === 1) {
      unique.push(bucket[0]!);
      continue;
    }
    logger?.warn?.("Dynamic workflow amend: duplicate actor name in predecessor, skipped", {
      actorName: name,
      count: bucket.length,
      event: "dynamic_workflow.amend.duplicate_actor_name",
      module: "bootstrap.app",
    });
  }
  return unique;
}

/**
 // * An actor's importable prefix + transcript source. Any missing ingredient returns undefined (the actor reruns fresh).
 *
 // * DEGRADE, DON'T FAIL is the motto here (the opposite of the gate's all-or-nothing): missing prefix, missing persona, no session on the chain,
 // * a cleaned-up source session -- all just "this actor has no cache"; no cache row in the journal means no cache, no lying.
 // * The only whole-run rejection is untrustworthy boundary accounting, which would truncate an ALREADY-ACCEPTED candidate at the wrong point.
 */
async function buildActorCandidate(input: {
  actor: ActorRecord;
  journal: ImportedCacheJournalReader;
  logger?: Logger;
  /** The actor's ask rows (grouped by actor, see {@link groupAsksByActor}). */
  asks: readonly NodeRecord[];
  predecessorRunId: string;
  quietSessions?: ReadonlySet<string>;
  transcripts?: ActorTranscriptStore;
}): Promise<ImportedActorCandidate | undefined> {
  const { actor, asks, journal, logger, predecessorRunId, quietSessions, transcripts } = input;
  const name = actor.name!;

  // The persona is the frozen identity the engine landed at createActor, so normally present; absence means the row was
  // rewritten by some external force. Runtime comparison has nothing to compare against -- drop the candidate rather than pass {}.
  if (actor.persona === undefined) return undefined;

  const { entries, next } = completedAskPrefix(asks);
  // Neither a completed prefix nor an in-flight ask behind it: this actor truly has nothing
  // importable. Early return saves the chain walk and one transcript read below.
  if (entries.length === 0 && next?.status !== "running") return undefined;

  const source = resolveTranscriptSource({
    actorName: name,
    journal,
    startRunId: predecessorRunId,
  });
  if (source === undefined) {
    // No ancestor on the chain holds a session for this actor (never created, or cleaned up). Full-fidelity transcript is this feature's
    // verdict; without a transcript there is no context to continue -- degrade to a fresh actor.
    logger?.info?.("Dynamic workflow amend: no transcript source for actor, import dropped", {
      actorName: name,
      event: "dynamic_workflow.amend.transcript_source_missing",
      module: "bootstrap.app",
      runId: predecessorRunId,
    });
    return undefined;
  }

  // An empty prefix bounds at 0 (no completed exchanges; continuation can only count from 0).
  const boundary = entries.length === 0 ? 0 : entries[entries.length - 1]!.messageBoundary;
  // The transcript count is READ ONCE: the source-honesty check and the in-flight ask's continuation position use the same number.
  // Reading twice means two observation windows on one fact, and they can disagree.
  const messageCount =
    transcripts === undefined ? undefined : await countSource(transcripts, source.sessionId);
  if (transcripts !== undefined && (messageCount === undefined || messageCount < boundary)) {
    logger?.warn?.(
      "Dynamic workflow amend: transcript source shorter than boundary, import dropped",
      {
        actorName: name,
        event: "dynamic_workflow.amend.transcript_source_short",
        messageBoundary: boundary,
        module: "bootstrap.app",
        sessionId: source.sessionId,
      },
    );
    return undefined;
  }

  const inFlight = resolveInFlightAsk({
    actor,
    boundary,
    ...(logger === undefined ? {} : { logger }),
    ...(messageCount === undefined ? {} : { messageCount }),
    ...(next === undefined ? {} : { next }),
    predecessorRunId,
    ...(quietSessions === undefined ? {} : { quietSessions }),
    sourceSessionId: source.sessionId,
  });
  // Empty prefix and no continuation deal: this candidate carries not one byte; accepting it only makes the engine create a session for an empty table.
  if (entries.length === 0 && inFlight === undefined) return undefined;

  return {
    persona: actor.persona,
    entries,
    ...(inFlight === undefined ? {} : { inFlight }),
    transcriptSourceSessionId: source.sessionId,
    ...(source.resolvedModel === undefined ? {} : { resolvedModel: source.resolvedModel }),
  };
}

/**
 // * The ask still IN FLIGHT when the predecessor stopped (docs/execution-engine.md, "What is imported"). Five conditions, all required:
 *
 // *   1. a row exists right after the prefix and is running -- cancelled asks keep their running row, so stopped
 // *      runs have one too; failed and seq holes are not "in flight", just two other reasons a prefix stops;
 // *   2. the transcript source is the predecessor's OWN row's session: the unfinished half of the conversation exists only there; a source
 // *      resolved from earlier ancestors carries only complete prefixes (each hop guarantees prefix equivalence only);
 // *   3. the session count is readable (transcript side present and readable) -- no count, no continuation point, nothing for the driver to truncate to;
 // *   4. the session is QUIET, see {@link AmendImportOptions.quietSessions};
 // *   5. the count is STRICTLY GREATER than the prefix boundary. A queued-never-dispatched ask has no extra transcript to carry, and a count
 // *      equal to the boundary (or 0) would make the driver seed a "nothing but the prefix" or empty segment
 // *      while marking the actor as continued -- divergence detection and transcript content would then disagree.
 *
 // * Any condition failing means just NO CONTINUATION (the completed prefix still imports), matching this module's degrade-don't-fail motto.
 */
function resolveInFlightAsk(input: {
  actor: ActorRecord;
  boundary: number;
  logger?: Logger;
  messageCount?: number;
  next?: NodeRecord;
  predecessorRunId: string;
  quietSessions?: ReadonlySet<string>;
  sourceSessionId: string;
}): ImportedInFlightAsk | undefined {
  const { actor, boundary, logger, messageCount, next, quietSessions, sourceSessionId } = input;
  if (next === undefined || next.status !== "running") return undefined;

  const drop = (reason: string): undefined => {
    logger?.info?.("Dynamic workflow amend: in-flight ask not carried", {
      actorName: actor.name,
      event: "dynamic_workflow.amend.in_flight_dropped",
      module: "bootstrap.app",
      reason,
      runId: input.predecessorRunId,
      sessionId: sourceSessionId,
    });
    return undefined;
  };

  if (actor.sessionId === undefined || actor.sessionId !== sourceSessionId) {
    return drop("transcript_source_is_ancestor");
  }
  if (messageCount === undefined) return drop("no_transcript_count");
  // Absent = all quiet (see {@link AmendImportOptions.quietSessions}).
  if (quietSessions !== undefined && !quietSessions.has(sourceSessionId)) {
    return drop("session_not_quiescent");
  }
  if (messageCount <= boundary) return drop("no_transcript_beyond_prefix");

  return { inputHash: next.inputHash, messageBoundary: messageCount };
}

/**
 * The actor's **longest all-completed ask prefix** (contiguous actorSeq 0..k) plus the row
 *
 * The prefix stops dead at the first non-completed entry; all three stop shapes are handled
 * alike: failure, mid-crash (running), index gap. * A failed ask is **non-binding** for the new run (models are stochastic; amendment often exists
 * to get past one failure), so it does not import itself; but skipping it while importing later
 // * while the cache claims it never happened. Stopping at the first non-completed row is the only self-consistent reading (spec, "What is imported").
 *
 * self-consistent reading. *
 * `next` is exactly the row that **stopped the prefix** (absent on a gap). It lives and dies with
 * the prefix because the in-flight ask is by definition this row: a second scan for
 */
function completedAskPrefix(asks: readonly NodeRecord[]): {
  entries: ImportedAskEntry[];
  next?: NodeRecord;
} {
  const bySeq = new Map<number, NodeRecord>();
  for (const node of asks) {
    if (node.actorSeq === undefined) continue;
    bySeq.set(node.actorSeq, node);
  }

  const entries: ImportedAskEntry[] = [];
  for (let seq = 0; ; seq++) {
    const node = bySeq.get(seq);
    if (node === undefined || node.status !== "completed") {
      return { entries, ...(node === undefined ? {} : { next: node }) };
    }
    // The boundary must be present: gate 3 already vetted the whole predecessor, so this is not an optimistic read but the invariant kept.
    const entry: ImportedAskEntry = {
      inputHash: node.inputHash,
      result: node.result,
      messageBoundary: node.messageBoundary!,
    };
    if (node.stats !== undefined) entry.stats = node.stats;
    entries.push(entry);
  }
}

/**
 // * Walk back the resumed_from chain to the MOST RECENT ancestor run holding a session for this actor name.
 *
 // * Why walk the chain: if actor X hit the cache for all of run B, then B never created a session for it (lazy creation), so when B->C
 // * revises and must continue X, the transcript lives in A. The count boundary survives prefix copies, so at ANY session-holding
 // * ancestor, the boundary value B copied is directly usable -- that is the foundation chain-amendment stands on.
 *
 // * resolvedModel and the session come from the SAME row: the pin means "do not switch models while continuing this transcript"; taking it
 // * from another row is making a promise about a transcript it does not belong to.
 *
 // * Cycle defense (seen) is pure defense: supersede only points to earlier finished runs, no cycle is constructible. But a corrupt
 // * graph would loop forever here, and the defense costs one Set.
 */
function resolveTranscriptSource(input: {
  actorName: string;
  journal: ImportedCacheJournalReader;
  startRunId: string;
}): { sessionId: string; resolvedModel?: string } | undefined {
  const { actorName, journal, startRunId } = input;
  const seen = new Set<string>();
  let runId: string | undefined = startRunId;

  while (runId !== undefined && !seen.has(runId)) {
    seen.add(runId);
    // Push the by-name row lookup into SQL and skip persona: previously every candidate actor, at every chain generation, read the whole actor table
    // (system prompts included) and filtered by name.
    const matches = journal.listActors(runId, { name: actorName, withPersona: false });
    // 0 = this generation has no such actor (the chain breaks for this name); >1 = duplicate names, session-by-name becomes a dice roll.
    // Both stop here instead of walking further up: an earlier generation's session is not THIS transcript's source.
    if (matches.length !== 1) return undefined;
    const actor = matches[0]!;
    if (actor.sessionId !== undefined) {
      return {
        sessionId: actor.sessionId,
        ...(actor.resolvedModel === undefined ? {} : { resolvedModel: actor.resolvedModel }),
      };
    }
    runId = journal.getRun(runId)?.resumedFrom;
  }
  return undefined;
}

/**
 // * The source session's current message count; undefined on read failure.
 *
 // * Two readers share this single read (see {@link buildActorCandidate}):
 *
 // *   - the SOURCE HONESTY check (count >= prefix boundary). It stitches the driver's FAIL-LOUD semantics to the spec's DEGRADE
 // *     semantics: the driver's seedActorTranscript throws DriverError on a short session (corruption level,
 // *     property 3 there), while the spec says missing transcript degrades silently to a fresh run. Both are right, at different scopes:
 // *     FORESEEABLE missing ingredients (cleaned/truncated session) should drop the candidate at build time, and the driver-side
 // *     failure thus degenerates to a backstop for what truly should never happen.
 // *   - the in-flight ask's continuation position (see {@link resolveInFlightAsk}).
 *
 // * Read failure counts as "cannot honor": the builder does not classify session-store errors, and any unreadable source is not a usable source.
 // * The counting semantics must match the driver's accounting and core's rehydration -- three readers, one access surface, see
 // * the header of workflow-actor-transcript.ts.
 */
async function countSource(
  transcripts: ActorTranscriptStore,
  sessionId: string,
): Promise<number | undefined> {
  try {
    return (await transcripts.messages({ sessionID: sessionId as SessionId })).length;
  } catch {
    return undefined;
  }
}

/**
 * World-node content table: `inputHash` -> record queue in journal insertion order (nth occurrence
 *
 * Keys reuse the **predecessor-recorded inputHash**, never recomputed: the engine's hash semantics
 * for `{op,args}` (worldRead in engine.ts) are exactly what that column holds; recomputing here
 * would duplicate the hash contract, and once it drifts the symptom is a cache that misses for no
 *
 * Completed only: failed world reads re-execute (failures are non-binding for the new run), let
 * alone running ones. * world-run and world-read share the table - importing world-run is a **safety feature**, not an
 * optimization: an amended continuation must never silently replay an already-journaled effect
 */
/** Actor coordinate key (same shape as the engine's refToString). */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}@${ordinal}`;
}

/** Groups the predecessor's ask rows by actor, journal order preserved within a group. */
function groupAsksByActor(nodes: readonly NodeRecord[]): Map<string, NodeRecord[]> {
  const groups = new Map<string, NodeRecord[]>();
  for (const node of nodes) {
    if (node.kind !== "ask" || node.actorSiteId === undefined || node.actorOrdinal === undefined) {
      continue;
    }
    const key = actorKey(node.actorSiteId, node.actorOrdinal);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [node]);
    else group.push(node);
  }
  return groups;
}

function buildWorldQueues(nodes: readonly NodeRecord[]): ReadonlyMap<string, ImportedWorldEntry[]> {
  const world = new Map<string, ImportedWorldEntry[]>();
  for (const node of nodes) {
    if (node.kind !== "world-read" && node.kind !== "world-run") continue;
    if (node.status !== "completed") continue;
    const queue = world.get(node.inputHash);
    const entry: ImportedWorldEntry = {
      inputHash: node.inputHash,
      kind: node.kind,
      result: node.result,
    };
    if (queue === undefined) world.set(node.inputHash, [entry]);
    else queue.push(entry);
  }
  return world;
}

/**
 // * Resume-side entry: rebuild the revised run's import cache. ANY failure degrades, never rejects the resume.
 *
 // * Shares {@link buildImportedCache} with the commit side -- not convenience but a correctness premise: a revised run's
 // * journal is self-contained only for the consumed prefix; unconsumed imports come back through this rebuild, and two different tables would mean
 // * "rebuild" becoming "build another one".
 *
 // * Three reasons why rebuild-failure differs utterly from commit-time build failure:
 // *   - the revised run already exists; rejecting resume turns a resumable run into a permanently stuck one;
 // *   - consumed hits are REAL rows in this run's journal; replay does not need the table -- the run's self-containedness does not depend on it;
 // *   - unconsumed imports degrade to live re-execution: correct, just spending tokens that could have been saved.
 *
 // * So the gate's three reasons are not even distinguished here: for resume, run_not_found (predecessor cleaned up) and
 // * missing_boundaries are the same thing -- "no cache available this time". The predecessor journal is thus the revised run's
 // * liveness dependency, but only an accelerator: losing it costs money, never correctness. Log info to explain the bill later.
 *
 // * WITHOUT {@link AmendImportOptions.quietSessions}: by here the predecessor is long terminal with no driver in this
 // * process and nothing writing its sessions. Passing an empty set would make the rebuilt table miss one
 // * inFlight versus the committed one, and both sides must be the same table (see the file header).
 */
export async function rebuildImportedCacheForResume(
  deps: AmendImportDeps,
  /** The resumed amendment run and its `resumed_from` (caller has verified the latter exists). */
  run: { runId: string; predecessorRunId: string },
): Promise<ImportedRunCache | undefined> {
  const { predecessorRunId, runId } = run;
  const built = await buildImportedCache(deps, predecessorRunId);
  if (built.ok) return built.cache;
  deps.logger?.info?.("Dynamic workflow amend cache rebuild skipped; resuming without it", {
    event: "dynamic_workflow.amend.rebuild_skipped",
    module: "bootstrap.app",
    reason: built.reason,
    resumedFrom: predecessorRunId,
    runId,
  });
  return undefined;
}
