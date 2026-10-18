import { create } from "zustand";
import type {
  CommandAck,
  CommandEnvelope,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
// Single source of truth for review-monotonicity rulings; the store policy is cross_flow accepts the newer Runtime authority
// (the renderer obeys the canonical snapshot latest delivery).
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";

export interface WorkspaceHookCommandBinding {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

interface WorkspaceHookReviewBinding {
  request: WorkspaceHookReviewRequestPayload;
  workspacePath: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

interface WorkspaceHookReviewState {
  bindings: Record<string, WorkspaceHookReviewBinding>;
  commandBindings: Record<string, WorkspaceHookCommandBinding>;
  connect(sessionId: string, binding: WorkspaceHookCommandBinding): void;
  disconnect(sessionId: string, sendCommand: WorkspaceHookCommandBinding["sendCommand"]): void;
  upsert(sessionId: string, binding: WorkspaceHookReviewBinding): void;
  clear(sessionId: string, interactionId?: string): void;
}

export const useWorkspaceHookReviewStore = create<WorkspaceHookReviewState>((set) => ({
  bindings: {},
  commandBindings: {},
  connect: (sessionId, binding) =>
    set((state) => ({
      commandBindings: { ...state.commandBindings, [sessionId]: binding },
    })),
  disconnect: (sessionId, sendCommand) =>
    set((state) => {
      const current = state.commandBindings[sessionId];
      if (!current || current.sendCommand !== sendCommand) return state;
      const commandBindings = { ...state.commandBindings };
      delete commandBindings[sessionId];
      const review = state.bindings[sessionId];
      if (!review || review.sendCommand !== sendCommand) return { commandBindings };
      // Once the command channel dies, the same-connection review binding must not survive, or Settings
      // gets a disposed client. The sendCommand identity guard keeps an old-connection cleanup from clearing the new one.
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings, commandBindings };
    }),
  upsert: (sessionId, binding) =>
    set((state) => {
      const commandBinding = state.commandBindings[sessionId];
      if (commandBinding && commandBinding.sendCommand !== binding.sendCommand) {
        // On renderer reconnect a stale effect may land late; only the current-session command channel may
        // refresh the review binding, keeping equal-generation replays from swapping the new client back to a disposed one.
        return state;
      }
      const current = state.bindings[sessionId];
      if (current) {
        const verdict = verdictWorkspaceHookReviewRequest(current.request, binding.request);
        // Generations compare only within one Runtime flow. A new Runtime mints a new
        // reviewFlowId counting from 1; across flows (cross_flow) the canonical snapshot latest delivery wins,
        // or a stale high generation blocks new authoritative requests forever. Within a flow generation is strictly
        // monotonic: replay/conflict/stale never overwrite the current binding.
        if (
          verdict === "same_flow_stale" ||
          verdict === "same_flow_replay" ||
          verdict === "same_flow_conflict"
        ) {
          return state;
        }
      }
      return { bindings: { ...state.bindings, [sessionId]: binding } };
    }),
  clear: (sessionId, interactionId) =>
    set((state) => {
      const current = state.bindings[sessionId];
      if (!current || (interactionId && current.request.interactionId !== interactionId)) {
        return state;
      }
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings };
    }),
}));

export function findWorkspaceHookReviewBinding(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  workspacePath?: string | null,
  workspaceIdentity?: string,
): WorkspaceHookReviewBinding | undefined {
  return Object.values(bindings)
    .filter((binding) =>
      matchesWorkspaceBinding({
        bindingWorkspaceIdentity: binding.request.workspaceIdentity,
        bindingWorkspacePath: binding.workspacePath,
        workspaceIdentity,
        workspacePath,
      }),
    )
    .sort((left, right) => right.request.createdAt - left.request.createdAt)[0];
}

const TRUSTABLE_WORKSPACE_HOOK_STATES = new Set(["pending_trust", "revoked", "stale_digest"]);

/**
 * Finds the exact immutable review binding able to authorize the given static Settings row.
 *
 * The Settings trustState is display-only, never mutation authority; before a real commit, match
 * workspace, bundle and the opaque reviewItemId together, so a wait cannot misuse another request across
 * generations/bundles.
 */
export function findWorkspaceHookReviewBindingForItem(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    bundleDigest: string;
    reviewItemId: string;
  },
): WorkspaceHookReviewBinding | undefined {
  return Object.values(bindings)
    .filter(
      (binding) =>
        matchesWorkspaceBinding({
          bindingWorkspaceIdentity: binding.request.workspaceIdentity,
          bindingWorkspacePath: binding.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
          workspacePath: input.workspacePath,
        }) &&
        binding.request.bundleDigest === input.bundleDigest &&
        binding.request.items.some(
          (item) =>
            item.reviewItemId === input.reviewItemId &&
            TRUSTABLE_WORKSPACE_HOOK_STATES.has(item.trustState),
        ),
    )
    .sort((left, right) => right.request.createdAt - left.request.createdAt)[0];
}

export function waitForWorkspaceHookReviewBindingForItem(
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    bundleDigest: string;
    reviewItemId: string;
  },
  timeoutMs: number,
): Promise<WorkspaceHookReviewBinding | undefined> {
  const current = findWorkspaceHookReviewBindingForItem(
    useWorkspaceHookReviewStore.getState().bindings,
    input,
  );
  if (current) return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const timer = globalThis.setTimeout(() => finish(undefined), timeoutMs);
    const finish = (binding: WorkspaceHookReviewBinding | undefined) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(binding);
    };
    unsubscribe = useWorkspaceHookReviewStore.subscribe((state) => {
      const binding = findWorkspaceHookReviewBindingForItem(state.bindings, input);
      if (binding) finish(binding);
    });

    // A synchronous upsert can still land between subscribe and first read; check once more after subscribing to close the race.
    const afterSubscribe = findWorkspaceHookReviewBindingForItem(
      useWorkspaceHookReviewStore.getState().bindings,
      input,
    );
    if (afterSubscribe) finish(afterSubscribe);
  });
}

export function findWorkspaceHookCommandBinding(
  bindings: Record<string, WorkspaceHookCommandBinding>,
  workspacePath?: string | null,
  workspaceIdentity?: string,
): WorkspaceHookCommandBinding | undefined {
  return Object.values(bindings).find((binding) =>
    matchesWorkspaceBinding({
      bindingWorkspaceIdentity: binding.workspaceIdentity,
      bindingWorkspacePath: binding.workspacePath,
      workspaceIdentity,
      workspacePath,
    }),
  );
}

function matchesWorkspaceBinding(input: {
  bindingWorkspaceIdentity?: string;
  bindingWorkspacePath: string;
  workspaceIdentity?: string;
  workspacePath?: string | null;
}): boolean {
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  if (!workspaceKey) return false;
  const bindingWorkspaceIdentity = input.bindingWorkspaceIdentity?.trim();
  if (bindingWorkspaceIdentity) {
    // An OR of identity-hit/path-hit is not enough: a same-path remote tab would be chosen by local Settings
    // as the trust-commit channel via equal paths, cross-authorizing workspaces.
    // Fix: once a binding carries an identity it matches workspaceKey strictly; only legacy local bindings
    // without an identity may fall back to path.
    return bindingWorkspaceIdentity === workspaceKey;
  }
  // A query carrying an identity likewise never degrades to path, or an unknown remote identity would pick
  // a local legacy binding without one.
  return !input.workspaceIdentity?.trim() && input.bindingWorkspacePath === input.workspacePath;
}
