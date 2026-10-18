import type { ReactNode } from "react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { countPatchFileDiffs } from "@/lib/patchDiffPreview.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ToolDisplayModel } from "@/lib/toolDisplay.js";
import type { Theme } from "@/useTheme.js";
import type { OpenPlanDetailSideTabRequest } from "@/lib/workspaceSidePane.js";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

export function readUnifiedDiffField(value: unknown): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  return readStringField(value, ["unified_diff", "unifiedDiff", "patch", "diff"]);
}

export function normalizeSingleFilePatch(
  patch: string | undefined,
  fileLabel: string,
): string | undefined {
  if (!patch) {
    return undefined;
  }

  const trimmedPatch = patch.trim();
  if (!trimmedPatch) {
    return undefined;
  }

  if (countPatchFileDiffs(trimmedPatch) > 1) {
    // When a sub-agent edits the same file again, the tool layer sometimes returns several diff segments concatenated in one field.
    // PatchDiff only parses single-file patches; rendering directly throws and breaks "click the file name to see changes".
    // Drop multi-file patches here and let the upper layer fall back to a single-file diff from old/newText (or a content preview).
    return undefined;
  }

  if (/^---\s+/m.test(trimmedPatch) && /^\+\+\+\s+/m.test(trimmedPatch)) {
    return trimmedPatch;
  }

  if (trimmedPatch.startsWith("@@ ")) {
    const firstHeader = trimmedPatch.match(/^@@\s-(\d+)(?:,(\d+))?\s\+(\d+)(?:,(\d+))?\s@@/m);
    const deletedCount = Number(firstHeader?.[2] ?? firstHeader?.[1] ?? "1");
    const addedCount = Number(firstHeader?.[4] ?? firstHeader?.[3] ?? "1");

    // The unified_diff returned by tools is often just hunk fragments without file headers.
    // For new-file cases, patching it into --- a/file makes PatchDiff parse it as a regular change,
    // which drags the page on large whole-file additions. Detect a pure addition from the first hunk and emit a /dev/null header.
    return [
      deletedCount === 0 && addedCount > 0 ? "--- /dev/null" : `--- a/${fileLabel}`,
      addedCount === 0 && deletedCount > 0 ? "+++ /dev/null" : `+++ b/${fileLabel}`,
      trimmedPatch,
    ].join("\n");
  }

  // Raw apply_patch text can also contain @@ but is not a standard unified diff.
  // Never force ---/+++ headers onto it, or opening the file from the summary feeds a malformed patch into PatchDiff.
  return trimmedPatch;
}

export function readRawToolCallInput(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return null;
  }

  if ("rawInput" in raw && raw.rawInput !== undefined) {
    return raw.rawInput;
  }

  // In the ZCode protocol permission/request payload the tool args live in input per the schema;
  // the legacy UI reads only the rawInput compat field, degrading Write/Edit into a raw JSON blob instead of a file diff.
  return "input" in raw ? raw.input : null;
}

export function readStructuredDiffBlock(
  value: unknown,
): { path?: string; oldText: string; newText: string } | null {
  if (!isPlainRecord(value) || value.type !== "diff" || typeof value.newText !== "string") {
    return null;
  }

  return {
    path: typeof value.path === "string" && value.path.trim() ? value.path : undefined,
    oldText:
      typeof value.oldText === "string"
        ? value.oldText
        : value.oldText == null
          ? ""
          : String(value.oldText),
    newText: value.newText,
  };
}

export function readRawToolCallChanges(raw: unknown) {
  if (!isPlainRecord(raw)) {
    return {
      directChanges: null,
      rawInputChanges: null,
      rawOutputChanges: null,
    };
  }

  const rawInputSource = readRawToolCallInput(raw);
  const rawInput = isPlainRecord(rawInputSource) ? rawInputSource : null;
  const rawOutput = isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;

  return {
    directChanges: isPlainRecord(raw.changes) ? raw.changes : null,
    rawInputChanges: rawInput && isPlainRecord(rawInput.changes) ? rawInput.changes : null,
    rawOutputChanges: rawOutput && isPlainRecord(rawOutput.changes) ? rawOutput.changes : null,
  };
}

