import { create } from "zustand";
import type { Hook, HookConfig } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";

interface HooksStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspaceKey: string | null;
  hooks: Hook[];
  loading: boolean;
  error: string | null;
  operatingHookId: string | null;
  initialize: (
    workspacePath: string | undefined,
    workspaceIdentity: string | undefined,
    hooksService: IHooksService,
  ) => Promise<void>;
  /**
   * refresh must be passed the target captured at call time (the path/identity/service triple).
   * The old signature took only service and read the workspace from the store at load time:
   * a workspace A->B switch during the Trust wait produced "A service + B path/identity",
   * polluting B's list with A's data. The triple is now captured atomically at the call site; store state is a drift guard only.
   */
  refresh: (
    hooksService: IHooksService,
    target: { workspacePath?: string | null; workspaceIdentity?: string | null },
  ) => Promise<void>;
  addHook: (config: HookConfig, hooksService: IHooksService) => Promise<void>;
  updateHook: (id: string, config: HookConfig, hooksService: IHooksService) => Promise<void>;
  deleteHook: (id: string, hooksService: IHooksService) => Promise<void>;
  toggleHook: (id: string, enabled: boolean, hooksService: IHooksService) => Promise<void>;
  importHook: (id: string, hooksService: IHooksService) => Promise<void>;
}

type StoreSet = (state: Partial<HooksStoreState>) => void;
type StoreGet = () => HooksStoreState;

const inflightLoads = new Map<string, Promise<void>>();

