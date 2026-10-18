/**
  * The replay **settlement-order gate**.
 *
  * Site ordinals are arrival counters, so every journal call a branch makes after an await is
  * numbered by fan-out completion order, not script issue order. That order is wall-clock; nothing in the node rows
  * reproduces it: releasing cache hits in admission order, the replayed Promise.all runs continuations in array order, and the first
  * report after the join gets the ordinal of whichever branch finished first -- the run dies in its own
  * defensive check (InputHashMismatch) even though the script is deterministic, purely from replay completion order.
 *
  * So resume replays the **scheduling**, not just the answers: this gate holds the first-born settlement order; a cache-hit settlement
  * parks at its release point until every predecessor has released. Instances outside the table pass freely -- the gate binds only what it has
  * evidence for -- degenerating to prior behavior on older journals, and never deadlocking a run it knows nothing about.
 */

import { isArtifactPresetOp } from "../facade/registry.js";
import type { InstanceRef, JournalStorePort, NodeRecord, RunEvent } from "./types.js";
import { refToString } from "./types.js";

export class ReplaySettleOrder {
    /** Instance key -> position in the first-born settlement order. */
  private readonly position: ReadonlyMap<string, number>;
    /** How far released (the table's cursor). */
  private cursor = 0;
    /** Arrived releases waiting for their turn. */
  private readonly parked = new Map<string, () => void>();
    /** Due releases parked in a microtask (FIFO; see {@link enqueue}). */
  private queue: Array<() => void> = [];
  private flushing = false;
    /** After run settlement the gate opens forever (see {@link open}). */
  private opened = false;

  constructor(private readonly order: readonly string[] = []) {
    const position = new Map<string, number>();
    order.forEach((key, index) => position.set(key, index));
    this.position = position;
  }

  static empty(): ReplaySettleOrder {
    return new ReplaySettleOrder([]);
  }

    /** The first-born settlement order (for diagnostics). */
  recorded(): readonly string[] {
    return this.order;
  }

  /**
      * Order-constrained release of one replay hit. Instance not in the table (fresh call, older journal), gate open,
      * or its turn already passed: run immediately; else park until due.
   */
  hold(instance: InstanceRef, release: () => void): void {
    const key = refToString(instance);
    const at = this.position.get(key);
    if (this.opened || at === undefined || at < this.cursor) {
      release();
      return;
    }
    this.parked.set(key, release);
    this.pump();
  }

  /**
      * Delivery is always later than the call producing the promise: the release enters the queue, running one microtask later.
   *
      * Without the hop the order inverts: in Promise.all every branch issues its call in the same synchronous slice,
      * and the head's release would run **inside its own ask** -- its await not yet attached, so
      * its continuation queues behind the one attached earlier and just fulfilled by this pump. The microtask hop lets every
      * await attach first; delivery order then equals release order. Not clock-based: one deterministic hop, FIFO queue.
   */
  private enqueue(release: () => void): void {
    this.queue.push(release);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => this.flush());
  }

    /** Run the queued deliveries to completion, FIFO (a no-op when empty; safe to repeat). */
  private flush(): void {
    this.flushing = false;
    const batch = this.queue;
    this.queue = [];
    for (const release of batch) release();
  }

  /**
      * Run settlement: the gate opens forever; parked releases drain in recorded order.
   *
      * Not draining would leave script-side promises pending forever -- harmless where the harness tears the sandbox down at once, a hang for
      * in-process runners such as EvalWorkflowSnippet. Post-settlement release is safe:
      * the engine has markSettled, and every host path starts with isRunSettled().
   */
  open(): void {
    if (this.opened) return;
    this.opened = true;
        // Queued deliveries drain first, in order: the settlement path calls this before run-settled, synchronously,
        // so hit events never land after the terminal event. Every parked await is attached by now; no hop needed.
    this.flush();
    for (let i = this.cursor; i < this.order.length; i++) {
      const key = this.order[i];
      if (key === undefined) continue;
      const release = this.parked.get(key);
      if (release === undefined) continue;
      this.parked.delete(key);
      release();
    }
    this.cursor = this.order.length;
        // Keys outside the table never park, so this pass is empty in theory; sweep anyway -- never leave an unfulfilled promise.
    const leftovers = [...this.parked.values()];
    this.parked.clear();
    for (const release of leftovers) release();
  }

    /** Advance the cursor as far as it goes: head arrived -> release, then the next. */
  private pump(): void {
    while (this.cursor < this.order.length) {
      const key = this.order[this.cursor];
      if (key === undefined) break;
      const release = this.parked.get(key);
      if (release === undefined) break;
      this.parked.delete(key);
      this.cursor++;
      this.enqueue(release);
    }
  }
}

/**
  * Recover the first-born settlement order from the run's own event log.
 *
  * The event is the source, not a new column: settlement order is already recorded per event in dwf_event, persisted in the same
  * stroke as the journal row; reading it back needs no migration and makes pre-rule journals resumable at once (on the local store, 54 of 258
  * runs sit in exactly this shape). recoverImportClosure already walked the same road (recovering the closed-flag from event
  * order with zero schema change).
 *
  * Only each instance's **first** settlement is taken: the replayed epoch re-emits cached events in this gate's release order, so first-
  * wins is stable across epochs; the third epoch recovers the same table.
 *
  * The table keeps only terminal rows that would fulfill a promise on replay: report is void and preset artifact declarations synchronous -- neither
  * ever claims; still-running rows are handled as re-live, also no claim.
 */
export function recoverSettleOrder(
  journal: JournalStorePort,
  runId: string,
    /** Node rows read once (the engine's resume branch reads them anyway; passed in to skip a second full scan). */
  nodes: readonly NodeRecord[] = journal.listNodes(runId),
): ReplaySettleOrder {
  const claimable = new Set<string>();
  for (const node of nodes) {
    if (node.status !== "completed" && node.status !== "failed") continue;
    if (!claimsOnReplay(node)) continue;
    claimable.add(refToString(node));
  }
  if (claimable.size === 0) return ReplaySettleOrder.empty();

  const order: string[] = [];
  const seen = new Set<string>();
  for (const { event } of journal.listEvents(runId)) {
    const key = settledInstanceKey(event);
    if (key === undefined || seen.has(key) || !claimable.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return new ReplaySettleOrder(order);
}

/** Settlement event -> the instance key it settles; undefined otherwise. */
function settledInstanceKey(event: RunEvent): string | undefined {
  if (
    event.type === "node-settled" ||
    event.type === "artifact-published" ||
    event.type === "artifact-failed"
  ) {
    return refToString(event.instance);
  }
  return undefined;
}

/**
  * Would this row fulfill a script-awaitable promise on replay?
  * ask / world nodes yes; report no (void); artifact rows by member family -- content members are effects (async),
  * preset declarations synchronous; only the former claims the gate. Failed artifact rows are content-only (declarations have no rejection channel).
 */
function claimsOnReplay(node: NodeRecord): boolean {
  if (node.kind === "report") return false;
  if (node.kind !== "artifact") return true;
  if (node.status === "failed") return true;
  const kind = (node.result as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" && !isArtifactPresetOp(kind);
}

/**
  * Order-gated fulfillment of one replay hit: run settle only when due, fulfilling/rejecting by its result.
  * For promise paths (world nodes, content artifacts); ask release is callback-based -- use {@link ReplaySettleOrder.hold} directly.
 */
export function heldResolution<T>(
  hold: (instance: InstanceRef, release: () => void) => void,
  instance: InstanceRef,
  settle: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    hold(instance, () => {
      try {
        resolve(settle());
      } catch (cause) {
        reject(cause);
      }
    });
  });
}
