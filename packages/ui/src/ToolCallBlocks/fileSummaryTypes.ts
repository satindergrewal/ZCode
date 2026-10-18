import type { PluginUiToolBinding } from "@/plugin-ui/contract.js";
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
    // When a sub-agent re-edits the same file, the tool layer sometimes returns multiple diff segments in one field.
    // PatchDiff only parses single-file patches; rendering directly throws and breaks the click-to-see-changes path.
    // Drop multi-file patches here and let the upper layer fall back to a single-file diff from old/newText (or the content preview).
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
    // For a new file, padding a --- a/file header makes PatchDiff parse it as a regular change,
    // which can stall the page on huge additions. Detect pure additions from the first hunk and emit a /dev/null header.
    return [
      deletedCount === 0 && addedCount > 0 ? "--- /dev/null" : `--- a/${fileLabel}`,
      addedCount === 0 && deletedCount > 0 ? "+++ /dev/null" : `+++ b/${fileLabel}`,
      trimmedPatch,
    ].join("\n");
  }

  // Raw apply_patch text may also contain @@, but it is not a standard unified diff.
  // Never force ---/+++ headers onto it, or opening the file from the summary feeds a malformed patch to PatchDiff.
  return trimmedPatch;
}

export function readRawToolCallInput(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return null;
  }

  if ("rawInput" in raw && raw.rawInput !== undefined) {
    return raw.rawInput;
  }

  // The ZCode protocol permission/request payload keeps tool args in input per the schema;
  // the legacy read-only input field rawInput degrades Write/Edit to a raw JSON blob instead of a file diff.
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
 * Every workflow run fact the chat tool card needs to render run state. Computed by the host when joining `workflowRuns` by `toolCallId`.
 *
 * Deliberately only these four fields: the card is entry and summary; budget, event log, result and failure panels belong to the detail page.
 */
export interface WorkflowRunCardSummary {
  runId: string;
  /**
   * Id of the **CreateWorkflow row** that started this run (projection `run.toolCallId`). Requests
   * to open the side-pane run view must carry it -- `WorkflowRunSidePane` uses it to find the originating row in the row window (causality
   * graph and script text hang on that row). Only populated in the byRunId join (the byToolCallId map is keyed by this value);
   * the resume row's own toolCallId is **not** this value (the resume row display has no graph).
   */
  toolCallId?: string;
  status: WorkflowRunState["status"];
  /** Why it stopped; present only when the projection carries it. */
  stopReason?: WorkflowRunState["stopReason"];
  /** Settled (`phase === "settled"`) node count, **including** those that hit the bound and never entered the table. */
  nodesSettled: number;
  /**
   * Scheduled (observed) node count, **not** a grand total -- a dynamic workflow's node count is decided by the script at runtime, so no
   * static total exists. Progress therefore reads "how many of the scheduled settled", never a completion percentage.
   *
   * Both numbers come from `workflowRunStepCounts` (@zcode/shared): `nodes` in-table + `usage.nodesUnlisted`
   * out-of-table. A run that hit the 1024 bound still reports true step counts; what is missing is **per-step detail**, one
   * "only showing n/m steps" line on card and detail page each.
   */
  nodesTotal: number;
  /**
   * Subagent count (projection `run.actors.length`). The card count only ever states phase and subagents.
   *
   * Still optional: both join-table builders always fill it, but the type does not require it -- after the cold-replay
   * landing removed the two journal-fallback merges there is no second producer; consumers stay tolerant of absence, no count written.
   */
  agents?: number;
  /**
   * This run in the live projection: the card builds its
   * timeline model from it (lights, pills, ink). Absent on journal-fallback hits -- status wording only, static timeline.
   */
  run?: WorkflowRunState;
  /**
   * Resumable (live projection `cancelled`, or `resumable` from the journal summary per the CLI resume gate).
   * The card footer Resume renders only when present; the UI never derives it from status + failureCode.
   */
  resumable?: true;
}

/**
 * Where a CreateWorkflow / AmendWorkflow row sits in its compile feedback loop. The host computes it in one pass over the row window by row order (`v4/workflowDraftJoin.ts`); the renderer only reads.
 */
export interface WorkflowDraftPosition {
  /** Draft number: same lineage, same round, nth commit since the last compile, starting at 1. */
  ordinal: number;
  /** A later row exists in the lineage: the feedback row's idle ring fades from warning to neutral. */
  superseded: boolean;
}

