import { localTtftFactsSchema } from "../localTtft.js";
/* eslint-disable max-lines -- the three topics' logical/physical/candidate schemas must share one transport declaration to avoid cross-file forking. */
// Transport envelope: connection handshake / subscription / frame envelope.
// Phases are type placeholders (enabled when the channel layer lands); data shapes are finalized per spec.
import { z } from "zod";
import { APP_USAGE_RANGES, appUsageSnapshotSchema } from "../usage-stats.js";
import { zcodeWorkspaceRefSchema } from "../zcode-protocol-legacy-types.js";
import {
  PROTOCOL_V4_LIMITS,
  V4_WIRE_PROTOCOL_VERSION,
  conversationRowTargetSchema,
  timestampSchema,
} from "./core.js";
import { conversationDeltaSchema } from "./delta.js";
import { conversationRowSchema, toolCallRowSchema } from "./rows.js";
import { sessionsIndexDeltaSchema, sessionsIndexSnapshotSchema } from "./sessions-index.js";
import { WORKFLOW_RUN_STOP_REASONS } from "./workflow-observation-display.js";
import { conversationSnapshotSchema } from "./snapshot.js";
import { workspaceConfigDeltaSchema, workspaceConfigSnapshotSchema } from "./workspace-config.js";
import { createTopicWireFrameSchema, topicWireFrameCandidateSchema } from "./wire.js";

