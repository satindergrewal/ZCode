import { localTtftFactsSchema } from "../localTtft.js";
/* eslint-disable max-lines -- the three topics' logical/physical/candidate schemas must share one transport declaration to avoid cross-file drift. */
// Transport envelope: connection handshake / subscription / frame envelope.
// Phases are type placeholders (enabled once the channel layer lands); data shapes are final per spec.
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
  // Wire-compatible: missing on an old Host means false; callers must test === true.
  workspaceHookReview: z.boolean().optional(),
  independentPlanState: z.boolean().optional(),
  /**
   * This Host emits workflowRun.* key-level deltas (the two ops in delta.ts), so workflowRuns
   * actors/nodes may reach 1024 instead of the legacy 256. Consumers without this bit still get
   * whole-key state.updated, pre-clamped to the legacy bounds by clampWorkflowRunsForLegacy.
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
    // Placeholder only.
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

// clientMode registers once per connection; never enters command envelopes.
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
         * This client understands workflowRun.* deltas. The declaration rule is one-way: the
         * client may include this key only after seeing workflowRunDeltas === true in the Host
         * hello. This capabilities object is .strict(); an old Host seeing an unknown key fails
         * the whole clientHello and the handshake never completes.
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

// -- Section 3.1 subscription --
export const subscribeParamsSchema = z
  .object({
    // "conversation/<sessionId>" | "sessions-index/<workspaceId>" | ...
    topic: z.string(),
    // Watermark invariant: only carry it when the client truly holds a consistent state of that moment.
    base: z.object({ logEpoch: z.string(), seq: z.number() }).optional(),
    // QoS hint: affects scheduling only, never semantics.
    visibility: z.enum(["foreground", "background"]).optional(),
  })
  .strict();
export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;

export const subscribeAckSchema = z.object({
  subscriptionId: z.string(),
  // resume = valid base, resume deltas from base.seq; else snapshot.
  mode: z.enum(["snapshot", "resume"]),
  logEpoch: z.string(),
});
export type SubscribeAck = z.infer<typeof subscribeAckSchema>;

const openTimingMsSchema = z.number().int().nonnegative().optional();
const openTimingCountSchema = z.number().int().nonnegative().optional();

/**
 * Low-frequency diagnostic timing for a desktop session's first open; rides only on the
 * conversation subscribe ACK, never on snapshot/delta/sessions-index/workspace-config.
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

// -- Frame envelope (factories instantiate per-topic schemas from the generic frame) --
export function createTopicFrameSchema<S extends z.ZodTypeAny, D extends z.ZodTypeAny>(
  snapshotSchema: S,
  deltaSchema: D,
) {
  return z.object({
    topic: z.string(),
    // Generation tag; keeps old streams from interleaving.
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

// Concrete frame schema for the conversation topic (the five-piece instantiation).
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

// Concrete frame schema for the sessions-index topic (five-piece instantiation; liveness source for the sidebar list).
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

// Concrete frame schema for the workspace-config topic (additive changes; liveness source for the config catalog).
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

/** Shared logical/physical routing surface for the three production topics. */
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

