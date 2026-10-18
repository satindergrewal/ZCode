import {
  SessionEventType,
  createChildTraceContext,
  createMessageId,
  createPartId,
  createTurnId,
} from "../deps.js";
import type {
  MessageId,
  SyntheticUserMessageSource,
  TraceContext,
  TurnInputIntentMetadata,
  WorkflowLaunchMeta,
} from "../deps.js";
import { buildUserContentFromTurn } from "../helpers/index.js";
import { realUserRuntimeMetadata } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ControlOnlyTurnRuntimeCommand } from "../command-queue.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import { maybeStartGoalSummaryTitleGeneration } from "./goal-summary-title.js";
import { maybeStartSessionTitleGeneration } from "./session-title.js";

/**
 * The controlOnly user-turn boundary, shared by `/goal` external queries and hub-launched workflows.
 *
 * Neither entry runs plain `executeTurn`, yet both persist a user-visible role=user message, feed it into
 * runtime history (model-visible next round) and add a full no-model-output turn boundary
 * (`TurnStarted{executionKind:"controlOnly"}` + `TurnComplete{response:""}`) — else live
 * ProductProjection misses TurnStarted, the query waits for cold restore, and a 0ms control turn reads as
 * worked-1-second at the marker. The only real difference is how the message lands (real user prompt vs
 * a synthetic user message with `workflowLaunch` metadata) plus title/side effects, via the `persistMessage`
 * and `afterTurnBoundary` callbacks.
 */
export async function emitControlOnlyUserTurn(
  this: AgentRuntimeInternal,
  options: {
    messageId: MessageId;
    /** The `ensureSessionPersisted` first-input title seed (normalized objective / workflow name). */
    titleInput: string;
    /** Visible text entering runtime history (model-readable next round). */
    historyText: string;
    /** `TurnStarted.input` (degraded view for old clients / TUI). */
    turnInput: string;
    traceContext: TraceContext;
    inputId?: string;
    inputSource?: SyntheticUserMessageSource;
    workflowLaunch?: WorkflowLaunchMeta;
    intent?: TurnInputIntentMetadata;
    /** Persist this user message (real or synthetic) — the paths only real difference. */
    persistMessage: () => Promise<void>;
    /** Optional post-first-persist, pre-turnNumber side effects (title sidecar etc). */
    afterTurnBoundary?: () => void;
  },
): Promise<void> {
  const { messageId, traceContext } = options;
  // A /goal entry can precede the first history write; addUser-first would
  // let lazy context init rebuild history and wash out the real user query.
  await this.ensureContextInitialized(traceContext);
  await this.ensureSessionPersisted(options.titleInput, traceContext);
  // Such entries skip plain submitPrompt yet carry real user intent; write both
  // runtime history and session store, so model context, desktop continuous and phone replay
  // share one visible user intent.
  this.messageHistory.addUser(
    buildUserContentFromTurn(options.historyText, []),
    realUserRuntimeMetadata(),
  );
  await options.persistMessage();
  // Non-executeTurn entries only persisted the transcript; live ProductProjection missed
  // TurnStarted and queries waited for cold restore. This adds the full no-model-output
  // turn boundary; later goal/notice rounds open own turns, no second bubble.
  const turnId = createTurnId();
  const turnTraceContext = createChildTraceContext(traceContext, {
    turnId,
    attributes: { turnNumber: this.turnNumber },
  });
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: this.turnNumber,
        input: options.turnInput,
        messageId,
        ...(options.inputId ? { inputId: options.inputId } : {}),
        // A visible query needs its own turn to show live, without running the Agent; missing it,
        // the modelChange marker shows 0ms control turns as worked-1-second, briefly covering
        // session running/activeWorks。
        executionKind: "controlOnly",
        ...(options.inputSource ? { inputSource: options.inputSource } : {}),
        ...(options.workflowLaunch ? { workflowLaunch: options.workflowLaunch } : {}),
        ...(options.intent ? { intent: options.intent } : {}),
      },
      turnTraceContext,
    ),
    turnTraceContext,
  );
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 0,
        resultType: "success",
        ...(options.inputId ? { inputId: options.inputId } : {}),
      },
      turnTraceContext,
    ),
    turnTraceContext,
  );
  options.afterTurnBoundary?.();
  this.turnNumber += 1;
  this.messageHistory.setCacheMiss();
}

