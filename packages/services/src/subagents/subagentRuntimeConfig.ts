import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  parseAgentProfileFromMarkdown,
  resolveSubagentRuntimeProfiles,
  type SubagentRuntimeConfig,
  type SubagentRuntimeState,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createSubagentConfigScope,
  type SubagentFileChanges,
  type SubagentConfigLoadContext,
} from "#src/subagents/subagentConfigScope.js";

const logger = createServiceLogger("subagentRuntimeConfig");
const INITIAL_LOAD_WAIT_MS = 5000;
interface Workspace {
  workspacePath: string;
  workspaceIdentity?: string;
}
interface ConfigReader {
  readUserRoot(): Promise<string>;
  readStatePath(): Promise<string>;
  readState(path: string): Promise<SubagentRuntimeState>;
}
type Profiles = Map<string, ReturnType<typeof parseAgentProfileFromMarkdown>>;
type Scope<T> = ReturnType<typeof createSubagentConfigScope<T>>;

async function listDocuments(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  // Custom-profile discovery matches the depth:0 watcher so deep definitions change on events, not just rescans.
  return entries
    .filter((entry) => entry.isFile() && /\.(md|markdown)$/iu.test(entry.name))
    .map((entry) => join(root, entry.name));
}
async function loadDocuments(
  root: string,
  source: "user" | "project",
  previous: Profiles | undefined,
  changes: SubagentFileChanges | undefined,
  context: SubagentConfigLoadContext,
): Promise<Profiles> {
  const next =
    changes && previous
      ? new Map(previous)
      : new Map<string, ReturnType<typeof parseAgentProfileFromMarkdown>>();
  const updates =
    changes ?? new Map((await listDocuments(root)).map((path) => [path, "read" as const]));
  await Promise.all(
    [...updates].map(async ([path, action]) => {
      if (action === "remove") {
        next.delete(path);
        return;
      }
      if (!(await context.waitForStableFile(path))) {
        next.delete(path);
        return;
      }
      context.signal.throwIfAborted();
      const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        // Deletes can beat the change-handler read; trust actual absence, never re-fill the old profile.
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (content === undefined) {
        next.delete(path);
        return;
      }
      context.signal.throwIfAborted();
      const parsed = parseAgentProfileFromMarkdown({ content, path, source });
      if (parsed.diagnostic) logger.warn(undefined, "Agent profile diagnostic", parsed.diagnostic);
      next.set(path, parsed);
    }),
  );
  return next;
}
const profiles = (documents: Profiles) =>
  [...documents]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, parsed]) => (parsed.profile ? [parsed.profile] : []));

