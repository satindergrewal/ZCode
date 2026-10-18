/**
 * The NDJSON wire protocol (Boundary A's transport encoding).
 *
 * The sandbox child and the parent harness speak newline-delimited JSON over stdio. This module is the single source of truth,
 * describing every message kind and field; the child source (child-source.ts's embedded string) hand-mirrors these
 * shapes -- it cannot import this module (it runs embedded in the entry file via toString()), so change both together. The parent side imports
 * these types directly, keeping the bridge strictly typed.
 *
 * Direction conventions:
 *   child -> parent: create-actor (fire-and-forget) / request (ask/world-read/publish-artifact/hole, reply required) /
 *                   event（log、report、declare-artifact）/ complete
 *   parent -> child: response (answers a request, carrying the latest budget snapshot)
 *
 * Why create-actor skips request/response: Boundary A requires createActor to return its handle synchronously. A round-trip cannot be awaited synchronously, so the child mints a
 * child-local handle (local#N) and fires create-actor; by stdio FIFO the parent completes the local->ActorId mapping before handling
 * any ask referencing the handle (the parent's create-actor handling is purely synchronous).
 */

import type { ArtifactContentOp, ArtifactPresetOp, WorldReadOp } from "@zcode/dynamic-workflow";

// ————————————————————————————————————————————————————————————————
// Wire shape of structured errors
// ————————————————————————————————————————————————————————————————

/**
 * The cross-boundary error shape. An ask rejection (WorkflowError) crosses as this; the child rebuilds an Error with
 * code/violations/finalText inside the sandbox so the script's try/catch can act on structure.
 * Model-side errors no longer cross: they retry within the runtime
 * or stop the whole run, unseen by the script.
 */
export interface WireError {
  name: string;
  message: string;
  code?: string;
  violations?: unknown[];
  finalText?: string;
  stack?: string;
}

// ————————————————————————————————————————————————————————————————
// child → parent
// ————————————————————————————————————————————————————————————————

/** Synchronous actor creation: fire-and-forget; by FIFO the parent maps local->ActorId before later asks. */
export interface CreateActorMessage {
  kind: "create-actor";
  localId: string;
  siteId: string;
  name?: string;
  persona?: unknown;
}

/**
 * Reply-required host calls: ask, world-read, or a content-artifact publish.
 *
 * The two artifact families split here: content members (file/markdown) are
 * effects -- awaited, catchable rejections -- so request/response; predeclared members are declarations returning
 * void, riding the event channel below.
 */
export interface RequestMessage {
  kind: "request";
  id: string;
  /**
   * hole: the script reached an unfilled hole (docs/execution-engine.md, "Holes"). The parent parks it via the engine
   * until the main agent fills it, answered with `{code}`; the parked branch is an in-flight request while siblings run and stall detection stays quiet.
   */
  type: "ask" | "world-read" | "publish-artifact" | "hole";
  siteId: string;
  /** ask-only: the child-local actor handle. */
  actor?: string;
  /** ask-only: the instruction text. */
  instructions?: string;
  /** hole-only: the hole's literal name. */
  name?: string;
  /** hole-only: the hint for the main agent (truncated to 4000 chars before journalling). Absent means the author wrote none. */
  prompt?: string;
  /** world-read-only: the op (vocabulary derives from the world-read registry; new primitives leave this file alone). */
  op?: WorldReadOp;
  /**
   * publish-artifact-only: the content-member op. Deliberately a second field instead of widening `op` into
   * a union of two vocabularies: widened, the parent's dispatch would hold a value needing re-narrowing whose only
   * basis is `type` -- exactly what the two fields already express. Two registries, two fields, no guessing.
   */
  artifactOp?: ArtifactContentOp;
  /**
   * world-read-only: the positional argument array. Lowering packs the call site's args verbatim; this layer passes them through,
   * arity and validation belong to the driver.
   * A single-arg `arg?: string` cannot carry multi/no-arg ops (files.grep(pattern, glob?), git.status()).
   */
  args?: unknown[];
}

