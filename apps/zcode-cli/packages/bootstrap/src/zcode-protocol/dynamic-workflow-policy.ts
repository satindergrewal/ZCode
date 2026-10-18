import { zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * Dynamic-workflow rollout gate. The Host decides:
 * it reads `dynamicWorkflow.mode` from `/client/configs`; the CLI only caches the verdict, never reading the feature key
 * or local override env vars. Isomorphic to off-peak-tool-policy.ts: CLI processes are workspace-isolated,
 * so one cached value suffices, and createRecord reads it for legacy create/resume, v4 createSession, and v4 cold
 * restore (subscribe -> resumePersistedSession, no host parameter channel) alike.
 * Only records created/resumed afterwards are affected; live records keep their tool surface (matching mid-rollout flips).
 */
export async function updateDynamicWorkflowPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.dynamicWorkflowEnabled = params.enabled;
  return { workspace: params.workspace, enabled: params.enabled };
}