// -- Connection and handshake --
export const hostCapabilitiesSchema = z.object({
  nativeDialogs: z.boolean(),
  localTerminal: z.boolean(),
  // ws binary (used for relay path probing).
  binaryFrames: z.boolean(),
  compression: z.enum(["none", "permessage-deflate"]),
  // Wire-compatible: missing on legacy hosts equals false; callers must test === true.
  workspaceHookReview: z.boolean().optional(),
  independentPlanState: z.boolean().optional(),
  /**
   * This host emits `workflowRun.*` key-level deltas (the two ops in delta.ts), so `workflowRuns`
   * actors / nodes may reach 1024 instead of the legacy 256. Consumers without this bit still get whole-key
   * `state.updated`, clamped to the legacy cap by `clampWorkflowRunsForLegacy` first.
   */
  workflowRunDeltas: z.boolean().optional(),
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

export const helloMessageSchema = z
  .object({
    kind: z.literal("hello"),
    protocolVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
    connectionId: z.string(),
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
    deliveryProfile: z.enum(["continuous", "replayable"]),
    // First clock calibration.
    serverTime: timestampSchema,
    capabilities: hostCapabilitiesSchema,
    // Reserved slot only.
    auth: z.object({ userId: z.string().optional() }),
  })
  .strict()
  .superRefine((hello, context) => {
    const expectedProfile = hello.clientMode === "desktop-continuous" ? "continuous" : "replayable";
    if (hello.deliveryProfile !== expectedProfile) {
      context.addIssue({
        code: "custom",
        message: "trusted clientMode and deliveryProfile must match",
        path: ["deliveryProfile"],
      });
    }
  });
export type HelloMessage = z.infer<typeof helloMessageSchema>;

// clientMode registers once per connection, never inside command envelopes.
export const clientHelloSchema = z
  .object({
    kind: z.literal("clientHello"),
    protocolVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
    clientId: z.string(),
    clientKind: z.enum(["desktop", "web", "mobileRemote", "mobileApp"]).optional(),
    appVersion: z.string(),
    // Absent means a legacy client without the Settings-centered review UI.
    capabilities: z
      .object({
        workspaceHookReviewUi: z.boolean().optional(),
        /**
         * This client understands `workflowRun.*` deltas. The declaration rule is **one-way**: the client may include this key only
         * after seeing `workflowRunDeltas === true` in the host hello--this capabilities object
         * is `.strict()`; legacy hosts fail the whole clientHello parse on unknown keys and the handshake never completes.
         */
        workflowRunDeltas: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ClientHello = z.infer<typeof clientHelloSchema>;

export function hostSupportsWorkspaceHookReview(capabilities: HostCapabilities): boolean {
  return capabilities.workspaceHookReview === true;
}

export function clientSupportsWorkspaceHookReview(clientHello: ClientHello): boolean {
  return clientHello.capabilities?.workspaceHookReviewUi === true;
}

export function hostSupportsWorkflowRunDeltas(capabilities: HostCapabilities): boolean {
  return capabilities.workflowRunDeltas === true;
}

export function clientSupportsWorkflowRunDeltas(clientHello: ClientHello): boolean {
  return clientHello.capabilities?.workflowRunDeltas === true;
}

// -- 3.1 Subscription --
export const subscribeParamsSchema = z
  .object({
    // "conversation/<sessionId>" | "sessions-index/<workspaceId>" | ...
    topic: z.string(),
    // Watermark invariant: include only when the client truly holds a consistent state as of that point.
    base: z.object({ logEpoch: z.string(), seq: z.number() }).optional(),
    // QoS hint: affects scheduling, not semantics.
    visibility: z.enum(["foreground", "background"]).optional(),
  })
  .strict();
export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;

export const subscribeAckSchema = z.object({
  subscriptionId: z.string(),
  // resume = valid base, deltas continue from base.seq; else snapshot.
  mode: z.enum(["snapshot", "resume"]),
  logEpoch: z.string(),
});
export type SubscribeAck = z.infer<typeof subscribeAckSchema>;

const openTimingMsSchema = z.number().int().nonnegative().optional();
const openTimingCountSchema = z.number().int().nonnegative().optional();

/**
 * Low-frequency diagnostic timing of a desktop session's first open; attached only to the conversation subscribe ACK,
 * never into snapshot, delta, sessions-index, or workspace-config.
 */
export const conversationOpenTimingSchema = z
  .object({
    version: z.literal(1),
    hostPrepareMs: openTimingMsSchema,
    providerRegistrySyncMs: openTimingMsSchema,
    taskMetaReadMs: openTimingMsSchema,
    cliRequestMs: openTimingMsSchema,
    cliBootstrapMs: openTimingMsSchema,
    cliSessionRestoreMs: openTimingMsSchema,
    initialFrameEncodeMs: openTimingMsSchema,
    cliProcessState: z.enum(["spawned", "reused"]).optional(),
    sessionRuntimeState: z.enum(["cold", "warm"]).optional(),
    snapshotRowCount: openTimingCountSchema,
  })
  .strict();
export type ConversationOpenTiming = z.infer<typeof conversationOpenTimingSchema>;

const conversationSubscribeAckSchema = subscribeAckSchema.extend({
  openTiming: conversationOpenTimingSchema.optional(),
});
export type ConversationSubscribeAck = z.infer<typeof conversationSubscribeAckSchema>;

// -- Frame envelope (generic frame; factories instantiate per topic) --
export function createTopicFrameSchema<S extends z.ZodTypeAny, D extends z.ZodTypeAny>(
  snapshotSchema: S,
  deltaSchema: D,
) {
  return z.object({
    topic: z.string(),
    // Generation id, keeping old streams from interleaving.
    subscriptionId: z.string(),
    // Range accounting (fromSeq, toSeq]; snapshot frames fix fromSeq at 0.
    fromSeq: z.number(),
    toSeq: z.number(),
    // CLI clock, for clockOffset estimation.
    sentAt: timestampSchema,
    payload: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("snapshot"), snapshot: snapshotSchema }),
      z.object({ kind: z.literal("deltas"), deltas: z.array(deltaSchema) }),
    ]),
  });
}

export interface TopicFrame<S, D> {
  topic: string;
  subscriptionId: string;
  fromSeq: number;
  toSeq: number;
  sentAt: Timestamp;
  payload: { kind: "snapshot"; snapshot: S } | { kind: "deltas"; deltas: D[] };
}
type Timestamp = z.infer<typeof timestampSchema>;

// Concrete frame schemas of the conversation topic (the five-piece instantiation).
// The transport envelope/golden tests use it for frame validation; the host channel layer reuses it.
export const conversationTopicFrameSchema = createTopicFrameSchema(
  conversationSnapshotSchema,
  conversationDeltaSchema,
)
  .extend({
    ttft: localTtftFactsSchema.optional(),
    ttftRelated: z.array(localTtftFactsSchema).max(16).optional(),
  })
  .superRefine((frame, context) => {
    if (!frame.topic.startsWith("conversation/") || frame.topic.length === "conversation/".length) {
      context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
    }
  });
export type ConversationTopicFrame = z.infer<typeof conversationTopicFrameSchema>;
export const conversationTopicWireFrameSchema = createTopicWireFrameSchema(
  conversationTopicFrameSchema,
).superRefine((wire, context) => {
  if (!wire.topic.startsWith("conversation/") || wire.topic.length === "conversation/".length) {
    context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
  }
});
export type ConversationTopicWireFrame = z.infer<typeof conversationTopicWireFrameSchema>;
export const conversationTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (!wire.topic.startsWith("conversation/") || wire.topic.length === "conversation/".length) {
      context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
    }
  },
);
export type ConversationTopicWireCandidate = z.infer<typeof conversationTopicWireCandidateSchema>;

// Concrete frame schemas of the sessions-index topic (five-piece instantiation; sidebar liveness source).
export const sessionsIndexTopicFrameSchema = createTopicFrameSchema(
  sessionsIndexSnapshotSchema,
  sessionsIndexDeltaSchema,
).superRefine((frame, context) => {
  if (
    !frame.topic.startsWith("sessions-index/") ||
    frame.topic.length === "sessions-index/".length
  ) {
    context.addIssue({ code: "custom", message: "invalid sessions-index topic", path: ["topic"] });
  }
});
export type SessionsIndexTopicFrame = z.infer<typeof sessionsIndexTopicFrameSchema>;
export const sessionsIndexTopicWireFrameSchema = createTopicWireFrameSchema(
  sessionsIndexTopicFrameSchema,
).superRefine((wire, context) => {
  if (!wire.topic.startsWith("sessions-index/") || wire.topic.length === "sessions-index/".length) {
    context.addIssue({ code: "custom", message: "invalid sessions-index topic", path: ["topic"] });
  }
});
export type SessionsIndexTopicWireFrame = z.infer<typeof sessionsIndexTopicWireFrameSchema>;
export const sessionsIndexTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (
      !wire.topic.startsWith("sessions-index/") ||
      wire.topic.length === "sessions-index/".length
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid sessions-index topic",
        path: ["topic"],
      });
    }
  },
);
export type SessionsIndexTopicWireCandidate = z.infer<typeof sessionsIndexTopicWireCandidateSchema>;

