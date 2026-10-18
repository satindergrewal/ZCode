/**
 * AutoDriver: the self-driving fake driver for integration tests, playing both the Boundary B driver port and the model.
 * The engine core's fake-driver suite (pure package tests/engine) has tests pump the report sink by hand; this package's
 * integration tests need a driver that reacts to startAsk on its own (stats plus submit/turn-end/fail),
 * because the sandbox child runs live and the test cannot intervene per tick.
 *
 * No timers/clock/sessions/disk: reports advance via queueMicrotask (avoiding synchronous reentry inside engine stacks).
 * Same pattern as the pure package's FakeDriver, autonomous; house rules forbid cross-package test imports, so it is implemented here.
 */

import type {
  ActorRef,
  ArtifactPublishRequest,
  ArtifactVersionRecord,
  AskMessage,
  AskStats,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  SessionRef,
  SubmitVerdict,
  WorkflowDriver,
  WorkflowError,
  WorkflowReportSink,
  WorldReadOp,
} from "@zcode/dynamic-workflow";
import { refToString } from "@zcode/dynamic-workflow";

/** One step the driver takes on the model's behalf after an ask dispatch. */
export type AskAction =
  /**
   * delayMs: runs after a real timer, not a microtask. For tests where settlement order is load-bearing: two request
   * lines can land in two stdout chunks admitted in two ticks, where the extra-lap-is-later microtask argument
   * collapses and only a real delay pins the order (resume.test.ts).
   */
  | { type: "submit"; payload: unknown; stats?: AskStats; delayMs?: number }
  | { type: "text"; finalText: string; stats?: AskStats }
  | { type: "fail"; error: WorkflowError }
  /** Deterministic model-side error: no node settlement; stopRun stops the whole run (ProviderStop). */
  | { type: "stop-run"; error: WorkflowError };

/** Per-site responder: one action or a list per instance/message (lists for repair/nudge sequences). */
export type AskResponder = (ctx: {
  instance: InstanceRef;
  message: AskMessage;
}) => AskAction | AskAction[];

export interface AutoDriverConfig {
  /** Ask responders by site id. Required for typed asks (else the default {} submit likely fails validation). */
  asks?: Record<string, AskResponder>;
  /** World-read handlers (args positional); defaults: [] for glob, "" for read. */
  worldReads?: (op: WorldReadOp, args: unknown[]) => unknown | Promise<unknown>;
  /**
   * Content-artifact publish handler (user-facing artifacts; docs/dynamic-workflow/authoring.md). Default: an
   * echo record. A real driver reads bytes into the store here; integration tests care that the request shape and record
   * reach the journal verbatim. Throws model the ArtifactSourceMissing family of node-level refusals.
   */
  artifacts?: (
    request: ArtifactPublishRequest,
  ) => ArtifactVersionRecord | Promise<ArtifactVersionRecord>;
  /** startAsk hook (resume tests assert zero dispatches or fail on purpose through it). */
  onStartAsk?: (instance: InstanceRef, message: AskMessage) => void;
}

interface StartAskCall {
  session: SessionRef;
  instance: InstanceRef;
  message: AskMessage;
}

export class AutoDriver implements WorkflowDriver {
  readonly events: RunEvent[] = [];
  readonly startAsks: StartAskCall[] = [];
  readonly sessionCreations: ActorRef[] = [];
  readonly cancels: InstanceRef[] = [];
  /** Request captured per content publish (asserts wire protocol and engine passthrough). */
  readonly artifactPublishes: ArtifactPublishRequest[] = [];

  private sink: WorkflowReportSink | undefined;
  private readonly scripts = new Map<string, { actions: AskAction[]; idx: number }>();

  constructor(
    readonly journal: JournalStorePort,
    private readonly config: AutoDriverConfig = {},
  ) {}

  /** Back-fills the sink once the harness builds the engine (breaking the driver/engine cycle). */
  attach(sink: WorkflowReportSink): void {
    this.sink = sink;
  }

