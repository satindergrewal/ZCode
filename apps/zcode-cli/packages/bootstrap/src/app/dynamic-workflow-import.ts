// ============================================================
// amend-resume import construction: predecessor journal -> ImportedRunCache
// ============================================================
//
// This module is amend-resume's only predecessor-reading site, shared by three call sites:
//   1. `port.amend` precheck ({@link preflightAmendImport}): decides `run_not_found` /
//      `missing_boundaries` before stopping an in-flight predecessor - on refusal the predecessor
//      keeps running and no row is written;
//   2. `port.amend` builds the cache after the predecessor settles ({@link buildImportedCache});
//   3. `port.resume` when `record.resumedFrom` is present: rebuilds the same table after a crash.
//
// Both sides share one construction rule: the amendment run's journal holds only the consumed
// execution prefix; unconsumed imports must be rebuilt. Completed entries are decided by the
// journal alone, in journal insertion order; an unfinished ask's boundary also needs the source
// transcript.
//
// One exception needs stating - the first number in this table that is not a pure journal
// function: the in-flight ask continuation (`inFlight`) boundary comes from the predecessor
// session's **current message count**, not a journal column.
//
// It is mostly stable between the two builds because "the predecessor has settled and nobody
// writes its session anymore":
//   - At submit time, guaranteed by {@link AmendImportOptions.quietSessions} (the superseded
//     predecessor just aborted; the driver waits for its turn to land; sessions not waited for are
//     not continued);
//   - At rebuild time the predecessor is terminal and this process holds no driver for it, so
//     nothing writes it by construction - hence the set is omitted (absent = all quiet).
//
// But "mostly" is not "always", nor does it need to be: two paths let the rebuild compute a larger
// M - the predecessor was resumed again and wrote more rounds (a superseded predecessor cannot be
// resumed, so only "amend an already stopped run, then resume it" constructs this), or a late
// background notification landed in that session. Both can only grow M, and correctness never
// depends on M being stable:
//   - The copy-in side is already gated shut: `seedActorTranscript` writes only into targets that
//     are empty or hold just this session's seed messages (property 2 in
//     workflow-actor-transcript.ts). Once the successor runs its own messages, a larger M coming
//     back gets no byte written - so "predecessor messages appended after this session's history"
//     cannot happen silently;
//   - While the successor has no own messages yet, a larger M copies a **later snapshot of the
//     same ask**; ordering stays index-decided (seed ids are purely determined by (session,
//     index), re-copy is an upsert) - just extra context, never corruption.
// This is also the catch-all for every future non-journal fact: no need to prove each one cannot
// grow; the copy point is closed once, for all.
//
// The only I/O is the journal read and the transcript-count read (both injected via narrow
// ports); this module never touches the session-store implementation directly.

import type { Logger, SessionId } from "@zcode/contracts";
import type {
  ActorRecord,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedInFlightAsk,
  ImportedRunCache,
  ImportedWorldEntry,
  NodeRecord,
  RunRecord,
} from "@zcode/dynamic-workflow";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";

/**
 * Journal read surface needed to build the import cache: three read methods, all by runId.
 *
 * Structurally a proper subset of the engine `JournalStorePort` (production passes the journal
 * through). Same narrowing rationale as {@link ActorTranscriptStore}: the builder reads only these
 * three; typing the whole port would make "import construction depends on every journal capability
 * (writes included)" true - and it writes not a byte. **Predecessor read-only** is an invariant;
 * let the type say it. */
interface ImportedCacheJournalReader {
  getRun(runId: string): RunRecord | undefined;
  listActors(runId: string): ActorRecord[];
  listNodes(runId: string): NodeRecord[];
}

