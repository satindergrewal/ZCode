/**
 * A fake driver: drives the engine core with scripted verdicts and manually settled promises, no timers/clock/sessions/disk.
 * The test plays both sandbox (calling the engine host API) and model (calling the engine WorkflowReportSink).
 */

import type {
  ActorSessionSeed,
  ArtifactPublishRequest,
  ArtifactVersionRecord,
  AskMessage,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  SessionRef,
  SubmitVerdict,
  WorkflowDriver,
  ActorRef,
  WorldReadOp,
} from "../../src/engine/index.js";
import { refToString } from "../../src/engine/index.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drains microtasks so the engine's async dispatch (lazy session creation) settles. */
export async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface StartAskCall {
  session: SessionRef;
  instance: InstanceRef;
  message: AskMessage;
}

interface WorldReadCall {
  op: WorldReadOp;
  /** Positional args (script args passed through verbatim per Boundary A). */
  args: unknown[];
  deferred: Deferred<unknown>;
}

export interface FakeDriverOptions {
  /**
   * When true, executeArtifactPublish is absent entirely -- an assembly with no artifact store (pure replay /
   * old fake). The engine must reject content members with ArtifactStoreUnavailable, not silently publish empties.
   */
  withoutArtifactStore?: boolean;
  /** When true, content publishes return a promise the test settles; otherwise they resolve immediately. */
  deferArtifactPublishes?: boolean;
  /** When true, session creation returns a promise the test settles; otherwise it resolves immediately. */
  deferSessions?: boolean;
  /**
   * Mimics production tier resolution: session creation writes the resolved model into the actor record,
   */
  resolveModel?: (persona: PersonaSpec) => string;
  /** runId for resolveModel writes (the engine's own). */
  runId?: string;
}

/** Takes title from the script's opts (the one slice a real driver performs). */
function titleOf(opts: unknown): string | undefined {
  const title = (opts as { title?: unknown } | undefined)?.title;
  return typeof title === "string" ? title : undefined;
}

export class FakeDriver implements WorkflowDriver {
  readonly startAsks: StartAskCall[] = [];
  readonly submitResponses: Array<{ instance: InstanceRef; verdict: SubmitVerdict }> = [];
  readonly cancels: InstanceRef[] = [];
  readonly sessionCreations: ActorRef[] = [];
  /** Persona captured per session creation (same order as sessionCreations). */
  readonly sessionPersonas: PersonaSpec[] = [];
  /**
   * Seed per session creation (same order; undefined when none). A real driver copies the source transcript
   */
  readonly sessionSeeds: Array<ActorSessionSeed | undefined> = [];
  readonly worldReads: WorldReadCall[] = [];
  /** Request captured per content publish (what the engine passes: id/version/path/opts). */
  readonly artifactPublishes: ArtifactPublishRequest[] = [];
  /** Controlled promises under deferArtifactPublishes, aligned with artifactPublishes. */
  readonly artifactDeferrals: Array<Deferred<ArtifactVersionRecord>> = [];
  /**
   * The in-memory store: id@version -> record. A real driver copies bytes into the tool-artifact store;
   */
  readonly artifactStore = new Map<string, ArtifactVersionRecord>();
  readonly events: RunEvent[] = [];
  readonly sessionDeferrals: Array<Deferred<SessionRef>> = [];
  /** dispose call count (engine contract: exactly once, after run-settled). */
  disposeCalls = 0;
  /** Events emitted when dispose ran (asserting it follows run-settled). */
  eventsAtDispose: number | undefined;

  constructor(
    readonly journal: JournalStorePort,
    private readonly options: FakeDriverOptions = {},
  ) {
    // A storeless assembly is not a flag -- the method is absent wholesale: the engine dispatches on presence,
    if (options.withoutArtifactStore === true) this.executeArtifactPublish = undefined;
  }

  createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    this.sessionCreations.push(actor);
    this.sessionPersonas.push(persona);
    this.sessionSeeds.push(seed);
    if (this.options.resolveModel !== undefined) {
      // The production seam's equivalent: read-modify-write, never a whole-record clobber (persona/name are not driver fields).
      const runId = this.options.runId ?? "run";
      const existing = this.journal.getActor(runId, actor.siteId, actor.ordinal);
      this.journal.putActor({
        ...(existing ?? { runId, siteId: actor.siteId, ordinal: actor.ordinal }),
        resolvedModel: this.options.resolveModel(persona),
      });
    }
    const session: SessionRef = { id: `session:${refToString(actor)}` };
    if (this.options.deferSessions === true) {
      const d = defer<SessionRef>();
      this.sessionDeferrals.push(d);
      return d.promise;
    }
    return Promise.resolve(session);
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    this.startAsks.push({ session, instance, message });
  }

  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void {
    this.submitResponses.push({ instance, verdict });
  }

  cancelAsk(instance: InstanceRef): void {
    this.cancels.push(instance);
  }

  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    const d = defer<unknown>();
    this.worldReads.push({ op, args, deferred: d });
    return d.promise;
  }

  /**
   * Content publish (Boundary B). A real driver resolves paths, reads bytes, writes the store; the fake records
   */
  executeArtifactPublish?: (request: ArtifactPublishRequest) => Promise<ArtifactVersionRecord> = (
    request,
  ) => {
    this.artifactPublishes.push(request);
    const record: ArtifactVersionRecord = {
      id: request.id,
      kind: request.op,
      version: request.version,
      contentType: request.op === "markdown" ? "text/markdown" : "application/pdf",
      bytes: (request.content ?? request.path ?? "").length,
      uri: `zcode-artifact://fake/${request.id}/${request.version}`,
      ...(request.path === undefined ? {} : { sourcePath: request.path }),
      ...(titleOf(request.opts) === undefined ? {} : { title: titleOf(request.opts) }),
      publishedAt: 1,
    };
    this.artifactStore.set(`${request.id}@${request.version}`, record);
    if (this.options.deferArtifactPublishes === true) {
      const d = defer<ArtifactVersionRecord>();
      this.artifactDeferrals.push(d);
      return d.promise;
    }
    return Promise.resolve(record);
  };

  emit(event: RunEvent): void {
    this.events.push(event);
  }

  dispose(): void {
    this.disposeCalls++;
    this.eventsAtDispose ??= this.events.length;
  }

  // ------------------------------------------------- assertion helpers -------------------------------------------------

  /** Instance keys that startAsk ran (asserting replay hits never re-execute). */
  startedInstanceKeys(): Set<string> {
    return new Set(this.startAsks.map((c) => refToString(c.instance)));
  }

  /** startAsk count (filterable per instance). */
  startAskCount(instance?: InstanceRef): number {
    if (instance === undefined) return this.startAsks.length;
    const key = refToString(instance);
    return this.startAsks.filter((c) => refToString(c.instance) === key).length;
  }

  /** Collects one event type. */
  eventsOfType<T extends RunEvent["type"]>(type: T): Array<Extract<RunEvent, { type: T }>> {
    return this.events.filter((e) => e.type === type) as Array<Extract<RunEvent, { type: T }>>;
  }

  // Order of cached-hit instance keys across node-settled events (hold-rule assertions).
  cachedSettleOrder(): string[] {
    return this.events
      .filter(
        (e): e is Extract<RunEvent, { type: "node-settled" }> =>
          e.type === "node-settled" && e.cached === true,
      )
      .map((e) => refToString(e.instance));
  }
}