  createActorSession(actor: ActorRef, _persona: PersonaSpec): Promise<SessionRef> {
    this.sessionCreations.push(actor);
    return Promise.resolve({ id: `session:${refToString(actor)}` });
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    this.startAsks.push({ session, instance, message });
    this.config.onStartAsk?.(instance, message);
    const responder = this.config.asks?.[instance.siteId];
    const raw = responder ? responder({ instance, message }) : defaultAction(message);
    const actions = Array.isArray(raw) ? raw : [raw];
    this.scripts.set(refToString(instance), { actions, idx: 0 });
    this.perform(instance);
  }

  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void {
    if (verdict.kind === "accept") return;
    // reject / nudge -> advance to the next action (scripted repair/nudge sequences).
    const script = this.scripts.get(refToString(instance));
    if (script === undefined) return;
    script.idx++;
    this.perform(instance);
  }

  cancelAsk(instance: InstanceRef): void {
    this.cancels.push(instance);
  }

  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    const handler = this.config.worldReads ?? defaultWorldRead;
    return Promise.resolve(handler(op, args));
  }

  // async rather than Promise.resolve(handler(...)): with a synchronously throwing handler the latter lets the escape
  // out of executeArtifactPublish synchronously, landing in the harness readline callback as an unhandled
  // exception and hanging the run forever. async turns sync throws into rejections -- real drivers are async methods anyway.
  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    this.artifactPublishes.push(request);
    const handler = this.config.artifacts ?? defaultArtifactPublish;
    return handler(request);
  }

  emit(event: RunEvent): void {
    this.events.push(event);
  }

  private perform(instance: InstanceRef): void {
    const script = this.scripts.get(refToString(instance));
    if (script === undefined) return;
    const action = script.actions[script.idx];
    if (action === undefined) return; // no more actions: the engine exhausts repair/nudge and fails on its own.
    const delayMs = action.type === "submit" ? action.delayMs : undefined;
    const schedule = (fn: () => void): void => {
      if (delayMs === undefined) queueMicrotask(fn);
      else setTimeout(fn, delayMs);
    };
    schedule(() => {
      const sink = this.sink;
      if (sink === undefined) throw new Error("AutoDriver: sink not attached");
      if (action.type !== "fail" && action.type !== "stop-run" && action.stats !== undefined)
        sink.askStats(instance, action.stats);
      switch (action.type) {
        case "submit":
          sink.askSubmitAttempted(instance, action.payload);
          return;
        case "text":
          sink.askTurnEnded(instance, action.finalText);
          return;
        case "fail":
          sink.askFailed(instance, action.error);
          return;
        case "stop-run":
          sink.stopRun(action.error);
          return;
      }
    });
  }

  // ------------------------------------------------- assertion helpers -------------------------------------------------

  startAskCount(): number {
    return this.startAsks.length;
  }

  eventsOfType<T extends RunEvent["type"]>(type: T): Array<Extract<RunEvent, { type: T }>> {
    return this.events.filter((e) => e.type === type) as Array<Extract<RunEvent, { type: T }>>;
  }
}

/** Fallback without a responder: untyped asks get a final text; typed asks submit {} (likely failing validation; fallback only). */
function defaultAction(message: AskMessage): AskAction {
  return message.typed ? { type: "submit", payload: {} } : { type: "text", finalText: "ok" };
}

/** Default artifact publish: echoes one record per request (bytes live in the store; the test does not care). */
function defaultArtifactPublish(request: ArtifactPublishRequest): ArtifactVersionRecord {
  return {
    id: request.id,
    kind: request.op,
    version: request.version,
    contentType: request.op === "markdown" ? "text/markdown" : "application/octet-stream",
    bytes: (request.content ?? request.path ?? "").length,
    uri: `zcode-artifact://auto/${request.id}/${request.version}`,
    ...(request.path === undefined ? {} : { sourcePath: request.path }),
    publishedAt: 1,
  };
}

/** Default world-read: glob -> [], read -> "". */
function defaultWorldRead(op: WorldReadOp): unknown {
  return op === "glob" ? [] : "";
}
