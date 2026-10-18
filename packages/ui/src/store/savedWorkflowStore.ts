// Read cache of the saved-workflow hub.
// Sharded by workspaceKey; disk stays the only authority (invariant 2) - the cache serves same-page re-renders only,
// and every change refreshes with bypass (the skillStore lesson: reusing the in-flight promise returns a stale scan).
import { create } from "zustand";
import {
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowInvalidEntry,
  type ZCodeSavedWorkflowRun,
  type ZCodeWorkflowsListResult,
} from "@zcode/shared";
import type { IZCodeAgentService, ZCodeAgentSavedWorkflowTarget } from "@zcode/services";
import { logger } from "@/logger.js";
import { useWorkflowRunSavedStore } from "@/store/workflowRunSavedStore.js";

/** How many runs a page pulls to compute last-run; a project rarely has more active workflows than that. */
const SAVED_WORKFLOW_RUNS_PAGE = 50;

/**
 * Declaration emit needs this: the useSavedWorkflowGlobalGroup return type references it and tsc -d requires it nameable;
 * knip cannot see that usage, hence the public marker.
 * @public
 */
export interface SavedWorkflowWorkspaceState {
  entries: ZCodeSavedWorkflowEntry[];
  invalid: ZCodeSavedWorkflowInvalidEntry[];
  runs: ZCodeSavedWorkflowRun[];
  /** Scanned dirs (local absolute paths) that the global group watches; null before load/list. */
  dir: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** JSON-RPC error code of the list call, when present; the global group reads -32602 as legacy-agent-unsupported. */
  errorCode: number | null;
}

const EMPTY_SAVED_WORKFLOW_STATE: SavedWorkflowWorkspaceState = {
  entries: [],
  invalid: [],
  runs: [],
  dir: null,
  loading: false,
  loaded: false,
  error: null,
  errorCode: null,
};

interface SavedWorkflowStoreState {
  byWorkspaceKey: Record<string, SavedWorkflowWorkspaceState>;
  load: (
    target: ZCodeAgentSavedWorkflowTarget,
    agentService: IZCodeAgentService,
    options?: { bypassCache?: boolean },
  ) => Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Read-cache shard key: the global scope (`scope:"global"` without a workspace)
 * uses the fixed key `"global"` - cross-project, carrier chosen by services, never to be confused with a project workspaceKey;
 * project scopes still shard by resolveWorkspaceKey.
 */
function savedWorkflowStoreKey(target: ZCodeAgentSavedWorkflowTarget): string {
  if (target.scope === "global" && !target.workspacePath) return "global";
  return resolveWorkspaceKey({
    workspacePath: target.workspacePath ?? "",
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  });
}

/** Extract the JSON-RPC code from a thrown error (ChannelClient keeps error.code); null when absent. */
function extractErrorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

async function fetchWorkspace(
  target: ZCodeAgentSavedWorkflowTarget,
  agentService: IZCodeAgentService,
): Promise<{ list: ZCodeWorkflowsListResult; runs: ZCodeSavedWorkflowRun[] }> {
  // List and run history in parallel; a history failure never sinks the list (without the journal the hub still views and manages).
  const [list, runs] = await Promise.all([
    agentService.listSavedWorkflows(target),
    agentService
      .listSavedWorkflowRuns({ ...target, limit: SAVED_WORKFLOW_RUNS_PAGE })
      .then((result) => result.runs)
      .catch((error: unknown) => {
        logger.warn("[savedWorkflowStore] Failed to fetch run history; treating as none", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as ZCodeSavedWorkflowRun[];
      }),
  ]);
  return { list, runs };
}

export const useSavedWorkflowStore = create<SavedWorkflowStoreState>((set) => ({
  byWorkspaceKey: {},
  async load(target, agentService, options = {}) {
    const key = savedWorkflowStoreKey(target);
    if (!options.bypassCache) {
      const current = inFlight.get(key);
      if (current) return current;
    }
    set((state) => ({
      byWorkspaceKey: {
        ...state.byWorkspaceKey,
        [key]: { ...(state.byWorkspaceKey[key] ?? EMPTY_SAVED_WORKFLOW_STATE), loading: true },
      },
    }));
    const request = fetchWorkspace(target, agentService)
      .then(({ list, runs }) => {
        // 中枢刚看过磁盘：把完成卡那张「这次 run 存成了哪个工作流」的读缓存一并作废
        // （docs/dynamic-workflow/transcript-and-notifications.md「Which workflow a run is saved as」）。
        // 中枢里的删除 / 移动 / 改元数据都以一次刷新收尾，这一行让那些动作也走到对话里的卡片上。
        useWorkflowRunSavedStore.getState().invalidate();
        set((state) => ({
          byWorkspaceKey: {
            ...state.byWorkspaceKey,
            [key]: {
              entries: list.workflows,
              invalid: list.invalid,
              runs,
              dir: list.dir,
              loading: false,
              loaded: true,
              error: null,
              errorCode: null,
            },
          },
        }));
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[savedWorkflowStore] Failed to fetch saved workflows", { error: message });
        set((state) => ({
          byWorkspaceKey: {
            ...state.byWorkspaceKey,
            [key]: {
              ...(state.byWorkspaceKey[key] ?? EMPTY_SAVED_WORKFLOW_STATE),
              loading: false,
              loaded: true,
              error: message,
              errorCode: extractErrorCode(error),
            },
          },
        }));
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  },
}));

export function selectSavedWorkflowState(
  state: SavedWorkflowStoreState,
  target: ZCodeAgentSavedWorkflowTarget | null,
): SavedWorkflowWorkspaceState {
  if (!target) return EMPTY_SAVED_WORKFLOW_STATE;
  return state.byWorkspaceKey[savedWorkflowStoreKey(target)] ?? EMPTY_SAVED_WORKFLOW_STATE;
}

/** 测试用：清掉 in-flight 去重表。 */
export function resetSavedWorkflowStoreForTests(): void {
  inFlight.clear();
  useSavedWorkflowStore.setState({ byWorkspaceKey: {} });
}
