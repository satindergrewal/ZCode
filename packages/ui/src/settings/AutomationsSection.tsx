import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- the scheduled-tasks root view intentionally keeps list, create/edit routes and start/stop/delete in one place for interaction consistency. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import { CircleCheck, RotateCcw, TriangleAlert } from "lucide-react";
import {
  AUTOMATION_CREATE_LIMIT,
  BUILTIN_MODEL_PROVIDER_IDS,
  TID_AUTOMATION_ACTION_DELETE,
  TID_AUTOMATION_ACTION_TOGGLE,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_CARD_MENU,
  TID_AUTOMATIONS_LIST,
  TID_AUTOMATIONS_STATUS_FILTER,
  TID_OFFPEAK_CREATE_BUTTON,
  TID_OFFPEAK_TAB,
  isAutomationCreateLimitError,
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast as showToast, type ToastOptions } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { AutomationScheduledTemplateIcon } from "@/settings/AutomationScheduledTemplateIcon.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  OFF_PEAK_CREATE_TOOLTIP_CLASSNAME,
  formatOffPeakRemainingWait,
  resolveOffPeakCreateBlockReason,
  type OffPeakCreateBlockReason,
} from "@/settings/offPeakUiPresentation.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useOffPeakEligibility } from "@/hooks/useOffPeakEligibility.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import {
  createIdleTimeCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanStateFromProviderSettings,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  useAutomationManagementStore,
  type AutomationRunNowResult,
} from "@/store/automationManagementStore.js";
import {
  isCurrentOffPeakCodingPlanSupported,
  resolveOffPeakCreateErrorMessageId,
  useOffPeakTaskStore,
  type OffPeakCreateDraft,
} from "@/store/offPeakTaskStore.js";
import {
  createAndReportOffPeakTask,
  freezeOffPeakCreateTelemetrySnapshot,
  reportOffPeakCreateResult,
} from "@/lib/offPeakTelemetry.js";
import { OffPeakTaskList } from "@/settings/OffPeakTaskList.js";
import { OffPeakTemplateIcon } from "@/settings/OffPeakTemplateIcon.js";
import { OffPeakEditView, type OffPeakEditSubmit } from "@/settings/OffPeakEditView.js";
import {
  formatAutomationCardNextRun,
  hasAutomationFailureState,
  resolveAutomationStatusKind,
  type AutomationStatusKind,
} from "@/settings/automationFormat.js";
import { describeAutomationCardSchedule } from "@/settings/automationCardSchedule.js";
import { AutomationEditView, type AutomationEditSubmit } from "@/settings/AutomationEditView.js";
import { AutomationScheduleBadge } from "@/settings/AutomationScheduleBadge.js";
import {
  AutomationClockIcon,
  AutomationContinueIcon,
  AutomationCreateDropdown,
  AutomationEditActionIcon,
  AutomationKeepAwakeNotice,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationRefreshIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  AUTOMATION_STATUS_FILTERS,
  DEFAULT_AUTOMATION_STATUS_FILTER,
  filterAutomationsByStatus,
  filterOffPeakTasksByStatus,
  resolveAutomationTabState,
  type AutomationStatusFilter,
  type AutomationTabState,
} from "@/settings/automationStatusFilter.js";
import { isRemoteAutomationWorkspace } from "@/hooks/useAutomationProjectOptions.js";
import {
  reportAutomationActionClick,
  reportAutomationCreateResult,
  resolveAutomationSelectionTelemetry,
} from "@/lib/automationTelemetry.js";
import {
  materializeOffPeakTemplateDraft,
  materializeScheduledTemplateDraft,
  resolveOffPeakTemplateText,
  resolveAutomationTemplateText,
  type ScheduledAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import {
  AutomationsPageTitle,
  type AutomationsPageTab,
} from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import {
  readAutomationsPageTab,
  writeAutomationsPageTab,
} from "@/settings/saved-workflows/automationsPageTabMemory.js";
import {
  SavedWorkflowsSection,
  type SavedWorkflowLaunchTarget,
  type SavedWorkflowProjectTarget,
  type SavedWorkflowsOpenArtifactParams,
  type SavedWorkflowsOpenRunParams,
  type SavedWorkflowsOpenTarget,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationTemplateSkeletonGrid } from "@/settings/AutomationTemplateSkeletonGrid.js";

interface AutomationsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** "Create via chat": switch to the session and let the agent create it via CronCreate; without it, fall back to the manual full-page creator.
   // target = the workflow's project; scheduled "create via chat" carries no target and lands on the active project. */
  onCreateViaChat?: (prompt: string, target?: SavedWorkflowProjectTarget) => void;
  /** Detail-navigation target for the in-session create card; cleared by the caller once resolved. */
  openAutomationId?: string | null;
  /** One-shot tab navigation target carried by the recommended prompt; applied only when that tab is visible. "workflow" lands on the top-level workflow tab. */
  openAutomationTab?: AutomationsNavigationTab | null;
  onOpenAutomationConsumed?: () => void;
  /** Workflow "run" = direct GUI start: after accepted, switch to the new session. */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  /** Run-history "view instance": switch to the session that started it and open the instance detail page. */
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** Artifact chip -> the `workflow-artifact` tab. */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  /** Deep link straight to the detail page; passed through to SavedWorkflowsSection, cleared by the caller once resolved. global needs only the name. */
  openWorkflow?: SavedWorkflowsOpenTarget | null;
  onOpenWorkflowConsumed?: () => void;
  /** Open the session tied to a run; the manage page lists all projects, so the automation's workspace must be carried along. */
  onOpenSession?: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => void;
}

export const AUTOMATIONS_TOAST_ANCHOR_ID = "automations-main-toast-anchor";

function toast(message: string, options?: ToastOptions): number {
  return showToast(message, {
    ...options,
    anchorId: AUTOMATIONS_TOAST_ANCHOR_ID,
  });
}

function OffPeakCreateButton({
  greyReason,
  greyTooltip,
  onCreate,
}: {
  greyReason: OffPeakCreateBlockReason | null;
  greyTooltip?: string;
  onCreate: () => void;
}) {
  const { intl } = useZCodeIntl();
  // Disabled buttons are pointer-events-none; the tooltip must hang on an outer pointerable element.
  const button = (
    <Button
      type="button"
      variant="default"
      size="default"
      data-testid={TID_OFFPEAK_CREATE_BUTTON}
      disabled={greyReason !== null}
      onClick={onCreate}
    >
      {intl.formatMessage({ id: "offPeak.createButton" })}
    </Button>
  );

  if (!greyTooltip) return button;
  return (
    <ControlHintTooltip
      title={greyTooltip}
      side="top"
      align="center"
      className={OFF_PEAK_CREATE_TOOLTIP_CLASSNAME}
    >
      <span className="inline-flex">{button}</span>
    </ControlHintTooltip>
  );
}

/** Prefill draft for the create form (from a "More ideas" template). */
interface AutomationDraft {
  templateId?: string;
  title: string;
  cronExpr: string;
  prompt: string;
}

/** Root-view internal routes: list / create / edit. */
type AutomationsView =
  | { mode: "list" }
  | { mode: "create"; draft: AutomationDraft | null }
  | { mode: "edit"; automation: ZCodeAutomation }
  | { mode: "offpeak-create"; draft?: OffPeakCreateDraft }
  | { mode: "offpeak-edit"; task: ZCodeOffPeakTask };

/** Root-view tabs: Scheduled always; Idle-time behind the rollout flag; no mixed All view. */
type AutomationsTab = "scheduled" | "idle";

const SCHEDULED_ONLY_AUTOMATION_TABS: readonly AutomationsTab[] = ["scheduled"];
const SCHEDULED_AND_IDLE_AUTOMATION_TABS: readonly AutomationsTab[] = ["scheduled", "idle"];

function resolveVisibleAutomationTabs({
  hasAnyTasks,
  offPeakVisible,
}: {
  hasAnyTasks: boolean;
  offPeakVisible: boolean;
}): readonly AutomationsTab[] {
  if (!hasAnyTasks) return [];
  return offPeakVisible ? SCHEDULED_AND_IDLE_AUTOMATION_TABS : SCHEDULED_ONLY_AUTOMATION_TABS;
}

function resolveAutomationTabAfterOffPeakChange(
  tab: AutomationsTab,
  offPeakVisible: boolean,
): AutomationsTab {
  return tab === "idle" && !offPeakVisible ? "scheduled" : tab;
}

function resolveAutomationTabNavigation({
  requestedTab,
  tabsReady,
  visibleTabs,
}: {
  requestedTab: AutomationsTab;
  tabsReady: boolean;
  visibleTabs: readonly AutomationsTab[];
}): { status: "pending" } | { status: "settled"; tab: AutomationsTab } {
  if (!tabsReady) return { status: "pending" };
  return {
    status: "settled",
    tab: visibleTabs.includes(requestedTab) ? requestedTab : "scheduled",
  };
}

