import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { applySubmissionExecutionState, sameModelSelection } from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { appendTurnRequestEntries } from "./turn-output-token-continuation.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

/**
 * Consume at most one guide at a legal model-step boundary; prepare the next provider request.
 * SendMessage can arrive mid child request; if that step closes
 * text-only, waiting for a tool batch parks the input in a never-woken queue.
 */
export async function drainInlineGuideForNextRequest(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<boolean> {
  const activeTurn = state.activeTurn;
  if (!activeTurn || !runtime.hasInlineGuidePendingInput(activeTurn)) return false;

  const drained = await runtime.drainPendingInput({
    activeTurn,
    events: state.events,
    traceContext: state.turnTraceContext,
  });
  if (!drained || drained.pendingInputIds.length === 0) return false;

  state.drainedSteerForNextRequest = drained;
  appendTurnRequestEntries(state.turnRequestState, drained.runtimeEntries ?? []);
  // A pinned model forbids switching only; it keeps Guide permission/Plan intent.
  if (state.modelSelectionScope === "execution" && drained.intent) {
    await applyRuntimeExecutionState(runtime, drained.intent, {
      source: "command",
      traceContext: state.turnTraceContext,
    });
  }
  const guideModel =
    state.modelSelectionScope === "execution"
      ? undefined
      : await applySubmissionExecutionState(runtime, drained?.intent, state.turnTraceContext);
  if (guideModel) {
    // A config reparse is no switch; compare the Loop execution choice, not the maybe-updated Session.
    const selectionChanged = !sameModelSelection(state.model, guideModel);
    state.model = guideModel;
    if (selectionChanged) {
      state.turnRequestState.entries = rebuildContextPrefix(runtime, {
        model: guideModel,
        turnRequestEntries: state.turnRequestState.entries,
      });
    }
  }
  state.currentUserMessageId = drained?.latestMessageId ?? state.currentUserMessageId;
  const nextQueryId = drained?.queryIds?.[0];
  if (nextQueryId) {
    // The guide continues the active turn as user role; later requests attribute to its query.
    state.turnTraceContext = { ...state.turnTraceContext, queryId: nextQueryId };
  }
  if ((drained.toolDisallowlist?.length ?? 0) > 0) {
    // An automation guide never restarts the turn; merge its limits into loop state.
    state.toolDisallowlist = [
      ...new Set([...(state.toolDisallowlist ?? []), ...(drained.toolDisallowlist ?? [])]),
    ];
  }
  state.repeatedToolCallSignature = undefined;
  state.repeatedToolCallStreakCount = 0;
  return true;
}
