import type {
  MessageAnchorOrigin,
  MessageProjectionAnchor,
  SyntheticUserMessageSource,
  TraceContext,
} from "../deps.js";

// ── v4 transcript anchors (inventory)──
// Additive JSON: anchor-less old data degrades gracefully; turnId comes from traceContext.
// sourceCommandId rides the command execution context once the v4 inbox wires in.
export function buildProjectionAnchor(
  traceContext: TraceContext,
  origin?: MessageAnchorOrigin,
  sourceCommandId?: string,
): MessageProjectionAnchor | undefined {
  if (traceContext.turnId === undefined && origin === undefined && sourceCommandId === undefined) {
    return undefined;
  }
  return {
    ...(traceContext.turnId ? { turnId: traceContext.turnId } : {}),
    ...(origin ? { origin } : {}),
    ...(sourceCommandId ? { sourceCommandId } : {}),
  };
}

// Read-only map: legacy SyntheticUserMessageSource to v4 userInput.origin.
export function mapSyntheticSourceToAnchorOrigin(
  source: SyntheticUserMessageSource,
): MessageAnchorOrigin {
  switch (source) {
    case "background_task":
    case "subagent":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    default:
      return "synthetic";
  }
}
