import type { AcknowledgedRelayOutboundBatch } from "./webRemoteControlAcknowledgedRelayProtocolTypes.js";

const COMPACT_RELEASED_PREFIX_THRESHOLD = 1_024;

export class AcknowledgedRelayBatchQueue {
  private storage: Array<AcknowledgedRelayOutboundBatch | undefined> = [];
  private headIndex = 0;
  private nextUnsentIndex = 0;

  get oldest(): AcknowledgedRelayOutboundBatch | undefined {
    return this.storage[this.headIndex];
  }

  get nextUnsent(): AcknowledgedRelayOutboundBatch | undefined {
    return this.storage[this.nextUnsentIndex];
  }

  get activeCount(): number {
    return this.storage.length - this.headIndex;
  }

  /** Internal observation point for bound tests; not exported from the @zcode/client public entry. */
  get retainedStorageSlots(): number {
    return this.storage.length;
  }

  get retainedBatchReferenceCount(): number {
    let count = 0;
    for (const batch of this.storage) if (batch) count += 1;
    return count;
  }

  get retainedPayloadBytes(): number {
    let bytes = 0;
    for (const batch of this.storage) if (batch) bytes += batch.outerBytes;
    return bytes;
  }

  append(batch: AcknowledgedRelayOutboundBatch): void {
    this.storage.push(batch);
  }

  advanceUnsent(): void {
    if (this.nextUnsentIndex < this.storage.length) this.nextUnsentIndex += 1;
  }

  resetReplay(): void {
    for (let index = this.headIndex; index < this.storage.length; index += 1) {
      const batch = this.storage[index];
      if (batch) batch.nextFrameIndex = 0;
    }
    this.nextUnsentIndex = this.headIndex;
  }

  releaseThrough(ackMessageSeq: number): { releasedBytes: number; releasedCount: number } {
    let releasedBytes = 0;
    let releasedCount = 0;
    while (this.headIndex < this.storage.length) {
      const batch = this.storage[this.headIndex]!;
      if (batch.messageSeq > ackMessageSeq) break;
      releasedBytes += batch.outerBytes;
      releasedCount += 1;
      // Drop payload/frame references right after ACK; compact only squeezes empty slots and must never gate big-data release.
      this.storage[this.headIndex] = undefined;
      this.headIndex += 1;
    }
    this.nextUnsentIndex = Math.max(this.nextUnsentIndex, this.headIndex);
    this.compactReleasedPrefix();
    return { releasedBytes, releasedCount };
  }

  clear(): void {
    this.storage = [];
    this.headIndex = 0;
    this.nextUnsentIndex = 0;
  }

  private compactReleasedPrefix(): void {
    // Bugfix: splicing the head per cumulative ACK degrades to O(n^2) once tiny RPCs pile up.
    // Advance head only; batch-compact at the threshold once past half released, keeping move cost amortized.
    if (
      this.headIndex < COMPACT_RELEASED_PREFIX_THRESHOLD ||
      this.headIndex * 2 < this.storage.length
    ) {
      return;
    }
    const releasedPrefix = this.headIndex;
    this.storage = this.storage.slice(releasedPrefix);
    this.nextUnsentIndex = Math.max(0, this.nextUnsentIndex - releasedPrefix);
    this.headIndex = 0;
  }
}
