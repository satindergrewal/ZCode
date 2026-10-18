import type { MessageSemantics, MessageVisibility, SyntheticUserMessageSource } from "../deps.js";
import { runtimeMetadataForSyntheticUserMessageSource } from "../helpers/index.js";

export function buildSyntheticUserNoticePartMetadata(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...metadata,
    runtimeMessage:
      metadata?.runtimeMessage ?? runtimeMetadataForSyntheticUserMessageSource(source),
    source,
    visibility,
  };
}

export function buildSyntheticUserNoticeMessageMetadata(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next.runtimeMessage;
  return {
    ...next,
    source,
    visibility,
  };
}

export function buildSyntheticUserNoticeSemantics(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
): MessageSemantics {
  if (source === "shared_context") {
    return {
      origin: "import",
      kind: "shared_context",
      source,
      uiVisibility: "hidden",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    };
  }
  const providerVisible = visibility === "model-only";
  return {
    origin: "agent_runtime",
    kind: syntheticUserNoticeKind(source),
    source,
    uiVisibility: providerVisible ? "hidden" : "visible",
    providerVisibility: providerVisible ? "visible" : "hidden",
    // A provider-visible user-role runtime context is not the user transcript.
    // If synthetic notices (fork/goal/background) were transcript-visible,
    // v4 hydration would call them real user turns.
    transcriptVisibility: providerVisible ? "hidden" : "visible",
  };
}

function syntheticUserNoticeKind(source: SyntheticUserMessageSource): MessageSemantics["kind"] {
  switch (source) {
    case "background_task":
      return "background_notification";
    case "fork":
      return "fork_notice";
    // goal_state_change is a trajectory-branch runtime injection (the target.ts change notice),
    // system-reminder semantics like goal-continuation.
    case "goal_state_change":
      return "system_reminder";
    case "goal-continuation":
      return "system_reminder";
    case "mission-continuation":
      return "system_reminder";
    case "agent_listing_delta":
    case "plugin_reference":
    case "bot_topic_context":
      return "system_reminder";
    case "rewind":
      return "rewind_notice";
    case "selection_side_chat":
      return "system_reminder";
    case "subagent":
      return "subagent_notification";
    case "subagent_message":
      // The child->parent model-only carrier;
      // an unhandled case persists kind=undefined and breaks cold-resume parity.
      return "subagent_notification";
    case "todo_reminder":
      return "todo_reminder";
    // Hub-launch turns skip this minting path (they need origin=real_user, kind=user_prompt,
    // via the dedicated message-persistence write); this entry is exhaustiveness only.
    case "workflow_launch":
      return "user_prompt";
    case "shared_context":
      return "shared_context";
  }
}
