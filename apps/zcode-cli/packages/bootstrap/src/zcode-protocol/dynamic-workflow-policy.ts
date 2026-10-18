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
  // mode 只在开启时有意义；关闭时清掉，免得下次开启（只发布尔的旧 Host）沿用过期的 onDemand。
  context.appRuntimePreferences.dynamicWorkflowMode = params.enabled ? params.mode : undefined;
  return { workspace: params.workspace, enabled: params.enabled };
}

/** createRecord 写进 runtimeConfig 的两个灰度字段（launch.md「On demand: activation」「How the mode travels」）。 */
export interface DynamicWorkflowRuntimeGate {
  dynamicWorkflowEnabled: boolean;
  dynamicWorkflowToolsOnDemand: boolean;
}

/**
 * 本次 create / resume 参数优先，缺席时读 Host 同步到进程的 workspace 级结论；两者都没有就是关闭
 * （fail-closed）。mode 同序取值，都缺席时按 alwaysOn——只发布尔的旧 Host 配对成今天的行为。
 * 两个字段**必须写出显式布尔**：core 把「缺席」定义为「不参与灰度、立刻注册全部工具」
 * （TUI / headless / workflow_child 的语义），受信 Host 创建的会话不能落进那条豁免。
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
