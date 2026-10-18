/**
 * NDJSON wire protocol (the transport encoding of Boundary A).
 *
 * The sandbox child and the parent harness speak newline-delimited JSON over stdio. This module is the **single
 * source of truth** for every message kind and field; the child source (the inline string in child-source.ts)
 * hand-mirrors these shapes -- it cannot import this module (it is embedded via `toString()` into the entry file),
 * so the two must change together. The parent side imports these types, keeping the bridge strictly typed.
 *
 * Direction conventions:
 *   child -> parent: create-actor (fire-and-forget) / request (ask/world-read/publish-artifact, answered) /
 *                    event (log, report, declare-artifact) / complete
 *   parent -> child: response (answers a request, carrying the latest budget snapshot)
 *
 * Why create-actor skips request/response: Boundary A requires `createActor` to return a handle **synchronously**,
 * and a child cannot wait a round-trip for a sync return. So it mints a child-local handle (`local#N`) and fires a
 * create-actor; by stdio FIFO order the parent finishes the local->engine ActorId mapping before handling any ask
 * that references the handle (the parent's create-actor handling is purely synchronous).
 */

import type { ArtifactContentOp, ArtifactPresetOp, WorldReadOp } from "@zcode/dynamic-workflow";

// ————————————————————————————————————————————————————————————————
// Wire shape of structured errors
// ————————————————————————————————————————————————————————————————

/**
 * The cross-boundary error shape. An ask rejection (WorkflowError) crosses as this; the child rebuilds an Error with
 * `code`/`violations`/`finalText` inside the sandbox so script try/catch can handle it structurally.
 * Model-side errors no longer cross: they are either retried in the runtime or stop the whole run -- the script never sees them.
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

/** Create an actor synchronously: fire-and-forget; the parent maps local->ActorId via FIFO before later asks. */
export interface CreateActorMessage {
  kind: "create-actor";
  localId: string;
  siteId: string;
  name?: string;
  persona?: unknown;
}

/**
 * Answerable host calls: ask, world-read, or **content-artifact publication**.
 *
 * The two artifact families split here: content members (`file`/`markdown`) are effects -- the script awaits them
 * and must be able to catch rejections -- so they use request/response; declaration members are statements
 * returning void and travel the event channel below.
 */
export interface RequestMessage {
  kind: "request";
  id: string;
  type: "ask" | "world-read" | "publish-artifact";
  siteId: string;
  /** ask only: child-local actor handle. */
  actor?: string;
  /** ask only: instruction body. */
  instructions?: string;
  /** world-read only: the op (vocabulary derived from the world-read registry; new primitives do not touch this file). */
  op?: WorldReadOp;
  /**
   * publish-artifact only: the content-member op. **Deliberately a second field instead of widening `op`** into a
   * union of the two vocabularies: widened, the parent's dispatch would hold a value it must narrow again, and the
   * only narrowing key would be `type` -- exactly what the two fields each express. Two registries, two fields, no guessing.
   */
  artifactOp?: ArtifactContentOp;
  /**
   * world-read only: the **positional args array**. Lowering packs call-site args verbatim; this layer forwards
   * them verbatim -- arity and validation belong to the driver. A single `arg?: string` cannot express
   * multi-arg/zero-arg ops (`files.grep(pattern, glob?)`, `git.status()`).
   */
  args?: unknown[];
}

/**
 * Fire-and-forget events, discriminated by `type`. None needs a reply, but **durability differs**: a lost `log` is a
 * lost aside, a lost `report` is a lost finding (the parent journals it) -- so FIFO order on the event channel is
 * load-bearing for reports: what arrives is what gets journaled.
 *
 * `declare-artifact` rides the same channel, and must: a labeled report is only legal once its declaration reached
 * the parent (otherwise the engine fails the whole run with `ArtifactUndeclared`). The script declares before
 * reporting, and the same FIFO makes the parent see them in that order. Turning declarations into answerable
 * requests would not improve this -- it would just add a wait to a sync void facade member.
 */
export type EventMessage =
  | LogEventMessage
  | ReportEventMessage
  | DeclareArtifactEventMessage
  | PhaseEnteredEventMessage;

/**
 * Control flow passed a `phase("...")` marker. Event channel: the script never awaits it; no site, not journaled;
 * the parent just has the engine emit `phase-entered`. Arrival order still matters -- "B entered before asks
 * inside B dispatch" is what lights up the timeline.
 */
export interface PhaseEnteredEventMessage {
  kind: "event";
  type: "phase-entered";
  /** The author's verbatim text, trimmed by lowering. */
  name: string;
}

/** Progress message: no site, not journaled. */
export interface LogEventMessage {
  kind: "event";
  type: "log";
  message: string;
}

/**
 * An intermediate result. Event channel rather than request/response because the script never awaits it; but unlike
 * `log`, the parent journals it as a `dwf_node` row keyed by `siteId` x ordinal.
 */
export interface ReportEventMessage {
  kind: "event";
  type: "report";
  siteId: string;
  item: unknown;
  /**
   * Artifact label (`report(item, "perf")`): which declared artifact this item also feeds. Absent means unlabeled
   * (JSON.stringify drops undefined keys entirely, so on the wire it is simply "key absent").
   */
  artifactId?: string;
}

/**
 * A **declared-artifact** statement (`artifact.chart` etc.). Event channel, not request/response: the facade member
 * returns void synchronously -- the script never awaits it. The parent journals a `dwf_node` row keyed by
 * `siteId` x ordinal (idempotent re-declarations aside), so arrival order is load-bearing here too (see {@link EventMessage}).
 */
export interface DeclareArtifactEventMessage {
  kind: "event";
  type: "declare-artifact";
  siteId: string;
  op: ArtifactPresetOp;
  /** Positional args (`[id, spec]`); lowering packs verbatim, this layer forwards verbatim. */
  args: unknown[];
}

/** Script termination: top-level artifact or thrown error. */
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
 * The child's initial payload. Embedded as a JSON literal in the entry file (child-source.ts `renderChildEntry`),
 * no longer via argv/base64: Windows caps command lines at 32,767 chars.
 */
export interface ChildPayload {
  /** The lowered script's async function body (free identifier: `__host` only). */
  lowered: string;
  /**
   * This run's arguments, injected into the sandbox as the **frozen** `args` global (lowering rewrites script
   * `args` reads to `__host.args`).
   *
   * Crosses the boundary once at spawn and never updates -- arguments are constant for the run's lifetime. Absent
   * reads as `{}`: inline runs and legacy journal rows both take that path, so `args.x` in a script is always a
   * legal property read, never a crash.
   */
  args?: Record<string, unknown>;
  /**
   * Heap cap in MB. **Effective only on the argsPrefix (SEA self re-exec) path**: that path cannot pass
   * `--max-old-space-size`, so when the entry file sees no flag in `execArgv` it best-effort
   * `v8.setFlagsFromString`s. The default path relies on the real Node flag; if the flag is present the entry
   * file skips this. Effects are not guaranteed (V8 may ignore flags already consumed at startup) -- recorded as a SEA limitation.

   */
  maxOldSpaceSizeMb?: number;
}
