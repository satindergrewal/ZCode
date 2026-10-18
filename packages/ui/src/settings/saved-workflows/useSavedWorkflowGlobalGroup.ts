// State and actions for the global workflows group. Hook extraction keeps the component file under
// max-lines 400; the carrier is useServices().zcodeAgentService and every RPC carries scope global.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeSavedWorkflowEntry, ZCodeSavedWorkflowRun } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { useSavedWorkflowsDirectoryWatch } from "@/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.js";
import {
  buildSavedWorkflowCreatePrompt,
  buildSavedWorkflowRevisePrompt,
} from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import {
  useSavedWorkflowLauncher,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import { lastRunByWorkflowName } from "@/settings/saved-workflows/savedWorkflowRunHistory.js";
import {
  GLOBAL_SAVED_WORKFLOW_TARGET,
  buildGlobalRunProjectResolver,
  findProjectByCwd,
  resolveGlobalActionTarget,
} from "@/settings/saved-workflows/globalWorkflowGroupHelpers.js";
import type { SavedWorkflowGroupMode } from "@/settings/saved-workflows/SavedWorkflowProjectGroup.js";
import { useSavedWorkflowRunOpeners } from "@/settings/saved-workflows/useSavedWorkflowRunOpeners.js";
import type {
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";
import { selectSavedWorkflowState, useSavedWorkflowStore } from "@/store/savedWorkflowStore.js";

interface UseSavedWorkflowGlobalGroupParams {
  refreshSeq: number;
  mode: SavedWorkflowGroupMode;
  onStateChange: (key: "global", state: { loaded: boolean; empty: boolean; count: number }) => void;
  onOpenDetail: (name: string) => void;
  onBack: () => void;
  /** Run = direct GUI launch: switches to the new session once accepted. */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** Artifact chip -> the workflow-artifact tab. */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  localProjects: readonly AutomationWorkspaceOption[];
  activeProjectKey: string | null;
  onMoved: () => void;
}

export function useSavedWorkflowGlobalGroup({
  refreshSeq,
  mode,
  onStateChange,
  onOpenDetail,
  onBack,
  onNavigateToLaunchedRun,
  onCreateViaChat,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  localProjects,
  activeProjectKey,
  onMoved,
}: UseSavedWorkflowGlobalGroupParams) {
  const { intl, locale } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const { zcodeAgentService: agentService, fileWatcherService } = useServices();

  const state = useSavedWorkflowStore((store) =>
    selectSavedWorkflowState(store, GLOBAL_SAVED_WORKFLOW_TARGET),
  );
  const load = useSavedWorkflowStore((store) => store.load);
  const [launchEntry, setLaunchEntry] = useState<ZCodeSavedWorkflowEntry | null>(null);
  const [moveEntry, setMoveEntry] = useState<ZCodeSavedWorkflowEntry | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(
    async (options: { bypassCache?: boolean } = {}) => {
      await load(GLOBAL_SAVED_WORKFLOW_TARGET, agentService, options);
      setNow(Date.now());
    },
    [agentService, load],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const lastRefreshSeq = useRef(refreshSeq);
  useEffect(() => {
    if (lastRefreshSeq.current === refreshSeq) return;
    lastRefreshSeq.current = refreshSeq;
    void refresh({ bypassCache: true });
  }, [refresh, refreshSeq]);

  // Directory watch: the absolute dir returned by list (~/.zcode/workflows) is watchable locally.
  useSavedWorkflowsDirectoryWatch({
    fileWatcherService,
    directory: state.dir,
    enabled: true,
    refresh,
  });

  const empty = state.loaded && state.entries.length === 0 && state.invalid.length === 0;
  const count = state.loaded ? state.entries.length : 0;
  useEffect(() => {
    onStateChange("global", { loaded: state.loaded, empty, count });
  }, [count, empty, onStateChange, state.loaded]);

  const lastRuns = useMemo(() => lastRunByWorkflowName(state.runs), [state.runs]);
  const resolveRunProject = useMemo(
    () => buildGlobalRunProjectResolver(localProjects),
    [localProjects],
  );
  const actionTarget = useMemo(
    () => resolveGlobalActionTarget(localProjects, activeProjectKey),
    [activeProjectKey, localProjects],
  );

  // Direct GUI launcher: global carrier = the local base agent service; target = the local project chosen in run-on.
  const launcher = useSavedWorkflowLauncher({
    agentService,
    onNavigate: onNavigateToLaunchedRun,
  });

  // Global workflows always open the dialog - even without args, the run-on selector is required.
  const handleRun = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      launcher.clearError();
      setLaunchEntry(entry);
    },
    [launcher],
  );
  const launch = useCallback(
    async (
      entry: ZCodeSavedWorkflowEntry,
      args: Record<string, unknown>,
      target?: AutomationWorkspaceOption,
    ) => {
      if (!target) return;
      const result = await launcher.launch(
        {
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        },
        { name: entry.name, scope: "global", args },
      );
      // Success: the launcher switched already; close the dialog. Failure keeps it open with the inline error (launcher.error).
      if (result.ok) setLaunchEntry(null);
    },
    [launcher],
  );
  const handleRevise = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      if (!actionTarget) return;
      onCreateViaChat?.(
        buildSavedWorkflowRevisePrompt({
          name: entry.name,
          path: entry.path,
          locale,
          scope: "global",
        }),
        actionTarget,
      );
    },
    [actionTarget, locale, onCreateViaChat],
  );
  const handleCreateViaChat = useCallback(() => {
    if (!actionTarget) return;
    onCreateViaChat?.(buildSavedWorkflowCreatePrompt(locale, "global"), actionTarget);
  }, [actionTarget, locale, onCreateViaChat]);
  const handleCopyPath = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      void navigator.clipboard
        ?.writeText(entry.path)
        .then(() => toast(intl.formatMessage({ id: "workflows.hub.copied" })))
        .catch((error: unknown) => {
          logger.warn("[SavedWorkflows] copy path failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [intl],
  );
  const handleDelete = useCallback(
    async (entry: ZCodeSavedWorkflowEntry) => {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage({ id: "workflows.hub.delete.title" }, { name: entry.name }),
        description: intl.formatMessage(
          { id: "workflows.hub.delete.description" },
          { path: entry.path },
        ),
        confirmLabel: intl.formatMessage({ id: "workflows.hub.delete.confirm" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      setBusyName(entry.name);
      try {
        const result = await agentService.deleteSavedWorkflow({
          scope: "global",
          name: entry.name,
        });
        if (!result.ok) {
          toast(
            intl.formatMessage(
              { id: "workflows.hub.deleteFailed" },
              { reason: intl.formatMessage({ id: `workflows.hub.reason.${result.reason}` }) },
            ),
          );
          return;
        }
        toast(intl.formatMessage({ id: "workflows.hub.deleted" }, { name: entry.name }));
        if (mode.kind === "detail" && mode.name === entry.name) onBack();
      } catch (error) {
        toast(
          intl.formatMessage(
            { id: "workflows.hub.deleteFailed" },
            { reason: error instanceof Error ? error.message : String(error) },
          ),
        );
      } finally {
        setBusyName(null);
        void refresh({ bypassCache: true });
      }
    },
    [agentService, intl, mode, onBack, refresh, requestConfirmation],
  );
  const handleCardDelete = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => void handleDelete(entry),
    [handleDelete],
  );
  const handleCardMove = useCallback((entry: ZCodeSavedWorkflowEntry) => setMoveEntry(entry), []);
  const handleOpen = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => onOpenDetail(entry.name),
    [onOpenDetail],
  );
  // Global runs resolve their target project by reverse-looking up run.cwd among open projects;
  // with no match both entries close (an instance must open in its originating project). Gates and
  // args builders are shared with the project group (artifacts need no toolCallId).
  const resolveRunTarget = useCallback(
    (run: ZCodeSavedWorkflowRun) => findProjectByCwd(localProjects, run.cwd) ?? null,
    [localProjects],
  );
  const { handleOpenArtifact, handleOpenRun } = useSavedWorkflowRunOpeners({
    resolveTarget: resolveRunTarget,
    ...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun }),
    ...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact }),
  });

  const handleMoveSubmit = useCallback(
    async (target: AutomationWorkspaceOption) => {
      const entry = moveEntry;
      if (!entry) return;
      setBusyName(entry.name);
      try {
        const result = await agentService.moveSavedWorkflow({
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          name: entry.name,
        });
        if (result.ok) {
          toast(
            intl.formatMessage(
              { id: "workflows.hub.move.toast.project" },
              { project: target.label },
            ),
          );
          setMoveEntry(null);
          if (mode.kind === "detail" && mode.name === entry.name) onBack();
          onMoved();
          return;
        }
        toast(
          intl.formatMessage(
            {
              id:
                result.reason === "target_exists"
                  ? "workflows.hub.move.targetExists"
                  : "workflows.hub.move.failed",
            },
            { reason: result.reason },
          ),
        );
      } catch (error) {
        toast(
          intl.formatMessage(
            { id: "workflows.hub.move.failed" },
            { reason: error instanceof Error ? error.message : String(error) },
          ),
        );
      } finally {
        setBusyName(null);
      }
    },
    [agentService, intl, mode, moveEntry, onBack, onMoved],
  );

  return {
    agentService,
    state,
    now,
    busyName,
    launchEntry,
    launchPending: launcher.pending,
    launchError: launcher.error,
    moveEntry,
    actionTarget,
    lastRuns,
    resolveRunProject,
    refresh,
    setLaunchEntry,
    setMoveEntry,
    handleRun,
    launch,
    handleRevise,
    handleCreateViaChat,
    handleCopyPath,
    handleDelete,
    handleCardDelete,
    handleCardMove,
    handleOpen,
    handleOpenRun,
    handleOpenArtifact,
    handleMoveSubmit,
  };
}
