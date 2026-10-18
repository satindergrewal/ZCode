import type { ModelStreamEvent } from "@zcode/contracts";

// Note: these events are buffered, not yielded, until a committed stream boundary appears.
// If a network reset happens first, the partial tool-input attempt can be discarded.
// A non-empty reasoning_delta is the first user-visible output token; do not wait for content or tool boundaries.
const RETRY_SAFE_PRELUDE_STREAM_EVENT_TYPES = new Set<ModelStreamEvent["type"]>([
  "start",
  "text_start",
  "text_end",
  "reasoning_start",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
]);

export function isRetrySafePreludeStreamEvent(event: ModelStreamEvent): boolean {
  // The SDK turns signature-only events into empty reasoning_delta; counting it as output would stop adapter retries
  // that core cannot recover without text or a complete tool call. Buffer empty deltas with the prelude; on success release signatures in order.
  if (event.type === "reasoning_delta" || event.type === "text_delta") {
    return event.text.length === 0;
  }
  return RETRY_SAFE_PRELUDE_STREAM_EVENT_TYPES.has(event.type);
}
