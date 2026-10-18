import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * Broadcast message
 *
 * Cross-window state sync. Sent from a Renderer via host -> main -> other hosts -> their Renderers.
 */
export interface BroadcastMessage {
  /** Channel name, e.g. state:theme, state:locale */
  channel: string;
  /** Message payload */
  payload: unknown;
  /** Origin window id (filled by BroadcastHub; receivers use it to skip themselves) */
  sourceWindowId?: number;
}

/** Temporary reservation for a cross-window opaque claim; the token drives safe commit/release. */
export interface BroadcastClaimLease {
  key: string;
  token: string;
}

export type BroadcastClaimAcquireResult =
  | { status: "acquired"; lease: BroadcastClaimLease }
  | { status: "busy"; retryAfterMs: number }
  | { status: "committed" }
  | { status: "unavailable" };

/**
 * Broadcast service interface
 *
 * Path: Renderer -> (RPC call) -> Host -> (parentPort) -> Main (BroadcastHub)
 *       -> (postMessage) -> other Host -> (RPC event onMessage) -> that Renderer
 */
export interface IBroadcastService {
  /** Send a broadcast message */
  send(message: BroadcastMessage): Promise<void>;
  /** Request a tokened temporary reservation; on busy retry after retryAfterMs. */
  acquireClaim(key: string): Promise<BroadcastClaimAcquireResult>;
  /** Commit the reservation into a claim lasting for the app process lifetime. */
  commitClaim(lease: BroadcastClaimLease): Promise<void>;
  /** Release an uncommitted reservation by token; late tokens never disturb a later winner. */
  releaseClaim(lease: BroadcastClaimLease): Promise<void>;
  /** Atomically take an opaque key within this app process; only the first claim returns true. */
  tryClaim(key: string): Promise<boolean>;
  /** Receive broadcasts from other windows */
  onMessage: Event<BroadcastMessage>;
}

export const IBroadcastService = createServiceDescriptor<IBroadcastService>(
  ServiceChannels.Broadcast,
);
