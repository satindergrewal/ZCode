// The completion card's Save popover (docs/dynamic-workflow/transcript-and-notifications.md "The popover").
//
// The two paths are ordered by value, not cost: first the full-width let-ZCode-distill-and-save, and
// only under a hairline the three fields of save-as-is. A just-finished script is one-off; lifting the
// values that vary between runs into args, with description and when-to-use, is work only someone who
// read the script can do — so it goes first.
//
// The three fields serve both paths: whatever is filled rides to ZCode with the message and is also what direct-save writes.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { SparkleIcon } from "lucide-react";
import type { ZCodeSavedWorkflowScope, ZCodeWorkflowsSaveResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from "@/components/ui/popover.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkflowSaveFields, type WorkflowSaveFailure } from "./WorkflowSaveFields.js";
import {
  initialWorkflowSaveDraft,
  isValidSavedWorkflowNameText,
  savedWorkflowPathPreview,
  type WorkflowSaveDraft,
} from "./workflowRunSave.js";

/** Debounce for the occupancy probe: a disk check per keystroke is noise; it matters when the person pauses. */
const NAME_PROBE_DEBOUNCE_MS = 320;

export interface WorkflowSavePopoverHost {
  /** Prefills name and description at open. */
  runName?: string;
  /** Older agents lack `workflows/save`: only the ZCode path remains. */
  directSaveUnsupported: boolean;
  /** Remote projects offer no global profile: `~` lives on the agent machine, which the hub never reads. */
  scopeLocked: boolean;
  saving: boolean;
  save: (input: {
    name: string;
    scope: ZCodeSavedWorkflowScope;
    meta: { description: string };
    overwrite?: boolean;
  }) => Promise<ZCodeWorkflowsSaveResult>;
  checkNameTaken: (name: string, scope: ZCodeSavedWorkflowScope) => Promise<boolean>;
  /**
   * Sends that user message (each host owns its send path: card in this session, pane in the parent).
   * Absent means the path is unreachable — the popover keeps only its below-the-line half.
   */
  sendLead?: (draft: WorkflowSaveDraft) => Promise<void>;
  /** Once written: the parent flips to Run again and fires one aria-live. */
  onSaved: (saved: { name: string; scope: ZCodeSavedWorkflowScope }) => void;
}

export function WorkflowSavePopover({
  anchorRef,
  host,
  onOpenChange,
  open,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  host: WorkflowSavePopoverHost;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        align="end"
        // On phones the card is narrower than the popover: 8px off the screen edge, never wider than the viewport (a 320px screen fits).
        className="w-80 max-w-[calc(100vw-16px)] gap-2.5"
        collisionPadding={8}
        data-testid="workflow-save-popover"
        // As in the Configure popover: portal outside, React events still bubble; uncaught, blank-space clicks read as card-body clicks.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault();
        }}
      >
        {/* Mounted only while open: the draft starts at this very opening and is dropped on close (the Esc semantics). */}
        {open ? <WorkflowSaveForm host={host} onClose={() => onOpenChange(false)} /> : null}
      </PopoverContent>
    </Popover>
  );
}