// -- v4 RPC entry/exit (host channel layer) --
// Rides the existing JSON-RPC (stdio NDJSON / socket) with v4/-prefixed method names alongside
// the legacy protocol; once the legacy session/* methods die, this is the only protocol surface.
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
  // Terminal ExitPlanMode catalog of the current active branch; read-only, stateless, safe to
  // resend on timeout.
  conversationPlans: "v4/conversation/plans",
  conversationFileChanges: "v4/conversation/fileChanges",
  backgroundBashOutput: "v4/conversation/backgroundBashOutput",
  conversationFileRewindPreview: "v4/conversation/fileRewindPreview",
  // Workflow run event-log paging (detail page audit view): read-only, stateless, safe to resend
  // on timeout. New methods are skew-safe by construction: old desktops never call them.
  conversationWorkflowRunEvents: "v4/conversation/workflowRunEvents",
  conversationWorkflowRuns: "v4/conversation/workflowRuns",
  // User-facing workflow run artifacts. Three of a family: read-only, stateless, safe to resend
  // on timeout; schemas in workflow-artifacts.ts (terminology disambiguation lives there too).
  //   Artifacts    artifact list (durable read for cold resume and the hub detail page)
  //   ArtifactData preset-board entry paging (cursor = journal sequence)
  //   ArtifactRead content-artifact bytes, <= 512 KiB per chunk, shaped verbatim on attachmentRead
  conversationWorkflowRunArtifacts: "v4/conversation/workflowRunArtifacts",
  conversationWorkflowRunArtifactData: "v4/conversation/workflowRunArtifactData",
  conversationWorkflowRunArtifactRead: "v4/conversation/workflowRunArtifactRead",
  // Workflow run workspace transcripts. Two of a family, split like the artifact 1/3 pair:
  // Workspace is the light row list (no bodies), NodeResult one node's bounded body.
  conversationWorkflowRunWorkspace: "v4/conversation/workflowRunWorkspace",
  conversationWorkflowRunNodeResult: "v4/conversation/workflowRunNodeResult",
  // Usage query (same shape as rows/range: read-only, stateless, safe to resend on timeout).
  // Usage truth lives in the CLI session store (model_usage/turn_usage aggregates) with no host
  // copy, so it converges as a v4 query instead of a direct host connection; the legacy
  // usage/stats and session/usage words are thereby retired.
  usageStats: "v4/usage/stats",
  conversationUsage: "v4/conversation/usage",
  // Attachment transactions: no full-data RPC. Each chunk's decoded bytes <= 512 KiB, and both
  // renderer->host Channel and host->CLI NDJSON must prove <= 1 MiB per request.
  attachmentBegin: "v4/attachment/begin",
  attachmentChunk: "v4/attachment/chunk",
  attachmentCommit: "v4/attachment/commit",
  attachmentAbort: "v4/attachment/abort",
  // Sent-image previews: read-only, authorized per session row; responses still chunk at 512 KiB.
  attachmentRead: "v4/attachment/read",
  // Share read of userInput attachments: allows non-media types such as text/plain, still
  // row/index-authorized and chunked.
  conversationAttachmentRead: "v4/conversation/attachmentRead",
  // Share precheck of userInput attachment metadata: row/index authorization plus stat only, no
  // full-file read.
  conversationAttachmentStat: "v4/conversation/attachmentStat",
  // Desktop-local sent videos: returns only local playback sources authorized by the same
  // row/index pair.
  attachmentPreviewSource: "v4/attachment/previewSource",
  commandsQuery: "v4/commands/query",
  command: "v4/command",
} as const;
export type V4Method = (typeof V4_METHODS)[keyof typeof V4_METHODS];

/** Task-authorized bounded output query; no arbitrary paths or caller-inflated read budgets. */
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
  // Downlink frames (snapshot/deltas); params = ConversationTopicFrame.
  conversationFrame: "v4/conversation/frame",
  // Body-less facts from live ingest only; never enter topic snapshot/recovery.
  conversationTelemetryFact: "v4/telemetry/event",
  localTtftFacts: "v4/telemetry/local-ttft",
  // Produced only by the current process's live ToolCallResult; history and replayable paths
  // must not fabricate it.
  cuaPermissionObservation: "v4/cua/permission-observation",
} as const;

/** The SSH historical-task ownership proof shares one bounded window with the sessions-index cold seed. */
export const MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE = 200;

