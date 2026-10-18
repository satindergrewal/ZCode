// Shared save/run-again controller for the completion card and run side pane (docs/dynamic-workflow/transcript-and-notifications.md,
// 「Saving the run, and running it again」）。
//
// One hook, not two wirings: card and side pane must read and act identically. It owns
//   1. which saved workflow the run used (derived, cached in workflowRunSavedStore);
//   2. save now = workflows/save (script by runId, no model turn);
//   3. run again = the hub launcher (useSavedWorkflowLauncher) with this run's args.
// Let-ZCode-summarize is not here: it hands a user message to the host sender
// (card in-session, side pane in the parent); each host has its own send path.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowMeta,
  type ZCodeSavedWorkflowScope,
  type ZCodeWorkflowsForRunCandidate,
  type ZCodeWorkflowsSaveResult,
} from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import {
  selectWorkflowRunSavedState,
  useWorkflowRunSavedStore,
  workflowRunSavedKey,
  type WorkflowRunSavedState,
} from "@/store/workflowRunSavedStore.js";
import {
  useSavedWorkflowLauncher,
  type SavedWorkflowLaunchError,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

export interface WorkflowRunSaveTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface WorkflowRunSaveHost extends WorkflowRunSaveTarget {
  runId: string;
  /** Candidates transcribed from the conversation (buildWorkflowSaveCandidatesByRunId). */
  candidates?: readonly ZCodeWorkflowsForRunCandidate[];
  /** Navigate to the new session on success; absent = host never navigates. */
  onNavigateToRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}

export interface WorkflowRunSaveSubmit {
  name: string;
  scope: ZCodeSavedWorkflowScope;
  meta: ZCodeSavedWorkflowMeta;
  overwrite?: boolean;
}

export interface WorkflowRunSaveController {
  /** The run's saved workflow (derived); undefined = not yet resolved. */
  saved: WorkflowRunSavedState | undefined;
  /** The saved entry; absent = none. */
  entry: ZCodeSavedWorkflowEntry | undefined;
  /** Args this run used, prefilling the run-again dialog. */
  runArgs: Record<string, unknown> | undefined;
  /** Old agents lack workflows/save: the dialog keeps only the ZCode path. */
  directSaveUnsupported: boolean;
  /** Remote projects skip the global slot: ~ lives on the agent host; the hub never reads it. */
  scopeLocked: boolean;
  saving: boolean;
  save: (input: WorkflowRunSaveSubmit) => Promise<ZCodeWorkflowsSaveResult>;
  /** Name taken? (pre-check while typing); on failure assume free, the agent decides. */
  checkNameTaken: (name: string, scope: ZCodeSavedWorkflowScope) => Promise<boolean>;
  launching: boolean;
  launchError: SavedWorkflowLaunchError | null;
  clearLaunchError: () => void;
  /** Run again: launch by entry; defaults to this run's args. */
  launch: (
    entry: ZCodeSavedWorkflowEntry,
    args: Record<string, unknown>,
    target?: WorkflowRunSaveTarget,
  ) => Promise<{ ok: true } | { ok: false; error: SavedWorkflowLaunchError }>;
}

export function useWorkflowRunSave(host: WorkflowRunSaveHost): WorkflowRunSaveController {
  const { candidates, runId, onNavigateToRun } = host;
  const resolution = useWorkspaceServicesResolution(
    host.workspacePath,
    host.remoteSessionId ?? null,
    host.workspaceIdentity,
  );
  const { rpcReady, services } = resolution;
  const agentService = services.zcodeAgentService;
  const isRemote = resolution.isRemoteTarget;

  const target = useMemo<WorkflowRunSaveTarget>(
    () => ({
      workspacePath: host.workspacePath,
      ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
      ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
    }),
    [host.workspacePath, host.workspaceIdentity, resolution.remoteSessionId],
  );
  const workspaceKey = useMemo(
    () =>
      resolveWorkspaceKey({
        workspacePath: host.workspacePath,
        ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
      }),
    [host.workspacePath, host.workspaceIdentity],
  );
  const key = useMemo(
    () => workflowRunSavedKey(workspaceKey, runId, candidates),
    [candidates, runId, workspaceKey],
  );

  const generation = useWorkflowRunSavedStore((state) => state.generation);
  const load = useWorkflowRunSavedStore((state) => state.load);
  const applySaved = useWorkflowRunSavedStore((state) => state.applySaved);
  const saved = useWorkflowRunSavedStore((state) => selectWorkflowRunSavedState(state, key));

  useEffect(() => {
    if (!rpcReady) return;
    // generation in deps: one invalidation requeries every card (save/delete/hub refresh).
    void generation;
    void load(key, () =>
      agentService.findSavedWorkflowForRun({
        ...target,
        runId,
        ...(candidates === undefined || candidates.length === 0 ? {} : { candidates }),
      }),
    );
  }, [agentService, candidates, generation, key, load, rpcReady, runId, target]);

  const [saving, setSaving] = useState(false);
  const save = useCallback(
    async (input: WorkflowRunSaveSubmit) => {
      setSaving(true);
      try {
        const result = await agentService.saveSavedWorkflowFromRun({
          ...target,
          runId,
          name: input.name,
          meta: input.meta,
          scope: input.scope,
          ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
        });
        if (result.ok) {
          // Surface the just-written entry (card flips to saved/run-again); invalidate the rest.
          applySaved(key, {
            name: result.name,
            description: input.meta.description,
            ...(input.meta.whenToUse === undefined ? {} : { whenToUse: input.meta.whenToUse }),
            ...(input.meta.args === undefined ? {} : { args: input.meta.args }),
            scope: result.scope,
            path: result.path,
          });
        }
        return result;
      } finally {
        setSaving(false);
      }
    },
    [agentService, applySaved, key, runId, target],
  );

  const checkNameTaken = useCallback(
    async (name: string, scope: ZCodeSavedWorkflowScope) => {
      try {
        const result = await agentService.getSavedWorkflow({ ...target, name, scope });
        return result.ok;
      } catch {
        // A failed probe never blocks saving; the agent still answers target_exists.
        return false;
      }
    },
    [agentService, target],
  );

  const launcher = useSavedWorkflowLauncher({
    agentService,
    ...(onNavigateToRun === undefined ? {} : { onNavigate: onNavigateToRun }),
  });
  const launch = useCallback(
    async (
      entry: ZCodeSavedWorkflowEntry,
      args: Record<string, unknown>,
      launchTarget?: WorkflowRunSaveTarget,
    ) => {
      const destination = launchTarget ?? target;
      const result = await launcher.launch(
        {
          workspacePath: destination.workspacePath,
          ...(destination.workspaceIdentity
            ? { workspaceIdentity: destination.workspaceIdentity }
            : {}),
          ...(destination.remoteSessionId ? { remoteSessionId: destination.remoteSessionId } : {}),
        },
        { name: entry.name, scope: entry.scope, args },
      );
      return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
    },
    [launcher, target],
  );

  return {
    saved,
    entry: saved?.entry,
    runArgs: saved?.runArgs,
    directSaveUnsupported: saved?.status === "unsupported",
    scopeLocked: isRemote,
    saving,
    save,
    checkNameTaken,
    launching: launcher.pending,
    launchError: launcher.error,
    clearLaunchError: launcher.clearError,
    launch,
  };
}