export interface ToolCallBlockRenderContext {
  isOfficeMode?: boolean;
  toolCallNode: TaskChatToolCallTreeNode;
  workspacePath: string;
  /**
   * Plugin UI: `scope` is the session scope the sandbox needs to register, `onOpenSidePane` the "open in side pane" callback;
   * injected at the boundary by PluginUiSessionProvider. Absent = host provides none, ui:// resource tools fall back to a plain MCP card.
   */
  pluginUi?: PluginUiToolBinding;
  /**
   * App theme (store decoupling): passed in by the host building the render context
   * (ToolCallBlock / PermissionDialog and friends) from upper-level state, so display
   * components such as MessageResponse / EditInlineDiffContent can split light/dark.
   * When absent, display components fall back to "system".
   */
  theme?: Theme;
  /** Code preview preferences (store decoupling): as above, host-provided with a stable reference. */
  codePreviewSettings?: CodePreviewSettings;
  displayModel: ToolDisplayModel;
  viewerSource: CodeViewerSource | null;
  rawFileSummaries: RawToolCallFileSummary[];
  isRunning: boolean;
  /** Permission preview not yet executed: no output and no empty-output placeholder. */
  isPermissionPreview?: boolean;
  statusLabel: string;
  sourceLabel?: string;
  errorText?: string;
  childToolList: ReactNode;
  showIcon?: boolean;
  /** CUA Group children scale up the App Icon explicitly; standalone CUA keeps the default size. */
  cuaAppIconClassName?: "size-4" | "size-5";
  kindLabelOverride?: ReactNode;
  showTodoToolCalls?: boolean;
  disableSummaryContentAnimation?: boolean;
  /** A Changes child may mount after its diff exists; the first count needs the entrance animation too. */
  animateDiffCountOnMount?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  /**
   * Read-only observation handle for a v4 subagent child session. The Agent renderer turns the summary row into
   * an open-in-side-tab action; non-Agent tools ignore it.
   */
  agentSummaryAction?: {
    onActivate: () => void;
    testId?: string;
  };
  /** Runtime authority projected from a paired v4 subagentRow; preferred while streamed input is incomplete. */
  authoritativeAgentType?: string;
  /** ExitPlanMode plan card: the session host binds parent/session scope, then opens the side pane. */
  onOpenPlanDetail?: (request: Omit<OpenPlanDetailSideTabRequest, "parentSessionId">) => void;
  /**
   * CreateWorkflow run detail entry.
   *
   * The card carries the display name only -- `toolCallId`, `runId` and session identity are all host-bound. **Its mere presence is the gate**:
   * the host injects it only when the tool call really has an openable run (run identity from the `workflowRuns` projection,
   * see the `workflowRunSchema.toolCallId` note: it is the tool-card-to-detail-page join key).
   * Deliberately not reading `backgroundTaskId` from tool output: a v4 row's `output.text` holds only
   * the `response` prose picked by `formatCreateWorkflowModelContent`; structured fields are not on the row.
   */
  onOpenWorkflowRun?: (request: { workflowName?: string; phaseId?: string }) => void;
  /**
   * Card footer Resume: the same
   * v4 `resumeWorkflowRun {workId}` command as the detail page, with runId and session host-bound. Absent = no button.
   */
  onResumeWorkflowRun?: (request: { workflowName?: string }) => void;
  /**
   * Clicking a subagent pill opens its transcript: the card hands over slot identity (run, site, index, runtime name, session id when known;
   * not-yet-started pills open too, onto a placeholder tab); session and workspace identity host-bound. Absent = pill inert.
   */
  onOpenWorkflowActor?: (request: {
    runId: string;
    actorSessionId?: string;
    siteId: string;
    ordinal: number;
    actorName?: string;
  }) => void;
  /**
   * Script pill to script transcript tab: the card hands over
   * only this stage's phase id (landing target) and display name; run, originating row and session identity host-bound (as `onOpenWorkflowRun`).
   * Absent = script pill inert.
   */
  onOpenWorkflowWorkspace?: (request: { phaseId: string; workflowName?: string }) => void;
  /**
   * Artifact pills under the timeline to artifact tab:
   * the card hands over the artifact id only; run and session identity host-bound. Absent = pill disabled.
   */
  onOpenWorkflowArtifact?: (artifactId: string) => void;
  /**
   * The workflow run summary this tool call joined to; presence switches the card into run state (compact clickable card).
   *
   * The card never walks the `workflowRuns` projection itself: join (by `toolCallId`) and counts are computed host-side in one pass
   * (`workflowRunCardJoin.ts`); the renderer only reads. `nodesTotal` is the **scheduled** (observed) count --
   * dynamic workflows have no static total, so progress reads "how many of the scheduled settled", not a percentage.
   */
  workflowRun?: WorkflowRunCardSummary;
  /**
   * This tool call's draft position; absent (host without a row window, e.g. read-only share) = unnumbered card, warning light stays.
   * Like `workflowRun`, not passed to child tool cards: position joins by toolCallId; another row means another draft number.
   */
  workflowDraft?: WorkflowDraftPosition;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
  /** Scheduled-task tool card jump to the management page; with `automationId` opens the detail directly. */
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
