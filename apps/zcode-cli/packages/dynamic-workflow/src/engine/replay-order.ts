/**
 * Replay's SETTLE-ORDER gate (docs/execution-engine.md "Replaying the settle order").
 *
 * Site ordinals mint at call arrival, so every post-await journal call in a branch is numbered by
 * fan-out completion order, not script order. That order is wall-clock; nothing in the node rows
 * reproduces it: releasing cache hits in admission order lets the replayed Promise.all run
 * continuations in array order, so the first post-join report takes the journal number of the
 * fastest branch, and the run dies in its own defensive check (InputHashMismatch) - a pure script
 * blamed for nondeterminism. Field 2026-09-17: 5-way research, completion 1,4,2,5,3, resume died
 * at report#2@2.
 *
 * Resume therefore replays the SCHEDULING, not just the answers: this gate holds the first-born
 * settlement order; cache-hit settlements park at their release point until every earlier one
 * released. Instances off-table pass straight through - the gate binds only what it has evidence
 * for, degrading to legacy behavior on pre-rule journals and never deadlocking an unknown run.
 */

import { isArtifactPresetOp } from "../facade/registry.js";
import { NODE_KINDS, type RunEventType } from "./journal-read-types.js";
import type { InstanceRef, JournalStorePort, NodeKind, NodeRecord, RunEvent } from "./types.js";
import { refToString } from "./types.js";

/**
 * Node kinds that always resolve a promise on replay: all but report (void) and artifact
 * (family-dependent, see claimsOnReplay). Derived from NODE_KINDS: new kinds opt in by default.
 */
export const REPLAY_WORK_KINDS: readonly NodeKind[] = NODE_KINDS.filter(
  (kind) => kind !== "report" && kind !== "artifact",
);

/** Settle order reads only these three events (settledInstanceKey); others need not load. */
const SETTLE_EVENT_TYPES: readonly RunEventType[] = [
  "node-settled",
  "artifact-published",
  "artifact-failed",
];

/**
 * Node rows the settle order needs: work rows WITHOUT results (kind/status/coordinates only);
 * artifact rows with them (family in result.kind; artifacts bounded 32 ids x 16 versions). Report
 * rows unread - they never claim the gate and a run may hold 65,536
 * (docs/execution-engine.md "Reading the journal").
 */
export function readReplayRows(
  journal: JournalStorePort,
  runId: string,
): { workRows: NodeRecord[]; artifactRows: NodeRecord[] } {
  return {
    workRows: journal.listNodes(runId, { kinds: REPLAY_WORK_KINDS, withResult: false }),
    artifactRows: journal.listNodes(runId, { kinds: ["artifact"], withResult: true }),
  };
}

export class ReplaySettleOrder {
  /** Instance key -> position in the first-born settle order. */
  private readonly position: ReadonlyMap<string, number>;
  /** How far released (the order table's cursor). */
  private cursor = 0;
  /** Arrived releases waiting for their turn. */
  private readonly parked = new Map<string, () => void>();
  /** Turned, queued behind a microtask (FIFO, see enqueue). */
  private queue: Array<() => void> = [];
  private flushing = false;
  /** Opened permanently at run settlement (see open). */
  private opened = false;

  constructor(private readonly order: readonly string[] = []) {
    const position = new Map<string, number>();
    order.forEach((key, index) => position.set(key, index));
    this.position = position;
  }

  static empty(): ReplaySettleOrder {
    return new ReplaySettleOrder([]);
  }

  /** The first-born settle order (diagnostics/tests). */
  recorded(): readonly string[] {
    return this.order;
  }