// subscribe request = generic SubscribeParams + connectionId (resubscribe replacement is decided
// per (connectionId, topic); on the single-pipe stdio transport the host assigns one per downstream
// client).
export const v4ConversationSubscribeParamsSchema = subscribeParamsSchema.extend({
  connectionId: z.string(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
  // Workspace of the currently trusted attachment; cold resume prefers it for identity restore, live ignores it.
  workspace: zcodeWorkspaceRefSchema.optional(),
  /** Allowlist of legacy task ownership read exactly from the current remote workspace's tasks-index. */
  legacyTaskIds: z.array(z.string().min(1)).max(MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE).optional(),
  // For host->CLI cold resume only; live conversation never consumes this hint.
  resumeThoughtLevel: z.string().trim().min(1).optional(),
  /**
   * Whether this subscription receives workflowRun.* key-level deltas. Same family as clientMode:
   * injected by the trusted host from that connection's clientHello; a UI-facing subscribe cannot
   * choose it. Whether a client understands deltas is a fact of the connection, not a per-subscription
   * preference. Absent = treat as a legacy consumer (whole-key patch + legacy-bound clamping).
   */
  workflowRunDeltas: z.boolean().optional(),
});
export type V4ConversationSubscribeParams = z.infer<typeof v4ConversationSubscribeParamsSchema>;

// The common subscribe response carries strictly an ACK. The initial snapshot/resume is emitted by
// the server's request-scoped post-response outbox as an owned notification after the response line.
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

// workspace-config also ACKs only; the initial frame follows the same post-response notification timing.
export const v4WorkspaceConfigSubscribeResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4WorkspaceConfigSubscribeResult = z.infer<
  typeof v4WorkspaceConfigSubscribeResultSchema
>;

// Same-subscription recovery for live subscriptions. topic/connection/profile must be looked up via
// the host's owned registry; the client may only declare its acknowledged watermark and whether to
// force a snapshot.
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

// CLI-facing shape: topic/connectionId can only be injected by the connection facade from the owned registry.
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

// -- rows/range (cursor-keyed row paging, loadOlder) --
// No index semantics: total order = rowId ascending; the client merges keyed by rowId.
export const v4ConversationRowsRangeParamsSchema = z.object({
  sessionId: z.string(),
  /** Host attachment injects this trusted value; renderer callers omit it. */
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  // Rows with rowId < beforeRowId; default = backwards from the current tail.
  beforeRowId: z.number().optional(),
  limit: z.number().min(1).max(PROTOCOL_V4_LIMITS.rowsRangeMaxLimit),
});
export type V4ConversationRowsRangeParams = z.infer<typeof v4ConversationRowsRangeParamsSchema>;

export const v4ConversationRowsRangeResultSchema = z.object({
  // rowId ascending.
  rows: z.array(conversationRowSchema),
  // Watermark/epoch at server read time; shared with read-only queries like fileChanges so data is
  // never published stitched across revisions.
  atSeq: z.number(),
  atRevision: z.number().int().nonnegative(),
  atLogEpoch: z.string(),
  // Whether older rows remain in the beforeRowId direction.
  hasMore: z.boolean(),
});
export type V4ConversationRowsRangeResult = z.infer<typeof v4ConversationRowsRangeResultSchema>;

// -- conversation plans directory --
// The directory comes from the CLI's full valid projection, never derived from the renderer's
// bounded tail window.
export const v4ConversationPlansParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ConversationPlansParams = z.infer<typeof v4ConversationPlansParamsSchema>;

export const v4ConversationPlansResultSchema = z
  .object({
    // Terminal ExitPlanMode rows of the active branch, rowId descending (newest first).
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
// Same family as rows/range and plans: read-only, stateless, safe to resend on timeout. The cursor
// is the journal sequence (monotonically assigned by appendEvent), refetched as
// workflowRuns[].lastEventSequence rises. Deliberately NOT a v4 command: a command's ACK result is
// commandResultSchema's closed change-result union; stuffing a page of read-only events into it puts
// reads into the write vocabulary and drags along baseRevision/idempotency for nothing.

/**
 * The two bounds per event-log page, used by the gateway when fetching
 * (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, "Reading the journal"). Bytes
 * count stored serialized bytes at one quarter of the single-frame protocol cap: entry count alone
 * cannot bound bytes, and 500 events carrying large report items reach the frame cap.
 */
export const WORKFLOW_RUN_EVENTS_PAGE_LIMITS = {
  maxEvents: 500,
  maxBytes: PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes / 4,
} as const;

export const v4ConversationWorkflowRunEventsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    /** Only events with sequence strictly greater; default from the start. */
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents).optional(),
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
          // The payload was bounded CLI-side by boundDynamicWorkflowRunEventPayload (the same
          // serialization also feeds the workflowRuns projection). The engine's event shape is not
          // restated here: readers interpret by kind.
          payload: z.record(z.string(), z.unknown()),
          truncated: z.boolean().optional(),
        })
        .strict(),
    ),
    /** More events after this page (the page may end early on the entry or byte bound). */
    hasMore: z.boolean(),
  })
  .strict();
// Deliberately NO atSeq/atLogEpoch, although sibling rows/range and plans both carry them.
//
// There those fields are stale-read protection: they read the conversation projection, whose rowId
// only means anything inside one log epoch (rebuild/fork/renumber on rewind), so the reader contract
// is "atLogEpoch != store epoch -> drop the whole result".
//
// This query reads the journal (dwf_event), unrelated to the conversation log, and its cursor never
// expires: the journal's JournalStorePort contract requires append-only sequences that continue from
// the prior max across resumes, never reset or reused, existing numbering immutable. A
// (runId, sequence) cursor is thus valid forever; there is no staleness to guard.
//
// Moreover, carrying atLogEpoch is not harmless symmetry: under the sibling reader contract, a
// perfectly unrelated session rewind (epoch change) would make the detail page drop an entirely
// valid journal page. Fewer fields beats a field with no definable semantics here.
export type V4ConversationWorkflowRunEventsResult = z.infer<
  typeof v4ConversationWorkflowRunEventsResultSchema
>;

// -- dwf run enumeration --
// Journal-backed post-restart discovery: the workflowRuns projection is memory-only (cold merges
// classify) and empty after restart, so tool-card joins and Resume availability can only be rebuilt
// from dwf_run rows. Same family as workflowRunEvents (read-only, stateless, resend-safe), equally
// not a v4 command, equally without atSeq/atLogEpoch (journal reads, unrelated to the conversation
// log; see the previous query's argument). New methods are skew-safe: old desktops never call them.
export const v4ConversationWorkflowRunsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    /** Result cap; defaulting and clamping happen CLI-side (bounded enumeration, never an unbounded scan). */
    limit: z.number().int().positive().max(64).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunsParams = z.infer<
  typeof v4ConversationWorkflowRunsParamsSchema
>;