/**
 * Persist the hub-launch turn user message.
 *
 * It is **synthetic yet a real user action**: `synthetic: true` + the new
 * `source: "workflow_launch"`, with `origin: "real_user"` / `kind: "user_prompt"` and
 * ui/provider/transcript all visible — the user clicked Run in the hub; the GUI just
 * draws the end-of-turn run card from `metadata.workflowLaunch`. The metadata enters message metadata (cold-restore
 * source) and the TurnStarted payload (live, caller-written), the same copy both places.
 */
export async function persistWorkflowLaunchUserMessage(
  this: AgentRuntimeInternal,
  options: {
    messageID: MessageId;
    text: string;
    meta: WorkflowLaunchMeta;
    traceContext: TraceContext;
  },
): Promise<void> {
  this.latestConversationMessageId = options.messageID;
  if (!this.sessionStore) return;

  const created = Date.now();
  await this.persistMessage(
    {
      id: options.messageID,
      sessionID: this.sessionId,
      role: "user",
      time: { created },
      agent: this.config.agentName ?? "zcode-agent",
      // Cold restore: transcript-hydration reads source === "workflow_launch" + metadata.workflowLaunch
      // to rebuild the launch-card row.
      metadata: { workflowLaunch: options.meta },
      modelSelection: this.getSessionModelSelection(),
      semantics: {
        // A real user action, not an agent_runtime notice; the model reads it as a plain user prompt.
        origin: "real_user",
        kind: "user_prompt",
        source: "workflow_launch",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: buildProjectionAnchor(options.traceContext, "realUser"),
      source: "workflow_launch",
      system: this.config.systemPrompt,
      synthetic: true,
      tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
      visibility: "user-visible",
    },
    options.traceContext,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: options.messageID,
      type: "text",
      text: options.text,
      synthetic: true,
      time: { start: created, end: created },
      metadata: { source: "workflow_launch", visibility: "user-visible" },
    },
    options.traceContext,
  );
}

/**
 * Run a queued controlOnly turn ({@link ControlOnlyTurnRuntimeCommand}): same shape as the hub launch —
 * synthetic `workflow_launch` user message + metadata + full turn boundary, timed by the queue.
 */
export async function runControlOnlyTurnCommand(
  this: AgentRuntimeInternal,
  command: ControlOnlyTurnRuntimeCommand,
): Promise<void> {
  const messageId = createMessageId();
  await emitControlOnlyUserTurn.call(this, {
    messageId,
    titleInput: command.titleInput,
    historyText: command.text,
    turnInput: command.text,
    traceContext: command.traceContext,
    ...(command.inputId === undefined ? {} : { inputId: command.inputId }),
    inputSource: "workflow_launch",
    workflowLaunch: command.workflowLaunch,
    persistMessage: () =>
      persistWorkflowLaunchUserMessage.call(this, {
        messageID: messageId,
        text: command.text,
        meta: command.workflowLaunch,
        traceContext: command.traceContext,
      }),
  });
}

export async function recordExternalUserPrompt(
  this: AgentRuntimeInternal,
  input: string,
  options?: {
    goalSummaryTargetID?: string;
    traceContext?: TraceContext;
    intent?: TurnInputIntentMetadata;
  },
): Promise<MessageId> {
  const traceContext = options?.traceContext ?? this.rootTraceContext;
  const canonicalInput = options?.intent?.text?.trim() || input;
  const messageId = createMessageId();
  await emitControlOnlyUserTurn.call(this, {
    messageId,
    titleInput: canonicalInput,
    historyText: input,
    turnInput: input,
    traceContext,
    inputId: options?.intent?.sourceCommandId,
    intent: options?.intent,
    // /goal skips plain submitPrompt, but a first-set objective is real user
    // query; auto-continuation reminders stay runtime-marked model-only.
    persistMessage: () =>
      this.persistUserPrompt(messageId, input, undefined, traceContext, {
        intent: options?.intent,
        sessionInputId: options?.intent?.queueItemId,
        executionKind: "controlOnly",
      }),
    afterTurnBoundary: () => {
      // Start the title sidecar while turnNumber is 0, or the first-round gate
      // misreads it as later: only a goal summaryTitle, first_input session title kept.
      const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
        this,
        canonicalInput,
        messageId,
        traceContext,
        { goalSummaryTargetID: options?.goalSummaryTargetID },
      );
      if (!titleGenerationStarted && options?.goalSummaryTargetID) {
        maybeStartGoalSummaryTitleGeneration.call(
          this,
          canonicalInput,
          options.goalSummaryTargetID,
          { traceContext },
        );
      }
    },
  });
  return messageId;
}
