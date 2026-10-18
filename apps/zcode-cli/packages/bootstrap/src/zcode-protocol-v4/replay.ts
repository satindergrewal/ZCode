// Replay export barrel.
//
// The downstream replay page rebuilds persisted MessageWithParts in the browser via the CLI's own three-stage reducer into
// ConversationSnapshot：synthesizeEventsFromMessages → mergeColdConversationEvents →
// ProductProjection (hydration replay). All three are pure functions/classes with no node deps -- a discipline enforced by
// the browser replay package's `vite build` check (any node builtin import in the barrel fails that build immediately).
//
// Re-exports only; defines nothing.
export { ProductProjection } from "./product-projection.js";
export { synthesizeEventsFromMessages } from "./transcript-hydration.js";
export { mergeColdConversationEvents, type ColdEventMergeResult } from "./cold-event-merge.js";
export { HYDRATION_TRACE_ID } from "./projection-state.js";
