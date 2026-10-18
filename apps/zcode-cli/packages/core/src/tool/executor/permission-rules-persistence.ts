// Permission-rule reads, persistence, and post-approval settling (split from permission-flow.ts).
// Reason: after permission-flow gained the responder race it crossed the 400-line file cap; these helpers cohere only with
// rule storage (project-level writes to sessionStore, session-level to the in-memory ruleset), not with ask ordering. When dialog settings
// pushed permission-flow toward the cap again, the rule updates in approval responses moved here too (behavior unchanged).
import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type PermissionRuleset,
  type PermissionUpdate,
  type ProjectId,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall, ToolExecutionResult } from "../types.js";
import { createErrorResult } from "./errors.js";
import { applyPermissionUpdates } from "./permission-rules.js";
import type { ToolExecutorDeps } from "./types.js";

export async function loadProjectPermissionRuleset(
  deps: ToolExecutorDeps,
): Promise<PermissionRuleset | null> {
  if (!deps.sessionStore) return null;
  const session = await deps.sessionStore.getSession(deps.sessionId);
  if (session?.permission?.scope === "session") return session.permission;
  if (!session?.projectID) return null;
  return deps.sessionStore.getProjectPermission(session.projectID);
}

export async function persistProjectPermissionUpdates(
  deps: ToolExecutorDeps,
  updates: PermissionUpdate[],
  traceContext: TraceContext,
): Promise<void> {
  if (updates.length === 0) return;

  if (!deps.sessionStore) {
    deps.logger?.warn("Project permission update skipped without session store", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.project_update.skipped",
      module: "core.tool.executor",
      status: "completed",
    });
    return;
  }

  const session = await deps.sessionStore.getSession(deps.sessionId);
  if (session?.permission?.scope === "session") {
    await deps.sessionStore.updateSession({
      id: deps.sessionId,
      permission: applyPermissionUpdates(session.permission, updates),
    });
    return;
  }
  const projectID = await resolveProjectId(deps);
  if (!projectID) {
    deps.logger?.warn("Project permission update skipped without persisted session", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.project_update.skipped",
      module: "core.tool.executor",
      status: "completed",
    });
    return;
  }

  const current = (await deps.sessionStore.getProjectPermission(projectID)) ?? { version: 1 };
  const next = applyPermissionUpdates(current, updates);
  await deps.sessionStore.saveProjectPermission({ projectID, permission: next });

  deps.logger?.info("Project permission updated", {
    ...traceContextToLogContext(traceContext),
    event: "tool.permission.project_update.saved",
    module: "core.tool.executor",
    status: "completed",
    updateCount: updates.length,
  });
}

/**
 * Rule updates inside an approval response: write project-level rules to disk first, then session-level rules into the in-memory ruleset. A write failure returns a tool failure
 * result (the chosen always-allow was not remembered — never a silent no-op) and session-level rules are skipped too.
 */
export async function applyGrantedPermissionUpdates(options: {
  deps: ToolExecutorDeps;
  permissionUpdates: PermissionUpdate[] | undefined;
  requestId: string;
  sessionPermissionUpdates: PermissionUpdate[] | undefined;
  toolCall: ExecutableToolCall;
  traceContext: TraceContext;
}): Promise<ToolExecutionResult | undefined> {
  const { deps, permissionUpdates, requestId, sessionPermissionUpdates, toolCall, traceContext } =
    options;
  if (permissionUpdates?.length) {
    try {
      await persistProjectPermissionUpdates(deps, permissionUpdates, traceContext);
    } catch (error) {
      return createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to persist project permission update", {
          cause: error instanceof Error ? error : undefined,
          context: {
            requestId,
            sessionId: deps.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          },
          recoverable: true,
        }),
      );
    }
  }

  if (sessionPermissionUpdates?.length) {
    // Session-level always-allow (docs/dynamic-workflow/launch.md "Always allow in this session"): into the in-memory session ruleset only,
    // invisible to the project-level persistence above and vice versa.
    deps.permissionService.grantSessionPermission(sessionPermissionUpdates);
    deps.logger?.info("Session permission granted", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.session_grant.applied",
      module: "core.tool.executor",
      requestId,
      status: "completed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      updateCount: sessionPermissionUpdates.length,
    });
  }
  return undefined;
}

async function resolveProjectId(deps: ToolExecutorDeps): Promise<ProjectId | undefined> {
  const session = await deps.sessionStore?.getSession(deps.sessionId);
  return session?.projectID;
}