/**
 * Fire-and-forget events, discriminated by type. None needs a reply, but durability differs: a lost log is one lost line
 * of chatter; a lost report is a lost finding (the parent journals it) -- hence the event channel's FIFO order is
 * load-bearing for reports: the parent journals what arrives.
 *
 * declare-artifact rides the same channel, necessarily: a tagged report is only valid
 * after its predeclaration reached the parent (else the engine fails the run with ArtifactUndeclared).
 * Scripts declare before reporting, and the shared FIFO makes the parent see the same order. Making the declaration a
 * reply-required request would not improve that -- just add a pointless await to a synchronous-void facade member.
 */
export type EventMessage =
  | LogEventMessage
  | ReportEventMessage
  | DeclareArtifactEventMessage
  | PhaseEnteredEventMessage;

/**
 * Control flow crossed a phase marker. Event channel: never awaited; no site, no journal row -- the parent has the engine emit one
 * phase-entered. Arrival order still matters -- enter-B-before-dispatching-B's-asks lights the timeline.
 */
export interface PhaseEnteredEventMessage {
  kind: "event";
  type: "phase-entered";
  /** The author's verbatim text, trimmed by lowering. */
  name: string;
}

/** Progress message: no site, no journal row. */
export interface LogEventMessage {
  kind: "event";
  type: "log";
  message: string;
}

/**
 * An intermediate result. Event channel, not request/response -- the script never awaits it; unlike log,
 * the parent journals a dwf_node row keyed by siteId x ordinal.
 */
export interface ReportEventMessage {
  kind: "event";
  type: "report";
  siteId: string;
  item: unknown;
  /**
   * Artifact tag (report(item, "perf")): which predeclared artifact also receives this item. Absent means untagged
   * (JSON.stringify drops undefined keys, so on the wire the key is simply absent).
   */
  artifactId?: string;
}

/**
 * A predeclared-artifact declaration (artifact.chart and kin). Event channel, not request/response:
 * the facade member returns void synchronously, never awaited. The parent journals a row by siteId x ordinal
 * (idempotent re-declarations aside), so this message's arrival order is load-bearing too (see {@link EventMessage}).
 */
export interface DeclareArtifactEventMessage {
  kind: "event";
  type: "declare-artifact";
  siteId: string;
  op: ArtifactPresetOp;
  /** Positional args ([id, spec]); packed verbatim by lowering, passed through verbatim here. */
  args: unknown[];
}

/** Script execution terminal: the top-level artifact or a throw. */
export interface CompleteMessage {
  kind: "complete";
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

/** Every child -> parent message. */
export type ChildMessage = CreateActorMessage | RequestMessage | EventMessage | CompleteMessage;

// ————————————————————————————————————————————————————————————————
// parent → child
// ————————————————————————————————————————————————————————————————

/** The reply to one request. */
export interface ResponseMessage {
  kind: "response";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

/** Every parent -> child message. */
export type ParentMessage = ResponseMessage;

/**
 * The child's initial payload, embedded in the entry file as a JSON literal (child-source.ts's renderChildEntry)
 * instead of argv/base64: Windows caps command lines at 32,767 chars.
 */
export interface ChildPayload {
  /** The lowered async function body (free identifier: __host only). */
  lowered: string;
  /**
   * This run's arguments, injected as the frozen `args` global (lowering rewrites `args` reads to
   * `__host.args`).
   *
   * Crosses once at spawn, never updated -- constant for the run's lifetime. Absent reads as
   * `{}`: inline runs and old journal
   * rows alike, so `args.x` is always a legal property read, never a crash.
   */
  args?: Record<string, unknown>;
  /**
   * Heap cap (MB). Effective only on the argsPrefix (SEA re-exec) path: no flags survive there,
   * so with --max-old-space-size missing from execArgv the entry file runs v8.setFlagsFromString
   * best-effort. The default path relies on the real Node flag; the entry skips this field when it sees one.
   * No guarantee (V8 may ignore flags consumed during startup); recorded as a SEA limitation.
   */
  maxOldSpaceSizeMb?: number;
}