export interface RawToolCallFileSummary {
  path: string;
  actionLabel: "Created" | "Edited" | "Deleted";
  operationKind: EditOperationKind;
  fileName: string;
  filePath: string | null;
  fileIconSrc: string;
  changeStat?: { added: number; removed: number };
  patch?: string | null;
}

/**
 * Every workflow run fact the chat tool card needs in run state. The host joins `toolCallId` against the `workflowRuns` projection.
 *
 * Deliberately only these four fields: the card is entry + summary; budget, event log, result and failure panels live on the detail page.
 */
export interface WorkflowRunCardSummary {
  runId: string;
  /**
   * The **CreateWorkflow row** id that started this run (projection `run.toolCallId`). Requests opening the side-pane run view
   * must carry it - `WorkflowRunSidePane` uses this id to find the originating row in the row window (causality graph and script
   * source both hang off that row). Only populated in the byRunId join (the byToolCallId map is keyed by this value);
   * the resume row's own toolCallId is **not** this value (the resume row display has no graph).
   */
  toolCallId?: string;
  status: WorkflowRunState["status"];
  /** Why it stopped; present only when the projection carries it. */
  stopReason?: WorkflowRunState["stopReason"];
  /** Settled (`phase === "settled"`) node count, **including** nodes that hit the cap and never made it into the table. */
  nodesSettled: number;
  /**
   * Scheduled (observed) node count, **not** a total: a dynamic workflow's node count is decided by the script at runtime,
   * so no static total exists. Read progress as "how many scheduled nodes settled", never as a completion percentage.
   *
   * Both numbers come from `workflowRunStepCounts` (@zcode/shared): `nodes` in-table + `usage.nodesUnlisted`
   * out-of-table. A run that hit the 1024 cap still reports true step counts; what is lost is **per-step detail**, noted by
   * a "showing n/m steps" line on the card and on the detail page.
   */
  nodesTotal: number;
  /**
   * Sub-agent count (projection `run.actors.length`). The card count only ever speaks in phases and sub-agents.
   *
   * Still optional: both join-table builders always populate it, but the type does not require it - after cold replay landed
   * the two journal-fallback merges were removed and no second producer exists; consumers stay tolerant and skip the count when absent.
   */
  agents?: number;
  /**
   * This run in the live projection: the card builds its
   * timeline model (lights, pills, ink) from it. Absent on journal-fallback hits - status word only, timeline drawn static.
   */
  run?: WorkflowRunState;
  /**
   * Resumable (live-projection `cancelled`, or `resumable` computed from the CLI resume gate in the journal summary).
   * The card footer Resume renders only when this is present; the UI never derives it from status + failureCode.
   */
  resumable?: true;
}

/**
 * Where a CreateWorkflow / AmendWorkflow row sits in its compile feedback loop. The host computes it in one pass by row order from the row window (`v4/workflowDraftJoin.ts`); the renderer only reads.
 */
export interface WorkflowDraftPosition {
  /** Draft number: the nth commit since the last compile within this lineage and round, starting at 1. */
  ordinal: number;
  /** A later row exists in this lineage: the feedback row's idle ring light fades from warning to neutral. */
  superseded: boolean;
}

