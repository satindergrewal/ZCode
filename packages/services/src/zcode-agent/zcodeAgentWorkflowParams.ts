import type { ZCodeSavedWorkflowMeta, ZCodeSavedWorkflowScope } from "@zcode/shared";
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
