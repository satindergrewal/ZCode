// Journal-sequence capture layer for engine events. A separate module rather than part of launch.ts: that file's job is "assemble and start a run", this one is
// "hand the sequence allocated by appendEvent to the emit immediately after" -- two complete concerns, and this one has a single consumer.
import type { JournalStorePort, RunEvent, StoredEvent } from "@zcode/dynamic-workflow";

/**
 * Wraps the journal for one reason: capture the sequence allocated by `appendEvent` for the emit immediately after.
 *
 * Invariant (guaranteed by the engine's `record()` and pinned by tests): every event is "appendEvent then synchronously
 * emit", one-to-one. So the last append's sequence is the sequence of the event currently being emitted.
 * As a safeguard, verify by object **reference equality**: a mismatch means the invariant broke; fall back to the last sequence instead of
 * guessing -- a silently wrong number is harder to debug than standing still, and tests catch it before production does.
 */
export function createJournalSequenceCapture(journal: JournalStorePort): {
  journal: JournalStorePort;
  sequenceOf: (event: RunEvent) => number;
  /** 同一条事件落库时盖的戳（`StoredEvent.timeCreated`）；引用不相等时不猜，回 `undefined`。 */
  timeCreatedOf: (event: RunEvent) => number | undefined;
} {
  let lastStored: StoredEvent | undefined;
  // Explicit per-method forwarding instead of `{...journal, appendEvent}`: both are class instances, and spreading copies only own properties,
  // dropping prototype methods (the engine's next getRun would TypeError). The forwarded surface is the engine port only:
  // orphan convergence and the narrow enum query deliberately stay out -- they happen service-side against deps.journal, not through this layer.
  const wrapped: JournalStorePort = {
    createRun: (record) => journal.createRun(record),
    getRun: (runId) => journal.getRun(runId),
    updateRunStatus: (runId, status, settlement) =>
      journal.updateRunStatus(runId, status, settlement),
    updateRunUsage: (runId, spentTokens) => journal.updateRunUsage(runId, spentTokens),
    updateRunCaps: (runId, caps) => journal.updateRunCaps(runId, caps),
    // 补全把有效脚本写回 run 行（docs/execution-engine.md「Holes」）；与其余写入同样原样转发。
    updateRunScript: (runId, scriptText, scriptHash) =>
      journal.updateRunScript(runId, scriptText, scriptHash),
    putActor: (record) => journal.putActor(record),
    getActor: (runId, siteId, ordinal) => journal.getActor(runId, siteId, ordinal),
    // 读面选项必须原样转发（docs/execution-engine.md「Reading the journal」）：TS 允许实现的形参
    // 比签名少，`(runId) => journal.listNodes(runId, <固定选项>)` 这种写法照样编译通过，却把调用方
    // 的过滤悄悄换掉，引擎的窄读就退化回整表读。
    listActors: (runId, opts) => journal.listActors(runId, opts),
    putNode: (record) => journal.putNode(record),
    getNode: (runId, siteId, ordinal, opts) => journal.getNode(runId, siteId, ordinal, opts),
    listNodes: (runId, opts) => journal.listNodes(runId, opts),
    countNodes: (runId, kind) => journal.countNodes(runId, kind),
    sumResultBytes: (runId, kind) => journal.sumResultBytes(runId, kind),
    appendEvent: (runId, event) => {
      const stored = journal.appendEvent(runId, event);
      lastStored = stored;
      return stored;
    },
    listEvents: (runId, opts) => journal.listEvents(runId, opts),
  };
  return {
    journal: wrapped,
    sequenceOf: (event) =>
      lastStored?.event === event ? lastStored.sequence : (lastStored?.sequence ?? 0),
    // 与 sequenceOf 同一条回落：内存 journal 在存储边界上深拷贝事件（引用不等），而「刚 append 的
    // 就是正在 emit 的」是引擎 record() 的契约，所以这里按最后一次 append 的戳给。
    timeCreatedOf: () => lastStored?.timeCreated,
  };
}