/**
 * The three refusal reasons for import construction. **Discriminant keys, not prose**: the model
 * picks its next move from them (another run / wait for settlement / abandon amendment for a fresh
 * run), so they must stay distinguishable; actionable wording belongs to the tool layer. *
 * Literally the same set as the port's `DynamicWorkflowRunSubmitRefusalReason` (contracts): the
 * service forwards these reasons verbatim, so drift becomes a compile error rather than a
 * discriminant quietly turning `undefined`. Deliberately not imported from contracts: this is the
 * domain-side builder; the port vocabulary depending on it is the right direction. */
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
 * by the amend, not refused. */
type AmendPreflightRefusalReason = Exclude<ImportedCacheRefusalReason, "not_amendable">;

type AmendPreflightResult =
  | { ok: true; run: RunRecord }
  | { ok: false; reason: AmendPreflightRefusalReason };

/**
 * The amend **precheck**: predecessor exists and every completed ask has a message boundary.
 * **Status-blind** - both are properties of the predecessor journal that stopping cannot change,
 * so they are decidable before stopping; precheck-then-stop is what keeps a refused amend from
 * leaving a needlessly stopped run. A settled ask of an in-flight run is already persisted with
 * its boundary, so the precheck is as decisive for in-flight predecessors as for settled ones. */
export function preflightAmendImport(
  journal: Pick<ImportedCacheJournalReader, "getRun" | "listNodes">,
  predecessorRunId: string,
): AmendPreflightResult {
  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  if (!completedAsksHaveBoundaries(journal.listNodes(predecessorRunId))) {
    return { ok: false, reason: "missing_boundaries" };
  }
  return { ok: true, run };
}

/**
 * Gate 3 predicate, shared by precheck and build: a missing marker has two causes - journals
 * written before the marker column existed, and driver-side accounting failures - both meaning
 * "this run's boundary accounting is untrustworthy", hence the whole table is checked strictly,
 // not merely the rows that would be imported. Unfinished asks without boundaries are **normal**
 // (they never enter the import prefix), so only completed rows count. */
function completedAsksHaveBoundaries(nodes: readonly NodeRecord[]): boolean {
  for (const node of nodes) {
    if (node.kind !== "ask" || node.status !== "completed") continue;
    if (node.messageBoundary === undefined) return false;
  }
  return true;
}

/**
 * The three dependencies cache construction needs. Field names match
 * `DynamicWorkflowRunServiceDeps` verbatim (this interface is a structural subset), so both run
 * service call sites pass `deps` through unchanged - every rename-mapping layer is one more
 * wiring drift, whose symptom is silent degradation like "transcript wired but honesty check
 * skipped". */