/** The host solely owns resolution; each parent-turn RPC copies the completed in-memory snapshot only. */
export function createSubagentRuntimeConfigCache(reader: ConfigReader) {
  let disposed = false;
  let user: { path: string; scope: Scope<Profiles> } | undefined;
  let state: { path: string; scope: Scope<SubagentRuntimeState> } | undefined;
  const workspaces = new Map<string, Scope<Profiles>>();
  const snapshots = new Map<string, SubagentRuntimeConfig>();
  const key = (workspace: Workspace) =>
    workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  const assertActive = () => {
    if (disposed) throw new Error("Subagent runtime configuration cache is disposed");
  };
  function publish() {
    if (disposed || !user || !state) return;
    for (const [workspaceKey, project] of workspaces) {
      const scopes = [user.scope, state.scope, project];
      // Keep completed snapshots only; a first-time timeout recovers from per-scope complete results without waiting for the shared refresh.
      if (snapshots.get(workspaceKey)?.kind === "ready" && scopes.some((scope) => scope.busy))
        continue;
      if (scopes.some((scope) => scope.failed))
        snapshots.set(workspaceKey, { kind: "built-in-fallback" });
      else if (user.scope.value && state.scope.value && project.value)
        snapshots.set(workspaceKey, {
          kind: "ready",
          ...resolveSubagentRuntimeProfiles(
            [...profiles(user.scope.value), ...profiles(project.value)],
            state.scope.value,
          ),
        });
    }
  }
  function documentScope(path: string, source: "user" | "project") {
    return createSubagentConfigScope({
      root: path,
      load: (previous: Profiles | undefined, changes, context) =>
        loadDocuments(path, source, previous, changes, context),
      onSettled: publish,
    });
  }
  function required(workspace: Workspace) {
    assertActive();
    const project = workspaces.get(key(workspace));
    if (!user || !state || !project)
      throw new Error("Subagent runtime configuration is not prepared");
    return [user.scope, state.scope, project];
  }
  async function waitForInitialScopes(scopes: Scope<unknown>[]) {
    let waiting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = (async () => {
      do {
        await Promise.all(scopes.map((scope) => scope.settle()));
      } while (waiting && scopes.some((scope) => scope.busy));
      // First-ready completes after the scope settles; publish even if the caller already returned.
      publish();
    })();
    try {
      await Promise.race([
        completed,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            waiting = false;
            logger.warn(
              undefined,
              "Subagent config init wait elapsed; starting anyway and loading in background",
              {
                waitMs: INITIAL_LOAD_WAIT_MS,
              },
            );
            resolve();
          }, INITIAL_LOAD_WAIT_MS);
        }),
      ]);
    } finally {
      // Release the caller only; never abort the shared load nor drop file events. The scope owns cancellation.
      waiting = false;
      if (timer) clearTimeout(timer);
    }
    assertActive();
  }
  return {
    async prepare(workspace?: Workspace) {
      assertActive();
      const initializing: Scope<unknown>[] = [];
      const [userPath, statePath] = (
        await Promise.all([reader.readUserRoot(), reader.readStatePath()])
      ).map((path) => resolve(path)) as [string, string];
      assertActive();
      // New workspaces reuse the shared cache; only an explicit restart rebuilds watchers and full reads.
      const reload = !workspace || workspaces.has(key(workspace));
      if (!user || user.path !== userPath || reload) {
        user?.scope.dispose();
        user = { path: userPath, scope: documentScope(userPath, "user") };
        initializing.push(user.scope);
      }
      if (!state || state.path !== statePath || reload) {
        state?.scope.dispose();
        state = {
          path: statePath,
          scope: createSubagentConfigScope({
            root: dirname(statePath),
            file: statePath,
            // Use the path pinned at prepare; file events never re-read CLI config nor switch storage roots.
            load: async (_previous, _changes, context) => {
              await context.waitForStableFile(statePath);
              context.signal.throwIfAborted();
              return reader.readState(statePath);
            },
            onSettled: publish,
          }),
        };
        initializing.push(state.scope);
      }
      if (workspace) {
        const workspaceKey = key(workspace);
        workspaces.get(workspaceKey)?.dispose();
        const project = documentScope(join(workspace.workspacePath, ".zcode", "agents"), "project");
        workspaces.set(workspaceKey, project);
        initializing.push(project);
      }
      await waitForInitialScopes(initializing);
      publish();
      if (workspace && !snapshots.has(key(workspace)))
        snapshots.set(key(workspace), { kind: "built-in-fallback" });
    },
    async read(workspace: Workspace): Promise<SubagentRuntimeConfig> {
      const scopes = required(workspace);
      if (!snapshots.has(key(workspace))) {
        await waitForInitialScopes(scopes);
        publish();
        if (!snapshots.has(key(workspace)))
          snapshots.set(key(workspace), { kind: "built-in-fallback" });
      }
      const snapshot = snapshots.get(key(workspace));
      if (!snapshot) throw new Error("Subagent runtime configuration is not prepared");
      return structuredClone(snapshot);
    },
    dispose() {
      disposed = true;
      user?.scope.dispose();
      state?.scope.dispose();
      for (const scope of workspaces.values()) scope.dispose();
      workspaces.clear();
      snapshots.clear();
    },
  };
}
