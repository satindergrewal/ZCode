import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus, Settings2 } from "lucide-react";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_EMPTY,
  TID_WORKFLOWS_OPEN_SETTINGS,
  TID_WORKFLOWS_REFRESH,
  isDynamicWorkflowOffered,
  resolveWorkspaceKey,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import {
  buildAutomationWorkspaceOptions,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import { AutomationRefreshIcon } from "@/settings/AutomationDesignPrimitives.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { buildSavedWorkflowCreatePrompt } from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import { SavedWorkflowProjectGroup } from "@/settings/saved-workflows/SavedWorkflowProjectGroup.js";
import { SavedWorkflowGlobalGroup } from "@/settings/saved-workflows/SavedWorkflowGlobalGroup.js";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import type {
  SavedWorkflowGroupState,
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

export type {
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
  SavedWorkflowLaunchTarget,
};

/** Deep-link target: project by default (missing scope for legacy callers) or global (no workspaceKey). */
export type SavedWorkflowsOpenTarget =
  | { scope?: "project"; workspaceKey: string; name: string }
  | { scope: "global"; name: string };

interface SavedWorkflowsSectionProps {
  /** Page header (title swap + subtitle); list state only - the detail page owns the full screen, same as the schedule editor. */
  header?: ReactNode;
  /** Active workspace: only for the Current marker and as the global empty-state creation target. */
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** Run = direct GUI launch: switches to the new session once accepted. */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  /** Create/revise via chat: prefills the draft, never sends; target = owning project (empty-state card uses the active project). */
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  /** Run history view-instance: switch to the originating session and open the instance detail page. */
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** Artifact chip -> the workflow-artifact tab. */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  /** Deep links land directly on the detail page; the caller clears after focus. project needs workspaceKey, global only name. */
  openWorkflow?: SavedWorkflowsOpenTarget | null;
  onOpenWorkflowConsumed?: () => void;
}

type SavedWorkflowsView =
  | { mode: "list" }
  | { mode: "detail"; scope: "project"; workspaceKey: string; name: string }
  | { mode: "detail"; scope: "global"; name: string };

/** The global group's readiness uses the fixed key "global", sharing one table with project workspaceKeys. */
const GLOBAL_READINESS_KEY = "global";

function resolveOptionKey(option: AutomationWorkspaceOption): string {
  return resolveWorkspaceKey({
    workspacePath: option.workspacePath,
    ...(option.workspaceIdentity ? { workspaceIdentity: option.workspaceIdentity } : {}),
  });
}

/**
 * The saved-workflows hub: a pinned Global group on top, then one group per opened project. The
 * page holds only the refresh counter, per-group loading state and the detail state; projects come
 * from buildAutomationWorkspaceOptions.
 */
export function SavedWorkflowsSection({
  header,
  workspacePath,
  workspaceIdentity,
  onNavigateToLaunchedRun,
  onCreateViaChat,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  openWorkflow,
  onOpenWorkflowConsumed,
}: SavedWorkflowsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const tabs = useTabStore((store) => store.tabs);
  const openSettingsTab = useTabStore((store) => store.openSettingsTab);
  // launch.md, hub page and user's choice: the title-row Workflow settings link opens the Settings General mode row,
  // which shows the current effective mode. The hub exists only when the mode is not off, so the off state is not handled here.
  // Link and target row appear together: the row exists only while the feature is offered (isDynamicWorkflowOffered); on old hosts
  // the snapshot lacks offeredMode, so no row and no link -- otherwise the link lands on a missing setting.
  const dynamicWorkflowConfig = useDynamicWorkflowAvailability().config;
  const dynamicWorkflowMode = dynamicWorkflowConfig?.mode;
  const showWorkflowSettings =
    dynamicWorkflowConfig !== null && isDynamicWorkflowOffered(dynamicWorkflowConfig);
  const handleOpenWorkflowSettings = useCallback(() => {
    setPendingSettingsSectionIntent("general");
    openSettingsTab();
  }, [openSettingsTab]);
  const projects = useMemo(() => buildAutomationWorkspaceOptions(tabs), [tabs]);
  // Global-group run/move destinations are local projects only: filter out remote workspaces.
  const localProjects = useMemo(
    () => projects.filter((project) => !project.remoteSessionId),
    [projects],
  );

  const [view, setView] = useState<SavedWorkflowsView>({ mode: "list" });
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [readiness, setReadiness] = useState<Record<string, SavedWorkflowGroupState>>({});

  // Active workspace (prop from the caller): Current marker, global-group default destination, and the global empty-state creation target.
  const activeKey = useMemo(
    () =>
      workspacePath
        ? resolveWorkspaceKey({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          })
        : null,
    [workspaceIdentity, workspacePath],
  );

  const handleStateChange = useCallback((key: string, next: SavedWorkflowGroupState) => {
    setReadiness((current) => {
      const prev = current[key];
      if (
        prev &&
        prev.loaded === next.loaded &&
        prev.empty === next.empty &&
        prev.count === next.count
      ) {
        return current;
      }
      return { ...current, [key]: next };
    });
  }, []);

  // Global-group move-to-project removes a file, so both groups refetch. No project-group action
  // changes both groups (promote-to-global only opens a session; the global copy appears via the
  // model's SaveWorkflow and the global group's directory watch), hence only the global group
  // signals here.
  const handleMoved = useCallback(() => setRefreshSeq((seq) => seq + 1), []);

  // Deep link: land openWorkflow on the matching detail page, then consume. Unknown project: consume without navigating.
  const consumedRef = useRef<SavedWorkflowsOpenTarget | null>(null);
  useEffect(() => {
    if (!openWorkflow) {
      consumedRef.current = null;
      return;
    }
    if (consumedRef.current === openWorkflow) return;
    consumedRef.current = openWorkflow;
    if (openWorkflow.scope === "global") {
      setView({ mode: "detail", scope: "global", name: openWorkflow.name });
    } else if (
      projects.some((project) => resolveOptionKey(project) === openWorkflow.workspaceKey)
    ) {
      setView({
        mode: "detail",
        scope: "project",
        workspaceKey: openWorkflow.workspaceKey,
        name: openWorkflow.name,
      });
    }
    onOpenWorkflowConsumed?.();
  }, [onOpenWorkflowConsumed, openWorkflow, projects]);

  // Project closed while its detail is open: fall back to the list (via effect, no setState during render).
  useEffect(() => {
    if (
      view.mode === "detail" &&
      view.scope === "project" &&
      !projects.some((project) => resolveOptionKey(project) === view.workspaceKey)
    ) {
      setView({ mode: "list" });
    }
  }, [projects, view]);

  // Global empty-state creation target: the active project, else the first candidate (for project-scope creation).
  const emptyCardTarget = useMemo<SavedWorkflowProjectTarget | null>(() => {
    const active = projects.find((project) => resolveOptionKey(project) === activeKey);
    const target = active ?? projects[0];
    if (!target) return null;
    return {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    };
  }, [activeKey, projects]);

  const handleCreateFromEmpty = useCallback(() => {
    if (!emptyCardTarget) return;
    onCreateViaChat?.(buildSavedWorkflowCreatePrompt(locale), emptyCardTarget);
  }, [emptyCardTarget, locale, onCreateViaChat]);

  const globalGroupCommonProps = {
    refreshSeq,
    onStateChange: handleStateChange,
    onNavigateToLaunchedRun,
    onCreateViaChat,
    onOpenWorkflowRun,
    onOpenWorkflowArtifact,
    localProjects,
    activeProjectKey: activeKey,
    onMoved: handleMoved,
  };

  // Detail state: render only the selected group (it renders the full-page detail inside); no page header / toolbar row.
  if (view.mode === "detail" && view.scope === "global") {
    return (
      <SavedWorkflowGlobalGroup
        {...globalGroupCommonProps}
        mode={{ kind: "detail", name: view.name }}
        onOpenDetail={(name) => setView({ mode: "detail", scope: "global", name })}
        onBack={() => setView({ mode: "list" })}
      />
    );
  }
  if (view.mode === "detail") {
    const project = projects.find((candidate) => resolveOptionKey(candidate) === view.workspaceKey);
    if (project) {
      return (
        <SavedWorkflowProjectGroup
          key={view.workspaceKey}
          project={project}
          isCurrent={activeKey === view.workspaceKey}
          refreshSeq={refreshSeq}
          mode={{ kind: "detail", name: view.name }}
          onStateChange={handleStateChange}
          onOpenDetail={(name) =>
            setView({ mode: "detail", scope: "project", workspaceKey: view.workspaceKey, name })
          }
          onBack={() => setView({ mode: "list" })}
          onNavigateToLaunchedRun={onNavigateToLaunchedRun}
          onCreateViaChat={onCreateViaChat}
          onOpenWorkflowRun={onOpenWorkflowRun}
          onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        />
      );
    }
    // Project closed while detail open: the effect above resets view to list; render the list here first.
  }

  const globalReady = readiness[GLOBAL_READINESS_KEY];
  const anyLoaded =
    Boolean(globalReady?.loaded) ||
    projects.some((project) => readiness[resolveOptionKey(project)]?.loaded);
  // The global empty card watches project groups only: shown when every project group is loaded and empty, ignoring the global group's emptiness.
  const allProjectsLoaded =
    projects.length > 0 &&
    projects.every((project) => readiness[resolveOptionKey(project)]?.loaded);
  const allProjectsEmpty =
    allProjectsLoaded && projects.every((project) => readiness[resolveOptionKey(project)]?.empty);
  // The count beside the title = sum of valid workflows across loaded groups, global included.
  const totalCount = projects.reduce(
    (sum, project) => {
      const entry = readiness[resolveOptionKey(project)];
      return sum + (entry?.loaded ? entry.count : 0);
    },
    globalReady?.loaded ? globalReady.count : 0,
  );

  return (
    <div data-automations-content className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col")}>
      {header}

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "workflows.hub.sectionTitle" })}
          {totalCount > 0 ? (
            <span className="ml-1 font-normal text-foreground-subtlest">{totalCount}</span>
          ) : null}
        </h2>
        <div className="flex items-center gap-3">
          {showWorkflowSettings ? (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              data-testid={TID_WORKFLOWS_OPEN_SETTINGS}
              className="text-foreground-subtle hover:text-foreground"
              onClick={handleOpenWorkflowSettings}
            >
              <Settings2 className="size-4" aria-hidden="true" />
              <span>{intl.formatMessage({ id: "workflows.hub.openSettings" })}</span>
              {dynamicWorkflowMode ? (
                <span className="ml-0.5 text-ui-sm text-foreground-subtlest">
                  {intl.formatMessage({
                    id: `settings.dynamicWorkflow.option.${dynamicWorkflowMode}`,
                  })}
                </span>
              ) : null}
            </Button>
          ) : null}
          <ControlHintTooltip title={intl.formatMessage({ id: "workflows.hub.refresh" })}>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={intl.formatMessage({ id: "workflows.hub.refresh" })}
              data-testid={TID_WORKFLOWS_REFRESH}
              onClick={() => setRefreshSeq((seq) => seq + 1)}
            >
              <AutomationRefreshIcon className="size-3.5" aria-hidden="true" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>

      {!anyLoaded ? (
        <div className="mt-8 flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : null}

      {/* Groups stay mounted so each can load and report (not-ready / empty project groups render null inside; the global group shows even empty);
         the first-paint spinner overlays only and never blocks loading. Global group always first, project groups below. */}
      <div className={cn("flex flex-col", anyLoaded ? "mt-5" : "hidden")}>
        <SavedWorkflowGlobalGroup
          {...globalGroupCommonProps}
          mode={{ kind: "list" }}
          onOpenDetail={(name) => setView({ mode: "detail", scope: "global", name })}
          onBack={() => setView({ mode: "list" })}
        />

        {projects.length === 0 ? (
          <p className="mt-8 text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "workflows.hub.noWorkspace" })}
          </p>
        ) : allProjectsEmpty ? (
          <div
            data-testid={TID_WORKFLOWS_EMPTY}
            className="mt-8 flex h-[226px] w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4"
          >
            <div className="flex translate-y-2 flex-col items-center gap-5">
              <div className="flex flex-col items-center gap-1.5 text-center">
                <p className="text-ui-base font-medium leading-5 text-foreground-subtlest">
                  {intl.formatMessage({ id: "workflows.hub.empty.title" })}
                </p>
                <p className="max-w-[420px] text-ui-base leading-5 text-foreground-subtlest">
                  {intl.formatMessage({ id: "workflows.hub.empty.hint" })}
                </p>
              </div>
              <Button
                type="button"
                size="lg"
                data-icon="inline-start"
                data-testid={TID_WORKFLOWS_CREATE_VIA_CHAT}
                onClick={handleCreateFromEmpty}
              >
                <Plus className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "workflows.hub.createViaChat" })}
              </Button>
            </div>
          </div>
        ) : null}

        {projects.map((project) => {
          const workspaceKey = resolveOptionKey(project);
          return (
            <SavedWorkflowProjectGroup
              key={workspaceKey}
              project={project}
              isCurrent={activeKey === workspaceKey}
              refreshSeq={refreshSeq}
              mode={{ kind: "list" }}
              onStateChange={handleStateChange}
              onOpenDetail={(name) =>
                setView({ mode: "detail", scope: "project", workspaceKey, name })
              }
              onBack={() => setView({ mode: "list" })}
              onNavigateToLaunchedRun={onNavigateToLaunchedRun}
              onCreateViaChat={onCreateViaChat}
              onOpenWorkflowRun={onOpenWorkflowRun}
              onOpenWorkflowArtifact={onOpenWorkflowArtifact}
            />
          );
        })}
      </div>
    </div>
  );
}