// Concrete frame schemas of the workspace-config topic (additive changes; config-directory liveness source).
export const workspaceConfigTopicFrameSchema = createTopicFrameSchema(
  workspaceConfigSnapshotSchema,
  workspaceConfigDeltaSchema,
).superRefine((frame, context) => {
  if (
    !frame.topic.startsWith("workspace-config/") ||
    frame.topic.length === "workspace-config/".length
  ) {
    context.addIssue({
      code: "custom",
      message: "invalid workspace-config topic",
      path: ["topic"],
    });
  }
});
export type WorkspaceConfigTopicFrame = z.infer<typeof workspaceConfigTopicFrameSchema>;
export const workspaceConfigTopicWireFrameSchema = createTopicWireFrameSchema(
  workspaceConfigTopicFrameSchema,
).superRefine((wire, context) => {
  if (
    !wire.topic.startsWith("workspace-config/") ||
    wire.topic.length === "workspace-config/".length
  ) {
    context.addIssue({
      code: "custom",
      message: "invalid workspace-config topic",
      path: ["topic"],
    });
  }
});
export type WorkspaceConfigTopicWireFrame = z.infer<typeof workspaceConfigTopicWireFrameSchema>;
export const workspaceConfigTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (
      !wire.topic.startsWith("workspace-config/") ||
      wire.topic.length === "workspace-config/".length
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid workspace-config topic",
        path: ["topic"],
      });
    }
  },
);
export type WorkspaceConfigTopicWireCandidate = z.infer<
  typeof workspaceConfigTopicWireCandidateSchema
>;

/** Shared logical / physical routing surface of the three production topics. */
export const routedTopicFrameSchema = z.union([
  conversationTopicFrameSchema,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopicFrameSchema,
]);
export type RoutedTopicFrame = z.infer<typeof routedTopicFrameSchema>;
export const routedTopicWireFrameSchema = z.union([
  conversationTopicWireFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  workspaceConfigTopicWireFrameSchema,
]);
export type RoutedTopicWireFrame = z.infer<typeof routedTopicWireFrameSchema>;
export const routedTopicWireCandidateSchema = z.union([
  conversationTopicWireCandidateSchema,
  sessionsIndexTopicWireCandidateSchema,
  workspaceConfigTopicWireCandidateSchema,
]);
export type RoutedTopicWireCandidate = z.infer<typeof routedTopicWireCandidateSchema>;

// -- v4 RPC entrances/exits (host channel layer) --
// Carriers reuse the existing JSON-RPC (stdio NDJSON / socket); method names carry the v4/ prefix alongside the legacy protocol;
// once the legacy session/* methods are deleted, this is the only protocol surface.
export const V4_METHODS = {
  connectionFlow: "v4/connection/flow",
  controllerSubscribe: "v4/controller/subscribe",
  controllerResync: "v4/controller/resync",
  controllerUnsubscribe: "v4/controller/unsubscribe",
  conversationSubscribe: "v4/conversation/subscribe",
  conversationResync: "v4/conversation/resync",
  conversationUnsubscribe: "v4/conversation/unsubscribe",
  // Row-paged query (rows/range): read-only, stateless, safe to resend on timeout.
  conversationRowsRange: "v4/conversation/rowsRange",
  // Terminal ExitPlanMode directory of the current effective branch; read-only, stateless, resend-safe.
  conversationPlans: "v4/conversation/plans",
  conversationFileChanges: "v4/conversation/fileChanges",
  backgroundBashOutput: "v4/conversation/backgroundBashOutput",
  conversationFileRewindPreview: "v4/conversation/fileRewindPreview",
  // Event-log paging of a workflow run (detail-page audit view): read-only, stateless, resend-safe.
  // New methods are skew-safe by construction--legacy desktops never call them.
  conversationWorkflowRunEvents: "v4/conversation/workflowRunEvents",
  conversationWorkflowRuns: "v4/conversation/workflowRuns",
  // User-facing artifacts of a workflow run. A family of three:
  // read-only, stateless, resend-safe; schemas in workflow-artifacts.ts (terminology disambiguation there too).
  //   Artifacts    the artifact list (durable read for cold recovery and the hub detail page)
  //   ArtifactData preset-dashboard entry paging (cursor = journal sequence)
  //   ArtifactRead content-artifact bytes, <= 512 KiB per chunk, shape verbatim from attachmentRead
  conversationWorkflowRunArtifacts: "v4/conversation/workflowRunArtifacts",
  conversationWorkflowRunArtifactData: "v4/conversation/workflowRunArtifactData",
  conversationWorkflowRunArtifactRead: "v4/conversation/workflowRunArtifactRead",
  // Workspace transcript of a workflow run. A pair,
  // split like artifacts 1/3: Workspace is the light row list (no bodies), NodeResult one node's bounded body.
  conversationWorkflowRunWorkspace: "v4/conversation/workflowRunWorkspace",
  conversationWorkflowRunNodeResult: "v4/conversation/workflowRunNodeResult",
  // usage query (same shape as rows/range: read-only, stateless, resend-safe).
  // The usage source of truth is the CLI session DB (model_usage/turn_usage aggregates); the host keeps no copy,
  // hence a v4 query instead of a host-direct connection; the legacy usage/stats and session/usage names are retired here.
  usageStats: "v4/usage/stats",
  conversationUsage: "v4/conversation/usage",
  // Attachment transactions: full-data RPC forbidden. Each chunk's decoded bytes <=512KiB;
  // both the renderer->host Channel and host->CLI NDJSON must prove <=1MiB per request.
  attachmentBegin: "v4/attachment/begin",
  attachmentChunk: "v4/attachment/chunk",
  attachmentCommit: "v4/attachment/commit",
  attachmentAbort: "v4/attachment/abort",
  // Sent-image previews: read-only, authorized per session row, responses still chunked at 512KiB.
  attachmentRead: "v4/attachment/read",
  // Share read of userInput attachments: non-media types like text/plain allowed, still row/index authorized and chunked.
  conversationAttachmentRead: "v4/conversation/attachmentRead",
  // Share precheck of userInput attachment metadata: row/index authorization and stat only, no full-file read.
  conversationAttachmentStat: "v4/conversation/attachmentStat",
  // Desktop-local sent videos: returns only local playback sources authorized by the same row/index.
  attachmentPreviewSource: "v4/attachment/previewSource",
  commandsQuery: "v4/commands/query",
  command: "v4/command",
} as const;
export type V4Method = (typeof V4_METHODS)[keyof typeof V4_METHODS];

