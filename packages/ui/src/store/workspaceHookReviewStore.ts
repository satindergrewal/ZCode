import { create } from "zustand";
import type {
  CommandAck,
  CommandEnvelope,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
// Single source of truth for review monotonicity rulings; the store's apply lets cross_flow
// accept the new Runtime authority (renderer obeys the latest canonical snapshot delivery).
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";

export interface WorkspaceHookCommandBinding {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

export interface WorkspaceHookReviewBinding {
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
      // A disconnected command channel must not keep its review binding, or Settings gets a
      // disposed client. The sendCommand identity guard keeps old-connection cleanup off the new one.
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings, commandBindings };
    }),
  upsert: (sessionId, binding) =>
    set((state) => {
      const commandBinding = state.commandBindings[sessionId];
      if (commandBinding && commandBinding.sendCommand !== binding.sendCommand) {
        // On reconnect a stale effect can land late; only the current session command channel may
        // refresh the review binding, so equal-generation replays never restore a disposed client.
        return state;
      }
      const current = state.bindings[sessionId];
      if (current) {
        const verdict = verdictWorkspaceHookReviewRequest(current.request, binding.request);
        // Generation is comparable only within one Runtime flow. A new Runtime issues a new
        // reviewFlowId restarting at 1; across flows (cross_flow) the canonical snapshot's latest
        // delivery wins, or an old high generation blocks new authority forever. Within a flow,
        // generation stays monotonic: replay/conflict/stale never override the current binding.
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
 * Finds the exact immutable review binding allowed to confirm a given static Settings row.
 *
 * Settings trustState is display-only and never the mutation authority; a commit must match
 * workspace, bundle, and the opaque reviewItemId together, so a pending wait cannot misapply
 * another request across generation/bundle.
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

    // A synchronous upsert can still land between subscribe and first read; re-check after subscribing.
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
    // OR-matching identity OR path is not enough: a remote tab with the same path would be
    // chosen by local Settings as the trust-submit channel, cross-authorizing workspaces.
    // Fix: once a binding carries an identity it matches workspaceKey strictly; only legacy
    // identity-less local bindings may fall back to path.
    return bindingWorkspaceIdentity === workspaceKey;
  }
  // When the query itself carries an identity, never downgrade to path either; an unknown remote
  // identity would otherwise mispick a legacy local binding without one.
  return !input.workspaceIdentity?.trim() && input.bindingWorkspacePath === input.workspacePath;
}
