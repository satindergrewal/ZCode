import { beginLocalTurnPreparation, type LocalTtftDetail } from "@zcode/contracts";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import { ensureGroupTaskPermissionScope } from "./input-intent-persistence.js";
import {
  CoreErrorType,
  HookEventName,
  SessionEventType,
  createChildTraceContext,
  createQueryId,
  createModelUsageSummaryFromEvents,
  createMessageId,
  createTurnId,
  runWithContextAsync,
  traceContextToLogContext,
  TurnMachineImpl,
  formatLocalIsoDate,
} from "../deps.js";
import type {
  HookRunResult,
  MessageId,
  MessagePart,
  QueryId,
  SessionEvent,
  SessionGoal,
  TurnState,
} from "../deps.js";
import {
  parseCompactCommand,
  parseRewindCommand,
  createTurnAbortScope,
  throwIfTurnAborted,
  createTurnFailureError,
  isTurnCancellationError,
  appendTurnOutcomeEvent,
  buildDateChangeReminderBody,
  buildRuntimeUserEntriesFromTurn,
  buildUserContentFromTurn,
  logResolvedTurnAttachments,
  resolveTurnAttachments,
  summarizeTurnAttachmentsForEvent,
  runtimeMetadataForSyntheticUserMessageSource,
} from "../helpers/index.js";
import type { ActiveTurnSteeringState, ExecuteTurnOptions, TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { buildReferencedSessionContextReminderBody } from "../../session-context/read-session-context.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import {
  maybeStartDeferredSessionTitleGeneration,
  maybeStartSessionTitleGeneration,
} from "./session-title.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { finishOutputTokenRecovery } from "./turn-output-token-continuation.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { persistStableForkCompletionBoundary } from "./stable-fork-boundary.js";
import {
  closeGoalStateChangeReminderDeferral,
  openGoalStateChangeReminderDeferral,
} from "./goal-state-reminder.js";
import {
  disposeProjectMemoryRecallPrefetch,
  startProjectMemoryRecallPrefetch,
} from "../helpers/project-memory-recall.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import { scheduleProjectMemoryExtraction } from "../helpers/project-memory-extraction.js";
import { appendBrowserTurnScreenshot } from "./browser-turn-screenshot.js";
import { clearBrowserTurnState } from "../../repl/browser-turn-state.js";
import {
  applySubmissionExecutionState,
  createTurnModel,
  resolveExecutionModelRetryBudget,
} from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";

const TARGET_RUN_HEARTBEAT_MS = 15_000;

export async function executeTurn(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
): Promise<TurnResult> {
  return await enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options,
      priority: "next",
      reject,
      resolve,
      traceContext: options?.traceContext ?? this.rootTraceContext,
    }),
  });
}