function resolveAutomationTemplateVisibility({
  hasAnyTasks,
  offPeakCreationEnabled,
  tab,
}: {
  hasAnyTasks: boolean;
  offPeakCreationEnabled: boolean;
  tab: AutomationsTab;
}): {
  showOffPeakTemplates: boolean;
  showScheduledTemplates: boolean;
} {
  // After the All tab was removed the empty landing still defaulted to Scheduled, hiding idle templates behind the tab condition.
  // With no tasks, show both template kinds side by side; with tasks, Scheduled / Idle tabs keep routing them.
  const showAllTemplates = !hasAnyTasks;
  return {
    showOffPeakTemplates: offPeakCreationEnabled && (showAllTemplates || tab === "idle"),
    showScheduledTemplates: showAllTemplates || tab === "scheduled",
  };
}

const STATUS_META: Record<
  AutomationStatusKind,
  { icon: ComponentType<SVGProps<SVGSVGElement>>; className: string }
> = {
  active: { icon: AutomationClockIcon, className: "text-success" },
  // The design's paused state is a stop-circle outline icon; do not regress to a filled square in a circle.
  paused: { icon: AutomationPausedIcon, className: "text-foreground-subtle" },
  completed: { icon: CircleCheck, className: "text-foreground-subtle" },
  failed: { icon: TriangleAlert, className: "text-destructive" },
};

function automationPromptSummary(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : " ";
}

function canRestartAutomation(automation: Pick<ZCodeAutomation, "lifecycleStatus">): boolean {
  return automation.lifecycleStatus === "failed";
}

function canToggleAutomation(automation: Pick<ZCodeAutomation, "lifecycleStatus">): boolean {
  return automation.lifecycleStatus !== "completed" && automation.lifecycleStatus !== "failed";
}

function getAutomationRunNowToastId(
  result: AutomationRunNowResult,
): "automations.runNowQueued" | "automations.runNowAlreadyRunning" | "automations.runNowFailed" {
  if (result === "queued") return "automations.runNowQueued";
  if (result === "duplicate") return "automations.runNowAlreadyRunning";
  return "automations.runNowFailed";
}

type AutomationActionError = "create" | "update" | "toggle" | "restart" | "delete";

/** Raw Agent/RPC errors stay in the logger; the UI shows only a comprehensible message for the current action. */
function getAutomationActionErrorToastId(action: AutomationActionError): string {
  return `automations.error.${action}`;
}

function getAutomationCreateErrorToastId(error: unknown): string {
  return isAutomationCreateLimitError(error)
    ? "automations.error.createLimit"
    : getAutomationActionErrorToastId("create");
}

function resolveAutomationDetailTarget(
  automations: readonly ZCodeAutomation[],
  automationId?: string | null,
): ZCodeAutomation | null {
  const targetId = automationId?.trim();
  if (!targetId) return null;
  return automations.find((automation) => automation.automationId === targetId) ?? null;
}

function resolveAutomationDetailNavigation(
  automations: readonly ZCodeAutomation[],
  automationId: string | null | undefined,
  listReady: boolean,
): { status: "pending" } | { status: "missing" } | { status: "found"; target: ZCodeAutomation } {
  if (!automationId?.trim() || !listReady) return { status: "pending" };
  const target = resolveAutomationDetailTarget(automations, automationId);
  return target ? { status: "found", target } : { status: "missing" };
}

/** Distinguishing the `offpeak-` prefixed ids inside openAutomationId (single generation site: offPeakTaskService's offpeak-${uuid}). */
function isOffPeakDetailNavigationId(automationId: string | null | undefined): boolean {
  return Boolean(automationId?.trim().startsWith("offpeak-"));
}

/** Parallel resolution path for idle-tail-card navigation; mirrors the cron resolveAutomationDetailNavigation. */
function resolveOffPeakDetailNavigation(
  tasks: readonly ZCodeOffPeakTask[],
  offPeakTaskId: string | null | undefined,
  listReady: boolean,
  listError: string | null = null,
):
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "missing" }
  | { status: "found"; target: ZCodeOffPeakTask } {
  const targetId = offPeakTaskId?.trim();
  if (!targetId || !listReady) return { status: "pending" };
  // review: store.refresh swallows errors and keeps the old list; while the list is untrusted, no found/missing verdict may be issued.
  if (listError) return { status: "unavailable" };
  const target = tasks.find((task) => task.offPeakTaskId === targetId) ?? null;
  return target ? { status: "found", target } : { status: "missing" };
}

interface AutomationActionsMenuProps {
  automation: ZCodeAutomation;
  busy: boolean;
  canRestart: boolean;
  canToggle: boolean;
  onRunNow: (automation: ZCodeAutomation) => void;
  onEdit: (automation: ZCodeAutomation) => void;
  onToggle: (automation: ZCodeAutomation, enabled: boolean) => void;
  onRestart: (automation: ZCodeAutomation) => void;
  onDelete: (automation: ZCodeAutomation) => void;
}

