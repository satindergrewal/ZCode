import type { TopicFrameDeliveryKind } from "@zcode/shared/zcode-protocol-v4";

/** Two-phase commit handle for the publisher watermark. */
export interface TopicFrameReservation<F> {
  /** Assigned authoritatively by publisher admission; shards and consumers must not guess it from ordering. */
  readonly deliveryKind: TopicFrameDeliveryKind;
  readonly logicalFrameId: string;
  /** Monotonically increasing within one subscription; used to reject stale PersistentProtocol frame replays. */
  readonly logicalFrameOrdinal: number;
  readonly frame: F;
  /** Advances the watermark only while the current subscription generation is valid. */
  commit(): boolean;
}
