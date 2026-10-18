// The control pair in the completion card and run pane headers (docs/dynamic-workflow/transcript-and-notifications.md
// 「Saving the run, and running it again」）：
//
//   leading  -- the saved chip: a fact about the file, not run status, hence a neutral ground not green;
//   trailing -- Save / Run again: the moment a run finishes is exactly when one knows whether it is worth keeping.
//
// Both slots share one controller (`useWorkflowRunSave`), so the same run says the same thing on card
// and pane. Returns ReactNode instead of rendering as a component: the two header slots are structurally
// separate, yet must sit on the very same query.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ArrowUpRightIcon, PlayIcon, SaveIcon } from "lucide-react";
import {
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
  type ZCodeWorkflowsForRunCandidate,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorkflowRunSave } from "@/hooks/useWorkflowRunSave.js";
import { useSavedWorkflowHub } from "@/v4/savedWorkflowHubContext.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  buildAutomationWorkspaceOptions,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import { SavedWorkflowLaunchDialog } from "@/settings/saved-workflows/SavedWorkflowLaunchDialog.js";
import { WorkflowSavePopover } from "./WorkflowSavePopover.js";
import { buildWorkflowSaveRequestPrompt, type WorkflowSaveDraft } from "./workflowRunSave.js";

export interface WorkflowRunSaveSlotsHost {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  runId: string;
  /** Run name: the popover prefills its description from it; the handed-to-ZCode message names which run just finished. */
  runName?: string;
  /** Transcript spots where SaveWorkflow claimed this run (`buildWorkflowSaveCandidatesByRunId`). */
  candidates?: readonly ZCodeWorkflowsForRunCandidate[];
  /**
   * Both gates (read-only, rollout) open: default false. Closed means no trailing at all — writing the
   * file and starting the engine go wherever Resume was withdrawn. The chip is fact and ignores the gates.
   */
  canSave?: boolean;
  /** Sends the user message; absent leaves the popover its direct-save half only. */
  sendLead?: (text: string) => Promise<void>;
  /**
   * When the verb collapses to icon-only: `card` (default) under a 480px completion card (the card's
   * container query); `never` keeps the label (the run pane's status header: labels everywhere, and no
   * wf-card container there).
   */
  verbWord?: "card" | "never";
}

export interface WorkflowRunSaveSlots {
  leading: ReactNode;
  trailing: ReactNode;
}

/** Under this card width the verb turns icon-only (the word moves to aria-label and tooltip). */
const SAVE_WORD_CONTAINER = "@[480px]/wf-card:inline";