/** Task-authorized bounded output query; no arbitrary paths, no caller-enlarged read budgets. */
export const v4BackgroundBashOutputParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
  workId: z.string().min(1),
});
export type V4BackgroundBashOutputParams = z.infer<typeof v4BackgroundBashOutputParamsSchema>;

export const v4ConnectionFlowStateSchema = z.enum(["saturated", "drained", "closed"]);
export type V4ConnectionFlowState = z.infer<typeof v4ConnectionFlowStateSchema>;

export const v4ConnectionFlowParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    state: v4ConnectionFlowStateSchema,
  })
  .strict();
export type V4ConnectionFlowParams = z.infer<typeof v4ConnectionFlowParamsSchema>;

export const v4ConnectionFlowResultSchema = z.object({}).strict();

export const V4_NOTIFICATIONS = {
  // Downstream frames (snapshot / deltas); params = ConversationTopicFrame.
  conversationFrame: "v4/conversation/frame",
  // Body-less facts for live ingest only; never into topic snapshot/recovery.
  conversationTelemetryFact: "v4/telemetry/event",
  localTtftFacts: "v4/telemetry/local-ttft",
  // Produced only by the current process's live ToolCallResult; history and replayable paths must not fabricate it.
  cuaPermissionObservation: "v4/cua/permission-observation",
} as const;

/** 3.3.6 SSH historical-task attribution proof; shares the bounded window with the sessions-index cold seed. */
export const MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE = 200;

