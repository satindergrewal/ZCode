import type {
  ZCodeSavedWorkflowMeta,
  ZCodeSavedWorkflowScope,
  ZCodeWorkflowsForRunCandidate,
} from "@zcode/shared";
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgentPluginParams.js";

// GUI hub for saved workflows: five workspace-scoped, session-less methods.
// Same path as the skill catalog (workspace agent client) - no dedicated plugin process; files
// live in the workspace, so remote workspaces scan remote dirs in the remote agent process.
//
// Global workflows: with scope "global" files land in ~/.zcode/workflows/ on the agent machine.
// Callers may omit workspace: the services layer then picks a carrier runtime (active local
// runtime -> the management workspace); protocol handlers do not read workspace paths for global.
// Project-scoped actions carry their own workspace (target and carrier), hence the union:
// either workspace set (scope optional, project default) or bare scope "global".
export type ZCodeAgentSavedWorkflowTarget =
  | (ZCodeAgentWorkspaceTarget & { scope?: ZCodeSavedWorkflowScope })
  | ({ scope: "global" } & Partial<ZCodeAgentWorkspaceTarget>);

export type ZCodeAgentListSavedWorkflowsParams = ZCodeAgentSavedWorkflowTarget;

export type ZCodeAgentGetSavedWorkflowParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
};

export type ZCodeAgentUpdateSavedWorkflowMetaParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
  meta: ZCodeSavedWorkflowMeta;
};

export type ZCodeAgentDeleteSavedWorkflowParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
};

export type ZCodeAgentListSavedWorkflowRunsParams = ZCodeAgentSavedWorkflowTarget & {
  /** Only runs of this workflow name; default is all within the scope. */
  name?: string;
  /** [1, 50]; clamped server-side. */
  limit: number;
};

// workflows/move moves a global file back into a project; the one direction only.
// workspace is required as both carrier and the chosen target project; same machine/user,
// never overwriting an existing target.
export type ZCodeAgentMoveSavedWorkflowParams = ZCodeAgentWorkspaceTarget & {
  name: string;
};

// 完成卡的「直接保存」与「已保存」判定（docs/dynamic-workflow/transcript-and-notifications.md
// 「Saving the run, and running it again」）。两者都**必带 workspace**，全局档也不例外：要存的
// 脚本在那个 agent 的 journal 里，载体不能由 services 另选一个本机运行时。
export type ZCodeAgentSaveSavedWorkflowFromRunParams = ZCodeAgentWorkspaceTarget & {
  /** 要保存的那次 run；脚本取它实际执行的那一份。 */
  runId: string;
  name: string;
  meta: ZCodeSavedWorkflowMeta;
  /** 缺省 `project`。 */
  scope?: ZCodeSavedWorkflowScope;
  /** 只有在已经把覆盖警告摆给用户看过之后才传 true。 */
  overwrite?: boolean;
};

export type ZCodeAgentFindSavedWorkflowForRunParams = ZCodeAgentWorkspaceTarget & {
  runId: string;
  /** 转写自对话的候选（模型存过并认领了这次 run）；最多 8 个，由 agent 再解析一遍。 */
  candidates?: readonly ZCodeWorkflowsForRunCandidate[];
};