export function useWorkflowRunSaveSlots(host: WorkflowRunSaveSlotsHost): WorkflowRunSaveSlots {
  const { intl, locale } = useZCodeIntl();
  const format = (id: string) => intl.formatMessage({ id });
  const hub = useSavedWorkflowHub();
  const anchorRef = useRef<HTMLElement | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [launchEntry, setLaunchEntry] = useState<ZCodeSavedWorkflowEntry | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  const controller = useWorkflowRunSave({
    workspacePath: host.workspacePath,
    ...(host.workspaceIdentity === undefined ? {} : { workspaceIdentity: host.workspaceIdentity }),
    ...(host.remoteSessionId === undefined ? {} : { remoteSessionId: host.remoteSessionId }),
    runId: host.runId,
    ...(host.candidates === undefined ? {} : { candidates: host.candidates }),
    ...(hub === null ? {} : { onNavigateToRun: hub.navigateToRun }),
  });
  const entry = controller.entry;

  // The global profile's run-in candidates: the same table as the hub's global group (local projects, no
  // remote). Defaults to this run's own project — hitting Run again on a card most naturally lands back
  // in the project it ran in.
  const tabs = useOptionalTabStore((store) => store.tabs);
  const localProjects = useMemo<AutomationWorkspaceOption[]>(
    () => buildAutomationWorkspaceOptions(tabs).filter((project) => !project.remoteSessionId),
    [tabs],
  );
  const runProjectKey = useMemo(
    () =>
      resolveWorkspaceKey({
        workspacePath: host.workspacePath,
        ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
      }),
    [host.workspacePath, host.workspaceIdentity],
  );

  const sendLead = host.sendLead;
  const leadHandler =
    sendLead === undefined
      ? undefined
      : async (draft: WorkflowSaveDraft) => {
          await sendLead(
            buildWorkflowSaveRequestPrompt({
              locale,
              runId: host.runId,
              ...(host.runName === undefined ? {} : { runName: host.runName }),
              name: draft.name,
              scope: draft.scope,
              description: draft.description,
            }),
          );
        };

  const handleRunAgain = () => {
    if (entry === undefined || controller.launching) return;
    const hasArgs = entry.args !== undefined && Object.keys(entry.args).length > 0;
    // The global profile always opens the dialog: it needs a run-in project, the user's choice, not the card's guess.
    if (hasArgs || entry.scope === "global") {
      controller.clearLaunchError();
      setLaunchEntry(entry);
      return;
    }
    // Outside the dialog: failures surface as a toast, worded from the launcher's own reason table (the hub's run path).
    void controller.launch(entry, {}).then((result) => {
      if (!result.ok) {
        toast(intl.formatMessage({ id: `workflows.hub.launch.error.${result.error.reason}` }));
      }
    });
  };

  const leading =
    entry === undefined ? null : (
      <WorkflowRunSavedChip
        entry={entry}
        label={format("chat.toolCall.workflow.saveRun.chip")}
        {...(hub === null
          ? {}
          : {
              hint: format("chat.toolCall.workflow.saveRun.chip.hint"),
              onOpen: () =>
                hub.openWorkflow({
                  name: entry.name,
                  scope: entry.scope,
                  workspacePath: host.workspacePath,
                  ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
                }),
            })}
      />
    );

  if (host.canSave !== true) return { leading, trailing: null };

  const verb =
    entry === undefined
      ? {
          label: format("chat.toolCall.workflow.saveRun.action"),
          icon: <SaveIcon className="size-3.5" />,
          testId: "workflow-save-open",
          onClick: (element: HTMLElement) => {
            anchorRef.current = element;
            setPopoverOpen((open) => !open);
          },
        }
      : {
          label: controller.launching
            ? format("chat.toolCall.workflow.saveRun.starting")
            : format("chat.toolCall.workflow.saveRun.runAgain"),
          icon: controller.launching ? (
            <Spinner className="size-3.5" />
          ) : (
            <PlayIcon className="size-3.5" />
          ),
          testId: "workflow-save-run-again",
          onClick: handleRunAgain,
        };

  const trailing = (
    <>
      <ControlHintTooltip title={verb.label} side="top">
        <Button
          aria-expanded={entry === undefined ? popoverOpen : undefined}
          aria-haspopup={entry === undefined ? "dialog" : undefined}
          aria-label={verb.label}
          data-icon="inline-start"
          data-testid={verb.testId}
          disabled={controller.launching}
          onClick={(event) => verb.onClick(event.currentTarget)}
          size="sm"
          type="button"
          variant="outline"
        >
          {verb.icon}
          {/* Narrow cards go icon-only: the word retreats into aria-label and tooltip, keeping the button inside the header. */}
          <span
            className={host.verbWord === "never" ? undefined : cn("hidden", SAVE_WORD_CONTAINER)}
          >
            {verb.label}
          </span>
        </Button>
      </ControlHintTooltip>
      <WorkflowSavePopover
        anchorRef={anchorRef}
        host={{
          ...(host.runName === undefined ? {} : { runName: host.runName }),
          directSaveUnsupported: controller.directSaveUnsupported,
          scopeLocked: controller.scopeLocked,
          saving: controller.saving,
          save: controller.save,
          checkNameTaken: controller.checkNameTaken,
          ...(leadHandler === undefined ? {} : { sendLead: leadHandler }),
          onSaved: (saved) => {
            setAnnouncement(
              format(
                saved.scope === "global"
                  ? "chat.toolCall.workflow.saveRun.announce.global"
                  : "chat.toolCall.workflow.saveRun.announce.project",
              ),
            );
            // Focus returns to that slot — it reads Run again by now.
            anchorRef.current?.focus();
          },
        }}
        onOpenChange={setPopoverOpen}
        open={popoverOpen}
      />
      <SavedWorkflowLaunchDialog
        entry={launchEntry}
        scope={launchEntry?.scope ?? "project"}
        projectLabel={
          localProjects.find(
            (project) =>
              resolveWorkspaceKey({
                workspacePath: project.workspacePath,
                ...(project.workspaceIdentity
                  ? { workspaceIdentity: project.workspaceIdentity }
                  : {}),
              }) === runProjectKey,
          )?.label ?? host.workspacePath
        }
        // The args this run used are the likeliest next run (courtesy of the journal).
        {...(controller.runArgs === undefined ? {} : { initialArgs: controller.runArgs })}
        {...(launchEntry?.scope === "global"
          ? { targets: localProjects, defaultTargetKey: runProjectKey }
          : {})}
        pending={controller.launching}
        error={controller.launchError}
        onOpenChange={(open) => (open ? undefined : setLaunchEntry(null))}
        onSubmit={(submitted, args, target) => {
          void controller
            .launch(
              submitted,
              args,
              target === undefined
                ? undefined
                : {
                    workspacePath: target.workspacePath,
                    ...(target.workspaceIdentity
                      ? { workspaceIdentity: target.workspaceIdentity }
                      : {}),
                    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
                  },
            )
            .then((result) => {
              if (result.ok) setLaunchEntry(null);
            });
        }}
      />
      {/* Announce the save once: the chip appears silently; screen readers must be told it happened. */}
      <span className="sr-only" aria-live="polite" data-testid="workflow-save-announcement">
        {announcement}
      </span>
    </>
  );

  return { leading, trailing };
}