export const v4ConversationWorkflowRunSummarySchema = z
  .object({
    runId: z.string().min(1),
    /** CreateWorkflow tool-call id that started the run (tool card -> detail/Resume join key); absent on old runs. */
    toolCallId: z.string().min(1).optional(),
    /**
     * Display label, derived server-side at read (name -> script first line -> runId). optional is
     * skew-safety: old CLIs omit the key and readers fall back to runId; a missing label is
     * degradation, not an error. The cap is the derivation's 80 chars doubled (user-set names are
     * not bound by the derivation cap).
     */
    label: z.string().min(1).max(160).optional(),
    /** Last update time (epoch ms, journal dwf_run.time_updated); absent hides the timestamp. */
    updatedAt: z.number().int().nonnegative().optional(),
    // Same five-value vocabulary as the workflowRuns projection; this query carries its own schema
    // so new query statuses never change the projection's state keys.
    status: z.enum(["completed", "errored", "pending", "running", "stopped"]),
    /** Present only when status is stopped. The vocabulary is shared with the observation surface;
     * it used to be copied here, so when the engine grew a new status this strict schema rejected
     * the whole run page (desktop showed run-summary-read-failed; task-list counts and the
     * directory went blank together). */
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    // lineage: a revised run carries its predecessor, a superseded run its successor (only with
    // stopReason superseded). Both optional: old CLIs omit them.
    resumedFrom: z.string().min(1).optional(),
    supersededBy: z.string().min(1).optional(),
    /** Structured failure code for errored/stopped(provider|interrupted) (ProviderStop/Interrupted/...). */
    failureCode: z.string().min(1).max(64).optional(),
    failureMessage: z.string().max(2048).optional(),
    /** Resumable flag, computed CLI-side by the same predicate as the resume gate; the UI never rederives it (two predicates drift). */
    resumable: z.boolean(),
  })
  .strict();
export type V4ConversationWorkflowRunSummary = z.infer<
  typeof v4ConversationWorkflowRunSummarySchema
>;

export const v4ConversationWorkflowRunsResultSchema = z
  .object({
    /** Most recently updated first (ordering in the storage layer). */
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

// -- usage query --
// App-level usage aggregation: range/timeZone inputs match the legacy usage/stats shape (consumer
// semantics unchanged); the result is AppUsageSnapshot (shape owned by the neutral usage-stats.ts
// module, not coupled to the legacy vocabulary file).
export const v4UsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();
export type V4UsageStatsParams = z.infer<typeof v4UsageStatsParamsSchema>;
export const v4UsageStatsResultSchema = appUsageSnapshotSchema;
export type V4UsageStatsResult = z.infer<typeof v4UsageStatsResultSchema>;

// Session-level token usage (the v4 namespace home of legacy session/usage: sessions are
// protocol-first-class, tasks are a UI projection concept and stay out of protocol vocabulary).
// Fields match the legacy result; the old schema dies with the word.
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

// -- attachment upload transaction --
// Higher UI layers still use put(input)->ref; this full-data schema describes renderer-internal calls
// only and must never become a production RPC method. The wire only ever uses
// begin/chunk/commit/abort.
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
    // New renderers disambiguate the same path across turns via stable row identity + attachment
    // ordinal; the pair is mandatory.
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
          value.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf" ||
          value.split(";", 1)[0]?.trim().toLowerCase() === "text/plain",
        "attachment preview only supports image/video/pdf/plain text types",
      ),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      // Root cause: the runtime supported text materials while the response schema still accepted
      // media only, failing cross-process previews.
      (value.mediaType.startsWith("image/") ||
        value.mediaType.split(";", 1)[0]?.trim().toLowerCase() === "text/plain") &&
      value.totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
    ) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        origin: "number",
        inclusive: true,
        message: "image/text preview exceeds total byte limit",
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

/** Share read of user-input attachments: any authorized MIME, leaving the media-preview read untouched. */
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

/** Metadata-only attachment check for the Share picker. */
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
    // stat is a metadata-only probe and must express real sizes beyond the transport cap, or
    // over-cap-known cannot block at selection time (see the attachmentStatMaxBytes comment).
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentStatMaxBytes),
    mtimeMs: z.number().finite().optional(),
  })
  .strict();
export type V4ConversationAttachmentStatResult = z.infer<
  typeof v4ConversationAttachmentStatResultSchema
>;

/** conversation topic key construction (inverse of parseConversationTopic). */
export function conversationTopic(sessionId: string): string {
  return `conversation/${sessionId}`;
}

/** conversation topic key parse ("conversation/<sessionId>"). */
export function parseConversationTopic(topic: string): string | null {
  if (!topic.startsWith("conversation/")) return null;
  const sessionId = topic.slice("conversation/".length);
  return sessionId.length > 0 ? sessionId : null;
}