  /**
   * Release one replay hit under the order. Runs at once when the instance is off-table (fresh
   * call, legacy journal), the gate opened, or its turn passed; else parks until called.
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
   * 投递永远晚于**产生这个 promise 的那次调用**：释放动作先进队列，一个微任务之后才执行。
   *
   * 少了这一跳，次序就是反的：`Promise.all` 里每条分支都在同一个同步片里发起自己的调用，
   * 队首那条的释放会**在它自己的 `ask()` 里**同步发生——那时它的 `await` 还没挂上去，于是
   * 它的续体排在「早先已挂上、刚被这次 pump 兑现」的那条后面。微任务这一跳让所有 `await`
   * 先挂稳，投递次序因此就是释放次序。这不是时钟：跳的是确定的一步，队列是 FIFO。
   */
  private enqueue(release: () => void): void {
    this.queue.push(release);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => this.flush());
  }

  /** Run queued deliveries FIFO (no-op when empty; safe to repeat). */
  private flush(): void {
    this.flushing = false;
    const batch = this.queue;
    this.queue = [];
    for (const release of batch) release();
  }

  /**
   * Run settled: open the gate forever; drain parked in recorded order.
   *
   * Not releasing would leave script promises unresolved - the harness sandbox closes anyway, but
   * same-process rigs (engine tests, EvalWorkflowSnippet) would hang. Post-settlement release is
   * safe: markSettled ran; every host path starts with isRunSettled().
   */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    // Queued deliveries drain in order first: settlement calls this BEFORE run-settled, synchronously,
    // so hit events never land after the terminal one. Every parked await settled long ago; no hop.
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
    // 次序表之外的键从不入 parked，这一轮理论上是空的；兜底清空，绝不留下没人兑现的 promise。
    const leftovers = [...this.parked.values()];
    this.parked.clear();
    for (const release of leftovers) release();
  }

  /** Advance the cursor as far as possible: head arrived -> release, next. */
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
 * Recover the first-born settle order from the run's own event log.
 *
 * 事实来源是事件而不是新列：结算次序**本来就**逐条记在 `dwf_event` 里，而它与 journal 行同一次
 * 写入落库；读回来既不用迁移，也让本规则之前跑出来的 journal 立刻可 resume（本地库里 258 个 run
 * 有 54 个正卡在这个形状上）。同一条路 `recoverImportClosure` 已经走过（零 schema 变更地从事件
 * 次序恢复关门判定）。
 *
 * Only each instance's FIRST settlement: a replayed life re-emits cached events in this gate's
 * order; first-wins is thus life-stable - the third life recovers the same table.
 *
 * 表里只留「重放时会兑现一个 promise 的终态行」：`report` 是 void、预置产物声明是同步的，两者
 * 永远不会来认领，留在表里就会把游标堵死；仍是 `running` 的行按重新 live 执行处理，也不认领。
 */
export function recoverSettleOrder(
  journal: JournalStorePort,
  runId: string,
  /** Node rows already read (the resume branch reads them anyway; passed in to skip a second read). */
  nodes: readonly NodeRecord[] = Object.values(readReplayRows(journal, runId)).flat(),
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
  for (const { event } of journal.listEvents(runId, {
    types: SETTLE_EVENT_TYPES,
    reportItems: { limit: 0 },
  })) {
    const key = settledInstanceKey(event);
    if (key === undefined || seen.has(key) || !claimable.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return new ReplaySettleOrder(order);
}

/** Settlement event -> its instance key; undefined otherwise. */
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
 * Would this row resolve an awaitable promise on replay? asks/world yes; report no (void);
 * artifacts by family - content is an effect (async) and claims; preset declares are sync. Failed
 * artifacts are content-only (declarations have no rejection channel).
 */
function claimsOnReplay(node: NodeRecord): boolean {
  if (node.kind === "report") return false;
  if (node.kind !== "artifact") return true;
  if (node.status === "failed") return true;
  const kind = (node.result as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" && !isArtifactPresetOp(kind);
}

/**
 * 受次序闸约束地兑现一次 replay 命中：轮到它时才执行 `settle` 并按其结果兑现 / 拒绝。
 * 给的是 promise 路径（world 节点与内容产物）；ask 的释放本就是回调，直接用 {@link ReplaySettleOrder.hold}。
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