// subscribe request = generic SubscribeParams + connectionId (re-subscribe replacement is decided by
// (connectionId, topic); in the single-stdio-pipe case the host allocates one per downstream client).
export const v4ConversationSubscribeParamsSchema = subscribeParamsSchema.extend({
  connectionId: z.string(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
  // Workspace of the currently trusted attachment; cold resume prefers it for identity restoration, live ignores it.
  workspace: zcodeWorkspaceRefSchema.optional(),
  /** Allowlist of legacy task attributions read exactly from the remote workspace's tasks-index by the host. */
  legacyTaskIds: z.array(z.string().min(1)).max(MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE).optional(),
  // For host->CLI cold resume only; live conversation never consumes this hint.
  resumeThoughtLevel: z.string().trim().min(1).optional(),
  /**
   * Whether this subscription takes `workflowRun.*` key-level deltas. Kin of `clientMode`: injected by the **trusted host** from that
   * connection's clientHello; UI-facing subscribes cannot pick it--whether a client understands deltas is a fact of the connection,
   * not a per-subscription taste. Absent = treat as legacy consumer (whole-key patch + legacy-cap clamp).
   */
  workflowRunDeltas: z.boolean().optional(),
});
export type V4ConversationSubscribeParams = z.infer<typeof v4ConversationSubscribeParamsSchema>;

// The common subscribe response is ACK-only. The initial snapshot/resume is emitted by the server's
// request-scoped post-response outbox as an owned notification after the response line.
export const v4ConversationSubscribeResultSchema = z
  .object({
    ack: conversationSubscribeAckSchema,
  })
  .strict();
export type V4ConversationSubscribeResult = z.infer<typeof v4ConversationSubscribeResultSchema>;

// sessions-index and conversation share one subscribe RPC; the common response is likewise ACK-only.
export const v4SessionsIndexSubscribeResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4SessionsIndexSubscribeResult = z.infer<typeof v4SessionsIndexSubscribeResultSchema>;

// workspace-config also ACKs only; the initial frame follows the same post-response notification ordering.
export const v4WorkspaceConfigSubscribeResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4WorkspaceConfigSubscribeResult = z.infer<
  typeof v4WorkspaceConfigSubscribeResultSchema
>;

// Same-sub recovery for live subscriptions. topic/connection/profile must be looked up by the host owned registry;
// the client may only declare its acknowledged watermark and whether to force a snapshot.
export const conversationResyncParamsSchema = z
  .object({
    subscriptionId: z.string().trim().min(1).max(1024),
    base: z
      .object({
        logEpoch: z.string().trim().min(1).max(1024),
        seq: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    forceSnapshot: z.boolean().optional(),
  })
  .strict();
export type ConversationResyncParams = z.infer<typeof conversationResyncParamsSchema>;

// CLI-facing shape: topic/connectionId injected only by the connection facade from the owned registry.
export const v4ConversationResyncParamsSchema = conversationResyncParamsSchema
  .extend({
    topic: z.string().trim().min(1).max(2048),
    connectionId: z.string().trim().min(1).max(1024),
  })
  .strict();
export type V4ConversationResyncParams = z.infer<typeof v4ConversationResyncParamsSchema>;

export const v4ConversationResyncResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4ConversationResyncResult = z.infer<typeof v4ConversationResyncResultSchema>;

export const v4ConversationUnsubscribeParamsSchema = z
  .object({
    topic: z.string().trim().min(1).max(2048),
    subscriptionId: z.string().trim().min(1).max(1024),
    connectionId: z.string().trim().min(1).max(1024),
  })
  .strict();
export type V4ConversationUnsubscribeParams = z.infer<typeof v4ConversationUnsubscribeParamsSchema>;

// -- rows/range (cursor-based row paging, loadOlder) --
// No index semantics: total order = ascending rowId; the client merges keyed by rowId.
export const v4ConversationRowsRangeParamsSchema = z.object({
  sessionId: z.string(),
  /** Host attachment injects this trusted value; renderer callers omit it. */
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  // Rows with rowId < beforeRowId; absent = backwards from the current tail.
  beforeRowId: z.number().optional(),
  limit: z.number().min(1).max(PROTOCOL_V4_LIMITS.rowsRangeMaxLimit),
});
export type V4ConversationRowsRangeParams = z.infer<typeof v4ConversationRowsRangeParamsSchema>;

export const v4ConversationRowsRangeResultSchema = z.object({
  // Ascending rowId.
  rows: z.array(conversationRowSchema),
  // Watermark/epoch at server read time; shared with read-only queries like fileChanges so data is not stitched across revisions.
  atSeq: z.number(),
  atRevision: z.number().int().nonnegative(),
  atLogEpoch: z.string(),
  // Whether older rows exist in the beforeRowId direction.
  hasMore: z.boolean(),
});
export type V4ConversationRowsRangeResult = z.infer<typeof v4ConversationRowsRangeResultSchema>;

// ── conversation plans directory ──
// The directory comes from the CLI's full effective projection, never derived from the renderer's bounded tail window.
export const v4ConversationPlansParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ConversationPlansParams = z.infer<typeof v4ConversationPlansParamsSchema>;

export const v4ConversationPlansResultSchema = z
  .object({
    // Terminal ExitPlanMode of the current effective branch, rowId descending (newest first).
    plans: z.array(toolCallRowSchema),
    atSeq: z.number().int().nonnegative(),
    atLogEpoch: z.string().min(1),
  })
  .strict();
export type V4ConversationPlansResult = z.infer<typeof v4ConversationPlansResultSchema>;

const readonlyDiffHunkSchema = z
  .object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  })
  .strict();

export const v4ConversationFileChangesParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    target: conversationRowTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    baseLogEpoch: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationFileChangesParams = z.infer<typeof v4ConversationFileChangesParamsSchema>;

export const v4ConversationFileChangesResultSchema = z
  .object({
    files: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    state: z.enum(["active", "reverted"]).optional(),
    items: z.array(
      z
        .object({
          path: z.string().min(1),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          writeCount: z.number().int().nonnegative(),
          toolNames: z.array(z.string()),
          patches: z.array(readonlyDiffHunkSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type V4ConversationFileChangesResult = z.infer<typeof v4ConversationFileChangesResultSchema>;

// -- workflow run event log --
// Same family as rows/range and plans: read-only, stateless, resend-safe. cursor = journal sequence
// (monotonically assigned by `appendEvent`), refetched when workflowRuns[].lastEventSequence rises.
// Deliberately **not** a v4 command: a command's ACK is the closed "change result" discriminated union of
// commandResultSchema--stuffing a read-only page into it puts reads into the write vocabulary and drags along baseRevision/idempotence for nothing.
export const v4ConversationWorkflowRunEventsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    /** Only events with sequence strictly greater; absent = from the beginning. */
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunEventsParams = z.infer<
  typeof v4ConversationWorkflowRunEventsParamsSchema
>;

export const v4ConversationWorkflowRunEventsResultSchema = z
  .object({
    events: z.array(
      z
        .object({
          sequence: z.number().int().nonnegative(),
          type: z.string().min(1).max(64),
          // The payload was bounded CLI-side by boundDynamicWorkflowRunEventPayload (the same serialization
          // also feeds the workflowRuns projection). The engine's event shape is not restated here: readers interpret by kind.
          payload: z.record(z.string(), z.unknown()),
          truncated: z.boolean().optional(),
        })
        .strict(),
    ),
    /** This page filled `limit` and more events follow. */
    hasMore: z.boolean(),
  })
  .strict();
// **Deliberately no `atSeq` / `atLogEpoch`**, although sibling rows/range and plans carry both.
//
// There those fields are **stale-read guards**: they read the conversation projection, whose
// `rowId` is meaningful only within one log epoch (rebuild / fork / rewind renumber), so the reader contract is
// "atLogEpoch != store's current epoch => discard the whole result".
//
// This query reads the **journal** (`dwf_event`), unrelated to the conversation log, and its cursor never expires:
// the journal's JournalStorePort contract requires append-only sequences,
// continuing from the existing max across resumes, never reset or reused; existing numbering is stable. So a
// `(runId, sequence)` cursor is valid forever--there is no "stale" to guard against.
//
// Worse, adding `atLogEpoch` is not harmless symmetry: per the sibling reader contract, a rewind of a wholly unrelated
// session (epoch change) would make the detail page drop an entirely **valid** journal page. Rather one field less
 // than a field whose correct semantics cannot be defined here.
export type V4ConversationWorkflowRunEventsResult = z.infer<
  typeof v4ConversationWorkflowRunEventsResultSchema
>;

// -- dwf run enumeration --
// The journal-backed post-restart discovery surface: the `workflowRuns` projection is memory-only (cold-merge classified)
// and empty after restart--tool-card joins and Resume-button availability must be restored from dwf_run rows. Kin of
// workflowRunEvents (read-only, stateless, resend-safe), likewise deliberately not a v4 command,
// likewise no atSeq/atLogEpoch (journal reads, unrelated to the conversation log; see the previous query's argument).
// New method, skew-safe by construction: legacy desktops never call it.
export const v4ConversationWorkflowRunsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    /** Row cap; defaulting and clamping live CLI-side (the enumeration surface is bounded, never an unbounded table scan). */
    limit: z.number().int().positive().max(64).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunsParams = z.infer<
  typeof v4ConversationWorkflowRunsParamsSchema
>;

export const v4ConversationWorkflowRunSummarySchema = z
  .object({
    runId: z.string().min(1),
    /** CreateWorkflow tool-call id that started the run (the tool-card -> detail/Resume join key); absent on legacy runs. */
    toolCallId: z.string().min(1).optional(),
    /**
     * Display label, derived at read time (`name` -> script first line -> runId). Optional is skew-safety:
     // legacy CLIs omit the key and readers fall back to runId--a missing label is degradation, not an error.
     // Cap mirrors the derivation side's 80 chars with headroom (user-set `name` is not bound by the derivation cap).
     */
    label: z.string().min(1).max(160).optional(),
    /** Last update (epoch millis, the journal's `dwf_run.time_updated`); absent = no time shown. */
    updatedAt: z.number().int().nonnegative().optional(),
    // Same five-value vocabulary as the workflowRuns projection;
    // this query uses its own schema so new query states never alter the projection's state keys.
    status: z.enum(["completed", "errored", "pending", "running", "stopped"]),
    /** Present only when `status === "stopped"`. One shared word list with the observation surface--duplicated copies once made this
     * strict schema reject the whole run directory when the engine gained
     * `superseded` (desktop showed "failed to read run summary"; task-list counts and the directory page blanked together). */
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    // lineage: revised runs carry a predecessor,
    // superseded runs a successor (only with `stopReason: "superseded"`). Both optional: legacy CLIs omit them.
    resumedFrom: z.string().min(1).optional(),
    supersededBy: z.string().min(1).optional(),
    /** Structured failure code of errored / stopped(provider|interrupted) (`ProviderStop` / `Interrupted` ...). */
    failureCode: z.string().min(1).max(64).optional(),
    failureMessage: z.string().max(2048).optional(),
    /** Resumable? Computed CLI-side by the same predicate as the resume gate--the UI never derives it (two predicates drift). */
    resumable: z.boolean(),
  })
  .strict();
export type V4ConversationWorkflowRunSummary = z.infer<
  typeof v4ConversationWorkflowRunSummarySchema
>;

export const v4ConversationWorkflowRunsResultSchema = z
  .object({
    /** Most recent first (ordered in the storage layer). */
    runs: z.array(v4ConversationWorkflowRunSummarySchema),
  })
  .strict();
export type V4ConversationWorkflowRunsResult = z.infer<
  typeof v4ConversationWorkflowRunsResultSchema
>;

export const v4ConversationFileRewindPreviewParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    target: conversationRowTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    baseLogEpoch: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationFileRewindPreviewParams = z.infer<
  typeof v4ConversationFileRewindPreviewParamsSchema
>;

const v4WorkspaceFileRewindSafeFileSchema = z
  .object({
    action: z.enum(["restore", "delete"]),
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    toolNames: z.array(z.string()),
  })
  .strict();

const v4WorkspaceFileRewindUnsafeFileSchema = z
  .object({
    currentHash: z.string().optional(),
    expectedHash: z.string().optional(),
    message: z.string().optional(),
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    reason: z.enum([
      "checkpoint_missing",
      "checkpoint_unreadable",
      "external_modified",
      "file_read_failed",
      "unsupported_checkpoint",
    ]),
    toolNames: z.array(z.string()),
  })
  .strict();

const v4WorkspaceFileRewindIgnoredFileSchema = z
  .object({
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    reason: z.literal("bash_ignored"),
    toolNames: z.array(z.string()),
  })
  .strict();

export const v4ConversationFileRewindPreviewResultSchema = z
  .object({
    canApply: z.boolean(),
    ignoredFiles: z.array(v4WorkspaceFileRewindIgnoredFileSchema),
    safeFiles: z.array(v4WorkspaceFileRewindSafeFileSchema),
    unsafeFiles: z.array(v4WorkspaceFileRewindUnsafeFileSchema),
  })
  .strict();
export type V4ConversationFileRewindPreviewResult = z.infer<
  typeof v4ConversationFileRewindPreviewResultSchema
>;

// ── usage query──
// App-level usage aggregation: range/timeZone inputs mirror legacy usage/stats (consumer semantics unchanged),
// result = AppUsageSnapshot (shape owned by the neutral usage-stats.ts, not coupled to the legacy name file).
export const v4UsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();
export type V4UsageStatsParams = z.infer<typeof v4UsageStatsParamsSchema>;
export const v4UsageStatsResultSchema = appUsageSnapshotSchema;
export type V4UsageStatsResult = z.infer<typeof v4UsageStatsResultSchema>;

    // Session-level token usage (the v4 namespace home of legacy session/usage: sessions are first-class protocol concepts,
    // tasks are a UI projection and stay out of the protocol vocabulary). Fields mirror the legacy result; the legacy schema dies with the name.
export const v4ConversationUsageParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ConversationUsageParams = z.infer<typeof v4ConversationUsageParamsSchema>;
export const v4ConversationUsageResultSchema = z
  .object({
    sessionId: z.string().min(1),
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    modelRequestCount: z.number().int().nonnegative(),
    modelErrorCount: z.number().int().nonnegative(),
    inputBaselineBySource: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type V4ConversationUsageResult = z.infer<typeof v4ConversationUsageResultSchema>;

// -- Attachment upload transaction --
// The UI high level still uses put(input)->ref; this full-data schema describes renderer-internal calls only, never a
// production RPC method. The wire only allows begin/chunk/commit/abort.
export const v4AttachmentPutParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    fileName: z.string().min(1),
    mime: z.string().min(1),
    // base64 (no data: prefix); decoded bytes <= PROTOCOL_V4_LIMITS.attachmentMaxBytes.
    dataBase64: z.string().min(1),
  })
  .strict();
export type V4AttachmentPutParams = z.infer<typeof v4AttachmentPutParamsSchema>;
export const v4AttachmentPutResultSchema = z.object({
  ref: z.string().min(1),
});
export type V4AttachmentPutResult = z.infer<typeof v4AttachmentPutResultSchema>;

const v4AttachmentUploadIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const v4AttachmentChecksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const v4AttachmentBeginParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\0\r\n]+$/),
    mime: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/),
    totalBytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    totalChunks: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks),
    checksum: v4AttachmentChecksumSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.totalBytes === 0) !== (value.totalChunks === 0)) {
      context.addIssue({
        code: "custom",
        message: "zero-byte upload must declare zero chunks",
        path: ["totalChunks"],
      });
    }
  });
