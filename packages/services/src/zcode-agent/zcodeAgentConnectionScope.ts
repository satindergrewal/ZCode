/* eslint-disable max-lines -- isomorphic connection-ownership lifecycle for the three V4 topic families, in one facade */
// V4 connection-scoped service facade: every RPC attachment owns its subscriptions,
// while the base service only relays CLI facts - no business state copies in host/main/relay.
import { Emitter, Event as RpcEvent, type Event, type IDisposable } from "@zcode/rpc";
import {
  V4_WIRE_PROTOCOL_VERSION,
  clientHelloSchema,
  clientSupportsWorkflowRunDeltas,
  conversationTopic,
  sessionsIndexTopic,
  workspaceConfigTopic,
  type ConversationTopicWireCandidate,
  type HelloMessage,
  type SessionsIndexTopicWireCandidate,
  type V4ConnectionFlowState,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  IZCodeAgentService,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentRuntimePolicy,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";

export type ZCodeAgentV4ClientMode = "desktop-continuous" | "web-remote-replayable";

export interface ZCodeAgentV4ConnectionContext {
  connectionId: string;
  clientMode: ZCodeAgentV4ClientMode;
  role?: "terminal-client" | "trusted-host-relay";
  /**
   * This connection's clientHello declares workflowRun.* key-level delta support. Like clientMode:
   // written by this facade from handshake facts; same-named subscription fields are cleared -
   // delta awareness is a property of the connection, not a per-subscription choice. Absent = legacy consumer.
   */
  workflowRunDeltas?: boolean;
}

const TRUSTED_CONNECTION_FIELD = "__zcodeTrustedV4Connection";
const TRUSTED_UNSUBSCRIBE_ROUTE_FIELD = "__zcodeTrustedV4UnsubscribeRoute";

type TrustedConnectionCarrier = {
  [TRUSTED_CONNECTION_FIELD]?: ZCodeAgentV4ConnectionContext;
};

interface TrustedZCodeAgentV4UnsubscribeRoute {
  topic: string;
  connectionId: string;
}

type TrustedUnsubscribeRouteCarrier = {
  [TRUSTED_UNSUBSCRIBE_ROUTE_FIELD]?: TrustedZCodeAgentV4UnsubscribeRoute;
};

export function readTrustedZCodeAgentV4UnsubscribeRoute(
  value: unknown,
): TrustedZCodeAgentV4UnsubscribeRoute | null {
  if (typeof value !== "object" || value === null) return null;
  const route = (value as TrustedUnsubscribeRouteCarrier)[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD];
  if (!route || typeof route.topic !== "string" || typeof route.connectionId !== "string") {
    return null;
  }
  return route;
}

/**
 * Passed only from host facade to base/remote service proxy; the facade overwrites same-named
 * UI fields, so renderer/mobile cannot fake a trusted connection mode.
 */
export function readTrustedZCodeAgentV4Connection(
  value: unknown,
): ZCodeAgentV4ConnectionContext | null {
  if (typeof value !== "object" || value === null) return null;
  const context = (value as TrustedConnectionCarrier)[TRUSTED_CONNECTION_FIELD];
  if (!context || typeof context.connectionId !== "string") return null;
  if (
    context.clientMode !== "desktop-continuous" &&
    context.clientMode !== "web-remote-replayable"
  ) {
    return null;
  }
  return {
    connectionId: context.connectionId,
    clientMode: context.clientMode,
    // True only: absent and false both mean legacy consumer; key presence is the downstream signal.
    ...(context.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
  };
}

function withTrustedConnection<T extends object>(
  value: T,
  context: ZCodeAgentV4ConnectionContext,
): T {
  const forwarded: Record<string, unknown> = {
    ...(value as unknown as Record<string, unknown>),
  };
  // When the shared service is exposed on several RPC ports, callers could pass profile and all
  // ports shared one workspace fan-out. The facade clears spoofable fields, then writes host truth.
  delete forwarded[TRUSTED_CONNECTION_FIELD];
  delete forwarded["connectionId"];
  delete forwarded["clientMode"];
  delete forwarded["deliveryProfile"];
  delete forwarded["subscriberScope"];
  // Trusted bit like clientMode: the UI subscribe path cannot pick its own delta encoding.
  delete forwarded["workflowRunDeltas"];
  forwarded[TRUSTED_CONNECTION_FIELD] = context;
  return forwarded as T;
}

function withTrustedUnsubscribeRoute<T extends object>(
  value: T,
  route: TrustedZCodeAgentV4UnsubscribeRoute,
): T {
  const forwarded = {
    ...(value as unknown as Record<string, unknown>),
  };
  delete forwarded[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD];
  forwarded[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD] = route;
  return forwarded as T;
}

function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function workspaceTarget(target: ZCodeAgentWorkspaceTarget): ZCodeAgentWorkspaceTarget {
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
}

type SubscriptionKind = "conversation" | "sessions-index" | "workspace-config";

interface OwnedSubscription {
  kind: SubscriptionKind;
  ownershipKey: string;
  subscriptionId: string;
  topic: string;
  connectionId: string;
  clientMode: ZCodeAgentV4ClientMode;
  target: ZCodeAgentWorkspaceTarget;
}

interface ConnectionFlowRoute {
  key: string;
  target: ZCodeAgentWorkspaceTarget;
  connection: ZCodeAgentV4ConnectionContext;
}

type RoutedTopicFrame =
  | ConversationTopicWireCandidate
  | SessionsIndexTopicWireCandidate
  | WorkspaceConfigTopicWireCandidate;

interface PendingOwnership {
  kind: SubscriptionKind;
  target: ZCodeAgentWorkspaceTarget;
  topic: string;
  frames: RoutedTopicFrame[];
  stagedBytes: number;
  overflowReason: string | null;
  runtimeGeneration: number;
  invalidatedByRuntimeRestart: boolean;
}

interface RoutedFrameEvent {
  emitter: Emitter<RoutedTopicFrame>;
  upstream: IDisposable;
}

// The ACK window covers control-plane races only, not subscriber buffer/resync. Bound by both
// frame count and JSON bytes so a rogue peer cannot pin host memory during subscribe pending.
const MAX_PENDING_OWNERSHIP_FRAMES = 1_024;
const MAX_PENDING_OWNERSHIP_BYTES = 32 * 1024 * 1024;
const MAX_DOWNSTREAM_CONNECTION_ID_LENGTH = 256;

function assertConnectionId(connectionId: string): void {
  if (
    connectionId.trim().length === 0 ||
    connectionId.length > MAX_DOWNSTREAM_CONNECTION_ID_LENGTH
  ) {
    throw new Error("fault.connection.invalidConnectionId");
  }
}

function namespaceRelayConnectionId(
  upstreamConnectionId: string,
  downstreamConnectionId: string,
): string {
  // Length-prefixing avoids a/b+c vs a+b/c separator collisions; connectionId stays an
  // opaque route key, opaque to business layers.
  return `relay:${upstreamConnectionId.length}:${upstreamConnectionId}${downstreamConnectionId.length}:${downstreamConnectionId}`;
}

function frameBytes(frame: RoutedTopicFrame): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

function deliveryProfileFor(clientMode: ZCodeAgentV4ClientMode): HelloMessage["deliveryProfile"] {
  return clientMode === "desktop-continuous" ? "continuous" : "replayable";
}

function createHello(context: ZCodeAgentV4ConnectionContext): HelloMessage {
  const continuous = context.clientMode === "desktop-continuous";
  return {
    kind: "hello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: context.connectionId,
    clientMode: context.clientMode,
    deliveryProfile: deliveryProfileFor(context.clientMode),
    serverTime: Date.now(),
    capabilities: {
      nativeDialogs: continuous,
      localTerminal: continuous,
      binaryFrames: false,
      compression: "none",
      workspaceHookReview: true,
      independentPlanState: true,
      // This host relays workflowRun.* key deltas; clients must see it to echo it in clientHello
      // (that capabilities schema is .strict(); legacy hosts would fail the handshake otherwise).
      workflowRunDeltas: true,
    },
    auth: {},
  };
}

export interface ZCodeAgentConnectionScope {
  readonly service: IZCodeAgentService;
  /** MessagePort/transport sideband only; not a UI-facing RPC. */
  setTransportFlowState(state: V4ConnectionFlowState): Promise<void>;
  dispose(): Promise<void>;
}

// Establishes a trusted V4 facade for one host/server RPC attachment.
export function createZCodeAgentConnectionScope(
  base: IZCodeAgentService,
  context: ZCodeAgentV4ConnectionContext,
): ZCodeAgentConnectionScope {
  assertConnectionId(context.connectionId);
  const role = context.role ?? "terminal-client";
  const owned = new Map<string, OwnedSubscription>();
  const routeKeyByOwnership = new Map<string, string>();
  const pendingByOwnership = new Map<string, Set<PendingOwnership>>();
  const routedFrameEvents = new Map<string, RoutedFrameEvent>();
  const runtimeGenerationByWorkspaceKey = new Map<string, number>();
  let disposed = false;
  // Trusted relays already choose identity at the transport layer (stdio / Node-only WS role header);
  // terminal UIs still go hello -> clientHello.
  let handshakeComplete = role === "trusted-host-relay";
  let helloIssued = role === "trusted-host-relay";
  let boundClientId: string | null = null;
  /** Delta declaration from clientHello; trusted relays have none and forward the downstream's. */
  let clientWorkflowRunDeltas = false;
  let commandQueryWorkspaceKey: string | null = null;
  let currentTransportFlowState: V4ConnectionFlowState = "drained";
  let flowClosed = false;
  let flowUpdateChain = Promise.resolve();
  const forwardedFlowStateByRoute = new Map<string, V4ConnectionFlowState>();
  /** Workspace routes touched by this attachment live until port dispose, trusted-closed with no subscriptions. */
  const attachmentFlowRoutes = new Map<string, ConnectionFlowRoute>();

  const forwardedConnection = (params: unknown): ZCodeAgentV4ConnectionContext => {
    const downstream = readTrustedZCodeAgentV4Connection(params);
    if (role === "trusted-host-relay" && downstream) {
      assertConnectionId(downstream.connectionId);
      return {
        connectionId: namespaceRelayConnectionId(context.connectionId, downstream.connectionId),
        clientMode: downstream.clientMode,
        // The delta bit belongs to the downstream end: relays do not consume frames, only forward
        // the downstream clientHello declaration.
      };
    }
    return {
      connectionId: context.connectionId,
      clientMode: context.clientMode,
      ...(clientWorkflowRunDeltas ? { workflowRunDeltas: true } : {}),
    };
  };

  const assertOpen = () => {
    if (disposed) throw new Error("fault.connection.closed");
  };
  const assertReady = () => {
    assertOpen();
    if (!handshakeComplete) throw new Error("fault.connection.handshakeRequired");
  };
  const routeKey = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ) => `${kind}\0${workspaceKey(target)}\0${topic}\0${subscriptionId}\0${connectionId}`;
  const ownershipKey = (kind: SubscriptionKind, target: ZCodeAgentWorkspaceTarget, topic: string) =>
    `${kind}\0${workspaceKey(target)}\0${topic}`;
  const routedEventKey = (kind: SubscriptionKind, target: ZCodeAgentWorkspaceTarget) =>
    `${kind}\0${workspaceKey(target)}`;
  const flowRouteKey = (target: ZCodeAgentWorkspaceTarget, connectionId: string) =>
    `${workspaceKey(target)}\0${connectionId}`;
  const flowRouteForEntry = (entry: OwnedSubscription): ConnectionFlowRoute => ({
    key: flowRouteKey(entry.target, entry.connectionId),
    target: entry.target,
    connection: {
      connectionId: entry.connectionId,
      clientMode: entry.clientMode,
    } satisfies ZCodeAgentV4ConnectionContext,
  });
  const currentFlowRoutes = () => {
    const routes = new Map<string, ConnectionFlowRoute>(attachmentFlowRoutes);
    for (const entry of owned.values()) {
      const route = flowRouteForEntry(entry);
      routes.set(route.key, route);
    }
    return routes;
  };
  const forwardFlowRoute = async (
    route: ConnectionFlowRoute,
    state: V4ConnectionFlowState,
  ): Promise<void> => {
    if (forwardedFlowStateByRoute.get(route.key) === state) return;
    await base.setConnectionFlowStateV4(
      withTrustedConnection(
        {
          ...workspaceTarget(route.target),
          state,
        },
        route.connection,
      ),
    );
    forwardedFlowStateByRoute.set(route.key, state);
  };
  const applyTransportFlowState = async (state: V4ConnectionFlowState): Promise<void> => {
    if (flowClosed && state !== "closed") return;
    currentTransportFlowState = state;
    if (state === "closed") flowClosed = true;
    for (const route of currentFlowRoutes().values()) {
      await forwardFlowRoute(route, state);
    }
  };
  const enqueueTransportFlowState = (state: V4ConnectionFlowState): Promise<void> => {
    if (disposed || (flowClosed && state !== "closed")) return Promise.resolve();
    const update = flowUpdateChain.then(() => applyTransportFlowState(state));
    // SAT->DRN and close must keep submission order; one RPC failure must not break later
    // close cleanup, though the caller still gets that update's rejection.
    flowUpdateChain = update.catch(() => {});
    return update;
  };
  const syncCurrentFlowForEntry = async (entry: OwnedSubscription): Promise<void> => {
    if (currentTransportFlowState !== "saturated") return;
    await forwardFlowRoute(flowRouteForEntry(entry), "saturated");
  };
  const closeUnusedFlowRoute = async (entry: OwnedSubscription): Promise<void> => {
    const route = flowRouteForEntry(entry);
    if (currentFlowRoutes().has(route.key)) return;
    if (forwardedFlowStateByRoute.has(route.key)) {
      await forwardFlowRoute(route, "closed");
      forwardedFlowStateByRoute.delete(route.key);
    }
  };
  const remember = (subscriptionId: string, entry: OwnedSubscription): void => {
    const key = routeKey(entry.kind, entry.target, entry.topic, subscriptionId, entry.connectionId);
    const previous = routeKeyByOwnership.get(entry.ownershipKey);
    if (previous) owned.delete(previous);
    routeKeyByOwnership.set(entry.ownershipKey, key);
    owned.set(key, entry);
  };
  const findBySubscription = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    subscriptionId: string,
    expectedRoute: TrustedZCodeAgentV4UnsubscribeRoute | null,
  ): OwnedSubscription | null => {
    const expectedWorkspaceKey = workspaceKey(target);
    const matches = [...owned.values()].filter(
      (entry) =>
        entry.kind === kind &&
        entry.subscriptionId === subscriptionId &&
        workspaceKey(entry.target) === expectedWorkspaceKey &&
        (!expectedRoute ||
          (entry.topic === expectedRoute.topic &&
            entry.connectionId === expectedRoute.connectionId)),
    );
    // Terminal UI passes only subId; on collision within method/workspace, refuse to guess.
    // Trusted relays hit exactly via the facade-written topic/connection.
    return matches.length === 1 ? matches[0]! : null;
  };
  const ownsFrame = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: { subscriptionId: string; topic: string },
  ) => {
    const expectedWorkspaceKey = workspaceKey(target);
    return [...owned.values()].some(
      (entry) =>
        entry.kind === kind &&
        entry.subscriptionId === frame.subscriptionId &&
        entry.topic === frame.topic &&
        workspaceKey(entry.target) === expectedWorkspaceKey,
    );
  };
  const forwardedUnsubscribeRoute = (
    params: unknown,
  ): TrustedZCodeAgentV4UnsubscribeRoute | null => {
    if (role !== "trusted-host-relay") return null;
    const downstream = readTrustedZCodeAgentV4UnsubscribeRoute(params);
    if (!downstream) return null;
    assertConnectionId(downstream.connectionId);
    return {
      topic: downstream.topic,
      connectionId: namespaceRelayConnectionId(context.connectionId, downstream.connectionId),
    };
  };
  const beginPendingOwnership = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
  ): PendingOwnership => {
    const pending: PendingOwnership = {
      kind,
      target: workspaceTarget(target),
      topic,
      frames: [],
      stagedBytes: 0,
      overflowReason: null,
      runtimeGeneration: runtimeGenerationByWorkspaceKey.get(workspaceKey(target)) ?? 0,
      invalidatedByRuntimeRestart: false,
    };
    const key = ownershipKey(kind, target, topic);
    const group = pendingByOwnership.get(key) ?? new Set<PendingOwnership>();
    group.add(pending);
    pendingByOwnership.set(key, group);
    return pending;
  };
  const removePendingOwnership = (pending: PendingOwnership): void => {
    const key = ownershipKey(pending.kind, pending.target, pending.topic);
    const group = pendingByOwnership.get(key);
    group?.delete(pending);
    if (group?.size === 0) pendingByOwnership.delete(key);
  };
  const discardPendingOwnership = (pending: PendingOwnership): void => {
    removePendingOwnership(pending);
    pending.frames.length = 0;
    pending.stagedBytes = 0;
    pending.overflowReason = null;
  };
  const stageFrame = (pending: PendingOwnership, frame: RoutedTopicFrame): void => {
    if (pending.overflowReason || pending.invalidatedByRuntimeRestart) return;
    const bytes = frameBytes(frame);
    if (
      pending.frames.length + 1 > MAX_PENDING_OWNERSHIP_FRAMES ||
      pending.stagedBytes + bytes > MAX_PENDING_OWNERSHIP_BYTES
    ) {
      // Legacy ACK staging shifted the oldest frame on overflow, permanently holing a logical
      // frame. Overflow must clear the batch and fail explicitly.
      pending.frames.length = 0;
      pending.stagedBytes = 0;
      pending.overflowReason = "fault.subscription.initialFrameStagingOverflow";
      return;
    }
    pending.frames.push(frame);
    pending.stagedBytes += bytes;
  };
  const routeIncomingFrame = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: RoutedTopicFrame,
    emitter: Emitter<RoutedTopicFrame>,
  ): void => {
    if (ownsFrame(kind, target, frame)) {
      emitter.fire(frame);
      return;
    }
    const group = pendingByOwnership.get(ownershipKey(kind, target, frame.topic));
    if (!group) return;
    for (const pending of group) stageFrame(pending, frame);
  };
  const routedEvent = <T extends RoutedTopicFrame>(
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    source: Event<T>,
  ): Event<T> => {
    const key = routedEventKey(kind, target);
    let route = routedFrameEvents.get(key);
    if (!route) {
      const emitter = new Emitter<RoutedTopicFrame>();
      route = {
        emitter,
        upstream: source((frame) => routeIncomingFrame(kind, target, frame, emitter)),
      };
      routedFrameEvents.set(key, route);
    }
    return route.emitter.event as Event<T>;
  };
  const forget = (entry: OwnedSubscription): void => {
    const key = routeKey(
      entry.kind,
      entry.target,
      entry.topic,
      entry.subscriptionId,
      entry.connectionId,
    );
    owned.delete(key);
    if (routeKeyByOwnership.get(entry.ownershipKey) === key) {
      routeKeyByOwnership.delete(entry.ownershipKey);
    }
  };
  const unsubscribeBase = (
    entry: OwnedSubscription,
    runtimePolicy?: ZCodeAgentRuntimePolicy,
  ): Promise<void> => {
    const params: ZCodeAgentConversationUnsubscribeParams = {
      ...entry.target,
      subscriptionId: entry.subscriptionId,
      ...(runtimePolicy ? { runtimePolicy } : {}),
    };
    const forwarded = withTrustedUnsubscribeRoute(params, {
      topic: entry.topic,
      connectionId: entry.connectionId,
    });
    switch (entry.kind) {
      case "conversation":
        return base.unsubscribeConversationV4(forwarded);
      case "sessions-index":
        return base.unsubscribeSessionsIndexV4(forwarded);
      case "workspace-config":
        return base.unsubscribeWorkspaceConfigV4(forwarded);
    }
  };
  const unsubscribeOwnedEntry = async (
    entry: OwnedSubscription,
    runtimePolicy?: ZCodeAgentRuntimePolicy,
  ): Promise<void> => {
    forget(entry);
    try {
      // Trusted relays validate flow control per owned route. The last subscription must close
      // before unsubscribe; reversed, upstream forgets the owner and closed is rejected, pausing the connection.
      await closeUnusedFlowRoute(entry);
    } finally {
      await unsubscribeBase(entry, runtimePolicy);
    }
  };
  const resyncBase = (entry: OwnedSubscription, params: ZCodeAgentConversationResyncParams) => {
    const forwarded = withTrustedUnsubscribeRoute(params, {
      topic: entry.topic,
      connectionId: entry.connectionId,
    });
    switch (entry.kind) {
      case "conversation":
        return base.resyncConversationV4(forwarded);
      case "sessions-index":
        return base.resyncSessionsIndexV4(forwarded);
      case "workspace-config":
        return base.resyncWorkspaceConfigV4(forwarded);
    }
  };
  const resyncOwned = (kind: SubscriptionKind, params: ZCodeAgentConversationResyncParams) => {
    assertReady();
    const entry = findBySubscription(
      kind,
      params,
      params.subscriptionId,
      forwardedUnsubscribeRoute(params),
    );
    if (!entry) return Promise.reject(new Error("fault.subscription.notOwned"));
    return resyncBase(entry, params);
  };
  const rememberAfterSubscribe = async (
    subscriptionId: string,
    entry: Omit<OwnedSubscription, "subscriptionId">,
    pending: PendingOwnership,
  ): Promise<void> => {
    removePendingOwnership(pending);
    const complete = { ...entry, subscriptionId };
    if (
      pending.invalidatedByRuntimeRestart ||
      pending.runtimeGeneration !==
        (runtimeGenerationByWorkspaceKey.get(workspaceKey(entry.target)) ?? 0)
    ) {
      // A legacy runtime's late ACK may collide with a new runtime reusing the subId.
      // Drop the local owner only; never unsubscribe the same name on the new runtime.
      discardPendingOwnership(pending);
      throw new Error("fault.subscription.runtimeRestarted");
    }
    if (disposed) {
      // Port close and subscribe ACK race; a late ACK must not re-register an owner on a closed
      // facade and must unsubscribe immediately.
      discardPendingOwnership(pending);
      await unsubscribeBase(complete).catch(() => {});
      throw new Error("fault.connection.closed");
    }
    if (pending.overflowReason) {
      const reason = pending.overflowReason;
      discardPendingOwnership(pending);
      await unsubscribeBase(complete).catch(() => {});
      throw new Error(reason);
    }
    remember(subscriptionId, complete);
    try {
      // Only once the transport is saturated does the subscribe ACK make the trusted downstream route real;
      // re-send SAT here instead of waiting for the next high-water edge.
      await syncCurrentFlowForEntry(complete);
    } catch (error) {
      forget(complete);
      await unsubscribeBase(complete).catch(() => {});
      throw error;
    }
    const route = routedFrameEvents.get(routedEventKey(entry.kind, entry.target));
    if (!route) return;
    // CLI notifications can beat the RPC subscribe response. Owner registration used to wait for
    // the await, dropping early frames forever; with both ends pending, guessing is wrong too.
    // After ACK release only that subscriptionId's frames, original arrival order preserved.
    for (const frame of pending.frames) {
      if (frame.subscriptionId === subscriptionId && ownsFrame(entry.kind, entry.target, frame)) {
        route.emitter.fire(frame);
      }
    }
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };

  const invalidateWorkspaceRuntime = (invalidatedWorkspaceKey: string, generation: number) => {
    runtimeGenerationByWorkspaceKey.set(invalidatedWorkspaceKey, generation);
    // Runtime subscriptions all gone: forget the local owner, no cleanup on the new runtime.
    for (const entry of owned.values()) {
      if (workspaceKey(entry.target) === invalidatedWorkspaceKey) forget(entry);
    }
    for (const key of forwardedFlowStateByRoute.keys()) {
      if (key.startsWith(`${invalidatedWorkspaceKey}\0`)) {
        forwardedFlowStateByRoute.delete(key);
      }
    }
    const invalidatedPending = [...pendingByOwnership.values()]
      .flatMap((group) => [...group])
      .filter((pending) => workspaceKey(pending.target) === invalidatedWorkspaceKey);
    for (const pending of invalidatedPending) {
      pending.invalidatedByRuntimeRestart = true;
      // Leave the routing group so a never-ACKing old owner stops buffering per frame for the new
      // runtime; the pending object stays with its Promise continuation and rejects late ACKs by generation.
      removePendingOwnership(pending);
      pending.frames.length = 0;
      pending.stagedBytes = 0;
    }
  };

  const hasRuntimeLifecycle = Boolean(base.onAgentRuntimeLifecycle);
  const runtimeLifecycleDisposable = base.onAgentRuntimeLifecycle?.((event) => {
    if (event.state === "available") {
      // A cold-start subscribe registers pending, then the same start publishes available(gen1),
      // and only then the ACK arrives. available is not an ownership-generation boundary;
      // bumping here would read the current runtime's valid ACK as a restart.
      // A real generation change always publishes unavailable first; that branch clears owner/pending.
      return;
    }
    // Listening only for restart keeps a stale owner when the runtime exits without restart, and
    // later UI cleanup rebuilds unsubscribe args and hits the startup client; so unavailable clears locally.
    invalidateWorkspaceRuntime(event.workspaceKey, event.runtimeIdentity.generation);
  });
  const runtimeRestartDisposable = hasRuntimeLifecycle
    ? undefined
    : base.onAgentRuntimeRestarted?.(({ workspaceKey: restarted }) => {
        const nextGeneration = (runtimeGenerationByWorkspaceKey.get(restarted) ?? 0) + 1;
        invalidateWorkspaceRuntime(restarted, nextGeneration);
      });

  const overrides: Partial<IZCodeAgentService> = {
    async helloConversationV4() {
      assertOpen();
      helloIssued = true;
      return createHello(context);
    },
    async initializeConversationV4(clientHello) {
      assertOpen();
      if (!helloIssued) throw new Error("fault.connection.helloRequired");
      const parsed = clientHelloSchema.parse(clientHello);
      if (boundClientId !== null && boundClientId !== parsed.clientId) {
        throw new Error("fault.connection.clientChanged");
      }
      boundClientId = parsed.clientId;
      clientWorkflowRunDeltas = clientSupportsWorkflowRunDeltas(parsed);
      handshakeComplete = true;
    },
    async setConnectionFlowStateV4(params) {
      assertOpen();
      if (role !== "trusted-host-relay") {
        throw new Error("fault.connection.flowControlForbidden");
      }
      const downstream = readTrustedZCodeAgentV4Connection(params);
      if (!downstream) throw new Error("fault.connection.flowControlUntrusted");
      const forwarded = forwardedConnection(params);
      const ownsRoute =
        attachmentFlowRoutes.has(flowRouteKey(params, forwarded.connectionId)) ||
        [...owned.values()].some(
          (entry) =>
            workspaceKey(entry.target) === workspaceKey(params) &&
            entry.connectionId === forwarded.connectionId,
        );
      if (!ownsRoute) throw new Error("fault.subscription.notOwned");
      await base.setConnectionFlowStateV4(withTrustedConnection(params, forwarded));
    },
    async sendConversationCommandV4(params) {
      assertOpen();
      if (role === "terminal-client") {
        assertReady();
        if (params.envelope.clientId !== boundClientId) {
          // Legacy facades did not cover command: un-handshaked calls and spoofed clientIds reach
          // the CLI; silently overwriting breaks command idempotency ownership, so reject mismatches.
          throw new Error("fault.command.clientMismatch");
        }
      }
      // command used to validate only envelope.clientId, unlike subscriptions/attachments, so
      // mobile could spoof top-level clientMode and relay downstream identity got lost.
      // The envelope passes through untouched; trusted context rides the internal host carrier.
      return base.sendConversationCommandV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async queryConversationCommandsV4(params) {
      assertReady();
      // A pure clock probe queries no command and must not steal/change workspace binding.
      if (params.clock)
        return base.queryConversationCommandsV4(
          withTrustedConnection(params, forwardedConnection(params)),
        );
      const requestedWorkspaceKey = workspaceKey(params);
      if (commandQueryWorkspaceKey !== null && commandQueryWorkspaceKey !== requestedWorkspaceKey) {
        throw new Error("fault.command.queryForeignWorkspace");
      }
      commandQueryWorkspaceKey = requestedWorkspaceKey;
      return base.queryConversationCommandsV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async backgroundBashOutputV4(params) {
      assertReady();
      return base.backgroundBashOutputV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async conversationRowsRangeV4(params) {
      assertReady();
      return base.conversationRowsRangeV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentBeginV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const result = await base.attachmentBeginV4(withTrustedConnection(params, forwarded));
      if (result.state === "staging") {
        if (disposed || flowClosed) {
          // begin ACK may land after port close; registering the route then is missed by closed,
          // leaving a TTL-only half-upload. Abort via the same trusted identity, then reject the late result.
          await base.attachmentAbortV4(withTrustedConnection(params, forwarded)).catch(() => {});
          throw new Error("fault.connection.closed");
        }
        const route: ConnectionFlowRoute = {
          key: flowRouteKey(params, forwarded.connectionId),
          target: workspaceTarget(params),
          connection: forwarded,
        };
        attachmentFlowRoutes.set(route.key, route);
        if (currentTransportFlowState === "saturated") {
          try {
            await forwardFlowRoute(route, "saturated");
          } catch (error) {
            attachmentFlowRoutes.delete(route.key);
            await base.attachmentAbortV4(withTrustedConnection(params, forwarded)).catch(() => {});
            throw error;
          }
        }
      }
      return result;
    },
    async attachmentReadV4(params) {
      assertReady();
      return base.attachmentReadV4(withTrustedConnection(params, forwardedConnection(params)));
    },
    async conversationAttachmentReadV4(params) {
      assertReady();
      return base.conversationAttachmentReadV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async conversationAttachmentStatV4(params) {
      assertReady();
      return base.conversationAttachmentStatV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentPreviewSourceV4(params) {
      assertReady();
      return base.attachmentPreviewSourceV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentChunkV4(params) {
      assertReady();
      return base.attachmentChunkV4(withTrustedConnection(params, forwardedConnection(params)));
    },
    async attachmentCommitV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      return base.attachmentCommitV4(withTrustedConnection(params, forwarded));
    },
    async attachmentAbortV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      await base.attachmentAbortV4(withTrustedConnection(params, forwarded));
    },
    async subscribeConversationV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = conversationTopic(params.sessionId);
      const pending = beginPendingOwnership("conversation", params, topic);
      try {
        const result = await base.subscribeConversationV4(withTrustedConnection(params, forwarded));
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "conversation",
            ownershipKey: `conversation\0${workspaceKey(params)}\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeConversationV4(params) {
      const entry = findBySubscription(
        "conversation",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncConversationV4(params) {
      return resyncOwned("conversation", params);
    },
    onDynamicConversationFrame(params) {
      return routedEvent<ConversationTopicWireCandidate>(
        "conversation",
        params,
        base.onDynamicConversationFrame(params),
      );
    },
    onDynamicLocalTtftFacts(params) {
      assertOpen();
      if (
        role !== "terminal-client" ||
        context.clientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      )
        return RpcEvent.None;
      return base.onDynamicLocalTtftFacts(workspaceTarget(params));
    },
    onDynamicConversationTelemetryFact(params) {
      assertOpen();
      // Trusted clientMode comes from the host attachment; web/mobile/relay must not install
      // production telemetry reporters via the shared workspace emitter.
      const downstream = readTrustedZCodeAgentV4Connection(params);
      const relayDesktopDownstream =
        role === "trusted-host-relay" && downstream?.clientMode === "desktop-continuous";
      if (
        context.clientMode !== "desktop-continuous" ||
        (role !== "terminal-client" && !relayDesktopDownstream)
      ) {
        return RpcEvent.None;
      }
      // The renderer workspace supervisor mounts before V4 hello/initialize. The telemetry emitter
      // itself sends no protocol requests, so trusted desktops may listen early; otherwise dynamic
      // events throw pre-handshake and kill the host channel. Live facts still appear only after ingest.
      // Remote workspaces additionally cross a trusted host relay: downstream clientMode/namespace
      // connectionId ride the existing trusted carrier, else the relay keeps rejecting.
      return base.onDynamicConversationTelemetryFact(
        withTrustedConnection(workspaceTarget(params), forwardedConnection(params)),
      );
    },
    onDynamicCuaPermissionObservation() {
      assertOpen();
      // Permission dialogs are a local desktop side effect; phone replay attachments consume
      // resumable conversation facts only.
      if (role !== "terminal-client" || context.clientMode !== "desktop-continuous") {
        return RpcEvent.None;
      }
      return base.onDynamicCuaPermissionObservation();
    },
    onDynamicProcessResourceSample() {
      assertOpen();
      // CLI resource samples only relay to main via the trusted desktop-host relay; renderer/mobile
      // attachments neither consume them nor pull them into continuous/replayable message surfaces.
      if (role !== "trusted-host-relay") {
        return RpcEvent.None;
      }
      return base.onDynamicProcessResourceSample();
    },
    onDynamicToolExecResource() {
      // Completion facts are not session delivery; keep them out of continuous/replayable attachments.
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicToolExecResource();
    },
    onDynamicMcpResourceSamples() {
      // Resource facts are not session stream; neither desktop continuous nor phone replay subscribes.
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicMcpResourceSamples();
    },
    onDynamicMcpTelemetry() {
      assertOpen();
      // MCP telemetry shares the trusted host-relay boundary with CLI resource samples; never the
      // renderer/mobile session path.
      if (role !== "trusted-host-relay") {
        return RpcEvent.None;
      }
      return base.onDynamicMcpTelemetry();
    },
    async subscribeSessionsIndexV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = sessionsIndexTopic(workspaceKey(params));
      const pending = beginPendingOwnership("sessions-index", params, topic);
      try {
        const result = await base.subscribeSessionsIndexV4(
          withTrustedConnection(params, forwarded),
        );
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "sessions-index",
            ownershipKey: `sessions-index\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeSessionsIndexV4(params) {
      const entry = findBySubscription(
        "sessions-index",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncSessionsIndexV4(params) {
      return resyncOwned("sessions-index", params);
    },
    onDynamicSessionsIndexFrame(params) {
      return routedEvent<SessionsIndexTopicWireCandidate>(
        "sessions-index",
        params,
        base.onDynamicSessionsIndexFrame(params),
      );
    },
    async subscribeWorkspaceConfigV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = workspaceConfigTopic(workspaceKey(params));
      const pending = beginPendingOwnership("workspace-config", params, topic);
      try {
        const result = await base.subscribeWorkspaceConfigV4(
          withTrustedConnection(params, forwarded),
        );
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "workspace-config",
            ownershipKey: `workspace-config\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeWorkspaceConfigV4(params) {
      const entry = findBySubscription(
        "workspace-config",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncWorkspaceConfigV4(params) {
      return resyncOwned("workspace-config", params);
    },
    onDynamicWorkspaceConfigFrame(params) {
      return routedEvent<WorkspaceConfigTopicWireCandidate>(
        "workspace-config",
        params,
        base.onDynamicWorkspaceConfigFrame(params),
      );
    },
  };

  const service = new Proxy(base, {
    get(target, property, receiver) {
      const override = Reflect.get(overrides, property, receiver);
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    service,
    setTransportFlowState(state) {
      return enqueueTransportFlowState(state);
    },
    async dispose() {
      if (disposed) return;
      // close must queue after pending SAT/DRN; proceed with owned cleanup even on RPC failure.
      await enqueueTransportFlowState("closed").catch(() => {});
      if (disposed) return;
      disposed = true;
      handshakeComplete = false;
      helloIssued = false;
      boundClientId = null;
      clientWorkflowRunDeltas = false;
      const entries = Array.from(owned.values());
      owned.clear();
      routeKeyByOwnership.clear();
      for (const group of pendingByOwnership.values()) {
        for (const pending of group) {
          pending.frames.length = 0;
          pending.stagedBytes = 0;
          pending.overflowReason = null;
        }
      }
      pendingByOwnership.clear();
      for (const route of routedFrameEvents.values()) {
        route.upstream.dispose();
        route.emitter.dispose();
      }
      routedFrameEvents.clear();
      runtimeLifecycleDisposable?.dispose();
      runtimeRestartDisposable?.dispose();
      runtimeGenerationByWorkspaceKey.clear();
      attachmentFlowRoutes.clear();
      forwardedFlowStateByRoute.clear();
      await Promise.allSettled(entries.map((entry) => unsubscribeBase(entry)));
    },
  };
}