export interface ToolCallBlockRenderContext {
  isOfficeMode?: boolean;
  toolCallNode: TaskChatToolCallTreeNode;
  workspacePath: string;
  /**
   * Applied theme (store decoupling): passed in by the host building the render context
   * (ToolCallBlock / PermissionDialog etc.) from upper-level state, for
   * light/dark branching in display components such as MessageResponse / EditInlineDiffContent.
   * Display components fall back to "system" when absent.
   */
  theme?: Theme;
  /** Code preview settings (store decoupling): same as above, host-passed and kept referentially stable. */
  codePreviewSettings?: CodePreviewSettings;
  displayModel: ToolDisplayModel;
  viewerSource: CodeViewerSource | null;
  rawFileSummaries: RawToolCallFileSummary[];
  isRunning: boolean;
  statusLabel: string;
  sourceLabel?: string;
  errorText?: string;
  childToolList: ReactNode;
  showIcon?: boolean;
  /** CUA group children explicitly enlarge the app icon; a standalone CUA keeps the default size. */
  cuaAppIconClassName?: "size-4" | "size-5";
  kindLabelOverride?: ReactNode;
  showTodoToolCalls?: boolean;
  disableSummaryContentAnimation?: boolean;
  /** A Changes child may mount after its diff already exists; the first count still plays the enter animation. */
  animateDiffCountOnMount?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  /**
   * Read-only observation entry for a v4 subagent child session. The Agent renderer turns the summary row into
   * an action that opens a side tab; non-Agent tools ignore it.
   */
  agentSummaryAction?: {
    onActivate: () => void;
    testId?: string;
  };
  /** Runtime-authoritative type projected from a paired v4 subagentRow; preferred while the streamed input is still incomplete. */
  authoritativeAgentType?: string;
  /** ExitPlanMode plan card: the session host opens the Side Pane after binding parent/session scope. */
  onOpenPlanDetail?: (request: Omit<OpenPlanDetailSideTabRequest, "parentSessionId">) => void;
  /**
   * CreateWorkflow run detail entry.
   *
   * The card carries a display name only - `toolCallId`, `runId` and session identity are all host-bound. **Its presence is the gate**:
   * the host injects it only when the tool call really has an openable run (run identity from the `workflowRuns` projection,
   * see the `workflowRunSchema.toolCallId` comment: it is the tool-card-to-detail-page join key).
   * Deliberately does not read `backgroundTaskId` from tool output: a v4 row's `output.text` holds only
   * the `response` prose picked by `formatCreateWorkflowModelContent`; the structured fields are not on the row.
   */
  onOpenWorkflowRun?: (request: { workflowName?: string; phaseId?: string }) => void;
  /**
   * Card footer Resume: the same
   * v4 `resumeWorkflowRun {workId}` command as the detail page, with runId and session host-bound. Absent means no button.
   */
  onResumeWorkflowRun?: (request: { workflowName?: string }) => void;
  /**
   * Clicking a sub-agent pill opens its transcript: the card hands over slot identity (run, site, index, runtime name, session id when known;
   * a not-yet-started pill also opens, into a placeholder tab); session and workspace identity stay host-bound. Absent means the pill is inert.
   */
  onOpenWorkflowActor?: (request: {
    runId: string;
    actorSessionId?: string;
    siteId: string;
    ordinal: number;
    actorName?: string;
  }) => void;
  /**
   * Script pill -> script transcript tab: the card hands over
   * only this stop's phase id (target) and display name; run, originating row and session identity stay host-bound (as in `onOpenWorkflowRun`).
   * Absent means the script pill is inert.
   */
  onOpenWorkflowWorkspace?: (request: { phaseId: string; workflowName?: string }) => void;
  /**
   * Artifact pill under the timeline -> artifact tab:
   * the card hands over the artifact id only; run and session identity stay host-bound. Absent disables the pill.
   */
  onOpenWorkflowArtifact?: (artifactId: string) => void;
  /**
   * The workflow run summary joined to this tool call; when present the card enters run state (compact clickable card).
   *
   * The card never scans the `workflowRuns` projection itself: the join (by `toolCallId`) and the counts are computed once on the host
   * (`workflowRunCardJoin.ts`); the renderer only reads. `nodesTotal` is the **scheduled** (observed) count -
   * dynamic workflows have no static total, so progress reads "how many scheduled settled", not a completion percentage.
   */
  workflowRun?: WorkflowRunCardSummary;
  /**
   * This tool call's draft slot; when absent (host without a row window, e.g. read-only share) the card shows no number and the light stays warning.
   * Like `workflowRun`, not passed down to child tool cards: slots join by toolCallId, so another row's slot is another row's draft number.
   */
  workflowDraft?: WorkflowDraftPosition;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
  /** Jump from the scheduled-task tool card to the management page; opens the detail directly when automationId is present. */
  onOpenAutomationsMain?: (automationId?: string) => void;
  onLoadFullToolCallFields?: (toolId: string) => Promise<boolean | void> | boolean | void;
}

export interface EditKindSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}

export type EditOperationKind = "write" | "edit" | "update" | "delete";
export type EditKindLabelId =
  | "chat.toolCall.edit.writing"
  | "chat.toolCall.edit.updating"
  | "chat.toolCall.edit.deleting"
  | "chat.toolCall.edit.editing"
  | "chat.toolCall.kind.write"
  | "chat.toolCall.kind.delete"
  | "chat.toolCall.kind.edit";
