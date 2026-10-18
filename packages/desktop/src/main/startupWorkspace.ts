import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import {
  appSettingsSchema,
  formatZodError,
  resolveStartupLocalWorkspaceSessionIndex,
  type WorkspacePurpose,
} from "@zcode/shared";

interface StartupWorkspaceLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

async function readStartupSettings(settingsFile: string, logger?: StartupWorkspaceLogger) {
  try {
    const raw = await readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    const result = appSettingsSchema.safeParse(parsed);

    if (!result.success) {
      logger?.warn?.(
        "[startup-workspace] invalid settings file, falling back to default workspace:",
        formatZodError(result.error),
      );
      return appSettingsSchema.parse({});
    }

    return result.data;
  } catch {
    return appSettingsSchema.parse({});
  }
}

export interface StartupWorkspaceWarmupTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

// Fix: session CLIs have no idle reclaim, so warming 3 would keep 3 agent process images
// resident per window; the cold-start gain on switching to a recent project cannot pay the
// resident cost. Converge on warming the active workspace only.
// Matches @zcode/protocol init-local `agentWarmupTargets.max(1)`.
export const STARTUP_AGENT_WARMUP_LIMIT = 1;

export interface StartupWindowBootstrap {
  restoreSession?: boolean;
  initialWorkspacePath?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  agentWarmupTargets?: StartupWorkspaceWarmupTarget[];
}

async function isAvailableWorkspaceDirectory(workspacePath: string): Promise<boolean> {
  try {
    const workspaceStat = await stat(workspacePath);
    if (!workspaceStat.isDirectory()) {
      return false;
    }
    await access(workspacePath, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePersistedActiveSession(
  sessions: NonNullable<ReturnType<typeof appSettingsSchema.parse>["lastWorkspaceSession"]>,
  lastActiveTabIndex: number | undefined,
) {
  if (sessions.length === 0) {
    return undefined;
  }
  const activeIndex = Math.min(Math.max(lastActiveTabIndex ?? 0, 0), sessions.length - 1);
  return sessions[activeIndex];
}

export function resolveStartupAgentWarmupTargets(
  settings: Pick<ReturnType<typeof appSettingsSchema.parse>, "recentProjects">,
  activeTarget: StartupWorkspaceWarmupTarget,
): StartupWorkspaceWarmupTarget[] {
  const candidates: StartupWorkspaceWarmupTarget[] = [
    activeTarget,
    ...(settings.recentProjects ?? []).map((workspacePath) => ({
      workspacePath,
    })),
  ];
  const seen = new Set<string>();
  const targets: StartupWorkspaceWarmupTarget[] = [];

  for (const candidate of candidates) {
    const workspaceKey = candidate.workspaceIdentity?.trim() || candidate.workspacePath;
    if (!workspaceKey || seen.has(workspaceKey)) {
      continue;
    }
    seen.add(workspaceKey);
    targets.push(candidate);
    if (targets.length === STARTUP_AGENT_WARMUP_LIMIT) {
      break;
    }
  }

  return targets;
}

export function createOpenWorkspaceStartupBootstrap(workspacePath: string): StartupWindowBootstrap {
  return {
    initialWorkspacePath: workspacePath,
    initialWorkspacePurpose: "project",
    agentWarmupTargets: [{ workspacePath }],
  };
}

export async function resolveStartupWindowBootstrap({
  settingsFile,
  conversationWorkspaceDir,
  logger,
}: {
  settingsFile: string;
  conversationWorkspaceDir: string;
  logger?: StartupWorkspaceLogger;
}): Promise<StartupWindowBootstrap> {
  const settings = await readStartupSettings(settingsFile, logger);
  const sessions = settings.lastWorkspaceSession ?? [];

  if (sessions.length > 0) {
    const persistedActiveSession = resolvePersistedActiveSession(
      sessions,
      settings.lastActiveTabIndex,
    );
    const unavailableWorkspacePath =
      persistedActiveSession?.kind === "local" &&
      !(await isAvailableWorkspaceDirectory(persistedActiveSession.workspacePath))
        ? persistedActiveSession.workspacePath
        : undefined;
    if (unavailableWorkspacePath) {
      // When the last-active workspace moved/was deleted, the agent keeps the original path for history,
      // but child cwd must exist; the conversation backing workspace is cwd fallback only.
      await mkdir(conversationWorkspaceDir, { recursive: true });
      logger?.warn?.(
        "[startup-workspace] active local workspace unavailable; using read-only restore:",
        unavailableWorkspacePath,
      );
    }
    const localActiveSessionIndex = resolveStartupLocalWorkspaceSessionIndex(
      sessions,
      settings.lastActiveTabIndex,
    );
    const activeSession =
      localActiveSessionIndex == null ? undefined : sessions[localActiveSessionIndex];
    if (activeSession?.kind === "local") {
      // Passive full restore from sessions-index must not start every workspace; Main pins the
      // single startup boundary to the active workspace only (STARTUP_AGENT_WARMUP_LIMIT), the
      // Host takes the normal initializeWorkspace path; recentProjects stay dormant and a failed
      // warmup never backfills from other workspaces.
      const agentWarmupTargets = resolveStartupAgentWarmupTargets(settings, {
        workspacePath: activeSession.workspacePath,
      });
      return {
        ...(unavailableWorkspacePath ? { unavailableWorkspacePath } : {}),
        agentWarmupTargets,
      };
    }
    return unavailableWorkspacePath ? { unavailableWorkspacePath } : {};
  }

  // The UI may have no project, but the agent always needs a real cwd. First start warms the
  // app-managed conversation backing workspace; no ZCodeProject that reads as a user project.
  await mkdir(conversationWorkspaceDir, { recursive: true });
  logger?.info?.("[startup-workspace] using conversation workspace:", conversationWorkspaceDir);
  return {
    initialWorkspacePath: conversationWorkspaceDir,
    initialWorkspacePurpose: "conversation",
    agentWarmupTargets: [{ workspacePath: conversationWorkspaceDir }],
  };
}

export async function resolveStartupWorkspacePath({
  settingsFile,
  conversationWorkspaceDir,
  logger,
}: {
  settingsFile: string;
  conversationWorkspaceDir: string;
  logger?: StartupWorkspaceLogger;
}): Promise<string | undefined> {
  return (
    await resolveStartupWindowBootstrap({
      settingsFile,
      conversationWorkspaceDir,
      logger,
    })
  ).initialWorkspacePath;
}
