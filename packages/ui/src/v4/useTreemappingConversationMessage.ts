// The TreemappingPane data source is the v4 conversation projection rows.
// Treemapping consumes only the toolCalls of one assistant turn plus its streaming flag; this adapter
// maps the ToolCallRow of the last assistant turn in snapshot rows back into the legacy TaskChatMessage shape,
// reusing the treemappingActivity parsing rules, without reviving zcodeChatMessages.
//
// TreemappingPane lives in a side pane (outside V4ConversationProvider) and therefore owns its own
// SessionDataLayer; the pane is hidden from the sidebar by default (workspaceSidePane sanitize filters
// the treemapping tab), so the subscription is established only once the pane actually mounts.
import { useEffect, useMemo, useState } from "react";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";
import { useServices } from "@/hooks/useServices.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { SessionDataLayer, type SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

const ASSISTANT_TURN_ROW_KINDS = new Set<ConversationRow["kind"]>([
  "assistantText",
  "reasoning",
  "toolCall",
  "subagent",
]);

/** Picks the last assistant turn from the rows window and adapts it to the legacy TaskChatMessage shape. */
export function buildTreemappingMessageFromRows(
  rows: readonly ConversationRow[],
): TaskChatMessage | null {
  let lastAssistantTurnId: string | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (ASSISTANT_TURN_ROW_KINDS.has(row.kind)) {
      lastAssistantTurnId = row.turnId;
      break;
    }
  }
  if (lastAssistantTurnId === null) {
    return null;
  }

  const turnRows = rows.filter((row) => row.turnId === lastAssistantTurnId);
  const toolCallRows = turnRows.filter((row): row is ToolCallRow => row.kind === "toolCall");
  const streaming = turnRows.some(
    (row) =>
      ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") ||
      (row.kind === "toolCall" && (row.status === "inputStreaming" || row.status === "running")),
  );

  return {
    id: `v4-turn-${lastAssistantTurnId}`,
    role: "assistant",
    content: "",
    timestamp: 0,
    streaming: streaming || undefined,
    toolCalls: toolCallRows.map((row) => toolCallRowToLegacyNode(row).toolCall),
  };
}

/**
 * Subscribes to the v4 conversation projection of the given session, returning the synthetic assistant message Treemapping needs.
 * With no sessionId, no subscription and a null return.
 */
export function useTreemappingConversationMessage(params: {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
}): TaskChatMessage | null {
  const { sessionId, workspacePath, workspaceIdentity } = params;
  const { zcodeAgentService } = useServices();
  const layer = useMemo(
    () =>
      new SessionDataLayer({
        transport: createAgentConversationTransport(zcodeAgentService, {
          workspacePath,
          workspaceIdentity,
        }),
      }),
    [zcodeAgentService, workspacePath, workspaceIdentity],
  );
  useEffect(() => {
    return () => layer.dispose();
  }, [layer]);

  const [lease, setLease] = useState<SessionLease | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setLease(null);
      return;
    }
    const nextLease = layer.acquire(sessionId);
    setLease(nextLease);
    return () => {
      nextLease.release();
    };
  }, [layer, sessionId]);

  const state = useConversationProjection(lease);
  const rows = state.snapshot?.rows.window;
  return useMemo(() => (rows ? buildTreemappingMessageFromRows(rows) : null), [rows]);
}
