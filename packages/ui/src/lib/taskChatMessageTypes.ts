// Re-home artifact (paving the way to delete zcodeChatMessages; same pattern as zcode-task-types-core).
// This file carries the load-bearing types from the legacy message-conversion layer
// (zcodeChatMessages/zcodeChatMessageHelpers) that the living stack still consumes type-only:
// TaskChatMessage / TaskChatToolCall / TaskChatMessagePart.
// Consumers: ToolCallBlocks(toolCallTree) / PermissionDialog / taskChangeSummary /
// treemappingActivity / codeViewer / toolDisplay / toolError / the app-shell test injection channel.
// Once the legacy assembly runtime (zcodeChatMessages.ts) is deleted, this is the single source of truth for the type surface.
import type {
  ZCodeAssistantMessagePart,
  ZCodeAssistantMessageFeedback,
  ZCodePromptAttachment,
  ZCodeTimelineMeta,
  ZCodeTaskSnapshotBodyRef,
  ZCodeTaskSnapshotToolFieldRef,
  ZCodeTaskSnapshotToolSlice,
} from "@zcode/shared";

export interface TaskChatToolCall {
  toolId: string;
  /** Parent toolCallId; null means the main agent, non-null means a Task/Agent subtool. */
  parentToolUseId?: string | null;
  /** Canonical ZCode tool name; kind remains for legacy ZCode Agent snapshot and UI grouping compatibility. */
  toolName?: string;
  kind: string;
  title?: string;
  input: unknown;
  status: string;
  /** Text output of the sub-agent owning parentToolUseId. */
  content?: string;
  /** Thought output of the sub-agent owning parentToolUseId. */
  thought?: string;
  output?: unknown;
  error?: string;
  raw?: unknown;
  /** References to tool fields trimmed by the snapshot budget; backfill full input/output/raw on demand. */
  snapshotRefs?: ZCodeTaskSnapshotToolFieldRef[];
  /** Local time when the tool call first entered the current message stream; only for spotting long-running calls. */
  startedAt?: number;
}

export type TaskChatMessagePart = ZCodeAssistantMessagePart;

export interface TaskModelChangeUiTimeline {
  type: "model_change";
  fromModelLabel: string;
  toModelLabel: string;
}

export type TaskUiTimelineMeta = TaskModelChangeUiTimeline;

export interface TaskChatMessage {
  id: string;
  /** Stable protocol messageId from the session snapshot; live-stream ids may be temporary display identities. */
  protocolMessageId?: string;
  /** Original messageIds kept after the snapshot merged the assistant message, so timeline anchors hit pre-merge children. */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Legacy goal display iteration for this assistant message; history status copy only, never verifier turn logic. */
  goalIteration?: number;
  /** UI-only streaming group; separates model-only goal resumes, not part of goal turn semantics. */
  streamGroupId?: string;
  mailboxMessage?: {
    content: string;
    createdAt?: string;
    fromSessionId: string;
    messageId: string;
  };
  /** Final duration of this assistant turn in history; written at turn end so UI recovery never re-guesses. */
  durationMs?: number;
  /** Whether the assistant ended via explicit stop/interrupt; lets UI avoid misreading latest as a natural completion. */
  interrupted?: boolean;
  /** Local feedback on the assistant reply; display/persistence only, never re-enters model context. */
  feedback?: ZCodeAssistantMessageFeedback;
  attachments?: ZCodePromptAttachment[];
  toolCalls?: TaskChatToolCall[];
  thought?: string;
  /**
   * Assistant messages used to render only the three aggregate fields thought/tool/content,
   * forcing "tools above, text below" once a turn had both. This also records the real arrival
   * order of stream events, so the renderer can replay in order instead of a fixed field layout.
   */
  parts?: TaskChatMessagePart[];
  /** Conversation turn this message belongs to; links per-turn file-change summaries and rollback. */
  turnIndex?: number;
  /** Full-body reference for the large-message first-screen preview; when present, treat the body as not fully loaded. */
  bodyRefs?: ZCodeTaskSnapshotBodyRef[];
  /** Cursor info when tools are sliced by count; used to fetch more in "show more tool calls". */
  toolSlice?: ZCodeTaskSnapshotToolSlice;
  /** Still streaming; current-run UI recovery only, never persisted. */
  streaming?: boolean;
  /** ZCode Agent synthetic timeline message; excluded from assistant body, tool calls, and fork. */
  syntheticTimeline?: ZCodeTimelineMeta;
  /** UI-only synthetic timeline message; never enters protocol snapshots or local history. */
  uiTimeline?: TaskUiTimelineMeta;
  /** ZCode CLI turn-steering marker; user-message display only. */
  turnSteer?: {
    status: "guided";
  };
}