export type V4AttachmentBeginParams = z.infer<typeof v4AttachmentBeginParamsSchema>;

export const v4AttachmentBeginResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      uploadId: v4AttachmentUploadIdSchema,
      state: z.literal("staging"),
      nextChunkIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      uploadId: v4AttachmentUploadIdSchema,
      state: z.literal("committed"),
      nextChunkIndex: z.number().int().nonnegative(),
      ref: z.string().min(1),
    })
    .strict(),
]);
export type V4AttachmentBeginResult = z.infer<typeof v4AttachmentBeginResultSchema>;

function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return null;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  return (value.length / 4) * 3 - padding;
}

export const v4AttachmentChunkParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    dataBase64: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
  });
export type V4AttachmentChunkParams = z.infer<typeof v4AttachmentChunkParamsSchema>;

export const v4AttachmentChunkResultSchema = z
  .object({
    uploadId: v4AttachmentUploadIdSchema,
    nextChunkIndex: z.number().int().nonnegative(),
  })
  .strict();
export type V4AttachmentChunkResult = z.infer<typeof v4AttachmentChunkResultSchema>;

const v4AttachmentTerminalParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
  })
  .strict();
export const v4AttachmentCommitParamsSchema = v4AttachmentTerminalParamsSchema;
export type V4AttachmentCommitParams = z.infer<typeof v4AttachmentCommitParamsSchema>;
export const v4AttachmentCommitResultSchema = v4AttachmentPutResultSchema.strict();
export type V4AttachmentCommitResult = z.infer<typeof v4AttachmentCommitResultSchema>;
export const v4AttachmentAbortParamsSchema = v4AttachmentTerminalParamsSchema;
export type V4AttachmentAbortParams = z.infer<typeof v4AttachmentAbortParamsSchema>;
export const v4AttachmentAbortResultSchema = z.object({}).strict();

