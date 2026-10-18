import { zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * The Off-Peak tool-surface gate (graduation active && local workspace) is workspace-level state. CLI processes are
 * workspace-isolated, so one cached value suffices; createRecord reads it for legacy create/resume, v4 createSession, and v4 cold
 * restore (subscribe -> resumePersistedSession, which has no host parameter channel) alike.
 * Only records created/resumed afterwards are affected; live records keep their tool surface (matching mid-rollout flips).
 */
export async function updateOffPeakToolPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.offPeakToolEnabled = params.enabled;
  return { workspace: params.workspace, enabled: params.enabled };
}
