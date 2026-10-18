import {
  SessionEventType,
  createEventId,
  type HighspeedMessageMetadata,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionId,
  type SessionStorePort,
  type TraceId,
} from "@zcode/contracts";
import { highspeedMessageMetaSchema } from "@zcode/shared";

export interface PersistHighspeedMetricsInput {
  sessionStore: SessionStorePort;
  eventStore: SessionEventStorePort;
  sessionId: string;
  messageId: string;
  entityId: string;
  metrics: {
    regularTps: number;
    outputTokens: number;
    durationMs: number;
    highspeedTps: number;
    savedDurationMs: number;
    modelDurationMs?: number;
    toolDurationMs?: number;
    otherDurationMs?: number;
  };
  traceId: string;
  now?: () => number;
  onPersistedEvent(event: SessionEvent): void;
  onLiveProjectionError?(error: unknown): void;
}

export interface PersistHighspeedTimingInput {
  sessionStore: SessionStorePort;
  eventStore: SessionEventStorePort;
  sessionId: string;
  sourceCommandId: string;
  timing: {
    modelDurationMs: number;
    toolDurationMs: number;
    otherDurationMs: number;
  };
  outputTokens?: number;
  durationMs?: number;
  /**
   * In the live projection, the moment this Turn's card expired into fallback. Lives only in the live projection; if terminal persistence omits it,
   // both HighspeedMetricsUpdated and cold hydration lose it (spec 5).
   */
  fallbackAt?: number;
  /** Fallback reason, same source as fallbackAt; the rule set is add-only, absent reads as card-expiry copy on cold restore. */
  fallbackReason?: HighspeedMessageMetadata["fallbackReason"];
  traceId: string;
  now?: () => number;
  onPersistedEvent(event: SessionEvent): void;
  onLiveProjectionError?(error: unknown): void;
}

/**
 * The turn terminal state has the CLI itself persist the real split into the transcript, so elapsed time survives renderer absence.
 // That stage does not require healthy TPS; card-level metrics are backfilled by renderer/later CLI flows after expiry.
 */
export async function persistHighspeedTiming(input: PersistHighspeedTimingInput): Promise<void> {
  const sessionId = input.sessionId as SessionId;
  const messages = await input.sessionStore.messages({ sessionID: sessionId });
  const user = messages.find((message) => {
    if (message.info.role !== "user") return false;
    const intent = message.info.metadata?.conversationInputIntent as
      | Record<string, unknown>
      | undefined;
    return (
      intent &&
      typeof intent === "object" &&
      !Array.isArray(intent) &&
      intent.sourceCommandId === input.sourceCommandId
    );
  });
  if (!user || user.info.role !== "user") return;
  const current = highspeedMessageMetaSchema.safeParse(user.info.metadata?.highspeed);
  if (!current.success) return;
  const highspeed = highspeedMessageMetaSchema.parse({
    ...current.data,
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...input.timing,
    // Add-only: a persisted transcript fallbackAt wins; the live projection's value fills only when absent.
    ...(current.data.fallbackAt === undefined && input.fallbackAt !== undefined
      ? { fallbackAt: input.fallbackAt }
      : {}),
    ...(current.data.fallbackReason === undefined && input.fallbackReason !== undefined
      ? { fallbackReason: input.fallbackReason }
      : {}),
  });
  const metadata: Record<string, unknown> = {
    ...(user.info.metadata as Record<string, unknown>),
    highspeed,
  };
  if (
    metadata.conversationInputIntent &&
    typeof metadata.conversationInputIntent === "object" &&
    !Array.isArray(metadata.conversationInputIntent)
  ) {
    metadata.conversationInputIntent = {
      ...metadata.conversationInputIntent,
      highspeed,
    };
  }
  const { metadata: _previousMetadata, ...userInfoWithoutMetadata } = user.info;
  await input.sessionStore.saveMessage({ ...userInfoWithoutMetadata, metadata });
  const event: SessionEvent = {
    id: createEventId(),
    sessionId,
    type: SessionEventType.HighspeedMetricsUpdated,
    timestamp: new Date((input.now ?? Date.now)()),
    traceId: input.traceId as TraceId,
    sequenceNumber: (await input.eventStore.getLatestSequenceNumber(sessionId)) + 1,
    payload: { entityId: String(user.info.id), highspeed },
  };
  try {
    input.onPersistedEvent(await input.eventStore.append(event));
  } catch (error) {
    try {
      await input.sessionStore.saveMessage(user.info);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "highspeed timing rollback failed");
    }
    throw error;
  }
}

/** The transcript is the durable authority for Highspeed terminal stats; events only advance the live/replayable projection. */
export async function persistHighspeedMetrics(input: PersistHighspeedMetricsInput): Promise<void> {
  const sessionId = input.sessionId as SessionId;
  const messages = await input.sessionStore.messages({ sessionID: sessionId });
  const user = messages.find((message) => String(message.info.id) === input.messageId);
  if (!user || user.info.role !== "user") throw new Error("proto.staleTarget");

  const metadata = { ...user.info.metadata };
  const currentHighspeed = highspeedMessageMetaSchema.safeParse(metadata.highspeed);
  if (!currentHighspeed.success) throw new Error("guard.actionUnavailable");
  const highspeed = highspeedMessageMetaSchema.parse({
    ...currentHighspeed.data,
    ...input.metrics,
  });
  metadata.highspeed = highspeed;
  if (
    metadata.conversationInputIntent &&
    typeof metadata.conversationInputIntent === "object" &&
    !Array.isArray(metadata.conversationInputIntent)
  ) {
    metadata.conversationInputIntent = {
      ...metadata.conversationInputIntent,
      highspeed,
    };
  }
  const { metadata: _previousMetadata, ...userInfoWithoutMetadata } = user.info;
  const nextUserInfo = { ...userInfoWithoutMetadata, metadata };
  await input.sessionStore.saveMessage(nextUserInfo);

  const event: SessionEvent = {
    id: createEventId(),
    sessionId,
    type: SessionEventType.HighspeedMetricsUpdated,
    timestamp: new Date((input.now ?? Date.now)()),
    traceId: input.traceId as TraceId,
    sequenceNumber: (await input.eventStore.getLatestSequenceNumber(sessionId)) + 1,
    payload: { entityId: input.entityId, highspeed },
  };
  let persisted: SessionEvent;
  try {
    persisted = await input.eventStore.append(event);
  } catch (error) {
    try {
      await input.sessionStore.saveMessage(user.info);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "highspeed metrics event append failed and transcript rollback failed",
      );
    }
    throw error;
  }
  try {
    input.onPersistedEvent(persisted);
  } catch (error) {
    input.onLiveProjectionError?.(error);
  }
}