function AutomationActionsMenu({
  automation,
  busy,
  canRestart,
  canToggle,
  onRunNow,
  onEdit,
  onToggle,
  onRestart,
  onDelete,
}: AutomationActionsMenuProps) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-hover md:opacity-0 md:group-hover:opacity-100 data-[state=open]:bg-hover data-[state=open]:opacity-100"
          data-testid={TID_AUTOMATION_CARD_MENU}
          aria-label={intl.formatMessage({ id: "automations.moreActions" })}
          disabled={busy}
          // The card clicks into edit; menu clicks do not bubble to the card.
          onClick={(event) => event.stopPropagation()}
        >
          <AutomationMoreHorizontalIcon
            className="size-4 text-foreground-subtle"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-[190px]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Run now: busy guards duplicates during the RPC, the entry restores on return; the host single-flights active runs. */}
        <DropdownMenuItem
          className="gap-1"
          disabled={busy}
          onSelect={() => void onRunNow(automation)}
        >
          <span className="flex size-5 items-center justify-center">
            <AutomationRunNowIcon className="size-4" aria-hidden="true" />
          </span>
          {intl.formatMessage({ id: "automations.runNow" })}
        </DropdownMenuItem>
        {canRestart ? (
          <DropdownMenuItem
            className="gap-1"
            disabled={busy}
            onSelect={() => void onRestart(automation)}
          >
            <span className="flex size-5 items-center justify-center">
              <RotateCcw className="size-4" strokeWidth={1.33} aria-hidden="true" />
            </span>
            {intl.formatMessage({ id: "automations.restart" })}
          </DropdownMenuItem>
        ) : null}
        {/* Terminal tasks hide pause/resume: failed offers Restart; completed is fully closed to view/delete only. */}
        {canToggle ? (
          <DropdownMenuItem
            data-testid={TID_AUTOMATION_ACTION_TOGGLE}
            className="gap-1"
            disabled={busy}
            onSelect={() => void onToggle(automation, !automation.enabled)}
          >
            {automation.enabled ? (
              <span className="flex size-5 items-center justify-center">
                <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
              </span>
            ) : (
              <span className="flex size-5 items-center justify-center">
                <AutomationContinueIcon className="size-4" aria-hidden="true" />
              </span>
            )}
            {intl.formatMessage({
              id: automation.enabled ? "automations.pause" : "automations.resume",
            })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="gap-1"
          disabled={busy}
          onSelect={() => void onEdit(automation)}
        >
          <span className="flex size-5 items-center justify-center">
            <AutomationEditActionIcon className="size-4" aria-hidden="true" />
          </span>
          {intl.formatMessage({ id: "automations.form.editTitle" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid={TID_AUTOMATION_ACTION_DELETE}
          className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
          disabled={busy}
          onSelect={() => void onDelete(automation)}
        >
          <AutomationTrashIcon />
          {intl.formatMessage({ id: "automations.delete" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Placeholder when the status filter matches nothing; reuses the idle empty-card outline, with copy distinct from the no-tasks state. */
function AutomationStatusFilterEmpty() {
  const { intl } = useZCodeIntl();
  return (
    <div className="rounded-[10px] border border-card-border px-3 py-3 text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "automations.statusFilter.empty" })}
    </div>
  );
}

export function AutomationsSection({
  workspacePath,
  workspaceIdentity,
  onCreateViaChat,
  openAutomationId,
  openAutomationTab,
  onOpenAutomationConsumed,
  onNavigateToLaunchedRun,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  openWorkflow,
  onOpenWorkflowConsumed,
  onOpenSession,
}: AutomationsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const { clientScenesService, offPeakTaskService, zcodeAgentService } = useServices();
  const confirmDialog = useConfirmDialog();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const { status: entryStatus, label: entryLabel, retry: retryEntry } = useCodingPlanEntryGate();
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings();
  useOffPeakEligibility(sharedSettings, providerSettingsView?.revision);

  const automations = useAutomationManagementStore((state) => state.automations);
  const automationCreateLimitReached = automations.length >= AUTOMATION_CREATE_LIMIT;
  const loading = useAutomationManagementStore((state) => state.loading);
  const operationId = useAutomationManagementStore((state) => state.operationId);
  const runsCache = useAutomationManagementStore((state) => state.runsCache);
  const initialize = useAutomationManagementStore((state) => state.initialize);
  const createAutomation = useAutomationManagementStore((state) => state.createAutomation);
  const updateAutomation = useAutomationManagementStore((state) => state.updateAutomation);
  const deleteAutomation = useAutomationManagementStore((state) => state.deleteAutomation);
  const setEnabled = useAutomationManagementStore((state) => state.setEnabled);
  const restartAutomation = useAutomationManagementStore((state) => state.restartAutomation);
  const runAutomationNow = useAutomationManagementStore((state) => state.runAutomationNow);
  const loadRuns = useAutomationManagementStore((state) => state.loadRuns);
  const deleteRun = useAutomationManagementStore((state) => state.deleteRun);
  const refresh = useAutomationManagementStore((state) => state.refresh);

  const automationTemplates = useAutomationTemplates(clientScenesService);
  const offPeakTasks = useOffPeakTaskStore((state) => state.tasks);
  const offPeakStoreLoading = useOffPeakTaskStore((state) => state.loading);
  const offPeakGrayConfig = useOffPeakTaskStore((state) => state.grayConfig);
  const offPeakCodingPlanSupport = useOffPeakTaskStore((state) => state.codingPlanSupport);
  const offPeakTakeNumberAvailability = useOffPeakTaskStore(
    (state) => state.takeNumberAvailability,
  );
  const offPeakTakeNumberAvailabilityStatus = useOffPeakTaskStore(
    (state) => state.takeNumberAvailabilityStatus,
  );
  const offPeakOperationId = useOffPeakTaskStore((state) => state.operationId);
  const offPeakRefresh = useOffPeakTaskStore((state) => state.refresh);
  const offPeakRefreshCodingPlanSupport = useOffPeakTaskStore(
    (state) => state.refreshCodingPlanSupport,
  );
  const offPeakRefreshTakeNumberAvailability = useOffPeakTaskStore(
    (state) => state.refreshTakeNumberAvailability,
  );
  const offPeakCreate = useOffPeakTaskStore((state) => state.createTask);
  const offPeakUpdate = useOffPeakTaskStore((state) => state.updateTask);
  const offPeakPause = useOffPeakTaskStore((state) => state.pauseTask);
  const offPeakContinue = useOffPeakTaskStore((state) => state.continueTask);
  const offPeakCancel = useOffPeakTaskStore((state) => state.cancelTask);
  const offPeakDelete = useOffPeakTaskStore((state) => state.deleteTask);
  const offPeakDeleteHistory = useOffPeakTaskStore((state) => state.deleteHistory);
  const consumePendingCreateDraft = useOffPeakTaskStore((state) => state.consumePendingCreateDraft);

  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<AutomationsView>({ mode: "list" });
  // Tab and status filter share one state: every setTab call goes through resolveAutomationTabState,
  // so any tab change resets the filter to all and away-back never restores a stale filter.
  const [tabState, setTabState] = useState<AutomationTabState<AutomationsTab>>({
    tab: "scheduled",
    filter: DEFAULT_AUTOMATION_STATUS_FILTER,
  });
  const { tab, filter: statusFilter } = tabState;
  const setTab = useCallback(
    (next: AutomationsTab | ((current: AutomationsTab) => AutomationsTab)) =>
      setTabState((previous) =>
        resolveAutomationTabState(previous, typeof next === "function" ? next(previous.tab) : next),
      ),
    [],
  );
  const setStatusFilter = useCallback(
    (filter: AutomationStatusFilter) => setTabState((previous) => ({ ...previous, filter })),
    [],
  );
  // Dynamic-workflow rollout: no hit means no workflow tab,
  // the page falls back to Automations alone. While the snapshot is not ready enabled is false — better a title that grows its switch half a beat late
  // than one that flashes and retracts; the hub is rarely the first thing a user looks at.
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();
  // Top-level tabs "Automations / Workflows": the page title is the switch. The hub is already cross-project, so memory is app-level single-key, not per-project.
  const [storedPageTab, setPageTabState] = useState<AutomationsPageTab>(() =>
    readAutomationsPageTab(),
  );
  // While the flag is off, ignore a remembered "workflow" tab: narrow the value read out, keep the memory itself,
  // so re-enabling returns the user to their last page. The hub mounts only in the `pageTab === "workflow"` branch;
  // narrowing pageTab means SavedWorkflowsSection never mounts — no one-frame mis-mount firing queries.
  const pageTab: AutomationsPageTab = dynamicWorkflowEnabled ? storedPageTab : "automation";
  const setPageTab = useCallback((next: AutomationsPageTab) => {
    setPageTabState(next);
    writeAutomationsPageTab(next);
  }, []);
  const activeWorkspaceTab = useTabStore((state) => {
    const activeTab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
    return activeTab && isWorkspaceTab(activeTab) ? activeTab : undefined;
  });
  const currentWorkspaceIsRemote = isRemoteAutomationWorkspace(activeWorkspaceTab);
  // Flag flipped mid-flight: hide only the create entry; existing non-terminal runs stay visible and run to completion.
  const offPeakGrayEnabled = offPeakGrayConfig?.enabled === true;
  const offPeakCreationEnabled = offPeakGrayEnabled && !currentWorkspaceIsRemote;
  // Scanning all providers would treat an unselected Coding Plan as the execution credential.
  // The mock demo field may still override; the real path accepts only a redacted resolver snapshot matching the current family/selectedKey.
  const offPeakNoPlan =
    offPeakGrayConfig?.codingPlanActive === false ||
    (offPeakGrayConfig?.codingPlanActive === undefined &&
      !offPeakStoreLoading &&
      !isCurrentOffPeakCodingPlanSupported(offPeakCodingPlanSupport, sharedSettings));
  const offPeakVisible =
    !currentWorkspaceIsRemote && (offPeakGrayEnabled || offPeakTasks.length > 0);
  const hasAnyTasks = automations.length > 0 || offPeakTasks.length > 0;
  const visibleTabs = resolveVisibleAutomationTabs({
    hasAnyTasks,
    offPeakVisible,
  });
  const hasVisibleTaskCards =
    tab === "scheduled" ? automations.length > 0 : offPeakTasks.length > 0;
  const visibleAutomations = filterAutomationsByStatus(automations, statusFilter);
  const visibleOffPeakTasks = filterOffPeakTasksByStatus(offPeakTasks, statusFilter);
  const { showOffPeakTemplates, showScheduledTemplates } = resolveAutomationTemplateVisibility({
    hasAnyTasks,
    offPeakCreationEnabled,
    tab,
  });
  const hasVisibleTemplates = showOffPeakTemplates || showScheduledTemplates;
  const showTaskTemplateSeparator = hasVisibleTaskCards && hasVisibleTemplates;
  const [loadedWorkspaceKey, setLoadedWorkspaceKey] = useState<string | null>(null);
  // Relative-time base; refreshed with the list, avoiding a frequent setInterval.
  const [now, setNow] = useState(() => Date.now());

  // Create admission is fail-closed. Only a server success with canTakeNumber=true admits; eligibility mismatch,
  // loading/idle/error and quota=false all block, so a swallowed dependency error surfaces at real create time at the latest.
  const offPeakCreateGrey = useMemo(() => {
    const reason = resolveOffPeakCreateBlockReason({
      availabilityStatus: offPeakTakeNumberAvailabilityStatus,
      canTakeNumber: offPeakTakeNumberAvailability?.canTakeNumber,
      grayEnabled: offPeakGrayEnabled,
      noPlan: offPeakNoPlan,
    });
    const tooltip =
      reason === "plan"
        ? intl.formatMessage({ id: "offPeak.create.codingPlanOnly" })
        : reason === "unavailable"
          ? intl.formatMessage({ id: "offPeak.create.availabilityUnavailable" })
          : reason === "quota" && offPeakTakeNumberAvailability?.nextTakeAt !== undefined
            ? intl.formatMessage(
                { id: "offPeak.create.limitReachedAt" },
                {
                  time: formatOffPeakRemainingWait(
                    offPeakTakeNumberAvailability.nextTakeAt,
                    now,
                    intl,
                  ),
                },
              )
            : undefined;
    return { reason, tooltip };
  }, [
    intl,
    now,
    offPeakGrayEnabled,
    offPeakNoPlan,
    offPeakTakeNumberAvailability,
    offPeakTakeNumberAvailabilityStatus,
  ]);

  // Lists load per current project (the root view receives the workspace from WorkspaceShellLayout).
  useEffect(() => {
    if (!workspacePath) return;
    const workspaceKey = resolveWorkspaceKey({
      workspacePath,
      workspaceIdentity,
    });
    let disposed = false;
    setLoadedWorkspaceKey(null);
    setNow(Date.now());
    void initialize({
      workspacePath,
      workspaceIdentity,
      agentService: zcodeAgentService,
    }).then(() => {
      if (!disposed) setLoadedWorkspaceKey(workspaceKey);
    });
    return () => {
      disposed = true;
    };
  }, [workspacePath, workspaceIdentity, zcodeAgentService, initialize]);

  useEffect(() => {
    const nextTab = resolveAutomationTabAfterOffPeakChange(tab, offPeakVisible);
    if (nextTab === tab) return;
    // With the idle rollout disabled in the background the Idle tab hides; if the stale state still sits on idle,
    // the scheduled list hides with tab === "idle" too. Return to Scheduled so scheduled tasks stay reachable.
    setTab(nextTab);
  }, [offPeakVisible, tab]);

  useEffect(() => {
    if (!openAutomationTab) return;
    // Flag off: the requested workflow tab does not exist,
    // fall back to Automations and consume the deep link — an unconsumed request hangs and keeps pulling the page back.
    if (openAutomationTab === "workflow" && !dynamicWorkflowEnabled) {
      setPageTab("automation");
      onOpenAutomationConsumed?.();
      return;
    }
    if (openAutomationTab === "workflow") {
      setPageTab("workflow");
      onOpenAutomationConsumed?.();
      return;
    }
    // Idle detail navigation is handled by the offpeak branch below (setTab("idle") + consume); resolving first against
    // the (possibly unloaded) visible tab to scheduled and consuming would clear the pending detail navigation too.
    if (isOffPeakDetailNavigationId(openAutomationId)) return;
    const currentWorkspaceKey = workspacePath
      ? resolveWorkspaceKey({ workspacePath, workspaceIdentity })
      : null;
    const result = resolveAutomationTabNavigation({
      requestedTab: openAutomationTab,
      tabsReady:
        currentWorkspaceKey !== null &&
        loadedWorkspaceKey === currentWorkspaceKey &&
        !offPeakStoreLoading,
      visibleTabs,
    });
    if (result.status === "pending") return;
    setPageTab("automation");
    if (result.tab !== tab) setTab(result.tab);
    onOpenAutomationConsumed?.();
  }, [
    dynamicWorkflowEnabled,
    loadedWorkspaceKey,
    offPeakStoreLoading,
    onOpenAutomationConsumed,
    openAutomationId,
    openAutomationTab,
    setPageTab,
    tab,
    visibleTabs,
    workspaceIdentity,
    workspacePath,
  ]);

  // The server gives the exact resume time; re-check when it passes. Keep admission blocked during refresh and after failure until a success returns true.
  useEffect(() => {
    const nextTakeAt = offPeakTakeNumberAvailability?.nextTakeAt;
    if (offPeakTakeNumberAvailability?.canTakeNumber !== false || nextTakeAt === undefined) return;
    const delay = Math.max(0, nextTakeAt - Date.now()) + 100;
    const timer = setTimeout(() => {
      setNow(Date.now());
      void offPeakRefreshTakeNumberAvailability(offPeakTaskService);
    }, delay);
    return () => clearTimeout(timer);
  }, [offPeakRefreshTakeNumberAvailability, offPeakTaskService, offPeakTakeNumberAvailability]);

  // The quota tooltip once showed a non-decrementing absolute date; advance the minute boundary per the remote implementation to keep remaining time honest.
  useEffect(() => {
    const nextTakeAt = offPeakTakeNumberAvailability?.nextTakeAt;
    if (offPeakTakeNumberAvailability?.canTakeNumber !== false || nextTakeAt === undefined) return;
    const remainingMs = nextTakeAt - Date.now();
    if (remainingMs <= 0) return;
    const minuteMs = 60_000;
    const remainderMs = remainingMs % minuteMs;
    const delay = (remainderMs === 0 ? minuteMs : remainderMs) + 50;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [now, offPeakTakeNumberAvailability]);

  // Rank/status poll refresh (host offPeakTaskSync writes the DB, renderer reads the snapshot every 10s; no polling with no tasks).
  useEffect(() => {
    if (view.mode !== "list" || offPeakTasks.length === 0) return;
    const timer = setInterval(() => {
      void offPeakRefresh(offPeakTaskService);
    }, 10_000);
    return () => clearInterval(timer);
  }, [view.mode, offPeakTasks.length, offPeakRefresh, offPeakTaskService]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refresh(zcodeAgentService),
        offPeakRefresh(offPeakTaskService),
        ...(offPeakGrayEnabled ? [offPeakRefreshCodingPlanSupport(offPeakTaskService)] : []),
      ]);
      setNow(Date.now());
    } finally {
      setRefreshing(false);
    }
  }, [
    offPeakGrayEnabled,
    offPeakRefresh,
    offPeakRefreshCodingPlanSupport,
    offPeakTaskService,
    refresh,
    zcodeAgentService,
  ]);

  // Arriving from the New-task template card: consume the prefill draft -> switch to the idle tab + open the prefilled create form.
  useEffect(() => {
    const draft = consumePendingCreateDraft();
    if (!draft) return;
    if (currentWorkspaceIsRemote) return;
    setTab("idle");
    setView({ mode: "offpeak-create", draft });
  }, [consumePendingCreateDraft, currentWorkspaceIsRemote]);

  useEffect(() => {
    if (!currentWorkspaceIsRemote) return;
    setTab((current) => (current === "idle" ? "scheduled" : current));
    setView((current) =>
      current.mode === "offpeak-create" || current.mode === "offpeak-edit"
        ? { mode: "list" }
        : current,
    );
  }, [currentWorkspaceIsRemote]);

  const handleOpenCodingPlanUpgrade = useCallback(() => {
    const providerId =
      sharedSettings?.providerFamilyDomain === "bigmodel"
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    const eventText = intl.formatMessage({
      id: "settings.modelProvider.codingPlan.upgrade",
    });
    // Why the instrumentation was missing: Automations' idle entry bypassed the purchase-funnel context and only opened the dialog.
    // Freeze the entry plan state on click; the later OAuth refreshes auth only, never rebuilding the funnel.
    openCodingPlanUpgrade({
      providerId,
      initialAudience: "personal",
      funnelContext: createIdleTimeCodingPlanFunnelContext({
        providerId,
        eventText,
        entryPlanState: resolveCodingPlanEntryPlanStateFromProviderSettings(providerSettingsView),
      }),
    });
  }, [intl, openCodingPlanUpgrade, providerSettingsView, sharedSettings?.providerFamilyDomain]);

  const showCodingPlanRequiredToast = useCallback(() => {
    toast(entryLabel ?? intl.formatMessage({ id: "offPeak.create.codingPlanToast" }), {
      durationMs: 8000,
      position: "top-center",
      variant: "info",
      actionLabel:
        entryStatus === "loading"
          ? undefined
          : (entryLabel ??
            intl.formatMessage({
              id: "settings.modelProvider.codingPlan.upgrade",
            })),
      onAction: entryStatus === "error" ? retryEntry : handleOpenCodingPlanUpgrade,
      dismissible: true,
      dismissLabel: intl.formatMessage({ id: "common.close" }),
    });
  }, [handleOpenCodingPlanUpgrade, intl, entryStatus, entryLabel, retryEntry]);

  const showAutomationCreateLimitToast = useCallback(() => {
    toast(
      intl.formatMessage(
        { id: "automations.error.createLimit" },
        { limit: String(AUTOMATION_CREATE_LIMIT) },
      ),
    );
  }, [intl]);

  // The in-session OffPeakCreate writes directly via the agent, bypassing the UI store; the store's loading starts
  // false too ("not loaded" indistinguishable from "loaded"). So every offpeak navigation force-refreshes the list and uses
  // "the refresh for this navigation id completed" as the only readiness signal, avoiding stale/empty lists misjudging targetNotFound.
  const [offPeakNavRefreshed, setOffPeakNavRefreshed] = useState<{
    id: string | null;
    error: string | null;
  }>({ id: null, error: null });
  useEffect(() => {
    if (!isOffPeakDetailNavigationId(openAutomationId)) return;
    let disposed = false;
    void offPeakRefresh(offPeakTaskService).finally(() => {
      if (disposed) return;
      // review: refresh never rejects, failures only set store.error; carry it out alongside the readiness signal.
      setOffPeakNavRefreshed({
        id: openAutomationId ?? null,
        error: useOffPeakTaskStore.getState().error ?? null,
      });
    });
    return () => {
      disposed = true;
    };
  }, [openAutomationId, offPeakRefresh, offPeakTaskService]);

  useEffect(() => {
    // The idle tail card carries an offpeak- prefixed id and resolves into the offpeak-edit view via the parallel path;
    // it must not fall into cron resolution (always missing, falsely reporting targetNotFound).
    if (isOffPeakDetailNavigationId(openAutomationId)) {
      const result = resolveOffPeakDetailNavigation(
        offPeakTasks,
        openAutomationId,
        offPeakNavRefreshed.id === openAutomationId,
        offPeakNavRefreshed.error,
      );
      if (result.status === "pending") return;
      if (result.status === "found") {
        setTab("idle");
        setView({ mode: "offpeak-edit", task: result.target });
      } else if (result.status === "unavailable") {
        // List refresh failed: land on the idle tab with a load-failed notice, not a false "task not found".
        setTab("idle");
        toast(intl.formatMessage({ id: "offPeak.nav.listUnavailable" }));
      } else {
        toast(intl.formatMessage({ id: "automations.error.targetNotFound" }));
      }
      onOpenAutomationConsumed?.();
      return;
    }
    const currentWorkspaceKey = workspacePath
      ? resolveWorkspaceKey({ workspacePath, workspaceIdentity })
      : null;
    const result = resolveAutomationDetailNavigation(
      automations,
      openAutomationId,
      currentWorkspaceKey !== null && loadedWorkspaceKey === currentWorkspaceKey,
    );
    if (result.status === "pending") return;
    if (result.status === "found") {
      setView({ mode: "edit", automation: result.target });
    } else {
      // The target task may be deleted; a dead one-shot navigation must toast and consume without hurting later entries.
      toast(intl.formatMessage({ id: "automations.error.targetNotFound" }));
    }
    onOpenAutomationConsumed?.();
  }, [
    automations,
    intl,
    loadedWorkspaceKey,
    offPeakNavRefreshed,
    offPeakTasks,
    onOpenAutomationConsumed,
    openAutomationId,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleCreateManually = useCallback(() => {
    if (automationCreateLimitReached) {
      showAutomationCreateLimitToast();
      return;
    }
    setView({ mode: "create", draft: null });
  }, [automationCreateLimitReached, showAutomationCreateLimitToast]);

  // "Create via chat": hand to the parent to switch to the session view; without it, fall back to the manual full page.
  const handleCreateViaChat = useCallback(() => {
    if (automationCreateLimitReached) {
      showAutomationCreateLimitToast();
      return;
    }
    if (currentWorkspaceIsRemote) {
      // Automations creation binds local projects only; a remote current session cannot implicitly become the target.
      // The manage page stays, but creation is narrowed to the form with a local project selector.
      setView({ mode: "create", draft: null });
      return;
    }
    if (onCreateViaChat) {
      onCreateViaChat(intl.formatMessage({ id: "automations.createViaChat.prompt" }));
    } else setView({ mode: "create", draft: null });
  }, [
    automationCreateLimitReached,
    currentWorkspaceIsRemote,
    intl,
    onCreateViaChat,
    showAutomationCreateLimitToast,
  ]);

  const handleUseTemplate = useCallback(
    (template: ScheduledAutomationTemplate) => {
      if (automationCreateLimitReached) {
        showAutomationCreateLimitToast();
        return;
      }
      const draft = materializeScheduledTemplateDraft(template, locale);
      setView({
        mode: "create",
        draft,
      });
    },
    [automationCreateLimitReached, locale, showAutomationCreateLimitToast],
  );

  // Create/edit page submit: create may pick the target project; edit keeps the original locked.
  const handleEditSubmit = useCallback(
    async ({
      input,
      workspacePath: targetPath,
      workspaceIdentity: targetIdentity,
    }: AutomationEditSubmit) => {
      if (view.mode === "edit") {
        const ok = await updateAutomation(view.automation.automationId, input, zcodeAgentService);
        if (!ok) {
          toast(
            intl.formatMessage({
              id: getAutomationActionErrorToastId("update"),
            }),
          );
        } else {
          setNow(Date.now());
        }
        return ok;
      }
      if (automationCreateLimitReached) {
        showAutomationCreateLimitToast();
        return false;
      }
      const created = await createAutomation(
        {
          ...(input as Parameters<typeof createAutomation>[0]),
          workspacePath: targetPath,
          workspaceIdentity: targetIdentity,
        },
        zcodeAgentService,
      );
      void reportAutomationCreateResult(platform, {
        automationId: created?.automationId,
        cronExpr: input.cronExpr ?? "",
        templateId: view.mode === "create" ? view.draft?.templateId : undefined,
        error: useAutomationManagementStore.getState().error,
        modelFields: resolveAutomationSelectionTelemetry(
          input.modelSelection,
          providerSettingsView,
        ),
      });
      if (!created) {
        const createError = useAutomationManagementStore.getState().error;
        toast(
          intl.formatMessage(
            { id: getAutomationCreateErrorToastId(createError) },
            { limit: String(AUTOMATION_CREATE_LIMIT) },
          ),
        );
        return false;
      }
      setNow(Date.now());
      return true;
    },
    [
      automationCreateLimitReached,
      createAutomation,
      intl,
      platform,
      providerSettingsView,
      showAutomationCreateLimitToast,
      updateAutomation,
      view,
      zcodeAgentService,
    ],
  );

  const handleToggle = useCallback(
    async (automation: ZCodeAutomation, enabled: boolean) => {
      await setEnabled(automation.automationId, enabled, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message) toast(intl.formatMessage({ id: getAutomationActionErrorToastId("toggle") }));
      else {
        // The edit view holds the automation object captured at entry; a list refresh does not swap
        // that local object, so after Pause/Resume from the menu the copy stuck on the old state.
        setView((prev) =>
          prev.mode === "edit" && prev.automation.automationId === automation.automationId
            ? {
                mode: "edit",
                automation: {
                  ...prev.automation,
                  enabled,
                  lifecycleStatus: enabled ? "active" : "paused",
                },
              }
            : prev,
        );
        setNow(Date.now());
      }
    },
    [intl, setEnabled, zcodeAgentService],
  );

  const handleRestart = useCallback(
    async (automation: ZCodeAutomation) => {
      await restartAutomation(automation.automationId, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message)
        toast(
          intl.formatMessage({
            id: getAutomationActionErrorToastId("restart"),
          }),
        );
      else setNow(Date.now());
    },
    [intl, restartAutomation, zcodeAgentService],
  );

  const handleRunNow = useCallback(
    async (automation: ZCodeAutomation, source: "list" | "editor" = "list") => {
      logger.debug("[automations] run-now interaction start", {
        automationId: automation.automationId,
        source,
      });
      void reportAutomationActionClick(platform, {
        action: "run_now",
        source,
        automation,
        providerSettingsView,
      });
      const result = await runAutomationNow(automation.automationId, zcodeAgentService);
      logger.debug("[automations] run-now interaction end", {
        automationId: automation.automationId,
        source,
        result,
      });
      if (result === "queued") {
        await loadRuns(automation.automationId, zcodeAgentService, true);
        const latestSessionId = useAutomationManagementStore
          .getState()
          .runsCache[automation.automationId]?.runs?.find(
            (run) => run.trigger === "manual" && Boolean(run.sessionId),
          )?.sessionId;
        toast(
          intl.formatMessage({ id: "scheduledPreview.toast.running" }, { title: automation.title }),
          {
            durationMs: 4000,
            position: "top-center",
            variant: "info",
            ...(latestSessionId && onOpenSession
              ? {
                  actionLabel: intl.formatMessage({
                    id: "scheduledPreview.toast.view",
                  }),
                  onAction: () =>
                    onOpenSession({
                      sessionId: latestSessionId,
                      workspacePath: automation.workspacePath,
                      workspaceIdentity: automation.workspaceIdentity,
                    }),
                }
              : {}),
            dismissible: true,
            dismissLabel: intl.formatMessage({ id: "common.close" }),
          },
        );
        setNow(Date.now());
      } else if (result === "duplicate") {
        // Repeated clicks or a still-running previous manual run make store/host return duplicate.
        // Visible feedback is required, or the button reads as dead.
        toast(intl.formatMessage({ id: getAutomationRunNowToastId(result) }));
      } else if (result === "failed") {
        toast(intl.formatMessage({ id: getAutomationRunNowToastId(result) }));
      }
    },
    [
      intl,
      loadRuns,
      onOpenSession,
      platform,
      providerSettingsView,
      runAutomationNow,
      zcodeAgentService,
    ],
  );

  const handleDelete = useCallback(
    async (automation: ZCodeAutomation, source: "list" | "editor" = "list") => {
      const confirmed = await confirmDialog({
        presentation: "automation-confirmation",
        title: intl.formatMessage({ id: "automations.delete.title" }),
        description: intl.formatMessage(
          { id: "automations.delete.description" },
          { title: automation.title },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
        confirmVariant: "destructive",
        // The shared confirm dialog renders esc / ⏎ right of the button by default, which reads as extra icons in the delete case.
        // The scheduled-task delete button keeps action text only, without changing other confirms' key-hint policy.
        showKeyboardHints: false,
      });
      if (!confirmed) return;
      void reportAutomationActionClick(platform, {
        action: "delete",
        source,
        automation,
        providerSettingsView,
      });
      await deleteAutomation(automation.automationId, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message) toast(intl.formatMessage({ id: getAutomationActionErrorToastId("delete") }));
      // If editing this task's page, return to the list after delete.
      setView((prev) =>
        prev.mode === "edit" && prev.automation.automationId === automation.automationId
          ? { mode: "list" }
          : prev,
      );
    },
    [confirmDialog, deleteAutomation, intl, platform, providerSettingsView, zcodeAgentService],
  );

  const handleOffPeakOpenSession = useCallback(
    (task: ZCodeOffPeakTask) => {
      if (!task.sessionId || !onOpenSession) return;
      onOpenSession({
        sessionId: task.sessionId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });
    },
    [onOpenSession],
  );

  const handleOffPeakOpen = useCallback((task: ZCodeOffPeakTask) => {
    // A card with a session must not jump to the session on primary click: it makes Settings/History
    // unstable to reach. The card's primary path always enters task detail; the session stays an explicit secondary action.
    setView({ mode: "offpeak-edit", task });
  }, []);

  const handleOffPeakCancel = useCallback(
    async (task: ZCodeOffPeakTask) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "offPeak.cancel.title" }),
        description: intl.formatMessage(
          { id: "offPeak.cancel.description" },
          { title: task.title || task.prompt },
        ),
        confirmLabel: intl.formatMessage({ id: "offPeak.action.cancel" }),
      });
      if (!confirmed) return;
      await offPeakCancel(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
    },
    [confirmDialog, intl, offPeakCancel, offPeakTaskService],
  );

  const handleOffPeakDelete = useCallback(
    async (task: ZCodeOffPeakTask) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "offPeak.delete.title" }),
        description: intl.formatMessage({ id: "offPeak.delete.description" }),
        confirmLabel: intl.formatMessage({ id: "offPeak.delete.confirm" }),
      });
      if (!confirmed) return;
      await offPeakDelete(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
      setView((prev) =>
        prev.mode === "offpeak-edit" && prev.task.offPeakTaskId === task.offPeakTaskId
          ? { mode: "list" }
          : prev,
      );
    },
    [confirmDialog, intl, offPeakDelete, offPeakTaskService],
  );

  const handleOffPeakDeleteHistory = useCallback(
    async (task: ZCodeOffPeakTask) => {
      await offPeakDeleteHistory(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
    },
    [offPeakDeleteHistory, offPeakTaskService],
  );

  const handleOffPeakSubmit = useCallback(
    async (input: OffPeakEditSubmit) => {
      const current = view;
      const telemetrySnapshot =
        current.mode === "offpeak-create"
          ? freezeOffPeakCreateTelemetrySnapshot({
              source: current.draft?.telemetrySource,
              model: input.modelSelection.modelId,
              providerId: input.modelSelection.providerId,
            })
          : null;
      if (current.mode !== "offpeak-edit" && offPeakCreateGrey.reason !== null) {
        if (offPeakCreateGrey.reason === "plan") {
          showCodingPlanRequiredToast();
        } else if (offPeakCreateGrey.reason === "unavailable") {
          toast(intl.formatMessage({ id: "offPeak.error.unavailable" }));
        } else {
          toast(offPeakCreateGrey.tooltip ?? intl.formatMessage({ id: "offPeak.error.quota" }));
        }
        if (telemetrySnapshot) {
          void reportOffPeakCreateResult(platform, telemetrySnapshot, {
            ok: false,
            failureStage: "client_validation",
            errorCategory: "client_validation",
            errorCode: "",
            providerName: "",
          });
        }
        return false;
      }
      if (current.mode === "offpeak-edit") {
        const updated = await offPeakUpdate(
          current.task.offPeakTaskId,
          {
            title: input.title,
            prompt: input.prompt,
            permissionMode: input.permissionMode,
            modelSelection: input.modelSelection,
          },
          offPeakTaskService,
        );
        if (!updated) {
          toast(intl.formatMessage({ id: "offPeak.error.generic" }));
        }
        return updated;
      }

      const result =
        telemetrySnapshot !== null
          ? await createAndReportOffPeakTask(platform, telemetrySnapshot, () =>
              offPeakCreate(input, offPeakTaskService),
            )
          : await offPeakCreate(input, offPeakTaskService);
      if (!result.ok) {
        toast(
          intl.formatMessage({
            id: resolveOffPeakCreateErrorMessageId(result),
          }),
        );
      }
      return result.ok;
    },
    [
      intl,
      offPeakCreate,
      offPeakCreateGrey,
      offPeakTaskService,
      offPeakUpdate,
      platform,
      showCodingPlanRequiredToast,
      view,
    ],
  );

  if (!workspacePath) {
    return (
      <div className="rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "automations.noWorkspace" })}
      </div>
    );
  }

  // Idle-task create/edit page (the form pattern).
  if (view.mode === "offpeak-create" || view.mode === "offpeak-edit") {
    const editingTask =
      view.mode === "offpeak-edit"
        ? (offPeakTasks.find((task) => task.offPeakTaskId === view.task.offPeakTaskId) ?? view.task)
        : null;
    return (
      <>
        <OffPeakEditView
          editing={editingTask}
          initialDraft={view.mode === "offpeak-create" ? (view.draft ?? null) : null}
          modelSelectionView={
            offPeakGrayConfig?.modelSelectionView ?? { revision: 0, providers: [] }
          }
          defaultWorkspacePath={workspacePath ?? ""}
          defaultWorkspaceIdentity={workspaceIdentity}
          saving={
            offPeakOperationId?.startsWith("offpeak:create") ||
            offPeakOperationId?.startsWith("offpeak:update") ||
            false
          }
          createBlocked={view.mode === "offpeak-create" && offPeakCreateGrey.reason !== null}
          createBlockedTooltip={offPeakCreateGrey.tooltip}
          onBack={() => setView({ mode: "list" })}
          onSubmit={handleOffPeakSubmit}
          onOpenSession={onOpenSession}
          onDelete={(task) => void handleOffPeakDelete(task)}
          onDeleteHistory={(task) => void handleOffPeakDeleteHistory(task)}
          onPause={(task) => void offPeakPause(task.offPeakTaskId, offPeakTaskService)}
          onContinue={(task) => void offPeakContinue(task.offPeakTaskId, offPeakTaskService)}
          showToast={toast}
        />
      </>
    );
  }

  // Create/edit page (with Settings/History tabs).
  if (view.mode !== "list") {
    return (
      <>
        <AutomationEditView
          editing={view.mode === "edit" ? view.automation : null}
          initialDraft={view.mode === "create" ? view.draft : null}
          defaultWorkspacePath={workspacePath}
          defaultWorkspaceIdentity={workspaceIdentity}
          saving={
            operationId?.startsWith("automation:create") ||
            operationId?.startsWith("automation:update") ||
            false
          }
          onBack={() => setView({ mode: "list" })}
          onSubmit={handleEditSubmit}
          onRunNow={(automation) => handleRunNow(automation, "editor")}
          onToggle={handleToggle}
          onDelete={(automation) => handleDelete(automation, "editor")}
          runsEntry={view.mode === "edit" ? runsCache[view.automation.automationId] : undefined}
          onLoadRuns={() => {
            if (view.mode === "edit")
              void loadRuns(view.automation.automationId, zcodeAgentService, true);
          }}
          onDeleteRun={(runId) => {
            if (view.mode === "edit") {
              void deleteRun(view.automation.automationId, runId, zcodeAgentService);
            }
          }}
          onOpenSession={
            view.mode === "edit" && onOpenSession
              ? (sessionId) => {
                  // The run-history jump previously had no navigation callback from the parent, so even with run.sessionId
                  // written into automation_runs the menu hid "go to session".
                  onOpenSession({
                    sessionId,
                    workspacePath: view.automation.workspacePath,
                    workspaceIdentity: view.automation.workspaceIdentity,
                  });
                }
              : undefined
          }
        />
      </>
    );
  }

  // The page title is the top-level switch: the two titles
  // sit side by side at 30/34, keeping the h1 page-title hierarchy; the subtitle follows the tab.
  const pageHeader = (
    <div className="flex flex-col gap-3">
      <AutomationsPageTitle
        workflowTabEnabled={dynamicWorkflowEnabled}
        value={pageTab}
        onValueChange={setPageTab}
      />
      <p className="text-ui-base leading-5 text-foreground-subtlest">
        {intl.formatMessage({
          id:
            pageTab === "workflow"
              ? "workflows.hub.description"
              : hasAnyTasks
                ? "automations.description.populated"
                : "automations.description",
        })}
      </p>
    </div>
  );

  if (pageTab === "workflow") {
    return (
      <SavedWorkflowsSection
        header={pageHeader}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        onNavigateToLaunchedRun={onNavigateToLaunchedRun}
        onCreateViaChat={onCreateViaChat}
        onOpenWorkflowRun={onOpenWorkflowRun}
        onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        openWorkflow={openWorkflow}
        onOpenWorkflowConsumed={onOpenWorkflowConsumed}
      />
    );
  }

  return (
    <div data-automations-content className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col")}>
      {pageHeader}

      {/* Tabs: Scheduled resident; Idle appears only on rollout hit or with idle backlog; no mixed All view.
         Create aligns right when tasks exist (4866-1735); the empty-state entry lives inside the big card (4889-2013), not duplicating the top bar. */}
      {visibleTabs.length > 0 ? (
        <div className="mt-8 flex items-center justify-between">
          {/* Tabs shared 12px gap with the right action group, missing the latest 8px compact rhythm.*/}
          <div className="flex items-center gap-2" data-testid={TID_OFFPEAK_TAB}>
            {/* The unselected state forces no surface background, keeping hierarchy against hover/selected.*/}
            {visibleTabs.map((key) => (
              <button
                key={key}
                type="button"
                className={cn(
                  "rounded-full px-3 py-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                  tab === key
                    ? "bg-selected text-foreground"
                    : "text-foreground-subtle hover:bg-hover hover:text-foreground",
                )}
                onClick={() => setTab(key)}
              >
                {intl.formatMessage({ id: `offPeak.tabs.${key}` })}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <ControlHintTooltip
              title={intl.formatMessage({
                id: refreshing ? "automations.refreshing" : "automations.refresh",
              })}
            >
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={intl.formatMessage({ id: "automations.refresh" })}
                onClick={() => void handleRefresh()}
                disabled={refreshing}
              >
                <AutomationRefreshIcon
                  className={cn("size-3.5", refreshing && "animate-spin")}
                  aria-hidden="true"
                />
              </Button>
            </ControlHintTooltip>
            {tab !== "idle" ? (
              <AutomationCreateDropdown
                onViaChat={handleCreateViaChat}
                onManually={handleCreateManually}
              />
            ) : null}
            {showOffPeakTemplates ? (
              <OffPeakCreateButton
                greyReason={offPeakCreateGrey.reason}
                greyTooltip={offPeakCreateGrey.tooltip}
                onCreate={() => setView({ mode: "offpeak-create" })}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Status filter: shared by scheduled / idle (all / running / completed / failed), only when the current tab has tasks.
         Same pill style as the header tabs, smaller type and padding for hierarchy. */}
      {visibleTabs.length > 0 && hasVisibleTaskCards ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-1.5"
          data-testid={TID_AUTOMATIONS_STATUS_FILTER}
        >
          {AUTOMATION_STATUS_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={statusFilter === key}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-ui-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                statusFilter === key
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover hover:text-foreground",
              )}
              onClick={() => setStatusFilter(key)}
            >
              {intl.formatMessage({ id: `automations.statusFilter.${key}` })}
            </button>
          ))}
        </div>
      ) : null}

      {loading && automations.length === 0 && offPeakTasks.length === 0 ? (
        <div className="mt-8 flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-8",
            // The list notice bar to action-row gap was 16px, under the spec's 20px.
            hasAnyTasks ? "mt-5" : "mt-8",
          )}
        >
          <div className="flex w-full flex-col gap-4">
            {/* keep-awake is a global switch (mirrored in Settings > General); scheduled runs benefit too,
               so it shows on both tabs. In list state it sits before the task cards; the empty state keeps the big empty card first. */}
            {hasAnyTasks ? (
              <AutomationKeepAwakeNotice
                checked={sharedSettings?.keepAwakeWhileRunning ?? false}
                onChange={(value) =>
                  void updateSharedSettings({
                    keepAwakeWhileRunning: value,
                  })
                }
              />
            ) : null}

            {/* After dropping the mixed All view the two kinds no longer share a grid; keep the anchor marking the tasks region start. */}
            <div data-automations-task-grid className="contents">
              {offPeakVisible && tab !== "scheduled" && offPeakTasks.length > 0 ? (
                <section className="flex w-full flex-col gap-4">
                  {visibleOffPeakTasks.length === 0 ? (
                    <AutomationStatusFilterEmpty />
                  ) : (
                    <OffPeakTaskList
                      tasks={visibleOffPeakTasks}
                      busyOperationId={offPeakOperationId}
                      onOpen={handleOffPeakOpen}
                      onPause={(task) => void offPeakPause(task.offPeakTaskId, offPeakTaskService)}
                      onContinue={(task) =>
                        void offPeakContinue(task.offPeakTaskId, offPeakTaskService)
                      }
                      onCancel={(task) => void handleOffPeakCancel(task)}
                      onDelete={(task) => void handleOffPeakDelete(task)}
                      onOpenSession={handleOffPeakOpenSession}
                    />
                  )}
                </section>
              ) : null}

              {/* Task created: real scheduled tasks in this project (all). The whole card opens edit.
                 On the idle tab the entire scheduled region (cards/empty/creation) renders nothing. */}
              {tab === "idle" ? null : automations.length > 0 ? (
                <section className="flex w-full flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                      {intl.formatMessage({ id: "automations.createdLabel" })}
                    </h2>
                    {/* Without the tab row the create entry sits right of the section title; with it, the entry is in the header — avoid duplicates. */}
                    {visibleTabs.length === 0 ? (
                      <AutomationCreateDropdown
                        onViaChat={handleCreateViaChat}
                        onManually={handleCreateManually}
                      />
                    ) : null}
                  </div>
                  {visibleAutomations.length === 0 ? (
                    <AutomationStatusFilterEmpty />
                  ) : (
                    <div
                      data-testid={TID_AUTOMATIONS_LIST}
                      className={cn(
                        "grid grid-cols-1 auto-rows-[132px] gap-x-4 gap-y-4 lg:grid-cols-2",
                        // The spec reveals at most 8 cards; the grid scrolls itself. Threshold on the filtered count,
                        // else a small filtered set locks the height and leaves a large blank area.
                        visibleAutomations.length > 8 &&
                          "max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]",
                      )}
                    >
                      {visibleAutomations.map((automation) => {
                        const status = resolveAutomationStatusKind(automation);
                        const hasFailure = hasAutomationFailureState(automation);
                        const statusMeta = STATUS_META[status];
                        const StatusIcon = statusMeta.icon;
                        const scheduleText = describeAutomationCardSchedule(automation, intl);
                        const formattedNextRun = formatAutomationCardNextRun(
                          automation.nextRunAt,
                          now,
                          intl,
                        );
                        // Terminal/paused/failed schedules no longer advance, but a limited-run task's nextRunAt
                        // may still point at the future and was concatenated onto cards as a false "next run". Only active,
                        // non-failed cards append next run; everything else shows the frequency summary only.
                        const scheduleCardText =
                          status === "active" && !hasFailure && formattedNextRun
                            ? `${scheduleText} · ${intl.formatMessage(
                                { id: "automations.nextRun" },
                                { when: formattedNextRun },
                              )}`
                            : scheduleText;
                        // The card shows scheduled + manual dispatch totals; maxRuns bounds the schedule only —
                        // as the denominator it would read as if run-now consumed limited-run quota.
                        const runCountText = intl.formatMessage(
                          { id: "automations.runCount" },
                          { count: String(automation.runCount) },
                        );
                        const busy = operationId?.endsWith(`:${automation.automationId}`) ?? false;
                        // completed means a limited-run task ended naturally and cannot revive via Restart;
                        // failed is the recoverable terminal state, allowing a manual reschedule.
                        const canRestart = canRestartAutomation(automation);
                        const canToggle = canToggleAutomation(automation);
                        return (
                          <div
                            key={automation.automationId}
                            data-testid={TID_AUTOMATION_CARD}
                            role="button"
                            tabIndex={0}
                            onClick={() => setView({ mode: "edit", automation })}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setView({ mode: "edit", automation });
                              }
                            }}
                            className={cn(
                              // Task cards and template cards used surface/border respectively; border depth diverged across themes.
                              "group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                              // Completed tasks stay statically dimmed; hover restores no opacity nor changes the surface.
                              status === "completed" ? "opacity-60" : "hover:bg-hover",
                            )}
                          >
                            <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
                              <span className="block truncate pr-12 text-ui-base font-medium leading-5 text-foreground">
                                {automation.title}
                              </span>
                              <p className="text-wrap-phrase line-clamp-2 h-10 text-ui-base font-normal leading-5 text-foreground-subtle">
                                {automationPromptSummary(automation.prompt)}
                              </p>
                              <div className="mt-auto flex h-6 min-w-0 items-center gap-2 text-ui-base leading-5">
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                  {hasFailure ? (
                                    <>
                                      <span className="inline-flex shrink-0 items-center py-0.5 pl-1 pr-2 font-normal text-destructive">
                                        <span className="flex size-5 shrink-0 items-center justify-center">
                                          <TriangleAlert
                                            className="size-4"
                                            strokeWidth={1.33}
                                            aria-hidden="true"
                                          />
                                        </span>
                                        <span className="pl-1">
                                          {intl.formatMessage({
                                            id: "automations.lifecycle.failed",
                                          })}
                                        </span>
                                      </span>
                                      {/* Failed also shows only the cron summary; never miswrite a stale nextRunAt as "next run". */}
                                      <span className="inline-flex min-w-0 items-center rounded-md bg-success/10 py-0.5 pl-1 pr-2 font-normal text-success opacity-40">
                                        <span className="flex size-5 shrink-0 items-center justify-center">
                                          <AutomationClockIcon
                                            className="size-4"
                                            aria-hidden="true"
                                          />
                                        </span>
                                        <span className="truncate pl-1">{scheduleCardText}</span>
                                      </span>
                                    </>
                                  ) : status === "active" ? (
                                    <AutomationScheduleBadge
                                      text={scheduleCardText}
                                      icon={
                                        <StatusIcon
                                          className="size-4 shrink-0"
                                          strokeWidth={1.33}
                                          aria-hidden="true"
                                        />
                                      }
                                    />
                                  ) : (
                                    <>
                                      <span
                                        className={cn(
                                          "inline-flex shrink-0 items-center gap-1 font-normal",
                                          statusMeta.className,
                                        )}
                                      >
                                        <span className="flex size-5 shrink-0 items-center justify-center">
                                          <StatusIcon
                                            className="size-4 shrink-0"
                                            strokeWidth={1.33}
                                            aria-hidden="true"
                                          />
                                        </span>
                                        {intl.formatMessage({
                                          id: `automations.lifecycle.${status}`,
                                        })}
                                      </span>
                                      {status === "paused" || status === "completed" ? (
                                        /* Paused/completed schedules no longer advance: cron summary only, no nextRunAt. */
                                        <AutomationScheduleBadge
                                          dimmed
                                          text={scheduleCardText}
                                          icon={
                                            <AutomationClockIcon
                                              className="size-4"
                                              aria-hidden="true"
                                            />
                                          }
                                        />
                                      ) : null}
                                    </>
                                  )}
                                </div>
                                <span
                                  className={cn(
                                    "inline-flex shrink-0 items-center whitespace-nowrap rounded-md bg-surface px-1.5 py-0.5 text-ui-base font-normal text-foreground-subtle",
                                    (hasFailure || status === "paused") && "opacity-40",
                                  )}
                                >
                                  {runCountText}
                                </span>
                              </div>
                            </div>

                            <div className="absolute right-3 top-3 flex items-center gap-1">
                              {busy ? <Spinner className="size-3.5" /> : null}
                              <AutomationActionsMenu
                                automation={automation}
                                busy={busy}
                                canRestart={canRestart}
                                canToggle={canToggle}
                                onRunNow={handleRunNow}
                                onEdit={(target) => setView({ mode: "edit", automation: target })}
                                onToggle={handleToggle}
                                onRestart={handleRestart}
                                onDelete={handleDelete}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              ) : (
                /* The empty-state card precedes Keep-awake; the button group sits 8px below card center. */
                <div
                  data-automations-empty-state
                  className="flex h-[226px] w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4"
                >
                  <div className="flex translate-y-2 flex-col items-center gap-5">
                    <p className="text-ui-base font-medium leading-5 text-foreground-subtlest">
                      {intl.formatMessage({ id: "automations.empty.title" })}
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <AutomationCreateDropdown
                        onViaChat={handleCreateViaChat}
                        onManually={handleCreateManually}
                      />
                      {/* With idle tasks the header already has the create entry; the empty card does not repeat it (4866-1735 vs 4889-2013). */}
                      {offPeakCreationEnabled && offPeakTasks.length === 0 ? (
                        <OffPeakCreateButton
                          greyReason={offPeakCreateGrey.reason}
                          greyTooltip={offPeakCreateGrey.tooltip}
                          onCreate={() => setView({ mode: "offpeak-create" })}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Empty state keeps the keep-awake notice after the big empty card. */}
            {!hasAnyTasks ? (
              <AutomationKeepAwakeNotice
                checked={sharedSettings?.keepAwakeWhileRunning ?? false}
                onChange={(value) =>
                  void updateSharedSettings({
                    keepAwakeWhileRunning: value,
                  })
                }
              />
            ) : null}
          </div>

          {/* Real task cards and templates cannot be split by whitespace alone: a divider is required;
             surface is too faint in Light, so use card-border like Card.
             Outer gap-8 plus this container's py-2 keep 40px from card to line and line to template title. */}
          {showTaskTemplateSeparator ? (
            <div
              data-automations-task-template-separator
              className="flex w-full flex-col py-2"
              aria-hidden="true"
            >
              <div className="h-px w-full bg-card-border" />
            </div>
          ) : null}

          {/* Idle-time task template (rollout hit; same copy as the New task page). */}
          {showOffPeakTemplates ? (
            <section
              data-automations-idle-templates
              aria-busy={automationTemplates.loading}
              className="flex w-full flex-col gap-4"
            >
              <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                {intl.formatMessage({ id: "offPeak.templates.sectionTitle" })}
              </h2>
              {automationTemplates.loading ? (
                <AutomationTemplateSkeletonGrid
                  label={intl.formatMessage({ id: "common.loading" })}
                />
              ) : automationTemplates.offPeak.length === 0 ? (
                <div
                  data-automation-template-empty-state
                  className="flex min-h-[114px] w-full items-center justify-center rounded-xl border border-card-border bg-background p-3 text-center text-ui-base font-normal text-foreground-subtlest"
                >
                  {intl.formatMessage({ id: "automations.templates.unavailable" })}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                  {automationTemplates.offPeak.map((template) => {
                    const planLocked = offPeakCreateGrey.reason === "plan";
                    const card = (
                      <button
                        type="button"
                        onClick={() => {
                          if (planLocked) {
                            showCodingPlanRequiredToast();
                            return;
                          }
                          const materializedDraft = materializeOffPeakTemplateDraft(
                            template,
                            locale,
                          );
                          setView({
                            mode: "offpeak-create",
                            draft: template.customize
                              ? {
                                  telemetrySource: {
                                    eventRegion: "app.automations",
                                    templateId: template.id,
                                  },
                                }
                              : {
                                  title: materializedDraft.title,
                                  prompt: materializedDraft.prompt,
                                  telemetrySource: {
                                    eventRegion: "app.automations",
                                    templateId: template.id,
                                  },
                                },
                          });
                        }}
                        // The grid wrapper stretches to the row height, but the card itself needs h-full to inherit the row's max height; with min-height alone, short-copy cards sit shorter.
                        className="flex h-full min-h-[114px] w-full flex-col gap-2 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      >
                        <div className="flex items-center gap-0.5 text-foreground">
                          <OffPeakTemplateIcon
                            className="size-4 shrink-0"
                            iconName={template.iconName}
                            name={template.icon}
                          />
                          <span className="truncate px-1 text-ui-base font-medium leading-5 text-foreground">
                            {resolveOffPeakTemplateText(
                              template,
                              "title",
                              locale,
                              intl.formatMessage,
                            )}
                          </span>
                        </div>
                        <p className="text-wrap-phrase line-clamp-2 flex-1 text-ui-base font-normal leading-5 text-foreground-subtle">
                          {resolveOffPeakTemplateText(
                            template,
                            "description",
                            locale,
                            intl.formatMessage,
                          )}
                        </p>
                        <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                          {intl.formatMessage({
                            id: "offPeak.form.soonestAvailable",
                          })}
                        </div>
                      </button>
                    );
                    return (
                      <div key={template.id} className="h-full">
                        {card}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {/* Scheduled task template: Client Scenes candidates; clicking only prefills the create page. Hidden on the idle tab. */}
          {showScheduledTemplates ? (
            <section
              data-automations-scheduled-templates
              aria-busy={automationTemplates.loading}
              className="flex w-full flex-col gap-4"
            >
              <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                {intl.formatMessage({ id: "automations.moreIdeas" })}
              </h2>
              {automationTemplates.loading ? (
                <AutomationTemplateSkeletonGrid
                  label={intl.formatMessage({ id: "common.loading" })}
                />
              ) : automationTemplates.scheduled.length === 0 ? (
                <div
                  data-automation-template-empty-state
                  className="flex min-h-[114px] w-full items-center justify-center rounded-xl border border-card-border bg-background p-3 text-center text-ui-base font-normal text-foreground-subtlest"
                >
                  {intl.formatMessage({ id: "automations.templates.unavailable" })}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {automationTemplates.scheduled.map((template) => {
                    return (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => handleUseTemplate(template)}
                        className="group flex min-h-[114px] flex-col gap-2 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      >
                        <div className="flex min-w-0 items-center gap-1 text-foreground">
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            <AutomationScheduledTemplateIcon
                              iconName={template.iconName}
                              name={template.icon}
                            />
                          </span>
                          <span className="truncate text-ui-base font-medium leading-5 text-foreground">
                            {resolveAutomationTemplateText(template.title, locale)}
                          </span>
                        </div>
                        {/* The scheduled template once concatenated the schedule time into the title row, inconsistent with the idle template's bottom meta tier. */}
                        <p className="line-clamp-2 flex-1 text-ui-base font-normal leading-5 text-foreground-subtle">
                          {resolveAutomationTemplateText(template.description, locale)}
                        </p>
                        <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                          {describeAutomationCardSchedule({ cronExpr: template.cronExpr }, intl)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
