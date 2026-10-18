import { create } from "zustand";
import type { ConversationShareAccessMode } from "@zcode/shared";
import type { ConversationShareFailureIssue } from "@zcode/services";

type ConversationShareScope = "all" | "partial";
type ConversationShareSelectionView = "selection" | "timeline";
type ConversationShareSelectionStage = "selection" | "configuration";
export const DEFAULT_CONVERSATION_SHARE_ACCESS_MODE: ConversationShareAccessMode =
  "public_importable";

export interface ConversationShareAttempt {
  key: string;
  clientRequestId: string;
  disclosureAcceptedAt: number;
}

export interface ConversationShareDisplayError {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount?: number;
  requestId?: string;
  /** Actionable copy resolved by error kind, shown when the server gives no issues. */
  messageId?: string;
}

/** Non-blocking notice when publish succeeded but some artifacts were skipped. */
export interface ConversationShareDisplayWarnings {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount?: number;
}

export type ConversationShareProgressPhase = "collecting" | "uploading" | "checking";

interface ConversationShareSelectionDraft {
  scope: ConversationShareScope;
  stage: ConversationShareSelectionStage;
  view: ConversationShareSelectionView;
  availableRowIds: readonly number[];
  excludedRowIds: readonly number[];
  productTurnIdByRowId: Readonly<Record<number, string>>;
  accessMode: ConversationShareAccessMode;
}

interface ConversationShareDockState {
  title?: string;
  disclosureAccepted: boolean;
  publishing: boolean;
  progress: ConversationShareProgressPhase;
  completedArtifacts: number;
  totalArtifacts: number;
  publishedShareUrl: string | null;
  error: ConversationShareDisplayError | null;
  warnings: ConversationShareDisplayWarnings | null;
  attempt: ConversationShareAttempt | null;
}

interface ConversationShareSelectionState {
  popoverOpen: boolean;
  drafts: Record<string, ConversationShareSelectionDraft>;
  dockStates: Record<string, ConversationShareDockState>;
  setPopoverOpen: (open: boolean) => void;
  setScope: (taskId: string, scope: ConversationShareScope) => void;
  setAccessMode: (taskId: string, accessMode: ConversationShareAccessMode) => void;
  syncAvailableRowIds: (taskId: string, rowIds: readonly number[]) => void;
  syncAvailableTurns: (
    taskId: string,
    turns: readonly { rowId: number; productTurnId: string }[],
  ) => void;
  toggleRow: (taskId: string, rowId: number) => void;
  /** Cancel the selection of a whole product turn (the dismiss-turn entry of blocking items). */
  deselectProductTurn: (taskId: string, productTurnId: string) => void;
  setAllRowsSelected: (taskId: string, selected: boolean) => void;
  goToConfiguration: (taskId: string) => void;
  goToSelection: (taskId: string) => void;
  showTimeline: (taskId: string) => void;
  showSelectionPanel: (taskId: string) => void;
  finishSelection: (taskId: string) => void;
  updateDockState: (taskId: string, patch: Partial<ConversationShareDockState>) => void;
  resetForTests: () => void;
}

const EMPTY_DRAFT: ConversationShareSelectionDraft = Object.freeze({
  scope: "all",
  stage: "selection",
  view: "timeline",
  availableRowIds: Object.freeze([]),
  excludedRowIds: Object.freeze([]),
  productTurnIdByRowId: Object.freeze({}),
  accessMode: DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
});

export const DEFAULT_CONVERSATION_SHARE_DOCK_STATE: ConversationShareDockState = Object.freeze({
  disclosureAccepted: false,
  publishing: false,
  progress: "collecting",
  completedArtifacts: 0,
  totalArtifacts: 0,
  publishedShareUrl: null,
  error: null,
  warnings: null,
  attempt: null,
});

function normalizeRowIds(rowIds: readonly number[]): number[] {
  return [...new Set(rowIds.filter(Number.isSafeInteger))].sort((left, right) => left - right);
}

