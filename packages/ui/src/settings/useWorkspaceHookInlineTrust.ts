import { useCallback, useEffect, useRef, useState } from "react";
import type { Hook } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useHooksStore } from "@/store/hooksStore.js";
import {
  findWorkspaceHookCommandBinding,
  findWorkspaceHookReviewBinding,
  useWorkspaceHookReviewStore,
} from "@/store/workspaceHookReviewStore.js";
import { trustWorkspaceHookWithReview } from "./workspaceHookReviewCommands.js";
import {
  didWorkspaceHookReviewSettle,
  resolveWorkspaceHookReasonCodeMessageId,
  shouldSilenceStaleRejection,
} from "./workspaceHookTrustState.js";

export function useWorkspaceHookInlineTrust(input: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  hooksService?: IHooksService;
  rpcReady?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const contextServices = useServices();
  // Settings' PluginScopeMenu can select a non-active (remote) workspace.
  // If the post-trust refresh or the settings pretrust fallback went through useServices()'s context service
  // (pinned to the active tab's host), RPCs would hit the wrong host; while remote-waiting the fallback would
  // worse, send cross-boundary RPC to a disconnected proxy. So hooksService must be passed in resolved against the
  // target workspace, and with rpcReady=false both fallback and refresh disable: an unusable trust link beats a wrong host.
  const hooksService =
    input.rpcReady === false
      ? undefined
      : (input.hooksService ??
        (input.rpcReady === true ? contextServices.hooksService : undefined));
  const canUseHooksService = hooksService !== undefined;
  const refreshHooks = useHooksStore((state) => state.refresh);
  const [trustingHookId, setTrustingHookId] = useState<string | null>(null);
  const activeReview = useWorkspaceHookReviewStore((state) =>
    findWorkspaceHookReviewBinding(state.bindings, input.workspacePath, input.workspaceIdentity),
  );
  const activeReviewInteractionId = activeReview?.request.interactionId;
  const hasWorkspaceGrantAuthority =
    canUseHooksService && Boolean(hooksService!.grantWorkspaceHookTrust);
  const trustActionAvailable = useWorkspaceHookReviewStore(
    (state) =>
      hasWorkspaceGrantAuthority ||
      Boolean(
        findWorkspaceHookReviewBinding(
          state.bindings,
          input.workspacePath,
          input.workspaceIdentity,
        ) ??
        findWorkspaceHookCommandBinding(
          state.commandBindings,
          input.workspacePath,
          input.workspaceIdentity,
        ),
      ),
  );

  // Refresh the list when the review binding ends, or the inline button sticks on a pre-trust snapshot.
  const previousReviewInteractionId = useRef(activeReviewInteractionId);
  useEffect(() => {
    const settled = didWorkspaceHookReviewSettle({
      previousInteractionId: previousReviewInteractionId.current,
      currentInteractionId: activeReviewInteractionId,
    });
    previousReviewInteractionId.current = activeReviewInteractionId;
    if (!settled || !input.workspacePath || !canUseHooksService) return;
    // Capture the triple at the same instant as the service, so a scope switch during the refresh cannot pollute the new workspace.
    const service = hooksService!;
    const target = {
      workspacePath: input.workspacePath,
      workspaceIdentity: input.workspaceIdentity,
    };
    void refreshHooks(service, target);
  }, [
    activeReviewInteractionId,
    canUseHooksService,
    hooksService,
    input.workspaceIdentity,
    input.workspacePath,
    refreshHooks,
  ]);

  const trustHook = useCallback(
    async (hook: Hook) => {
      if (!canUseHooksService) return;
      const service = hooksService!;
      setTrustingHookId(hook.id);
      try {
        const result = await trustWorkspaceHookWithReview({
          hook,
          workspacePath: input.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
          ...(service.grantWorkspaceHookTrust
            ? {
                grantWithoutSession: (target) => service.grantWorkspaceHookTrust!(target),
              }
            : {}),
        });
        if (!result.accepted) {
          const currentBinding = findWorkspaceHookReviewBinding(
            useWorkspaceHookReviewStore.getState().bindings,
            input.workspacePath,
            input.workspaceIdentity,
          );
          const hasLivePendingBinding = Boolean(currentBinding);
          if (
            !shouldSilenceStaleRejection({
              reasonCode: result.reasonCode,
              hasLivePendingBinding,
            })
          ) {
            toast(
              intl.formatMessage({
                id: resolveWorkspaceHookReasonCodeMessageId(result.reasonCode),
              }),
            );
          }
          return;
        }
        // On success refresh atomically against the originating target; a mid-wait scope switch is dropped by the store guard.
        await refreshHooks(service, {
          workspacePath: input.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
        });
      } catch (cause) {
        logger.error("[workspace-hook-trust] inline trust command failed", { cause });
        toast(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setTrustingHookId(null);
      }
    },
    [
      canUseHooksService,
      hooksService,
      input.workspaceIdentity,
      input.workspacePath,
      intl,
      refreshHooks,
    ],
  );

  return {
    activeReviewInteractionId,
    trustActionAvailable,
    trustingHookId,
    trustHook,
  };
}
