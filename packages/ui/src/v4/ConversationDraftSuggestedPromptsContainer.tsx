import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import {
  advanceRecommendedPromptPane,
  getRecommendedPromptsForPane,
  getRecommendedPromptsRevision,
  registerRecommendedPromptPane,
  subscribeRecommendedPrompts,
  unregisterRecommendedPromptPane,
} from "@/v4/featureSuggestedPromptRotation.js";
/* oxlint-disable eslint(max-lines) -- recommended prompts concentrate latest-wins, cancellation, trusted resolution, operation feedback, and Composer handoff; splitting would shred that state machine. */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import { reportPromptTemplateClick } from "@/lib/promptTemplateTelemetry.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  ConversationDraftSuggestedPrompts,
  type DraftSuggestedPromptItem,
} from "@/v4/ConversationDraftSuggestedPrompts.js";
import { buildDraftSuggestedPluginMention } from "@/v4/draftSuggestedPromptPrefill.js";
import { resolveDraftSuggestedPromptText } from "@/v4/draftSuggestedPromptItems.js";
import {
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS,
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
} from "@/v4/draftSuggestedPromptItems.js";
import {
  resolveDraftSuggestedPluginFlowStage,
  type ConversationDraftSuggestedPromptsContainerProps,
  type DraftSuggestedPluginFlow,
  type DraftSuggestedPluginOperation,
  trackDraftSuggestedPluginOperation,
} from "@/v4/ConversationDraftSuggestedPluginFlow.js";
import { useDraftSuggestedPromptItems } from "@/v4/useDraftSuggestedPromptItems.js";
import { useDraftSuggestedPluginActionPopover } from "@/v4/useDraftSuggestedPluginActionPopover.js";
import { getComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import { useComposerTextInsertApplied } from "@/v4/useComposerTextInsertApplied.js";

type PluginMutationKind = "install" | "enable";

const INSTALL_OPERATION_TIMEOUT_MS = 10_000;

type Props = ConversationDraftSuggestedPromptsContainerProps & {
  proactive?: boolean;
  onOpenAutomations?: (automationTab?: AutomationsNavigationTab) => void;
};

let draftSuggestedPluginOperationSequence = 0;

function createDraftSuggestedPluginOperation(
  requestVersion: number,
): DraftSuggestedPluginOperation {
  return {
    operationId:
      globalThis.crypto?.randomUUID?.() ??
      `suggested-${Date.now()}-${requestVersion}-${++draftSuggestedPluginOperationSequence}`,
    abort: new AbortController(),
  };
}

function toPluginMutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ConversationDraftSuggestedPromptsContainer({
  className,
  proactive = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  onOpenAutomations,
  isDesktop = false,
}: Props) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const isOfficeMode = useIsOfficeMode();
  const { update } = useSettings();
  const onboardingRecordService = useOnboardingRecordService();
  const recommendationPaneId = useId();
  const recommendationMode = isOfficeMode ? "office" : "coding";
  const recommendationRevision = useSyncExternalStore(
    subscribeRecommendedPrompts,
    getRecommendedPromptsRevision,
  );
  useEffect(() => {
    if (!proactive) return;
    registerRecommendedPromptPane(recommendationPaneId, recommendationMode);
    return () => unregisterRecommendedPromptPane(recommendationPaneId);
  }, [proactive, recommendationMode, recommendationPaneId]);
  const recommendedItems = useMemo(
    () => getRecommendedPromptsForPane(recommendationPaneId, recommendationMode),
    [recommendationMode, recommendationPaneId, recommendationRevision],
  );
  const [closing, setClosing] = useState(false);
  const closeRecommendations = async () => {
    setClosing(true);
    try {
      // The close button shares the persisted setting with onboarding/settings so a second local toggle cannot reshow the recommendation.
      await update({ proactiveSuggestionsEnabled: false });
      // Manual changes write back into the record, so account-switch sync never resurrects a dismissed recommendation; failures never block closing.
      await onboardingRecordService
        ?.updateRecordPreferences({ proactiveSuggestionsEnabled: false })
        .catch((cause: unknown) => {
          logger.warn("[v4-suggested-prompts] failed to write back onboarding record", {
            error: String(cause),
          });
        });
    } catch (error) {
      logger.warn("[v4-suggested-prompts] failed to dismiss recommendation", {
        error: String(error),
      });
      toast(intl.formatMessage({ id: "chat.officeSuggestions.closeError" }));
    } finally {
      setClosing(false);
    }
  };
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  // Plugin RPC is async; draft, Popover, and chip settle on the latest click only.
  const requestVersionRef = useRef(0);
  const activeOperationRef = useRef<DraftSuggestedPluginOperation | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const allItems = useDraftSuggestedPromptItems({
    clientScenesService: resolution.services.clientScenesService,
    rpcReady: resolution.rpcReady,
    workspaceKey,
  });
  const items = useMemo(
    () =>
      (proactive ? recommendedItems : allItems).filter(
        (item) =>
          !item.actions?.some(
            (action) =>
              action === DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS ||
              action === DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
          ) || Boolean(onOpenAutomations),
      ),
    [allItems, onOpenAutomations, proactive, recommendedItems],
  );
  const {
    clearPluginActionPopover,
    pluginActionPopover,
    showPluginActionPopover,
    showPluginActionResultPopover,
  } = useDraftSuggestedPluginActionPopover();
  const clearOperationFeedback = useCallback(
    (operationId?: string) => {
      clearPluginActionPopover(operationId);
    },
    [clearPluginActionPopover],
  );
  const waitForComposerTextInsertApplied = useComposerTextInsertApplied(
    workspacePath,
    workspaceIdentity,
  );

  const targetParams = useCallback(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
    }),
    [resolution.remoteSessionId, workspaceIdentity, workspacePath],
  );

  const cancelOperation = useCallback(
    (operation: DraftSuggestedPluginOperation): Promise<void> => {
      if (operation.cancellation) return operation.cancellation;
      operation.abort.abort();
      operation.cancellation = (async () => {
        try {
          await resolution.services.pluginManagementService.cancelPluginOperation({
            operationId: operation.operationId,
          });
        } catch (error) {
          logger.warn(
            "[v4-suggested-prompts] failed to cancel stale plugin operation; dropping its late result anyway",
            {
              operationId: operation.operationId,
              error: error instanceof Error ? error.message : String(error),
              workspaceKey,
            },
          );
        } finally {
          await operation.pending?.catch(() => undefined);
          if (activeOperationRef.current === operation) {
            activeOperationRef.current = null;
          }
        }
      })();
      return operation.cancellation;
    },
    [resolution.services.pluginManagementService, workspaceKey],
  );

  useEffect(() => {
    return () => {
      // Drop stale feedback immediately on workspace/attachment switch; late remote results stay gated by version and abort.
      requestVersionRef.current += 1;
      clearOperationFeedback();
      const active = activeOperationRef.current;
      if (active) void cancelOperation(active);
    };
  }, [cancelOperation, clearOperationFeedback, resolution.remoteSessionId, workspaceKey]);

  const prependResolvedPlugin = useCallback(
    (plugin: { stableId: string; label: string }, requestVersion: number, icon?: string) => {
      if (requestVersion !== requestVersionRef.current) return null;
      // Both the recommendation state and display icon come from one trusted resolution against
      // the target Host. No workspace-level plugins exist today; reading referenceCatalog would
      // re-validate and add an RPC.
      const mention = buildDraftSuggestedPluginMention(plugin, icon);
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspacePath,
          mention.markdown,
          workspaceIdentity,
          mention,
          "prepend-if-missing",
        );
    },
    [workspaceIdentity, workspacePath],
  );

  const replacePlainPrompt = useCallback(
    (prompt: string, requestVersion: number, expectedRevision?: number) => {
      if (
        requestVersion !== requestVersionRef.current ||
        (expectedRevision !== undefined &&
          getComposerDraftRevision(workspacePath, workspaceIdentity) !== expectedRevision)
      ) {
        return null;
      }
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, prompt, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );

  const replaceWithResolvedPluginAndPrompt = useCallback(
    (
      plugin: { stableId: string; label: string },
      prompt: string,
      requestVersion: number,
      expectedRevision: number,
      icon?: string,
    ) => {
      if (
        requestVersion !== requestVersionRef.current ||
        getComposerDraftRevision(workspacePath, workspaceIdentity) !== expectedRevision
      ) {
        return null;
      }
      if (prompt.includes("](plugin://")) {
        // With plugin references already in the body, let the Composer resolve every inline
        // mention. Keep an existing target-plugin reference in place; otherwise prepend one
        // reference. The old single-mention path degraded the rest to bare text.
        const hasTarget = prompt.includes(`(plugin://${plugin.stableId})`);
        const text = hasTarget
          ? prompt
          : `${buildDraftSuggestedPluginMention(plugin, icon).markdown} ${prompt}`;
        return useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(workspacePath, text, workspaceIdentity);
      }
      const mention = buildDraftSuggestedPluginMention(plugin, icon);
      const text = prompt.trim() ? `${mention.markdown} ${prompt.trim()}` : mention.markdown;
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, text, workspaceIdentity, mention);
    },
    [workspaceIdentity, workspacePath],
  );

  const revalidateAndPrependPlugin = useCallback(
    async (current: DraftSuggestedPluginFlow, requestVersion: number) => {
      await invalidateDeferredDraftSessionForSkillChange({
        zcodeSessionService: resolution.services.zcodeSessionService,
        workspacePath,
        workspaceIdentity,
        reason: "suggested-prompt-plugin-change",
      });
      if (requestVersion !== requestVersionRef.current) return null;
      const resolved =
        await resolution.services.pluginManagementService.resolveSuggestedPluginReference({
          ...targetParams(),
          clientMode: "desktop-continuous" as const,
          deliveryKind: "desktop-continuous" as const,
          stableId: current.plugin.stableId,
          operationId: current.operationId,
        });
      if (requestVersion !== requestVersionRef.current) return null;
      if (resolveDraftSuggestedPluginFlowStage(resolved) !== "checking") return null;
      return prependResolvedPlugin(current.plugin, requestVersion, resolved.icon);
    },
    [
      prependResolvedPlugin,
      resolution.services.pluginManagementService,
      resolution.services.zcodeSessionService,
      targetParams,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const finishMutation = useCallback(
    (flow: DraftSuggestedPluginFlow, kind: PluginMutationKind, succeeded: boolean) => {
      const active = activeOperationRef.current;
      if (active?.operationId === flow.operationId) activeOperationRef.current = null;
      // Success must not hardcode installSucceeded, or merely enabling an installed plugin shows installed-successfully.
      const messageId = `chat.draft.suggestedPrompt.pluginFlow.${kind}${
        succeeded ? "Succeeded" : "Failed"
      }`;
      showPluginActionResultPopover(flow, messageId, succeeded);
    },
    [showPluginActionResultPopover],
  );

  const showMutationConfirmation = useCallback(
    (
      flow: DraftSuggestedPluginFlow,
      operation: DraftSuggestedPluginOperation,
      requestVersion: number,
      kind: PluginMutationKind,
      onAction: () => void,
    ) => {
      showPluginActionPopover(
        flow,
        `chat.draft.suggestedPrompt.pluginFlow.${kind}Confirmation`,
        "confirmation",
        {
          label: intl.formatMessage({
            id: "chat.draft.suggestedPrompt.pluginFlow.confirm",
          }),
          onAction,
          onDismiss: () => {
            if (
              requestVersion !== requestVersionRef.current ||
              activeOperationRef.current !== operation
            ) {
              return;
            }
            // The confirm state once exited on a fixed timer, interrupting readers and unable to
            // express explicit cancellation. Now only a primary pointer-down outside the Popover
            // closes it, cancelling the same operation so late results stay gated.
            clearOperationFeedback(operation.operationId);
            void cancelOperation(operation);
          },
        },
      );
    },
    [cancelOperation, clearOperationFeedback, intl, showPluginActionPopover],
  );

  const handleMutation = useCallback(
    async function runPluginMutation(
      flow: DraftSuggestedPluginFlow,
      requestVersion: number,
      kind: PluginMutationKind,
    ) {
      const operation = activeOperationRef.current;
      if (
        !operation ||
        operation.operationId !== flow.operationId ||
        requestVersion !== requestVersionRef.current ||
        (kind === "install" &&
          (!flow.result?.pluginName ||
            flow.result.marketplace !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID ||
            flow.result.sourceTrust !== "official"))
      ) {
        return;
      }
      showPluginActionPopover(
        flow,
        kind === "install"
          ? "chat.draft.suggestedPrompt.pluginFlow.installing"
          : "chat.draft.suggestedPrompt.pluginFlow.enabling",
        "progress",
      );
      let installTimedOut = false;
      let mutationCompleted = false;
      const restoreInstallConfirmation = (errorMessage: string) => {
        // The install-failure state used to remove the action entry too. Restore the same
        // PopoverContent under a fresh operation: immediate retry, and a timed-out/failed old
        // operation cannot overwrite the new state late.
        operation.abort.abort();
        const retryOperation = createDraftSuggestedPluginOperation(requestVersion);
        const retryFlow: DraftSuggestedPluginFlow = {
          ...flow,
          operationId: retryOperation.operationId,
        };
        activeOperationRef.current = retryOperation;
        logger.warn(
          "[v4-suggested-prompts] recommended plugin install failed; restoring confirm state for retry",
          {
            error: errorMessage,
            operationId: flow.operationId,
            pluginId: flow.plugin.stableId,
            workspaceKey,
          },
        );
        toast(
          intl.formatMessage(
            { id: "chat.draft.suggestedPrompt.pluginFlow.installFailureToast" },
            { pluginLabel: flow.plugin.label, error: errorMessage },
          ),
          { variant: "warning" },
        );
        showMutationConfirmation(
          retryFlow,
          retryOperation,
          requestVersion,
          "install",
          () => void runPluginMutation(retryFlow, requestVersion, "install"),
        );
      };
      try {
        if (kind === "install") {
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const installRequest = resolution.services.pluginManagementService.installPlugin({
            ...targetParams(),
            pluginName: flow.result!.pluginName!,
            marketplace: flow.result!.marketplace!,
            scope: "user",
            operationId: flow.operationId,
          });
          const timedInstallRequest = installRequest.finally(() => {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          });
          const timeoutRequest = new Promise<never>((_, reject) => {
            // After an install timeout, cancel the same operation explicitly; merely ending the UI wait lets a late remote success keep polluting the draft.
            timeoutHandle = setTimeout(() => {
              installTimedOut = true;
              void cancelOperation(operation);
              reject(
                new Error(
                  intl.formatMessage({
                    id: "chat.draft.suggestedPrompt.pluginFlow.installTimedOut",
                  }),
                ),
              );
            }, INSTALL_OPERATION_TIMEOUT_MS);
          });
          const result = await trackDraftSuggestedPluginOperation(
            operation,
            Promise.race([timedInstallRequest, timeoutRequest]),
          );
          const errorDiagnostic = result.diagnostics.find(
            (diagnostic) => diagnostic.severity === "error",
          );
          if (errorDiagnostic || result.installedPlugins.length === 0) {
            restoreInstallConfirmation(
              errorDiagnostic?.message ??
                intl.formatMessage({
                  id: "chat.draft.suggestedPrompt.pluginFlow.installReturnedEmpty",
                }),
            );
            return;
          }
        } else {
          await trackDraftSuggestedPluginOperation(
            operation,
            resolution.services.pluginManagementService.setPluginEnabled({
              ...targetParams(),
              pluginId: flow.plugin.stableId,
              enabled: true,
              operationId: flow.operationId,
            }),
          );
        }
        mutationCompleted = true;
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        const composerRequestId = await trackDraftSuggestedPluginOperation(
          operation,
          revalidateAndPrependPlugin(flow, requestVersion),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        if (composerRequestId === null) {
          finishMutation(flow, kind, false);
          return;
        }
        const applied = await trackDraftSuggestedPluginOperation(
          operation,
          waitForComposerTextInsertApplied(composerRequestId, operation.abort.signal),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        finishMutation(flow, kind, applied);
      } catch (error) {
        if (
          (operation.abort.signal.aborted && !installTimedOut) ||
          requestVersion !== requestVersionRef.current
        )
          return;
        if (kind === "install" && !mutationCompleted) {
          restoreInstallConfirmation(toPluginMutationErrorMessage(error));
          return;
        }
        logger.warn(
          `[v4-suggested-prompts] recommended plugin ${kind === "install" ? "install" : "enable"} failed`,
          {
            error: toPluginMutationErrorMessage(error),
            operationId: flow.operationId,
            pluginId: flow.plugin.stableId,
            workspaceKey,
          },
        );
        finishMutation(flow, kind, false);
      }
    },
    [
      cancelOperation,
      finishMutation,
      intl,
      revalidateAndPrependPlugin,
      resolution.services.pluginManagementService,
      showMutationConfirmation,
      showPluginActionPopover,
      targetParams,
      waitForComposerTextInsertApplied,
      workspaceKey,
    ],
  );

  const handleSelect = useCallback(
    async (item: DraftSuggestedPromptItem) => {
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      const templateName = resolveDraftSuggestedPromptText(item.label, locale);
      const prompt = resolveDraftSuggestedPromptText(item.prompt, locale);
      if (isDesktop) {
        // Telemetry is passive observation: fire before navigation/async plugin resolution and never block the interaction.
        void reportPromptTemplateClick(platform, {
          templateId: item.id,
          templateName,
          templatePrompt: prompt,
        });
      }
      if (
        onOpenAutomations &&
        item.actions?.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK)
      ) {
        onOpenAutomations("idle");
        return;
      }
      if (
        onOpenAutomations &&
        item.actions?.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS)
      ) {
        onOpenAutomations();
        return;
      }
      const plugin = item.plugin
        ? {
            stableId: item.plugin.stableId,
            label: resolveDraftSuggestedPromptText(item.plugin.label, locale),
          }
        : undefined;

      // Non-plugin recommendations have no remote check: replace the plain draft immediately as
      // before. Plugin-backed ones wait for trusted resolution and decide once between plain
      // prompt and plugin+prompt, never a two-phase Composer update.
      if (!plugin || !resolution.rpcReady) {
        replacePlainPrompt(prompt, requestVersion);
      }

      const previous = activeOperationRef.current;
      if (previous) {
        // Switching recommendations manually is expected takeover: close the old feedback, no cancel/interrupt toast.
        clearOperationFeedback(previous.operationId);
        setCancelling(true);
        await cancelOperation(previous);
        if (requestVersion !== requestVersionRef.current) return;
        setCancelling(false);
      }
      if (!plugin || !resolution.rpcReady) return;
      // Take the baseline only after the old operation's cancellation settles: it may just have
      // handed its plain prompt to the Composer. That is this recommendation flow's procedural
      // write and must not read as a user edit to the new recommendation.
      const draftRevision = getComposerDraftRevision(workspacePath, workspaceIdentity);

      const operation = createDraftSuggestedPluginOperation(requestVersion);
      activeOperationRef.current = operation;
      const checkingFlow: DraftSuggestedPluginFlow = {
        anchorItemId: item.id,
        operationId: operation.operationId,
        plugin,
        stage: "unavailable",
      };
      // Trusted resolution of a missing plugin waits on the official Marketplace refresh; the old
      // flow opened the confirm Popover only after the request, looking frozen while waiting.
      // Subscribe to the same operation's local check first and only move the existing single
      // Popover's phase; confirm/operate/result keep one mount point.
      const progressSubscription =
        resolution.services.pluginManagementService.onDynamicPluginOperationProgress(
          operation.operationId,
        )((event) => {
          if (
            event.state !== "refreshing" ||
            operation.abort.signal.aborted ||
            activeOperationRef.current !== operation ||
            requestVersion !== requestVersionRef.current ||
            getComposerDraftRevision(workspacePath, workspaceIdentity) !== draftRevision
          ) {
            return;
          }
          showPluginActionPopover(
            checkingFlow,
            "chat.draft.suggestedPrompt.pluginFlow.checking",
            "progress",
          );
        });
      try {
        const result = await trackDraftSuggestedPluginOperation(
          operation,
          resolution.services.pluginManagementService.resolveSuggestedPluginReference({
            ...targetParams(),
            clientMode: "desktop-continuous" as const,
            deliveryKind: "desktop-continuous" as const,
            stableId: plugin.stableId,
            operationId: operation.operationId,
          }),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        if (getComposerDraftRevision(workspacePath, workspaceIdentity) !== draftRevision) {
          clearOperationFeedback(operation.operationId);
          activeOperationRef.current = null;
          return;
        }
        const flow: DraftSuggestedPluginFlow = {
          anchorItemId: item.id,
          operationId: operation.operationId,
          plugin,
          result,
          stage: resolveDraftSuggestedPluginFlowStage(result),
        };
        if (flow.stage === "checking") {
          replaceWithResolvedPluginAndPrompt(
            flow.plugin,
            prompt,
            requestVersion,
            draftRevision,
            result.icon,
          );
          if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current)
            return;
          activeOperationRef.current = null;
          clearOperationFeedback(flow.operationId);
          return;
        }
        if (flow.stage === "missing" || flow.stage === "disabled") {
          // Disabled needs no Marketplace refresh and may never see an Agent progress notice; still
          // move the same Popover to checking before the plain-prompt write, then wait for the
          // Composer to land and flip the confirm state in place.
          showPluginActionPopover(
            flow,
            "chat.draft.suggestedPrompt.pluginFlow.checking",
            "progress",
          );
          const composerRequestId = replacePlainPrompt(prompt, requestVersion, draftRevision);
          if (composerRequestId === null) {
            clearOperationFeedback(flow.operationId);
            activeOperationRef.current = null;
            return;
          }
          // If the confirm Popover opens before the Composer consumes the plain prompt, the
          // growing input shifts the whole recommendation anchor and the popover appears at stale
          // coordinates then jumps. Both install and enable measure the anchor only after the
          // insertion lands.
          const applied = await trackDraftSuggestedPluginOperation(
            operation,
            waitForComposerTextInsertApplied(composerRequestId, operation.abort.signal),
          );
          if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current)
            return;
          if (!applied) {
            clearOperationFeedback(flow.operationId);
            activeOperationRef.current = null;
            return;
          }
          const kind: PluginMutationKind = flow.stage === "missing" ? "install" : "enable";
          showMutationConfirmation(
            flow,
            operation,
            requestVersion,
            kind,
            () => void handleMutation(flow, requestVersion, kind),
          );
          return;
        }
        replacePlainPrompt(prompt, requestVersion, draftRevision);
        clearOperationFeedback(flow.operationId);
        activeOperationRef.current = null;
      } catch (error) {
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        logger.warn("[v4-suggested-prompts] recommended plugin trusted resolution failed", {
          error: error instanceof Error ? error.message : String(error),
          pluginId: plugin.stableId,
          workspaceKey,
        });
        replacePlainPrompt(prompt, requestVersion, draftRevision);
        clearOperationFeedback(operation.operationId);
        activeOperationRef.current = null;
      } finally {
        progressSubscription.dispose();
      }
    },
    [
      cancelOperation,
      clearOperationFeedback,
      locale,
      onOpenAutomations,
      platform,
      replacePlainPrompt,
      replaceWithResolvedPluginAndPrompt,
      resolution.rpcReady,
      resolution.services.pluginManagementService,
      handleMutation,
      isDesktop,
      showMutationConfirmation,
      showPluginActionPopover,
      targetParams,
      waitForComposerTextInsertApplied,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );

  return (
    <div data-v4-draft-suggested-prompts-slot="true" className={cn(!proactive && "h-8", className)}>
      <ConversationDraftSuggestedPrompts
        // Absolute positioning pulls the recommendation strip out of the Composer flow - opaque
        // to debug and wrong spacing semantics. Legacy-scenario recommendations keep the fixed
        // slot; proactive lists must size by content or multiline entries overflow over what is
        // beneath.
        items={items}
        layout={proactive ? "list" : "chips"}
        onSelect={handleSelect}
        onRefresh={proactive ? () => advanceRecommendedPromptPane(recommendationPaneId) : undefined}
        onClose={proactive ? closeRecommendations : undefined}
        disabled={cancelling || closing}
        refreshDisabled={Boolean(pluginActionPopover)}
        pluginActionPopover={pluginActionPopover}
      />
    </div>
  );
}
