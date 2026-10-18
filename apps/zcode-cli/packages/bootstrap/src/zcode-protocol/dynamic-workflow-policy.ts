import {
  zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema,
  type DynamicWorkflowMode,
} from "@zcode/shared";
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
  // mode matters only when enabled; clear it when off, so a re-enable (legacy Boolean-only hosts) never inherits a stale onDemand.
  context.appRuntimePreferences.dynamicWorkflowMode = params.enabled ? params.mode : undefined;
  return { workspace: params.workspace, enabled: params.enabled };
}

/** The two gradation fields createRecord writes into runtimeConfig (launch.md "On demand: activation", "How the mode travels"). */
export interface DynamicWorkflowRuntimeGate {
  dynamicWorkflowEnabled: boolean;
  dynamicWorkflowToolsOnDemand: boolean;
}

/**
 * This create/resume call wins; absent, the Host's process-synced workspace-level verdict; neither means off
 // (fail-closed). mode reads in the same order, defaulting to alwaysOn when both absent — pairing legacy Boolean-only hosts with today's behavior.
 * Both fields **must be written as explicit booleans**: core defines absent as "not part of the gradation, register all tools now"
 // (the TUI / headless / workflow_child semantics); trusted-host sessions must not fall into that exemption.
 */
export function resolveDynamicWorkflowRuntimeGate(
  params: { dynamicWorkflowEnabled?: boolean; dynamicWorkflowMode?: DynamicWorkflowMode },
  preferences: { dynamicWorkflowEnabled: boolean; dynamicWorkflowMode?: DynamicWorkflowMode },
): DynamicWorkflowRuntimeGate {
  const enabled = params.dynamicWorkflowEnabled === true || preferences.dynamicWorkflowEnabled;
  if (!enabled) return { dynamicWorkflowEnabled: false, dynamicWorkflowToolsOnDemand: false };
  const mode = params.dynamicWorkflowMode ?? preferences.dynamicWorkflowMode ?? "alwaysOn";
  return { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: mode === "onDemand" };
}