/**
 * Mount the controller only with a service context (spec Gates: a card without session context — static
 * render, replay, read-only share timeline — is just its old self, controls and all gone). The controller
 * must query an agent, which such hosts do not have; a boundary wrapper instead of null checks in the
 * hook, because hooks cannot be called conditionally.
 */
export function WorkflowRunSaveSlotsBoundary({
  children,
  host,
}: {
  children: (slots: WorkflowRunSaveSlots | null) => ReactNode;
  host: WorkflowRunSaveSlotsHost;
}) {
  const services = useOptionalServices();
  if (services === null) return <>{children(null)}</>;
  return <WorkflowRunSaveSlotsMount host={host}>{children}</WorkflowRunSaveSlotsMount>;
}

function WorkflowRunSaveSlotsMount({
  children,
  host,
}: {
  children: (slots: WorkflowRunSaveSlots | null) => ReactNode;
  host: WorkflowRunSaveSlotsHost;
}) {
  const slots = useWorkflowRunSaveSlots(host);
  return <>{children(slots)}</>;
}

/** The saved chip: the pending-question chip's shape on a `bg-surface` ground — it speaks about the file, not run status. */
function WorkflowRunSavedChip({
  entry,
  hint,
  label,
  onOpen,
}: {
  entry: ZCodeSavedWorkflowEntry;
  hint?: string;
  label: string;
  /** Absent means the hub is unreachable (phone remote shell): the chip renders as plain text. */
  onOpen?: () => void;
}) {
  const content = (
    <>
      <CheckIcon aria-hidden className="size-3" />
      {label}
      {onOpen === undefined ? null : (
        // Visible on hover / keyboard focus, no space reserved: the chip is one word and trails no blank.
        <ArrowUpRightIcon
          aria-hidden
          className="hidden size-3 group-hover/saved-chip:block group-focus-visible/saved-chip:block"
        />
      )}
    </>
  );
  const className =
    "group/saved-chip flex shrink-0 items-center gap-1 rounded-full bg-surface py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-foreground-subtle";
  if (onOpen === undefined) {
    return (
      <span className={className} data-testid="workflow-saved-chip">
        {content}
      </span>
    );
  }
  return (
    <ControlHintTooltip title={hint ?? label} side="top">
      <button
        className={cn(className, "hover:bg-hover hover:text-foreground")}
        data-testid="workflow-saved-chip"
        onClick={onOpen}
        title={entry.name}
        type="button"
      >
        {content}
      </button>
    </ControlHintTooltip>
  );
}