/** Sent image/video/PDF preview query; the ref must be re-authorized by the CLI against the current session projection. */
export const v4AttachmentReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    // New renderers use stable row identity + attachment ordinal to kill same-path cross-round ambiguity; the pair is mandatory.
    target: conversationRowTargetSchema.optional(),
    attachmentIndex: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.target === undefined) === (value.attachmentIndex === undefined)) return;
    context.addIssue({
      code: "custom",
      message: "target and attachmentIndex must be provided together",
      path: value.target === undefined ? ["target"] : ["attachmentIndex"],
    });
  });
export type V4AttachmentReadParams = z.infer<typeof v4AttachmentReadParamsSchema>;

/** Desktop-local sent-video source query; remote and web must return chunked. PDF is always chunked. */
export const v4AttachmentPreviewSourceParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema.optional(),
    attachmentIndex: z.number().int().nonnegative().optional(),
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.target === undefined) === (value.attachmentIndex === undefined)) return;
    context.addIssue({
      code: "custom",
      message: "target and attachmentIndex must be provided together",
      path: value.target === undefined ? ["target"] : ["attachmentIndex"],
    });
  });
export type V4AttachmentPreviewSourceParams = z.infer<typeof v4AttachmentPreviewSourceParamsSchema>;

export const v4AttachmentPreviewSourceResultSchema = z.union([
  z
    .object({
      kind: z.literal("local_path"),
      path: z.string().min(1),
      mediaType: z.string().refine((value) => value.startsWith("video/"), {
        message: "local attachment preview only supports video media types",
      }),
    })
    .strict(),
  z.object({ kind: z.literal("chunked") }).strict(),
]);
export type V4AttachmentPreviewSourceResult = z.infer<typeof v4AttachmentPreviewSourceResultSchema>;

