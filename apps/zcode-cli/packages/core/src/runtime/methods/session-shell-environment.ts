import { countContextPrefixMessages } from "../deps.js";
import type { EnvInfo, ExecutionShellSelection, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  persistBashShellSelectionSnapshot,
  readPersistedBashShellSelectionSnapshot,
  resolveBashShellSnapshotForResume,
  type BashShellSnapshotRestore,
} from "./bash-shell-snapshot.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import {
  buildShellEnvironmentResumeNotice,
  getShellEnvironmentResumeNoticeKind,
} from "./shell-environment.js";
import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";

type SessionShellConfig = Pick<AgentRuntimeConfig, "bashShellSelection">;

export type SessionShellEnvironmentCandidate =
  | ExecutionShellSelection
  | (() => ExecutionShellSelection);

interface SessionShellEnvironment {
  selection: ExecutionShellSelection;
  promptShell: string;
}

export function getSessionShellSelectionFromConfig(
  config: SessionShellConfig,
): ExecutionShellSelection | undefined {
  return config.bashShellSelection;
}

export function getSessionShellEnvironment(
  runtime: AgentRuntimeInternal,
): SessionShellEnvironment | undefined {
  const selection = getSessionShellSelectionFromConfig(runtime.config);
  if (!selection) return undefined;
  return {
    promptShell: selection.display.name,
    selection,
  };
}

export function getSessionShellSelection(
  runtime: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return getSessionShellEnvironment(runtime)?.selection;
}

export function getContextSourceShellDisplayName(
  runtime: AgentRuntimeInternal,
): string | undefined {
  return getSessionShellEnvironment(runtime)?.promptShell;
}

export function initializeSessionShellEnvironmentIfNeeded(
  runtime: AgentRuntimeInternal,
  candidate: SessionShellEnvironmentCandidate,
): boolean {
  if (getSessionShellEnvironment(runtime)) {
    return false;
  }

  // The Bash shell is a session-start snapshot; entrances express a candidate only,
  // initialized once by the runtime before the first real execution. A candidate may lazy-resolve,
  // so snapshotted sessions never re-probe upstream.
  applySessionShellEnvironment(runtime, resolveSessionShellCandidate(candidate), {
    refreshPreConversationContext: true,
  });
  return true;
}

function applySessionShellEnvironment(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
  options: { refreshPreConversationContext?: boolean } = {},
): void {
  runtime.config.bashShellSelection = selection;
  refreshBranchAwareBuiltInTools(runtime);

  if (options.refreshPreConversationContext !== false) {
    refreshPreConversationShellContext(runtime, selection);
  }
}

function resolveSessionShellCandidate(
  candidate: SessionShellEnvironmentCandidate,
): ExecutionShellSelection {
  return typeof candidate === "function" ? candidate() : candidate;
}

function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T,
  selection: ExecutionShellSelection | undefined,
): T;
function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined;
function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined {
  if (!envInfo || !selection?.display.name) {
    return envInfo;
  }
  return {
    ...envInfo,
    shell: selection.display.name,
  };
}

export async function persistSessionShellEnvironmentSnapshot(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  await persistBashShellSelectionSnapshot({
    logger: runtime.logger,
    selection: getSessionShellSelection(runtime),
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    traceContext,
  });
}

export async function restoreSessionShellEnvironmentSelectionForResume(
  runtime: AgentRuntimeInternal,
  options: {
    currentSelection: ExecutionShellSelection | undefined;
    traceContext: TraceContext;
  },
): Promise<BashShellSnapshotRestore> {
  const restore = resolveBashShellSnapshotForResume({
    currentSelection: options.currentSelection,
    logger: runtime.logger,
    restore: await readPersistedBashShellSelectionSnapshot({
      logger: runtime.logger,
      sessionId: runtime.sessionId,
      sessionStore: runtime.sessionStore,
      traceContext: options.traceContext,
    }),
    traceContext: options.traceContext,
  });

  if (restore.status === "restored" || restore.status === "fallback") {
    applySessionShellEnvironment(runtime, restore.selection, {
      refreshPreConversationContext: false,
    });
  }

  return restore;
}

export function announceSessionShellEnvironmentNoticeAfterResume(
  runtime: AgentRuntimeInternal,
  options: {
    persistedEnvInfo: EnvInfo | undefined;
    restore: BashShellSnapshotRestore;
  },
): void {
  const selection = getSessionShellSelection(runtime);
  const noticeKind = getShellEnvironmentResumeNoticeKind({
    persistedShell: options.persistedEnvInfo?.shell,
    restoreStatus: options.restore.status,
    selection,
  });
  if (!selection || !noticeKind) {
    return;
  }

  const notice = buildShellEnvironmentResumeNotice(noticeKind, selection);
  if (hasShellEnvironmentChangeAttachment(runtime, notice)) {
    return;
  }

  // Legacy Windows sessions without a usable snapshot may fall under auto Git Bash
  // after upgrade; history can still pull the model to old shell habits, so a
  // provider-visible shell reminder follows resume; with a usable snapshot, none, keeping
  // the shell-changes-apply-to-new-sessions-only contract.
  runtime.messageHistory.addAttachment("shell_environment_change", notice);
}

function hasShellEnvironmentChangeAttachment(
  runtime: AgentRuntimeInternal,
  content: string,
): boolean {
  return runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .some(
      (entry) =>
        entry.kind === "attachment" &&
        entry.metadata?.source === "shell_environment_change" &&
        entry.content === content,
    );
}

function refreshPreConversationShellContext(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
): void {
  if (
    !selection ||
    !runtime.contextBuilder ||
    !runtime.contextInitialized ||
    !runtime.contextSourceSnapshot ||
    runtime.sessionPersisted
  ) {
    return;
  }
  const activeEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  if (activeEntries.length !== countContextPrefixMessages(activeEntries)) {
    return;
  }

  // A deferred draft is hidden warmup: at first-send refresh there is no real
  // conversation message; refresh the session-start # Environment block too,
  // or the model Shell and the Bash-executing shell diverge.
  runtime.config.envInfo = applySessionShellToEnvInfo(runtime.config.envInfo, selection);
  runtime.contextSourceSnapshot = {
    ...runtime.contextSourceSnapshot,
    envInfo: applySessionShellToEnvInfo(runtime.contextSourceSnapshot.envInfo, selection),
  };
  rebuildContextPrefix(runtime);
}
