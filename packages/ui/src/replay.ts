// Replay export barrel.
//
// The browser-side replay page assembles the run detail view from STATIC data: the board
// (WorkflowRunGraphSection), a read-only SessionPane, collapsed-section headers, plus the
// provider and data-layer seams they need. These components were previously App-internal and
// not exported from index; they are surfaced here once, with no behavior changes.
//
// Discipline: re-exports only, define nothing.
//
// The run side pane's Results / event log / Script sections were removed from the product and
// their components deleted, so their entries are gone too. The pure event-line formatter
// `workflowRunEventLines` and its i18n keys are KEPT: they are not the removed UI but the
// rendering rule for journal events, still used by the browser replay over static data.
export { SessionPane, type SessionPaneProps } from "./v4/SessionPane.js";
export {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "./v4/V4ConversationContext.js";
export { SessionDataLayer, type SessionLease } from "./v4/sessionDataLayer.js";
export type { ConversationTransport, ConversationAttachmentReadParams } from "./v4/transport.js";
export { WorkflowRunPhaseList } from "./app-shell/WorkflowRunPhaseList.js";
export { WorkflowRunSectionToggle } from "./app-shell/WorkflowRunSectionToggle.js";
export {
  workflowRunEventLines,
  workflowRunResultView,
  type WorkflowActorInstance,
  type WorkflowRunEventItem,
  type WorkflowRunEventLine,
} from "./app-shell/workflowRunPanel.js";
export { WorkflowTimeline } from "./components/workflow-timeline/WorkflowTimeline.js";
export { buildWorkflowTimeline } from "./components/workflow-timeline/timeline-model.js";
export type { WorkflowCausalityGraphData } from "./components/workflow-graph/types.js";
export { workflowRunOverlay } from "./components/workflow-graph/run-status.js";
export { TooltipProvider } from "./components/ui/tooltip.js";
export { ServiceProvider } from "./hooks/useServices.js";
export { PlatformProvider } from "./hooks/usePlatform.js";
export { StoreProvider, useZCodeStore } from "./store/StoreProvider.js";
export { TabStoreProvider } from "./store/TabStoreProvider.js";
export { DiffsWorkerPoolProvider } from "./root/DiffsWorkerPoolProvider.js";
export { ZCodeIntlProvider, useZCodeIntl } from "./i18n/IntlProvider.js";
export { Button } from "./components/ui/button.js";
export { cn } from "./components/lib/utils.js";