interface AmendImportDeps {
  journal: ImportedCacheJournalReader;
  /**
   * Session-transcript read surface. When present, adds a **source honesty check** (see
   * {@link honorsBoundary}); when absent candidates are still accepted - the driver-side seeding
   * still fails loudly, the corruption-level backstop.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
}

/**
 * **Runtime evidence** visible at build time, as opposed to journal facts. Today exactly one:
 * which predecessor sessions have gone quiet. *
 * Deliberately kept out of {@link AmendImportDeps}: deps are the assembly (journal, transcript
 * surface, logger) and stay the same instance for the process lifetime; this object is an
 * observation valid for **this build only** and may differ between the two builds. Folding it
 * into deps would sour "same deps imply same table". */
export interface AmendImportOptions {
  /**
   * Predecessor session ids that have gone **quiet** (no turn still writing). Affects only
   * in-flight ask continuation: completed-prefix boundaries are journal facts, independent of
   * current session length.   *
   * **Absent = all quiet**, not "none quiet". The two call sites each supply half: amend just
   * aborted the in-flight predecessor whose cancelled turn may still be landing its last
   * messages, so it passes the driver-computed set in; the resume-side rebuild
   * ({@link rebuildImportedCacheForResume}) faces a long-settled predecessor with no driver in
   * this process - nothing writes it, which absence expresses. With the polarity flipped, the
   * rebuilt table would lose one `inFlight` versus the submit-time table, and both sides must
   * produce the same table (see the file header).   */
  quietSessions?: ReadonlySet<string>;
}

/**
 * Reads the predecessor journal and transcript state to build {@link ImportedRunCache}.
 * The completed prefix is journal-decided; unfinished-ask continuation also depends on source
 * session count and quiet state. *
 * Three gates in order (gate before build: a failed gate reads nothing):
 *   1. predecessor missing -> `run_not_found`;
 *   2. predecessor non-terminal -> `not_amendable`;
 *   3. predecessor has completed asks without `messageBoundary` -> `missing_boundaries`. *
 * Gate 3 is **whole-table strict** (not just the rows that would be imported): a missing marker
 * has two causes - journals written before the marker column existed, and driver-side accounting
 * failures - both meaning "this run's boundary accounting is untrustworthy", not "this one row
 * slipped". Row-by-row admission would let a half-broken ledger produce a plausible-looking table
 * that truncates at the wrong place on disagreement (model-visible context quietly diverging from
 * the journal boundary). A journal missing completed-ask boundaries is rejected wholesale; no
 * possibly-wrong transcript boundaries are synthesized. Unfinished asks without boundaries are
 * **normal** (never in the import prefix), so the gate looks at completed rows only. */
export async function buildImportedCache(
  deps: AmendImportDeps,
  predecessorRunId: string,
  options?: AmendImportOptions,
): Promise<BuildImportedCacheResult> {
  const { actorTranscriptStore: transcripts, journal, logger } = deps;

  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  // Amendable set = any terminal state, deliberately not reusing plain resume's
  // isResumableRecord: that predicate gates byte-identical resume (stopped), while amendment is
  // most useful for exactly the two classes it excludes - real script failures (fix bug, keep
  // cache) and completed (warm-started extension). Two sets, two purposes.
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return { ok: false, reason: "not_amendable" };

  const nodes = journal.listNodes(predecessorRunId);
  if (!completedAsksHaveBoundaries(nodes)) return { ok: false, reason: "missing_boundaries" };

  const actors = new Map<string, ImportedActorCandidate>();
  for (const record of namedUniqueActors(journal.listActors(predecessorRunId), logger)) {
    const name = record.name!;
    const candidate = await buildActorCandidate({
      actor: record,
      journal,
      ...(logger === undefined ? {} : { logger }),
      nodes,
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
 * Anonymous rows are skipped (the name is the cache identity key; no name, no coordinate to
 * compare). Duplicate names skip **both**: the engine's `DuplicateActorName` is a later runtime
 * invariant, so journals written before it can genuinely hold duplicate-name rows, and
 * by-name candidate pickup on such a predecessor is a dice roll. Skipping both beats picking one:
 * the cost is both actors rerunning fresh, versus the wrong pick serving another actor's session
 * prefix as this actor's context. */
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
 * A candidate actor's importable prefix plus transcript source. Any missing ingredient returns
 * `undefined` (the actor reruns fresh). *
 * **Degrade, never fail** is the governing tone here (the mirror of the gates' wholesale
 * refusal): missing prefix, missing persona, no session on the chain, pruned source session - all
 * just "this actor has no cache"; no cache row in the journal means no cache, no lying. The only
 * wholesale refusal is untrustworthy boundary accounting, which would truncate **accepted**
 * candidates at the wrong place. */
async function buildActorCandidate(input: {
  actor: ActorRecord;
  journal: ImportedCacheJournalReader;
  logger?: Logger;
  nodes: NodeRecord[];
  predecessorRunId: string;
  quietSessions?: ReadonlySet<string>;
  transcripts?: ActorTranscriptStore;
}): Promise<ImportedActorCandidate | undefined> {
  const { actor, journal, logger, nodes, predecessorRunId, quietSessions, transcripts } = input;
  const name = actor.name!;

  // The persona is the frozen identity the engine persists synchronously at createActor, so it is
  // normally present; absence means an externally rewritten row. Runtime comparison has nothing to
  // compare against - drop the candidate rather than stand in `{}`.
  if (actor.persona === undefined) return undefined;

  const { entries, next } = completedAskPrefix(nodes, actor);
  // Neither a completed prefix nor an in-flight ask behind it: this actor truly has nothing
  // importable. Early return saves the chain walk and one transcript read below.
  if (entries.length === 0 && next?.status !== "running") return undefined;

  const source = resolveTranscriptSource({
    actorName: name,
    journal,
    startRunId: predecessorRunId,
  });
  if (source === undefined) {
    // No ancestor on the chain holds a session for this actor (never created, or pruned). The
    // full-fidelity transcript is this feature's verdict; no transcript, no context to continue -
    // degrade to a fresh actor.
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
  // The transcript count is **read once**: source honesty check and in-flight-ask continuation
  // position use the same number. Reading twice opens two windows on one fact, and they may
  // disagree.
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
  // Empty prefix and no continuation deal: this candidate carries not a byte; accepting it would
  // only make the engine build a session for an empty table.
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
 * The ask still **in flight** when the predecessor stopped. All five conditions required: *
 *   1. A row exists right after the prefix and is `running` - cancelled asks keep their running
 *      row, so stopped runs have one too; `failed` and index gaps are not "in flight", they are
 *      the other two reasons a prefix stops;
 *   2. The transcript source is the predecessor's **own** row session: that half-finished
 *      conversation exists only there; sources resolved from earlier ancestors carry complete
 *      prefixes only (each chain hop guarantees prefix equivalence alone);
 *   3. The session is countable (transcript surface present and readable) - no count, no
 *      continuation position, and nothing for the driver to truncate to;
 *   4. That session is already **quiet**, see {@link AmendImportOptions.quietSessions};
 *   5. Count **strictly greater than** the prefix boundary. A queued-never-dispatched ask has no
 *      extra transcript to carry, and a messageCount equal to the boundary (or 0) would have the
 *      driver seed a "just the prefix" or empty transcript while marking the actor as continued -
 *      divergence verdicts and transcript content would then disagree. *
 * Any failed condition merely means **no continuation** (the completed prefix still imports), in
 * line with this module's degrade-never-fail tone. */
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
 * **immediately after** it. *
 * The prefix stops dead at the first non-completed entry; all three stop shapes are handled
 * alike: failure, mid-crash (running), index gap. * A failed ask is **non-binding** for the new run (models are stochastic; amendment often exists
 * to get past one failure), so it does not import itself; but skipping it while importing later
 * entries smuggles context - the skipped round's Q&A still sits in the source transcript while
 * the cache claims it never happened. Stopping at the first non-completed entry is the only
 * self-consistent reading. *
 * `next` is exactly the row that **stopped the prefix** (absent on a gap). It lives and dies with
 * the prefix because the in-flight ask is by definition this row: a second scan for
 * `actorSeq === entries.length` would compute the immediately-after-prefix coordinate twice. */
function completedAskPrefix(
  nodes: NodeRecord[],
  actor: ActorRecord,
): { entries: ImportedAskEntry[]; next?: NodeRecord } {
  const bySeq = new Map<number, NodeRecord>();
  for (const node of nodes) {
    if (node.kind !== "ask") continue;
    if (node.actorSiteId !== actor.siteId || node.actorOrdinal !== actor.ordinal) continue;
    if (node.actorSeq === undefined) continue;
    bySeq.set(node.actorSeq, node);
  }

  const entries: ImportedAskEntry[] = [];
  for (let seq = 0; ; seq++) {
    const node = bySeq.get(seq);
    if (node === undefined || node.status !== "completed") {
      return { entries, ...(node === undefined ? {} : { next: node }) };
    }
    // The boundary must be present: gate 3 already vetted the whole predecessor, so this is not
    // optimistic reading but an invariant being honored.
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
 * Walk back the `resumed_from` chain to the **nearest** ancestor run holding a session for this
 * actor name. *
 * Why walk the chain: an actor that hit the cache all along in run B means B never created a
 * session for it (lazy creation), so the B->C amendment continuing that actor finds the
 * transcript only in A. The count boundary is copy-invariant across prefixes, so at any
 * session-holding ancestor the boundary value B copied stays directly usable - the very foundation
 * chained amendments stand on. *
 * `resolvedModel` and the session come from the **same row**: the pin means "do not switch models
 * while continuing this transcript"; another row would make a promise about a transcript it does
 * not own. *
 * The cycle guard (seen) is pure defense: supersede only points at earlier terminal runs, no
 * cycles constructible. Still, on truly corrupt data this while would spin forever, and the guard
 * costs one Set. */
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
    const matches = journal.listActors(runId).filter((actor) => actor.name === actorName);
    // 0 = this generation has no such actor (the chain breaks for this name); >1 = duplicate
    // names, by-name session pickup is a dice roll. Both stop here rather than walking further up:
    // an earlier generation's session is not the source of **this** transcript.
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
 * The source session's current message count; `undefined` on read failure. *
 * Two readers share this single read (see {@link buildActorCandidate}): * - Checks the source session reached the completed-prefix boundary. On a short or unreadable
 *   count the builder drops the candidate and lets the successor re-execute; the driver's
 *   transcript copy still rejects sources shorter than the boundary, preventing incomplete
 *   context writes. * - Computes the unfinished-ask continuation position (see {@link resolveInFlightAsk}). *
 * The count semantics must match driver accounting and core history restore; all use the same
 * message-store interface. */
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
 * pairs with nth entry). *
 * Keys reuse the **predecessor-recorded inputHash**, never recomputed: the engine's hash semantics
 * for `{op,args}` (worldRead in engine.ts) are exactly what that column holds; recomputing here
 * would duplicate the hash contract, and once it drifts the symptom is a cache that misses for no
 * visible reason. *
 * Completed only: failed world reads re-execute (failures are non-binding for the new run), let
 * alone running ones. * world-run and world-read share the table - importing world-run is a **safety feature**, not an
 * optimization: an amended continuation must never silently replay an already-journaled effect
 * (deploy scripts running twice). */
function buildWorldQueues(nodes: NodeRecord[]): ReadonlyMap<string, ImportedWorldEntry[]> {
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
 * Resume-side entry: rebuild the amendment run's import cache. **Any failure degrades only; it
 * never refuses the resume**. *
 * Shares {@link buildImportedCache} with the submit side - not reuse convenience but a correctness
 * precondition: the amendment run's journal is self-contained only for the reached execution
 * prefix; unconsumed imports are restored by this rebuild, and two different tables would turn
 * "rebuild" into "build another". *
 * Three reasons why rebuild failure and submit-time build failure are different animals: *   - The amendment run already exists. Refusing resume would turn a resumable run into a
 *   permanently stuck one; *   - Consumed hits are **real rows** in this run's journal; replay needs no table - the run's
 *   self-containedness never depended on it; *   - Unconsumed imports degrade to live re-execution: correct results, merely spending tokens
 *   that could have been saved. *
 * Hence not even the three gate reasons are distinguished here: for resume, `run_not_found`
 * (predecessor pruned) and `missing_boundaries` are the same fact - no cache this time. The
 * predecessor journal is thus a liveness dependency but only an accelerator: losing it costs
 * tokens, never correctness. One info line keeps later bill explanations possible. *
 * **No {@link AmendImportOptions.quietSessions}**: by this point the predecessor is long terminal
 * and this process holds no driver for it; nothing writes its session. Passing an empty set would
 * make the rebuilt table lose one `inFlight` versus the submit-time one, and both sides must
 * produce the same table (see the file header). */
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