function getConversationShareDraft(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): ConversationShareSelectionDraft {
  return state.drafts[taskId] ?? EMPTY_DRAFT;
}

export function getConversationShareDockState(
  state: Pick<ConversationShareSelectionState, "dockStates">,
  taskId: string,
): ConversationShareDockState {
  return state.dockStates[taskId] ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
}

export function getConversationShareSelectedRowIds(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): number[] {
  const draft = getConversationShareDraft(state, taskId);
  const excluded = new Set(draft.excludedRowIds);
  return draft.availableRowIds.filter((rowId) => !excluded.has(rowId));
}

export function getConversationShareSelectedProductTurnIds(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): string[] {
  const draft = getConversationShareDraft(state, taskId);
  const seen = new Set<string>();
  return getConversationShareSelectedRowIds(state, taskId).flatMap((rowId) => {
    const productTurnId = draft.productTurnIdByRowId[rowId];
    if (!productTurnId || seen.has(productTurnId)) return [];
    seen.add(productTurnId);
    return [productTurnId];
  });
}

export const useConversationShareSelectionStore = create<ConversationShareSelectionState>()(
  (set) => ({
    popoverOpen: false,
    drafts: {},
    dockStates: {},
    setPopoverOpen: (popoverOpen) => set({ popoverOpen }),
    setScope: (taskId, scope) =>
      set((state) => {
        const currentDraft = state.drafts[taskId];
        const dockStates = { ...state.dockStates };
        if (scope === "partial") {
          if (currentDraft?.scope !== "partial") {
            const previousAttempt = state.dockStates[taskId]?.attempt;
            dockStates[taskId] = previousAttempt
              ? { ...DEFAULT_CONVERSATION_SHARE_DOCK_STATE, attempt: previousAttempt }
              : DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
          }
        } else {
          delete dockStates[taskId];
        }
        return {
          // In per-turn selection the left pane is the only scope selector, so two overlays never fight for focus.
          popoverOpen: scope === "partial" ? false : state.popoverOpen,
          drafts: {
            ...state.drafts,
            [taskId]:
              scope === "partial"
                ? {
                    scope,
                    stage: "selection",
                    view: "selection",
                    availableRowIds:
                      state.drafts[taskId]?.availableRowIds ?? EMPTY_DRAFT.availableRowIds,
                    // Entering from All conversations always starts a new selection draft, all-selected by product semantics.
                    excludedRowIds: [],
                    productTurnIdByRowId:
                      state.drafts[taskId]?.productTurnIdByRowId ??
                      EMPTY_DRAFT.productTurnIdByRowId,
                    accessMode: state.drafts[taskId]?.accessMode ?? EMPTY_DRAFT.accessMode,
                  }
                : EMPTY_DRAFT,
          },
          dockStates,
        };
      }),
    setAccessMode: (taskId, accessMode) =>
      set((state) => ({
        drafts: {
          ...state.drafts,
          [taskId]: {
            ...(state.drafts[taskId] ?? EMPTY_DRAFT),
            accessMode,
          },
        },
      })),
    syncAvailableRowIds: (taskId, rowIds) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial") return state;
        const availableRowIds = normalizeRowIds(rowIds);
        const available = new Set(availableRowIds);
        const excludedRowIds = current.excludedRowIds.filter((rowId) => available.has(rowId));
        if (
          availableRowIds.length === current.availableRowIds.length &&
          availableRowIds.every((rowId, index) => current.availableRowIds[index] === rowId) &&
          excludedRowIds.length === current.excludedRowIds.length
        ) {
          return state;
        }
        return {
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, availableRowIds, excludedRowIds },
          },
        };
      }),
    syncAvailableTurns: (taskId, turns) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial") return state;
        const productTurnIdByRowId = Object.fromEntries(
          turns.map((turn) => [turn.rowId, turn.productTurnId]),
        );
        const availableRowIds = normalizeRowIds(turns.map((turn) => turn.rowId));
        const available = new Set(availableRowIds);
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              availableRowIds,
              excludedRowIds: current.excludedRowIds.filter((rowId) => available.has(rowId)),
              productTurnIdByRowId,
            },
          },
        };
      }),
    toggleRow: (taskId, rowId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial" || !current.availableRowIds.includes(rowId)) {
          return state;
        }
        const excluded = new Set(current.excludedRowIds);
        if (excluded.has(rowId)) excluded.delete(rowId);
        else excluded.add(rowId);
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              excludedRowIds: [...excluded].sort((left, right) => left - right),
            },
          },
        };
      }),
    /**
     * Cancels the selection of a whole product turn.
     *
     * The UI must not index its per-query lists by the service turnOrdinal:
     * the two numberings misalign in conversations with system-context turns or multiple steer queries, and toggleRow
     * excludes a single row only, leaving the turn other queries selected - the blocking turn never removed.
     * Dismiss-turn means the whole turn: exclude every row by productTurnId, idempotently.
     */
    deselectProductTurn: (taskId, productTurnId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial" || !productTurnId) return state;
        const excluded = new Set(current.excludedRowIds);
        let changed = false;
        for (const rowId of current.availableRowIds) {
          if (current.productTurnIdByRowId[rowId] !== productTurnId || excluded.has(rowId)) {
            continue;
          }
          excluded.add(rowId);
          changed = true;
        }
        if (!changed) return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              excludedRowIds: [...excluded].sort((left, right) => left - right),
            },
          },
        };
      }),
    setAllRowsSelected: (taskId, selected) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial") return state;
        const excludedRowIds = selected ? [] : [...current.availableRowIds];
        if (
          excludedRowIds.length === current.excludedRowIds.length &&
          excludedRowIds.every((rowId, index) => current.excludedRowIds[index] === rowId)
        ) {
          return state;
        }
        return {
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, excludedRowIds },
          },
        };
      }),
    goToConfiguration: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (
          current.scope !== "partial" ||
          current.stage === "configuration" ||
          getConversationShareSelectedRowIds(state, taskId).length === 0
        ) {
          return state;
        }
        return {
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, stage: "configuration" },
          },
        };
      }),
    goToSelection: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial" || current.stage === "selection") return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, stage: "selection", view: "selection" },
          },
        };
      }),
    showTimeline: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial") return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, view: "timeline" },
          },
        };
      }),
    showSelectionPanel: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.scope !== "partial" || current.stage !== "selection") return state;
        return {
          // The timeline was marked keep-open for the popover, so returning to the left pane
          // left the corner dropdown stuck. The store owns pane switches and closes the dropdown too.
          popoverOpen: false,
          drafts: {
            ...state.drafts,
            [taskId]: { ...current, view: "selection" },
          },
        };
      }),
    finishSelection: (taskId) =>
      set((state) => {
        const dockStates = { ...state.dockStates };
        const previousAttempt = dockStates[taskId]?.attempt;
        if (previousAttempt) {
          // Idempotent-retry records persist per session, but visible results, progress and errors must clear on close.
          dockStates[taskId] = {
            ...DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
            attempt: previousAttempt,
          };
        } else {
          delete dockStates[taskId];
        }
        return {
          drafts: { ...state.drafts, [taskId]: EMPTY_DRAFT },
          // When SessionPane reuses the instance, the shared-success state must not stay component-local,
          // or it keeps rendering after the session switches; ending a share clears only that session dock key.
          dockStates,
        };
      }),
    updateDockState: (taskId, patch) =>
      set((state) => ({
        dockStates: {
          ...state.dockStates,
          [taskId]: {
            ...getConversationShareDockState(state, taskId),
            ...patch,
          },
        },
      })),
    resetForTests: () =>
      set({
        popoverOpen: false,
        drafts: {},
        dockStates: {},
      }),
  }),
);
