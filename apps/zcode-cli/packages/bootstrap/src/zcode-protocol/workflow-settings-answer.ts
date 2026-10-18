// ============================================================
// Settings adjustments in the workflow confirm-dialog answer -> the broker result's inputAdjustments
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」。
//
// Split from interaction-broker.ts (max-lines gate): one job — on the CreateWorkflow / AmendWorkflow
// **allow** response, read the v4 answer's content, fold it into those two fields by the contract schema, and hand to the executor.

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  parseWorkflowSettingsAdjustment,
} from "@zcode/contracts";
import type { V4InteractionAnswer } from "../zcode-protocol-v4/interaction-registry.js";

/**
 // Only the two tools' allow responses count. A rejection (Refine included) never carries adjustments: settings belong to the run the Allow starts,
 // and a rejection starts nothing. Unknown keys drop; a malformed content voids the whole thing — not a grant (the bound only lowers,
 // and models re-resolve via the catalog); voiding just means run with the pre-dialog input.
 */
export function withWorkflowSettingsAdjustment<T extends { decision: string }>(
  response: T,
  answer: V4InteractionAnswer,
  toolName: string,
): T & { inputAdjustments?: Readonly<Record<string, unknown>> } {
  if (toolName !== CREATE_WORKFLOW_TOOL_NAME && toolName !== AMEND_WORKFLOW_TOOL_NAME) {
    return response;
  }
  if (response.decision !== "allow" || answer.content === undefined) return response;
  const adjustment = parseWorkflowSettingsAdjustment(answer.content);
  return adjustment === undefined ? response : { ...response, inputAdjustments: adjustment };
}