export const v4AttachmentReadResultSchema = z
  .object({
    dataBase64: z.string(),
    mediaType: z
      .string()
      .refine(
        (value) =>
          value.startsWith("image/") ||
          value.startsWith("video/") ||
          value.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf",
        "attachment preview only supports image/video/pdf media types",
      ),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.mediaType.startsWith("image/") &&
      value.totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
    ) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        origin: "number",
        inclusive: true,
        message: "image preview exceeds total byte limit",
        path: ["totalBytes"],
      });
    }
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4AttachmentReadResult = z.infer<typeof v4AttachmentReadResultSchema>;

/** Share read of user-input attachments; any authorized MIME, no change to media-preview read semantics. */
export const v4ConversationAttachmentReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema,
    attachmentIndex: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict();
export type V4ConversationAttachmentReadParams = z.infer<
  typeof v4ConversationAttachmentReadParamsSchema
>;

export const v4ConversationAttachmentReadResultSchema = z
  .object({
    dataBase64: z.string(),
    mediaType: z.string().min(1),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4ConversationAttachmentReadResult = z.infer<
  typeof v4ConversationAttachmentReadResultSchema
>;

/** Share selection-stage metadata-only attachment check. */
export const v4ConversationAttachmentStatParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema,
    attachmentIndex: z.number().int().nonnegative(),
  })
  .strict();
export type V4ConversationAttachmentStatParams = z.infer<
  typeof v4ConversationAttachmentStatParamsSchema
>;

export const v4ConversationAttachmentStatResultSchema = z
  .object({
    mediaType: z.string().min(1),
    // stat is a metadata-only probe and must express real sizes above the transfer cap, otherwise
    // "known over-capacity" cannot be presented as a blocker at selection time (see the attachmentStatMaxBytes comment).
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentStatMaxBytes),
    mtimeMs: z.number().finite().optional(),
  })
  .strict();
export type V4ConversationAttachmentStatResult = z.infer<
  typeof v4ConversationAttachmentStatResultSchema
>;

/** conversation topic key construction (dual of parseConversationTopic). */
export function conversationTopic(sessionId: string): string {
  return `conversation/${sessionId}`;
}

/** conversation topic key parse ("conversation/<sessionId>"). */
export function parseConversationTopic(topic: string): string | null {
  if (!topic.startsWith("conversation/")) return null;
  const sessionId = topic.slice("conversation/".length);
  return sessionId.length > 0 ? sessionId : null;
}