export async function executeTurnCommand(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  // Plain Turns read Session Selection/output style after async init;
  // mid-init switches crossed admission and hit a started Turn.
  // Freeze this turn facts pre-await; later config changes apply next turn.
  const admittedModelSelection = options?.intent?.modelSelection ?? this.getSessionModelSelection();
  const admittedOutputStyle = this.config.outputStyle;
  const compactInstructions = parseCompactCommand(input);
  const rewindCommand = parseRewindCommand(input);
  const turnId = startReservation?.turnId ?? createTurnId();
  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const displayInput = options?.displayInput ?? input;
  const turnTraceContext =
    startReservation?.traceContext ??
    createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
      queryId,
      sessionId: this.sessionId,
      turnId,
      attributes: {
        turnNumber: this.turnNumber,
      },
    });
  const traceId = turnTraceContext.traceId;
  const turnStartedAtMs = Date.now();
  const targetRunInputID = options?.inputId ?? String(turnId);
  const events: SessionEvent[] = [];
  let turnMachine = TurnMachineImpl.create(this.sessionId, this.turnNumber, input, traceId, turnId);
  this.currentTurnFileChanges = new Map();
  if (!startReservation) this.reserveTurnStart(turnId, turnTraceContext, "regular");

  const turnAbortScope = createTurnAbortScope(options?.abortSignal);
  const turnAbortSignal = turnAbortScope.signal;
  let activeTurn: ActiveTurnSteeringState | undefined;
  let startedTarget: SessionGoal | null = null;
  let targetRunHeartbeat: ReturnType<typeof setInterval> | undefined;
  let userMessageId: MessageId | undefined;
  let loopState: RegularTurnLoopState | undefined;
  let shouldRetryTitleGenerationAfterTurn = false;
  // A live worked-N-seconds-no-terminal suspect: an await before the inner Turn try/catch
  // rejecting straight through. Log the phase and handled-ness to reconstruct the stall.
  let turnPhase = "queued";
  let turnFailureHandled = false;
  let finishPreparation: () => void = () => {};
  const preparationStages: Record<string, LocalTtftDetail["stage"]> = {
    context_initialization: "context",
    session_start_hooks: "hooks",
    user_prompt_hooks: "hooks",
    session_persistence: "persistence",
    turn_started_event: "persistence",
    target_accounting: "persistence",
  };
  const startTurnPhase = (phase: string): number => {
    const stage = preparationStages[phase];
    finishPreparation =
      stage && stage !== "attempt" && stage !== "retry_wait" && stage !== "user_confirmation"
        ? beginLocalTurnPreparation(turnTraceContext, stage)
        : () => {};
    turnPhase = phase;
    const startedAt = Date.now();
    this.logger?.info("Turn phase started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "turn.phase.started",
      module: "core.runtime",
      phase,
      status: "started",
    });
    return startedAt;
  };
  const completeTurnPhase = (phase: string, startedAt: number): void => {
    finishPreparation();
    this.logger?.info("Turn phase completed", {
      ...traceContextToLogContext(turnTraceContext),
      durationMs: Date.now() - startedAt,
      event: "turn.phase.completed",
      module: "core.runtime",
      phase,
      status: "completed",
    });
  };
  const turnTelemetry = this.agentTelemetry.turn({
    inputSource: options?.inputSource,
    traceContext: turnTraceContext,
    turnNumber: this.turnNumber,
  });

  const execute = () =>
    runWithContextAsync(turnTraceContext, async () => {
      const executionStartedAt = performance.timeOrigin + performance.now();
      beginLocalTurnPreparation(turnTraceContext, "execution")();
      throwIfTurnAborted(turnAbortSignal);
      let admittedModel;
      try {
        admittedModel =
          rewindCommand === null
            ? createTurnModel(this, {
                requestDependencies: options?.modelExecution?.requestDependencies,
                selection: admittedModelSelection,
                // Execution handles with a fallback declaration retry 0 times: on failure, hand straight to the turn step's session-model fallback.
                retryBudget: resolveExecutionModelRetryBudget({
                  selection: admittedModelSelection,
                  selectionFallback: options?.modelExecution?.selectionFallback,
                }),
              })
            : undefined;
      } catch (error) {
        // Sync lag / dead model can fail pre-inner-try; logging alone leaves admitted input
        // terminal-less and invisible on desktop/phone; reuse the outcome, no sync wait, no re-choice.
        turnFailureHandled = true;
        const coreError = createTurnFailureError(error, turnAbortSignal, "Model creation failed");
        await appendTurnOutcomeEvent(this, {
          coreError,
          events,
          durationMs: Date.now() - turnStartedAtMs,
          turnPhase: "model_creation",
          inputId: options?.inputId,
          traceContext: turnTraceContext,
          fallbackMessage: "Model creation failed",
          logEvent: "turn.failed",
          logLabel: "Turn",
        });
        throw coreError;
      }
      let phaseStartedAt = startTurnPhase("context_initialization");
      if (this.contextInitialized) {
        // Each later model step re-projects Context on the Model it actually holds;
        // Session Selection only picks future Models, never execution fact.
        rebuildContextPrefix(this, { model: admittedModel });
      } else {
        // First-round init built the full Context on the admitted Model; another rebuild
        // would construct the same Prefix twice. The branches are exclusive; one build per model step.
        await this.ensureContextInitialized(turnTraceContext, admittedModel);
      }
      completeTurnPhase("context_initialization", phaseStartedAt);
      throwIfTurnAborted(turnAbortSignal);
      phaseStartedAt = startTurnPhase("session_start_hooks");
      const sessionStartHookResult = await this.runSessionStartHooks(
        "startup",
        turnTraceContext,
        turnAbortSignal,
        admittedModel,
      );
      completeTurnPhase("session_start_hooks", phaseStartedAt);
      this.injectHookAdditionalContextIntoMessageHistory(
        HookEventName.SessionStart,
        sessionStartHookResult.additionalContexts,
      );

      if (compactInstructions !== null) {
        const compactModel = await applySubmissionExecutionState(
          this,
          options?.intent,
          turnTraceContext,
          options?.modelExecution,
          admittedModel,
        );
        return this.executeManualCompact(
          input,
          compactInstructions,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
          compactModel,
        );
      }
      if (rewindCommand !== null) {
        return this.executeRewindCommand(
          input,
          rewindCommand,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
        );
      }
      activeTurn = this.beginActiveTurn(turnId, turnTraceContext, "regular", true, {
        ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
      });
      this.logger?.info("Turn started", {
        ...traceContextToLogContext(turnTraceContext),
        event: "turn.started",
        inputLength: input.length,
        module: "core.runtime",
        status: "started",
      });

      turnMachine = new TurnMachineImpl(turnMachine.start());
      phaseStartedAt = startTurnPhase("session_persistence");
      await this.ensureSessionPersisted(displayInput, turnTraceContext);
      await ensureGroupTaskPermissionScope(this.sessionStore, this.sessionId, options?.intent);
      // An execution-scoped temp Provider (off-peak jobs) owns this turn model, no
      // Session Selection write; plain Submissions apply their atomic choice at start.
      const submissionModel = await applySubmissionExecutionState(
        this,
        options?.intent,
        turnTraceContext,
        options?.modelExecution,
        admittedModel,
      );
      startedTarget = await this.readSessionTargetForContext(turnTraceContext);
      completeTurnPhase("target_read", phaseStartedAt);
      if (startedTarget?.status !== "active") {
        startedTarget = null;
      }
      userMessageId =
        options?.skipInputRecord === true
          ? (options.recordedInputMessageId ?? createMessageId())
          : createMessageId();
      // Attachment display metadata rides TurnStarted (v4 projection, userInput row.attachments).
      // Workspace checkpoints hang off the user messageId; mint the id before TurnStarted
      // so the projection finds the checkpoint by turn rowId — no counted-but-empty expansion.
      const attachmentMetas = summarizeTurnAttachmentsForEvent(attachments);
      const turnStartedEvent = this.createEvent(
        SessionEventType.TurnStarted,
        {
          executionStartedAt,
          turnNumber: this.turnNumber,
          input: displayInput,
          messageId: userMessageId,
          inputId: options?.inputId,
          ...(options?.automationId
            ? { automationId: options.automationId }
            : options?.offPeakTaskId
              ? {
                  offPeakTaskId: options.offPeakTaskId,
                  ...(options.offPeakRunType ? { offPeakRunType: options.offPeakRunType } : {}),
                }
              : {}),
          foregroundExecutionId: this.activeForegroundExecution?.foregroundExecutionId,
          queryId,
          inputSource: options?.inputSource,
          inputVisibility: options?.inputVisibility,
          originMeta: options?.originMeta,
          ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
          ...(options?.backgroundSource ? { backgroundSource: options.backgroundSource } : {}),
          targetId: options?.targetId,
          ...(options?.intent ? { intent: options.intent } : {}),
          ...(attachmentMetas ? { attachments: attachmentMetas } : {}),
        },
        turnTraceContext,
      );
      phaseStartedAt = startTurnPhase("turn_started_event");
      await this.appendEvent(turnStartedEvent, turnTraceContext);
      completeTurnPhase("turn_started_event", phaseStartedAt);
      events.push(turnStartedEvent);
      phaseStartedAt = startTurnPhase("target_accounting");
      startedTarget = await this.startTargetTurnAccounting({
        inputID: targetRunInputID,
        startedAtMs: turnStartedAtMs,
        startedTarget,
        traceContext: turnTraceContext,
      });
      completeTurnPhase("target_accounting", phaseStartedAt);
      if (startedTarget && this.sessionStore?.heartbeatTargetRun) {
        targetRunHeartbeat = setInterval(() => {
          void this.trackResidencyBlockingWork(
            this.heartbeatTargetTurnAccounting({
              inputID: targetRunInputID,
              seenAtMs: Date.now(),
              startedTarget,
              traceContext: turnTraceContext,
            }),
          );
        }, TARGET_RUN_HEARTBEAT_MS);
        if (typeof targetRunHeartbeat === "object" && "unref" in targetRunHeartbeat) {
          targetRunHeartbeat.unref();
        }
      }

      try {
        phaseStartedAt = startTurnPhase("user_prompt_hooks");
        const userPromptHookResult: HookRunResult = options?.skipUserPromptSubmitHooks
          ? { additionalContexts: [] }
          : await this.runUserPromptSubmitHooks(
              input,
              attachments,
              turnTraceContext,
              turnAbortSignal,
            );
        completeTurnPhase("user_prompt_hooks", phaseStartedAt);
        if (userPromptHookResult.preventContinuation) {
          const response =
            userPromptHookResult.stopReason ?? "Prompt blocked by UserPromptSubmit hook.";
          if (activeTurn) activeTurn.steerable = false;
          turnMachine = new TurnMachineImpl(turnMachine.complete(response, "success"));
          const turnUsage = createModelUsageSummaryFromEvents(events);
          const completeEvent = this.createEvent(
            SessionEventType.TurnComplete,
            {
              response,
              tokenCount: 0,
              usage: turnUsage,
              toolCallCount: 0,
              duration: Date.now() - turnMachine.state.startedAt.getTime(),
              resultType: "success",
              cacheStats: this.messageHistory.getCacheStats(),
              inputId: options?.inputId,
            },
            turnTraceContext,
          );
          await this.appendEvent(completeEvent, turnTraceContext);
          events.push(completeEvent);
          await recordTurnUsageFact(this, {
            completedAt: Date.now(),
            events,
            startedAt: turnStartedAtMs,
            status: "completed",
            traceContext: turnTraceContext,
            turnId,
          });
          this.turnNumber++;
          const projection = await this.rebuildProjection();
          await this.accountTargetTurnCompletion({
            inputID: targetRunInputID,
            startedAtMs: turnStartedAtMs,
            startedTarget,
            traceContext: turnTraceContext,
            usage: turnUsage,
          });
          return {
            response,
            turnId,
            traceId,
            usage: turnUsage,
            events,
            projection,
          };
        }
        this.injectHookAdditionalContextIntoMessageHistory(
          HookEventName.UserPromptSubmit,
          userPromptHookResult.additionalContexts,
        );
        injectReferencedSessionContextReminderIntoMessageHistory.call(this, input, options);
        // Topic originals are read on demand as standard text attachments; trusted-source archives must not regenerate hidden context.
        injectDateChangeReminderIntoMessageHistory.call(this);
        const resolvedAttachments = await resolveTurnAttachments(attachments, {
          abortSignal: turnAbortSignal,
          artifactStore: this.artifactStore,
          fileSystemPort: this.fileSystemPort,
          imageProcessorPort: this.imageProcessorPort,
          sessionId: this.sessionId,
          traceContext: turnTraceContext,
          turnId,
          workingDirectory: this.workingDirectory,
        });
        logResolvedTurnAttachments(this.logger, turnTraceContext, resolvedAttachments);
        const sharedContextRefs = options?.sharedContextRefs ?? options?.intent?.sharedContextRefs;
        if (sharedContextRefs && sharedContextRefs.length > 0) {
          const [reference] = sharedContextRefs;
          if (!reference || reference.kind !== "shared_context_import") {
            throw new Error("invalid shared context reference");
          }
          if (!this.sessionStore) throw new Error("shared context import storage is unavailable");
          const alreadyHydrated = this.messageHistory
            .borrowReadOnlyRuntimeEntries()
            .some(
              (entry) => entry.kind !== "attachment" && entry.metadata?.source === "shared_context",
            );
          if (!alreadyHydrated) {
            const importedMessages = await this.sessionStore.messages({
              sessionID: this.sessionId,
            });
            const contextMessage = importedMessages.find(
              (message) =>
                message.info.role === "user" &&
                message.info.source === "shared_context" &&
                message.info.metadata &&
                typeof message.info.metadata === "object" &&
                (message.info.metadata as Record<string, unknown>).contextId ===
                  reference.context_id,
            );
            const contextText = contextMessage?.parts
              .filter(
                (part): part is Extract<MessagePart, { type: "text" }> => part.type === "text",
              )
              .map((part) => part.text)
              .join("\n")
              .trim();
            if (!contextText) throw new Error("shared context content is unavailable");
            this.messageHistory.addUser(
              contextText,
              runtimeMetadataForSyntheticUserMessageSource("shared_context"),
            );
          }
        }
        await this.persistPendingModelChangeTimeline(turnTraceContext);
        if (options?.skipInputRecord !== true && options?.inputVisibility === "model-only") {
          const inputSource = options.inputSource ?? "goal-continuation";
          const userContent = buildUserContentFromTurn(input, resolvedAttachments);
          this.messageHistory.addUser(
            userContent,
            runtimeInputMetadata(options.inputPresentation) ??
              runtimeMetadataForSyntheticUserMessageSource(inputSource),
          );
          // A /goal auto-continuation is a runtime-injected internal user-role input,
          // not a new chat message. Persist raw input for recovery/debug
          // but model-only semantics keep it out of user bubbles.
          await this.persistSyntheticUserNoticeForSession({
            messageID: userMessageId,
            metadata: {
              ...(options.targetId ? { targetId: options.targetId } : {}),
              ...(options.inputPresentation
                ? { inputPresentation: options.inputPresentation }
                : {}),
              visibility: "model-only",
            },
            sessionId: this.sessionId,
            source: inputSource,
            text: input,
            traceContext: turnTraceContext,
            visibility: "model-only",
          });
        } else if (options?.skipInputRecord !== true) {
          this.messageHistory.addEntries(
            buildRuntimeUserEntriesFromTurn(
              withConversationQuotes(
                input,
                options?.intent?.conversationQuotes,
                options?.intent?.botGroupSource,
              ),
              resolvedAttachments,
              {
                browserAmbientContext: options?.browserAmbientContext,
              },
            ).map((entry) => {
              const metadata = runtimeInputMetadata(options?.inputPresentation);
              return entry.kind !== "attachment" && metadata ? { ...entry, metadata } : entry;
            }),
          );
          // /init and custom slash commands expand the input into a longer internal
          // prompt; model-visible history takes the expansion, while UI, session title and
          // resume snapshots show the raw query the user typed.
          await this.persistUserPrompt(
            userMessageId,
            displayInput,
            resolvedAttachments,
            turnTraceContext,
            {
              intent: options?.intent,
              inputPresentation: options?.inputPresentation,
              sessionInputId: options?.intent?.queueItemId,
              sourceCommandId: options?.inputId,
              ...(options?.epilogueStart === undefined
                ? {}
                : { epilogueStart: options.epilogueStart }),
            },
          );
        }
        // Config reads used to preceder input display/persistence; a failure made sent messages vanish from the UI.
        // Pin this turn's definition after the original input record; errors/cancel reuse this layer's finalization, and no title or model request starts.
        await this.prepareAgentDefinitions({
          signal: turnAbortSignal,
          traceContext: turnTraceContext,
        });
        throwIfTurnAborted(turnAbortSignal);
        if (options?.skipInputRecord !== true && options?.inputVisibility !== "model-only") {
          // Why: title generation used to wait for the main turn to succeed; on user stop/cancel of the first request
          // never let it start. Generate async post first-persist, safe from main-link cancels.
          const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
            this,
            displayInput,
            userMessageId,
            turnTraceContext,
            {
              deferIfProviderRuntimeHeadersRefresh: true,
            },
          );
          shouldRetryTitleGenerationAfterTurn = !titleGenerationStarted;
        }
        // Append plugin reminders only after the user message hits history and session store:
        // provider shape stays user then system, and cold hydration replays that order.
        // Why: input may be command-expanded; parsing that grants plugin:// inside templates
        // user-reference semantics; parse only the persisted canonical displayInput.
        // Internal model-only continuations are not new intent; no reparse.
        if (options?.inputVisibility !== "model-only") {
          await this.injectPluginReferenceReminderFromTurn(
            displayInput,
            turnTraceContext,
            options?.toolDisallowlist,
          );
        }

        this.messageHistory.setCacheMiss();
        const loopModel = submissionModel ?? admittedModel;
        if (!loopModel) {
          throw new Error("Turn model was not created before execution");
        }
        startProjectMemoryRecallPrefetch(
          this,
          {
            model: loopModel,
            traceContext: turnTraceContext,
            turnAbortSignal,
          },
          ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
        );
        loopState = {
          activeTurn,
          ...(options?.automationId ? { automationId: options.automationId } : {}),
          // The off-peak identity enters loop state; the execution boundary denies OffPeakCreate.
          ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
          anomalyWarningsInjected: 0,
          backgroundSubagentResultConsumed: options?.backgroundSubagentResultConsumed === true,
          workflowResultConsumed: options?.workflowResultConsumed === true,
          completedRealToolResultBatch: false,
          currentUserMessageId: userMessageId,
          events,
          input,
          ...(options?.inputId ? { inputId: options.inputId } : {}),
          modelResponse: "",
          model: loopModel,
          ...(options?.modelExecution?.selectionScope === "execution"
            ? { modelSelectionScope: "execution" as const }
            : {}),
          // When the speed-up card expires mid-tool-execution, the turn does not fail wholesale; it falls back to the Session Selection to finish.
          ...(options?.modelExecution?.selectionFallback
            ? { selectionFallback: options.modelExecution.selectionFallback }
            : {}),
          ...(options?.modelExecution?.subagents && options.intent?.modelSelection
            ? {
                subagentModelOverride: {
                  selection: options.intent.modelSelection,
                  requestDependencies: options.modelExecution.requestDependencies,
                  background: options.modelExecution.subagents.background,
                },
              }
            : {}),
          modelStepCount: 0,
          historyRoundCount: 0,
          reactiveCompactAttemptedInCurrentModelStep: false,
          repeatedToolCallSignature: undefined,
          repeatedToolCallStreakCount: 0,
          stopHookContinuationCount: 0,
          streamRecoveryRetryCount: 0,
          tokenCount: 0,
          toolCallCount: 0,
          turnRequestState: {
            // The Turn borrows the canonical members once; explicit commits advance; the entry
            // follows MessageHistory immutability.
            entries: [...this.messageHistory.borrowReadOnlyRuntimeEntries()],
            outputTokenContinuationCount: 0,
          },
          toolDisallowlist: options?.toolDisallowlist,
          traceId,
          turnAbortSignal,
          turnId,
          turnMachine,
          turnOutputStyle: admittedOutputStyle,
          turnTraceContext,
          userMessageId,
        };

        openGoalStateChangeReminderDeferral(activeTurn);
        phaseStartedAt = startTurnPhase("regular_turn_loop");
        try {
          await runRegularTurnLoop.call(this, loopState);
          completeTurnPhase("regular_turn_loop", phaseStartedAt);
        } finally {
          finishOutputTokenRecovery(loopState.turnRequestState);
          await closeGoalStateChangeReminderDeferral.call(this, activeTurn, turnTraceContext);
        }
        turnMachine = loopState.turnMachine;

        const turnUsage = createModelUsageSummaryFromEvents(events);
        // Settle goal usage/active-run, then pin the exact goal/verifier boundary; only when both
        // persist may TurnComplete open the final assistant fork to projection/UI.
        await this.accountTargetTurnCompletion({
          inputID: targetRunInputID,
          startedAtMs: turnStartedAtMs,
          startedTarget,
          traceContext: turnTraceContext,
          usage: turnUsage,
        });
        if (loopState.stableProductStartMessageId && loopState.stableBoundaryAssistantMessageId) {
          await persistStableForkCompletionBoundary(this, {
            boundaryMessageId: loopState.stableBoundaryAssistantMessageId,
            startMessageId: loopState.stableProductStartMessageId,
            historyRoundCount: loopState.historyRoundCount,
            traceContext: turnTraceContext,
          });
        }
        if (loopState.stableBoundaryAssistantMessageId) {
          await appendBrowserTurnScreenshot(
            this,
            loopState,
            loopState.stableBoundaryAssistantMessageId,
          );
        }
        const completeEvent = this.createEvent(
          SessionEventType.TurnComplete,
          {
            response: loopState.modelResponse,
            tokenCount: loopState.tokenCount,
            usage: turnUsage,
            toolCallCount: loopState.toolCallCount,
            historyRoundCount: loopState.historyRoundCount,
            duration: Date.now() - turnMachine.state.startedAt.getTime(),
            resultType: "success",
            ...(loopState.backgroundSubagentResultConsumed
              ? { backgroundSubagentResultConsumed: true }
              : {}),
            ...(loopState.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
            cacheStats: this.messageHistory.getCacheStats(),
            inputId: options?.inputId,
          },
          turnTraceContext,
        );
        await this.appendEvent(completeEvent, turnTraceContext);
        events.push(completeEvent);
        await recordTurnUsageFact(this, {
          completedAt: Date.now(),
          events,
          startedAt: turnStartedAtMs,
          status: "completed",
          traceContext: turnTraceContext,
          turnId,
          userMessageId,
        });
        if (shouldRetryTitleGenerationAfterTurn && userMessageId) {
          // Models needing pre-request header refresh
          // would burn the auth refresh window on a pre-turn title, failing the real user message.
          maybeStartDeferredSessionTitleGeneration.call(
            this,
            displayInput,
            userMessageId,
            turnTraceContext,
          );
        }
        this.turnNumber++;

        const projection = await this.rebuildProjection();
        this.logger?.info("Turn completed", {
          ...traceContextToLogContext(turnTraceContext),
          durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
          event: "turn.completed",
          module: "core.runtime",
          status: "completed",
          toolCallCount: loopState.toolCallCount,
        });
        // Single-shot policy suppresses this successful Turn extraction only; Session Memory config untouched.
        if (options?.modelExecution?.memoryExtraction !== "skip") {
          scheduleProjectMemoryExtraction(this, {
            model: loopState.model,
            traceContext: turnTraceContext,
          });
        }

        const result: TurnResult = {
          response: loopState.modelResponse,
          turnId,
          traceId,
          usage: turnUsage,
          events,
          projection,
        };
        return result;
      } catch (error) {
        turnFailureHandled = true;
        const coreError = createTurnFailureError(error, turnAbortSignal, "Turn execution failed");
        const preserveQueueAutoDrainOnCancel =
          coreError.type === CoreErrorType.TurnCancelled &&
          this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
        const finishedTarget = await this.finishTargetTurnAccounting({
          endedAtMs: Date.now(),
          inputID: targetRunInputID,
          startedTarget,
          status: coreError.type === CoreErrorType.TurnCancelled ? "paused" : undefined,
          traceContext: turnTraceContext,
        });
        if (finishedTarget?.targetID === startedTarget?.targetID) {
          startedTarget = finishedTarget;
        }
        if (coreError.type === CoreErrorType.TurnCancelled) {
          // Queue promotion (send now / send queued now) preempts the turn on purpose:
          // the goal stays active and the promoted prompt's own post-turn goal loop
          // continues the mission with the new input included. Only other cancellations
          // pause the goal.
          const suppressGoalPause =
            this.activeForegroundExecution?.suppressGoalPauseOnCancel === true;
          if (suppressGoalPause) {
            this.logger?.info("Goal pause suppressed: turn preempted by queue promotion", {
              ...traceContextToLogContext(turnTraceContext),
              event: "target.pause_skipped_queue_promotion",
              module: "core.runtime",
            });
          } else {
            await this.pauseActiveTargetForCancellation({
              traceContext: turnTraceContext,
              reason:
                coreError.cause instanceof Error
                  ? coreError.cause.message
                  : String(coreError.cause ?? "turn cancelled"),
            });
          }
          if (activeTurn) {
            await this.fallbackPendingGuidesToQueue({
              activeTurn,
              events,
              reasonCode: "guide.turnInterrupted",
              traceContext: turnTraceContext,
            });
          }
        }
        // A plain TurnError ends this turn; accepted future inputs stay.
        // The v4 TurnError projection error-pauses the queue; the runtime closes inline drain
        // and holds queued input for explicit resume.
        if (activeTurn && coreError.type !== CoreErrorType.TurnCancelled) {
          const pendingInputs = (await this.rebuildProjection()).pendingSteerInputs;
          if (pendingInputs.length > 0) {
            this.queueAutoDrain = false;
            this.queueExternalDrainActive = false;
          }
        } else if (
          activeTurn &&
          coreError.type === CoreErrorType.TurnCancelled &&
          !preserveQueueAutoDrainOnCancel &&
          activeTurn.pendingInputs.length > 0
        ) {
          // Keep the runtime grant in lockstep with the projection: on TurnComplete(cancelled)+queue>0 it
          // sets queue.autoDrain false (held); the runtime drain gate must flip too,
          // or a turn started during held drains new items and forks from the projection.
          this.queueAutoDrain = false;
          this.queueExternalDrainActive = false;
        }

        // A background wake can cancel pre-loopState; keep the dequeued-result facts anyway.
        const backgroundSubagentResultConsumed =
          options?.backgroundSubagentResultConsumed === true ||
          loopState?.backgroundSubagentResultConsumed === true;
        const workflowResultConsumed =
          options?.workflowResultConsumed === true || loopState?.workflowResultConsumed === true;
        await appendTurnOutcomeEvent(this, {
          coreError,
          events,
          durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
          turnPhase: turnMachine.state.phase,
          inputId: options?.inputId,
          traceContext: turnTraceContext,
          fallbackMessage: "Turn execution failed",
          logEvent: "turn.failed",
          logLabel: "Turn",
          preserveQueueAutoDrainOnCancel,
          backgroundSubagentResultConsumed,
          workflowResultConsumed,
          historyRoundCount: loopState?.historyRoundCount,
        });
        await recordTurnUsageFact(this, {
          completedAt: Date.now(),
          error: coreError,
          events,
          startedAt: turnStartedAtMs,
          status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
          traceContext: turnTraceContext,
          turnId,
          userMessageId,
        });
        throw coreError;
      }
    }).then(
      (result) => {
        turnTelemetry.finishCompleted("assistant_message");
        return result;
      },
      (error: unknown) => {
        if (!turnFailureHandled) {
          this.logger?.warn("Turn execution escaped lifecycle handler", {
            ...traceContextToLogContext(turnTraceContext),
            durationMs: Date.now() - turnStartedAtMs,
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.lifecycle.unhandled_rejection",
            module: "core.runtime",
            phase: turnPhase,
            status: "failed",
          });
        }
        if (isTurnCancellationError(error, turnAbortSignal)) {
          turnTelemetry.finishCancelled("abort_signal");
        } else {
          turnTelemetry.finishFailed("unhandled", "unknown", error);
        }
        throw error;
      },
    );

  return turnTelemetry.run(execute).finally(async () => {
    disposeProjectMemoryRecallPrefetch(this);
    if (targetRunHeartbeat) {
      clearInterval(targetRunHeartbeat);
    }
    this.releaseTurnStart(turnId);
    clearBrowserTurnState(this.sessionId, turnId);
    this.finishActiveTurn(activeTurn);
    turnAbortScope.dispose();
    try {
      await this.browserControlPort?.turnEnded?.({
        sessionId: this.sessionId,
        turnId: String(turnId),
        traceContext: turnTraceContext,
      });
    } catch (error) {
      // Cleanup failures never override a finished/failed turn; the backend sweeps at session close.
      this.logger?.warn("Browser turn cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.turn_cleanup.failed",
        turnId: String(turnId),
      });
    }
  });
}

function injectDateChangeReminderIntoMessageHistory(this: AgentRuntimeInternal): void {
  const currentDate = formatLocalIsoDate(this.now());
  const previousDate = this.lastEmittedLocalDate;
  this.lastEmittedLocalDate = currentDate;

  if (!previousDate || previousDate === currentDate) {
    return;
  }

  this.messageHistory.addAttachment(
    "date_change",
    buildDateChangeReminderBody(previousDate, currentDate),
  );
}

function injectReferencedSessionContextReminderIntoMessageHistory(
  this: AgentRuntimeInternal,
  input: string,
  options?: ExecuteTurnOptions,
): void {
  if (options?.inputVisibility === "model-only") return;
  const reminderBody = buildReferencedSessionContextReminderBody(input);
  if (!reminderBody) return;
  this.messageHistory.addAttachment("referenced_session_context", reminderBody);
}