// The store is a singleton, so a load started before a workspace switch can land later. Before any async result
// is written back, compare it against the target key captured at call time, or the old workspace's hooks
// overwrite the current projection and get persisted to the new workspace.
function currentWorkspaceKey(get: StoreGet): string | null {
  const { workspacePath, workspaceIdentity } = get();
  return workspacePath ? getWorkspaceKey(workspacePath, workspaceIdentity) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildZCodeHookLocation(
  workspacePath: string,
  storageLevel: "user" | "project" = "user",
): Hook["location"] {
  return storageLevel === "project"
    ? {
        source: "zcode",
        scope: "project",
        directoryPath: "",
        projectPath: workspacePath,
      }
    : {
        source: "zcode",
        scope: "user",
        directoryPath: "",
      };
}

function isEditableHook(hook: Hook): boolean {
  return hook.editable ?? (!hook.location || hook.location.source === "zcode");
}

function hookFromConfig(config: HookConfig, workspacePath: string): Hook {
  return {
    id: `hook-${crypto.randomUUID()}`,
    event: config.event,
    matcher: config.matcher,
    type: config.type,
    command: config.command,
    ...(config.type === "process" ? { args: config.args ?? [] } : {}),
    ...(config.type === "command" && config.async !== undefined ? { async: config.async } : {}),
    ...(config.type === "command" && config.shell !== undefined ? { shell: config.shell } : {}),
    ...(config.statusMessage ? { statusMessage: config.statusMessage } : {}),
    timeout: config.timeout ?? 60,
    enabled: config.enabled ?? true,
    custom: config.custom,
    location: buildZCodeHookLocation(workspacePath, config.storageLevel),
  };
}

function updateHookFromConfig(hook: Hook, config: HookConfig): Hook {
  return {
    ...hook,
    event: config.event,
    matcher: config.matcher,
    type: config.type,
    command: config.command,
    args: config.type === "process" ? (config.args ?? []) : undefined,
    async: config.type === "command" ? config.async : undefined,
    shell: config.type === "command" ? config.shell : undefined,
    statusMessage: config.statusMessage,
    timeout: config.timeout ?? 60,
    enabled: config.enabled ?? hook.enabled,
    custom: config.custom,
  };
}

async function loadCurrentHooks(get: StoreGet, set: StoreSet, hooksService: IHooksService) {
  const { workspacePath, workspaceIdentity } = get();
  if (!workspacePath) return;
  const key = getWorkspaceKey(workspacePath, workspaceIdentity);
  const result = await hooksService.loadHooks({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
  if (currentWorkspaceKey(get) !== key) return;
  set({
    hooks: result.hooks,
    loadedWorkspaceKey: key,
  });
}

async function persistHooks(
  hooks: Hook[],
  get: StoreGet,
  set: StoreSet,
  hooksService: IHooksService,
): Promise<void> {
  const { workspacePath, workspaceIdentity } = get();
  if (!workspacePath) throw new Error("No workspace path set");
  await hooksService.saveHooks({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    hooks,
  });
  await loadCurrentHooks(get, set, hooksService);
}

// The five write actions share one optimistic update -> persist -> rollback flow, in one place so the stale guard is written only once.
async function applyHookMutation(
  get: StoreGet,
  set: StoreSet,
  hooksService: IHooksService,
  updatedHooks: Hook[],
  operatingHookId?: string,
): Promise<void> {
  const previousHooks = get().hooks;
  const key = currentWorkspaceKey(get);
  set({
    hooks: updatedHooks,
    error: null,
    ...(operatingHookId ? { operatingHookId } : {}),
  });
  try {
    await persistHooks(updatedHooks, get, set, hooksService);
    set({ operatingHookId: null });
  } catch (error) {
    // On save failure after a workspace switch, rolling the captured old hooks back would pollute the current workspace.
    set(
      currentWorkspaceKey(get) === key
        ? { hooks: previousHooks, operatingHookId: null, error: errorMessage(error) }
        : { operatingHookId: null },
    );
    throw error;
  }
}

export const useHooksStore = create<HooksStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspaceKey: null,
  hooks: [],
  loading: false,
  error: null,
  operatingHookId: null,

  initialize: async (workspacePath, workspaceIdentity, hooksService) => {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    set({ workspacePath: workspacePath ?? null, workspaceIdentity: normalizedIdentity });
    if (!workspacePath) {
      set({ hooks: [], loading: false, loadedWorkspaceKey: null });
      return;
    }
    const key = getWorkspaceKey(workspacePath, normalizedIdentity);
    // Drop the previous projection as soon as the workspace switches so its hooks are not shown or mutated before fresh data arrives.
    if (get().loadedWorkspaceKey !== key) {
      set({ hooks: [], loadedWorkspaceKey: null });
    }
    const existing = inflightLoads.get(key);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      set({ loading: true, error: null });
      try {
        const result = await hooksService.loadHooks({
          workspacePath,
          ...(normalizedIdentity ? { workspaceIdentity: normalizedIdentity } : {}),
        });
        if (currentWorkspaceKey(get) !== key) return;
        set({ hooks: result.hooks, loadedWorkspaceKey: key, loading: false });
      } catch (error) {
        if (currentWorkspaceKey(get) !== key) return;
        set({ error: errorMessage(error), loading: false });
      } finally {
        inflightLoads.delete(key);
      }
    })();
    inflightLoads.set(key, promise);
    await promise;
  },

  refresh: async (hooksService, target) => {
    // The triple is captured atomically at the call site: service and path/identity must come from the same target at the same moment.
    const targetPath = target.workspacePath ?? null;
    const targetIdentity = target.workspaceIdentity?.trim() || null;
    if (!targetPath) return;
    const key = getWorkspaceKey(targetPath, targetIdentity);
    // Bail out when the target has already stopped being the current workspace (user left during the Trust wait):
    // loading/error is a single global field, and setting loading=true for a result that is dropped on key mismatch
    // would leave this workspace stuck in loading forever.
    if (currentWorkspaceKey(get) !== key) return;
    set({ loading: true, error: null });
    try {
      const result = await hooksService.loadHooks({
        workspacePath: targetPath,
        ...(targetIdentity ? { workspaceIdentity: targetIdentity } : {}),
      });
      // The store switched to another workspace while waiting -> this result is invalid for the current
      // projection; drop it silently. The loading lifecycle belongs to the new workspace's own initialize.
      if (currentWorkspaceKey(get) !== key) return;
      set({ hooks: result.hooks, loadedWorkspaceKey: key, loading: false });
    } catch (error) {
      if (currentWorkspaceKey(get) !== key) return;
      set({ error: errorMessage(error), loading: false });
    }
  },

  addHook: async (config, hooksService) => {
    const { workspacePath, hooks } = get();
    if (!workspacePath) throw new Error("No workspace path set");
    await applyHookMutation(get, set, hooksService, [
      ...hooks,
      hookFromConfig(config, workspacePath),
    ]);
  },

  updateHook: async (id, config, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.map((hook) => (hook.id === id ? updateHookFromConfig(hook, config) : hook)),
      id,
    );
  },

  deleteHook: async (id, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.filter((hook) => hook.id !== id),
      id,
    );
  },

  toggleHook: async (id, enabled, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.map((hook) => (hook.id === id ? { ...hook, enabled } : hook)),
      id,
    );
  },

  importHook: async (id, hooksService) => {
    const { hooks, workspacePath } = get();
    if (!workspacePath) throw new Error("No workspace path set");
    const source = hooks.find((hook) => hook.id === id);
    if (!source || source.location?.source === "zcode") throw new Error("Hook is not importable");
    const imported: Hook = {
      ...source,
      id: `hook-${crypto.randomUUID()}`,
      enabled: true,
      location: buildZCodeHookLocation(workspacePath, source.location?.scope ?? "user"),
    };
    await applyHookMutation(get, set, hooksService, [...hooks, imported], id);
  },
}));