function WorkflowSaveForm({
  host,
  onClose,
}: {
  host: WorkflowSavePopoverHost;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const format = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  // The start is fixed at open (as in Configure): run changes while open must not drag the form back.
  const [draft, setDraft] = useState<WorkflowSaveDraft>(() =>
    initialWorkflowSaveDraft({
      ...(host.runName === undefined ? {} : { runName: host.runName }),
      ...(host.scopeLocked ? { scope: "project" as const } : {}),
    }),
  );
  const [probe, setProbe] = useState({ taken: false, shadowing: false });
  const [failure, setFailure] = useState<WorkflowSaveFailure | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Focus the name field on open (Tab order stays lead, name, scope, description, save).
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const name = draft.name.trim();
  const nameInvalid = name.length > 0 && !isValidSavedWorkflowNameText(name);
  const canDirectSave =
    !host.directSaveUnsupported && name.length > 0 && !nameInvalid && !host.saving;

  const { checkNameTaken, directSaveUnsupported, scopeLocked } = host;
  const { scope } = draft;
  // Occupancy probe: debounced 320ms, both scopes at once — the target decides overwrite, the other
  // shadow. Any name or scope change voides the conclusion first, so no stale answer sticks to a new name.
  useEffect(() => {
    setProbe({ taken: false, shadowing: false });
    if (directSaveUnsupported || name.length === 0 || !isValidSavedWorkflowNameText(name)) return;
    let cancelled = false;
    const other: ZCodeSavedWorkflowScope = scope === "global" ? "project" : "global";
    const timer = window.setTimeout(() => {
      void Promise.all([
        checkNameTaken(name, scope),
        // Remote projects have the project profile only; asking after the other is pointless (the hub never reads the agent's `~`).
        scopeLocked ? Promise.resolve(false) : checkNameTaken(name, other),
      ]).then(([taken, shadowing]) => {
        if (!cancelled) setProbe({ taken, shadowing });
      });
    }, NAME_PROBE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [checkNameTaken, directSaveUnsupported, name, scope, scopeLocked]);

  const update = (next: Partial<WorkflowSaveDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setFailure(undefined);
  };

  const handleLead = () => {
    if (host.sendLead === undefined || sending || host.saving) return;
    setSending(true);
    void host.sendLead({ ...draft, name }).then(
      () => onClose(),
      () => setSending(false),
    );
  };

  const handleDirectSave = () => {
    if (!canDirectSave) return;
    setFailure(undefined);
    void host
      .save({
        name,
        scope,
        // An empty description falls back to the name: the hub card's line must not be blank.
        meta: { description: draft.description.trim() || name },
        ...(probe.taken ? { overwrite: true } : {}),
      })
      .then(
        (result) => {
          if (result.ok) {
            host.onSaved({ name: result.name, scope: result.scope });
            onClose();
            return;
          }
          // Target exists: not a failure, an unconfirmed overwrite — show the warning, relabel the button overwrite-and-save.
          if (result.reason === "target_exists") {
            setProbe((current) => ({ ...current, taken: true }));
            return;
          }
          setFailure({
            reason: result.reason,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          });
        },
        (error: unknown) => {
          setFailure({
            reason: "generic",
            detail: error instanceof Error ? error.message : String(error),
          });
        },
      );
  };

  const pathPreview = useMemo(
    () => savedWorkflowPathPreview(scope, name.length > 0 ? name : "…"),
    [name, scope],
  );
  const submitLabel = host.saving
    ? format("chat.toolCall.workflow.saveRun.submit.saving")
    : probe.taken
      ? format("chat.toolCall.workflow.saveRun.submit.overwrite")
      : format("chat.toolCall.workflow.saveRun.submit");

  return (
    <div
      className="flex flex-col gap-2.5"
      // `⌘↩` / `Ctrl↩` from any field fires the primary path: the popover's whole claim is that one button.
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          handleLead();
        }
      }}
    >
      <PopoverTitle>{format("chat.toolCall.workflow.saveRun.title")}</PopoverTitle>
      {host.sendLead === undefined ? null : (
        <div className="flex flex-col gap-1.5">
          <Button
            className="h-8 w-full"
            data-icon="inline-start"
            data-testid="workflow-save-lead"
            disabled={sending || host.saving}
            onClick={handleLead}
            type="button"
          >
            {sending ? <Spinner className="size-3.5" /> : <SparkleIcon className="size-3.5" />}
            {format(
              sending
                ? "chat.toolCall.workflow.saveRun.lead.sending"
                : "chat.toolCall.workflow.saveRun.lead",
            )}
          </Button>
          <p className="text-ui-sm leading-snug text-foreground-subtle">
            {format("chat.toolCall.workflow.saveRun.lead.hint")}
            {host.directSaveUnsupported
              ? ` ${format("chat.toolCall.workflow.saveRun.lead.unsupported")}`
              : ""}
          </p>
        </div>
      )}
      {host.directSaveUnsupported ? null : (
        <WorkflowSaveFields
          draft={draft}
          failure={failure}
          nameInvalid={nameInvalid}
          nameRef={nameRef}
          onDirectSave={handleDirectSave}
          pathPreview={pathPreview}
          saving={host.saving}
          scopeLocked={host.scopeLocked}
          shadowing={probe.shadowing}
          showDivider={host.sendLead !== undefined}
          submitDisabled={!canDirectSave}
          submitLabel={submitLabel}
          taken={probe.taken}
          update={update}
        />
      )}
    </div>
  );
}
