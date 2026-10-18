// The sessions-index topic: list liveness source; conflated latest state, never overflows.
import { z } from "zod";
import { timestampSchema } from "./core.js";
import { sessionWorkflowActivitySchema } from "./sessions-index-workflow-activity.js";
import {
  goalStateSchema,
  interactionAutoResolutionSchema,
  sessionMetaStateSchema,
  sessionPhaseSchema,
} from "./snapshot.js";

export const sessionPendingInteractionSummarySchema = z.object({
  interactionId: z.string(),
  kind: z.enum(["permission", "userInput"]),
  // Only the light tool identity, letting the sidebar tell AskUserQuestion from other blocking confirms; no question or answer carried.
  toolName: z.string().optional(),
  autoResolution: interactionAutoResolutionSchema.optional(),
});
export type SessionPendingInteractionSummary = z.infer<
  typeof sessionPendingInteractionSummarySchema
>;

export const pendingInteractionSummarySchema = z.object({
  permissionCount: z.number().int().nonnegative(),
  userInputCount: z.number().int().nonnegative(),
});
export type PendingInteractionSummary = z.infer<typeof pendingInteractionSummarySchema>;

export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  // Fork tree.
  parentSessionId: z.string().optional(),
  title: z.string(),
  // custom = user-renamed; default/generated are never manual titles in the product sense.
  // optional for legacy sessions-index frame / legacy persisted summary compat.
  titleSource: sessionMetaStateSchema.shape.titleSource.optional(),
  phase: sessionPhaseSchema,
  sessionEnded: z.boolean(),
  // For the list dot (kept boolean here, sparing the sidebar a whole backgroundWorks subscription).
  hasBackgroundWork: z.boolean(),
  // The sidebar workflow-run row: a bounded run summary,
  // only the fields the mini-track needs; absent when the session has no run. optional for legacy frame / legacy CLI compat.
  workflowActivity: sessionWorkflowActivitySchema.optional(),
  pendingInteraction: sessionPendingInteractionSummarySchema.optional(),
  // The sidebar needs kind/count only; no question, command, or answer payloads.
  // optional for legacy sessions-index frame / stored summary compat.
  pendingInteractionSummary: pendingInteractionSummarySchema.optional(),
  goalStatus: goalStateSchema.shape.status.optional(),
  // Unread derivation: the client compares locally-remembered lastSeenActivityAt (never seq; epochs reset).
  lastActivityAt: timestampSchema,
  // <= 120 chars.
  lastAssistantPreview: z.string().optional(),
  createdAt: timestampSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionsIndexSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  workspaceId: z.string(),
  // Host-level list log generation (unrelated to any session's logEpoch).
  logEpoch: z.string(),
  // Unordered; ordering is client display logic.
  sessions: z.array(sessionSummarySchema),
});
export type SessionsIndexSnapshot = z.infer<typeof sessionsIndexSnapshotSchema>;

export const sessionsIndexDeltaSchema = z.discriminatedUnion("op", [
  // conflation key = sessionId。
  z.object({ op: z.literal("session.upserted"), session: sessionSummarySchema }),
  z.object({ op: z.literal("session.removed"), sessionId: z.string() }),
]);
export type SessionsIndexDelta = z.infer<typeof sessionsIndexDeltaSchema>;

/** sessions-index topic key construction (dual of parseSessionsIndexTopic). */
export function sessionsIndexTopic(workspaceId: string): string {
  return `sessions-index/${workspaceId}`;
}

/** sessions-index topic key parse ("sessions-index/<workspaceId>"). */
export function parseSessionsIndexTopic(topic: string): string | null {
  if (!topic.startsWith("sessions-index/")) return null;
  const workspaceId = topic.slice("sessions-index/".length);
  return workspaceId.length > 0 ? workspaceId : null;
}
