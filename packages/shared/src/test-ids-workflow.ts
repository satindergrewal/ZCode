// Test ids for dynamic workflows.
// test-ids.ts sits at oxlint's max-lines cap (400), so this family split out;
// still exported from the @zcode/shared barrel, import paths unchanged.

// The saved-workflow GUI hub.
export const TID_AUTOMATIONS_PAGE_TAB = "automations-page-tab";
export const TID_WORKFLOWS_LIST = "workflows-list";
export const TID_WORKFLOWS_EMPTY = "workflows-empty";
export const TID_WORKFLOWS_REFRESH = "workflows-refresh";
export const TID_WORKFLOWS_CREATE_VIA_CHAT = "workflows-create-via-chat";
export const TID_WORKFLOW_PROJECT_GROUP = "workflow-project-group";
export const TID_WORKFLOW_GLOBAL_GROUP = "workflow-global-group";
export const TID_WORKFLOW_CARD = "workflow-card";
export const TID_WORKFLOW_CARD_RUN = "workflow-card-run";
export const TID_WORKFLOW_CARD_MENU = "workflow-card-menu";
export const TID_WORKFLOW_ACTION_DELETE = "workflow-action-delete";
export const TID_WORKFLOW_LAUNCH_DIALOG = "workflow-launch-dialog";
export const TID_WORKFLOW_LAUNCH_ARG = "workflow-launch-arg";
export const TID_WORKFLOW_LAUNCH_TARGET = "workflow-launch-target";
export const TID_WORKFLOW_LAUNCH_SUBMIT = "workflow-launch-submit";
// Direct launch: the args-pane inline error area. The session-top growth is the ordinary end-of-round run card.
export const TID_WORKFLOW_LAUNCH_ERROR = "workflow-launch-error";
// End-of-round run card; suffix = `${turnKey}-${toolCallId}`.
export const TID_CHAT_WORKFLOW_RUN_DIGEST = "workflow-run-digest";
export const TID_WORKFLOW_ACTION_MOVE = "workflow-action-move";
export const TID_WORKFLOW_MOVE_DIALOG = "workflow-move-dialog";
export const TID_WORKFLOW_MOVE_DIALOG_TARGET = "workflow-move-dialog-target";
export const TID_WORKFLOW_MOVE_DIALOG_SUBMIT = "workflow-move-dialog-submit";
export const TID_WORKFLOW_DETAIL = "workflow-detail";
export const TID_WORKFLOW_DETAIL_RUN = "workflow-detail-run";
export const TID_WORKFLOW_DETAIL_MENU = "workflow-detail-menu";
export const TID_WORKFLOW_DETAIL_TAB = "workflow-detail-tab";
export const TID_WORKFLOW_DETAIL_DESCRIPTION = "workflow-detail-description";
export const TID_WORKFLOW_DETAIL_WHEN_TO_USE = "workflow-detail-when-to-use";
export const TID_WORKFLOW_DETAIL_SCRIPT = "workflow-detail-script";
export const TID_WORKFLOW_META_SAVE = "workflow-meta-save";
export const TID_WORKFLOW_META_DISCARD = "workflow-meta-discard";
export const TID_WORKFLOW_RUN_ROW = "workflow-run-row";

// The four surfaces of user-facing artifacts.
//
// Terminology: artifact here is what the script published to the user via artifact.* (file/markdown/
// board), not the engine-internal RunSettlement.artifact's "top-level return" homonym.
//
// Only the **entry-level** four live here (section, card, tab root, chip): desktop e2e's landing spots; duplicated
// literals would drift. In-section version stepper, per-kind bodies, and header actions remain component literals, matching the run detail
// page's other sections (workflow-run-questions etc.).
export const TID_WORKFLOW_ARTIFACTS_SECTION = "workflow-run-artifacts";
export const TID_WORKFLOW_ARTIFACTS_TOGGLE = "workflow-run-artifacts-toggle";
export const TID_WORKFLOW_ARTIFACT_CARD = "workflow-run-artifact-card";
/** Root of the workflow-artifact side-panel tab. */
export const TID_WORKFLOW_ARTIFACT_PANE = "workflow-artifact-pane";
/** Chip on the hub (run history row / detail page's recent artifacts). */
export const TID_WORKFLOW_ARTIFACT_CHIP = "workflow-run-artifact-chip";
/** Chip on the collapsed header of the session's terminal notice row--deliberately a different id from the hub's: */
// the payloads differ, and e2e must target "chips on the notice row" and "chips on the hub history row" separately.
export const TID_CHAT_WORKFLOW_ARTIFACT_CHIP = "workflow-notification-artifact-chip";
