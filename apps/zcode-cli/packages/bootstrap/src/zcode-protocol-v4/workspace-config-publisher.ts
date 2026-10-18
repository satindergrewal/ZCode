// workspace-config topic publisher (v4 additive): conflated latest state of the workspace-level config catalogs (config options +
// slash command catalogs) + seq-interval accounting + snapshot/delta frame building.
// Same shape as SessionsIndexPublisher, simpler: the payload is one wholesale replacement state (config.updated),
// conflation = deep-compare debounce; the replay buffer is bounded, gaps degrade to snapshot (equivalent under conflated semantics).
import type {
  WorkspaceConfigDelta,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { workspaceConfigTopic } from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

interface ConfigSubscription {
  subscriptionId: string;
  connectionId: string;
    /** Next frame's fromSeq ((fromSeq, toSeq] semantics). */
  sentSeq: number;
  inFlight: TopicFrameReservation<WorkspaceConfigTopicFrame> | null;
  nextLogicalFrameOrdinal: number;
}

export interface WorkspaceConfigSubscribeResult {
  subscriptionId: string;
  mode: "snapshot" | "resume";
  frame: WorkspaceConfigTopicFrame | null;
  reservation: TopicFrameReservation<WorkspaceConfigTopicFrame> | null;
  rollback(): boolean;
}

interface WorkspaceConfigResyncRequest {
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

/** Catalog payloads are small and rarely change; deep comparison uses stable serialization (builder output field order is stable). */
function statesEqual(a: WorkspaceConfigState, b: WorkspaceConfigState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class WorkspaceConfigPublisher {
  private state: WorkspaceConfigState = { configOptions: [], slashCommands: [] };
  private currentSeq = 0;
    /** Bounded (seq, delta) replay buffer; overflow/gaps degrade to snapshot. */
  private readonly deltaLog: Array<{
    seq: number;
    delta: WorkspaceConfigDelta;
  }> = [];
  private readonly maxDeltaLog = 32;
  private readonly subscriptions = new Map<string, ConfigSubscription>();
  private readonly subscriptionIdByConnection = new Map<string, string>();
  private nextSubscriptionSerial = 1;
  private nextLogicalFrameSerial = 1;

  constructor(
    readonly workspaceId: string,
    readonly logEpoch: string,
    private readonly now: () => number = Date.now,
  ) {}

  private get topic(): string {
    return workspaceConfigTopic(this.workspaceId);
  }

  getState(): WorkspaceConfigState {
    return this.state;
  }

    /** Latest config catalog arrived -> conflated debounce; on change, account and advance seq. Returns whether anything changed. */
  publish(state: WorkspaceConfigState): boolean {
    if (statesEqual(this.state, state)) return false;
    this.state = state;
    this.currentSeq += 1;
    this.deltaLog.push({
      seq: this.currentSeq,
      delta: { op: "config.updated", config: state },
    });
    while (this.deltaLog.length > this.maxDeltaLog) this.deltaLog.shift();
    return true;
  }

  get seq(): number {
    return this.currentSeq;
  }

    /** Subscribe: resume when the base is valid and resumable, else snapshot. One subscription per connection (re-subscribe replaces the generation). */
  subscribe(
    connectionId: string,
    base?: { logEpoch: string; seq: number },
  ): WorkspaceConfigSubscribeResult {
    const result = this.subscribeReserved(connectionId, base);
    result.reservation?.commit();
    return result;
  }

  subscribeReserved(
    connectionId: string,
    base?: { logEpoch: string; seq: number },
  ): WorkspaceConfigSubscribeResult {
    const previousId = this.subscriptionIdByConnection.get(connectionId);
    const previousSubscription = previousId ? this.subscriptions.get(previousId) : undefined;
    if (previousId) this.subscriptions.delete(previousId);
    const subscriptionId = `wcs-${this.logEpoch}-${this.nextSubscriptionSerial++}`;
    const subscription: ConfigSubscription = {
      subscriptionId,
      connectionId,
      sentSeq: 0,
      inFlight: null,
      nextLogicalFrameOrdinal: 1,
    };
    this.subscriptions.set(subscriptionId, subscription);
    this.subscriptionIdByConnection.set(connectionId, subscriptionId);
    const rollback = (): boolean => {
      if (
        subscription.inFlight === null ||
        this.subscriptions.get(subscriptionId) !== subscription ||
        this.subscriptionIdByConnection.get(connectionId) !== subscriptionId
      ) {
        return false;
      }
      this.subscriptions.delete(subscriptionId);
      if (previousId && previousSubscription) {
        this.subscriptions.set(previousId, previousSubscription);
        this.subscriptionIdByConnection.set(connectionId, previousId);
      } else {
        this.subscriptionIdByConnection.delete(connectionId);
      }
      return true;
    };

    const canResume =
      base !== undefined &&
      base.logEpoch === this.logEpoch &&
      this.canResumeFrom(base.seq);
    if (canResume) {
      subscription.sentSeq = base.seq;
      const reservation =
        base.seq === this.currentSeq ? null : this.reserveDeltaFrame(subscription, "initial");
      return this.subscribeResult(
        subscriptionId,
        "resume",
        reservation,
        reservation ? rollback : () => false,
      );
    }
    const reservation = this.reserveFrame(
      subscription,
      this.snapshotFrame(subscriptionId),
      "initial",
    );
    return this.subscribeResult(subscriptionId, "snapshot", reservation, rollback);
  }

    /** same-sub recovery: rebuilt from the client's base, never trusting sentSeq. */
  resyncReserved(
    subscriptionId: string,
    request: WorkspaceConfigResyncRequest,
  ): WorkspaceConfigSubscribeResult | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    const previous = { sentSeq: subscription.sentSeq, inFlight: subscription.inFlight };
    subscription.inFlight = null;
    const base = request.base;
    const canResume =
      !request.forceSnapshot &&
      base !== null &&
      base.logEpoch === this.logEpoch &&
      this.canResumeFrom(base.seq);
    if (canResume) {
      subscription.sentSeq = base.seq;
      const reservation =
        base.seq === this.currentSeq
          ? this.reserveFrame(subscription, {
              topic: this.topic,
              subscriptionId,
              fromSeq: base.seq,
              toSeq: base.seq,
              sentAt: this.now(),
              payload: { kind: "deltas", deltas: [] },
            }, "recovery")
          : this.reserveDeltaFrame(subscription, "recovery");
      return this.subscribeResult(
        subscriptionId,
        "resume",
        reservation,
        this.resyncRollback(subscription, reservation, previous),
      );
    }
    subscription.sentSeq = 0;
    const reservation = this.reserveFrame(
      subscription,
      this.snapshotFrame(subscriptionId),
      "recovery",
    );
    return this.subscribeResult(
      subscriptionId,
      "snapshot",
      reservation,
      this.resyncRollback(subscription, reservation, previous),
    );
  }

  private resyncRollback(
    subscription: ConfigSubscription,
    reservation: TopicFrameReservation<WorkspaceConfigTopicFrame>,
    previous: Pick<ConfigSubscription, "sentSeq" | "inFlight">,
  ): () => boolean {
    return (): boolean => {
      if (
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        subscription.inFlight !== reservation
      ) {
        return false;
      }
      subscription.sentSeq = previous.sentSeq;
      subscription.inFlight = previous.inFlight;
      return true;
    };
  }

  private canResumeFrom(seq: number): boolean {
    if (seq < 0 || seq > this.currentSeq) return false;
    if (seq === this.currentSeq) return true;
    const firstPending = this.deltaLog.find((entry) => entry.seq > seq);
    return firstPending?.seq === seq + 1;
  }

  unsubscribe(subscriptionId: string, connectionId?: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    if (connectionId !== undefined && subscription.connectionId !== connectionId) {
      return;
    }
    this.subscriptions.delete(subscriptionId);
    if (this.subscriptionIdByConnection.get(subscription.connectionId) === subscriptionId) {
      this.subscriptionIdByConnection.delete(subscription.connectionId);
    }
  }

  hasSubscription(subscriptionId: string, connectionId?: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    return Boolean(
      subscription && (connectionId === undefined || subscription.connectionId === connectionId),
    );
  }

  private snapshotFrame(subscriptionId: string): WorkspaceConfigTopicFrame {
    return {
      topic: this.topic,
      subscriptionId,
      fromSeq: 0,
      toSeq: this.currentSeq,
      sentAt: this.now(),
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          workspaceId: this.workspaceId,
          logEpoch: this.logEpoch,
          config: this.state,
        },
      },
    };
  }

    /** Drains a subscription's unsent delta frames; null when there are none. */
  flush(subscriptionId: string): WorkspaceConfigTopicFrame | null {
    const reservation = this.reserveFlush(subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  reserveFlush(subscriptionId: string): TopicFrameReservation<WorkspaceConfigTopicFrame> | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    if (subscription.inFlight) return subscription.inFlight;
    if (subscription.sentSeq >= this.currentSeq) return null;
    return this.reserveDeltaFrame(subscription);
  }

  private reserveDeltaFrame(
    subscription: ConfigSubscription,
    deliveryKind: TopicFrameDeliveryKind = "online",
  ): TopicFrameReservation<WorkspaceConfigTopicFrame> {
    const pending = this.deltaLog.filter((entry) => entry.seq > subscription.sentSeq);
        // The replay buffer dropped part of the interval (seq gap) -> degrade to snapshot (equivalent under conflated semantics).
    if (pending.length === 0 || pending[0]!.seq !== subscription.sentSeq + 1) {
      return this.reserveFrame(
        subscription,
        this.snapshotFrame(subscription.subscriptionId),
        deliveryKind,
      );
    }
    const fromSeq = subscription.sentSeq;
    return this.reserveFrame(subscription, {
      topic: this.topic,
      subscriptionId: subscription.subscriptionId,
      fromSeq,
      toSeq: this.currentSeq,
      sentAt: this.now(),
      payload: { kind: "deltas", deltas: pending.map((entry) => entry.delta) },
    }, deliveryKind);
  }

  private reserveFrame(
    subscription: ConfigSubscription,
    frame: WorkspaceConfigTopicFrame,
    deliveryKind: TopicFrameDeliveryKind,
  ): TopicFrameReservation<WorkspaceConfigTopicFrame> {
    let committed = false;
    const reservation: TopicFrameReservation<WorkspaceConfigTopicFrame> = {
      deliveryKind,
      logicalFrameId: `${subscription.subscriptionId}-lf-${this.nextLogicalFrameSerial++}`,
      logicalFrameOrdinal: subscription.nextLogicalFrameOrdinal++,
      frame,
      commit: () => {
        if (committed) return true;
        if (
          this.subscriptions.get(subscription.subscriptionId) !== subscription ||
          subscription.inFlight !== reservation
        ) {
          return false;
        }
        subscription.sentSeq = frame.toSeq;
        subscription.inFlight = null;
        committed = true;
        return true;
      },
    };
    subscription.inFlight = reservation;
    return reservation;
  }

  private subscribeResult(
    subscriptionId: string,
    mode: "snapshot" | "resume",
    reservation: TopicFrameReservation<WorkspaceConfigTopicFrame> | null,
    rollback: () => boolean,
  ): WorkspaceConfigSubscribeResult {
    return {
      subscriptionId,
      mode,
      reservation,
      rollback,
      get frame() {
        reservation?.commit();
        return reservation?.frame ?? null;
      },
    };
  }

  hasSubscribers(): boolean {
    return this.subscriptions.size > 0;
  }

  subscriptionIds(): string[] {
    return [...this.subscriptions.keys()];
  }

  connectionIdForSubscription(subscriptionId: string): string | null {
    return this.subscriptions.get(subscriptionId)?.connectionId ?? null;
  }
}
