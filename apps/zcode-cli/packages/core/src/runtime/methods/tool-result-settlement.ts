import { traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import type {
  MessageId,
  PartId,
  ToolCall,
  ToolCallId,
  ToolExecutionResult,
  TraceContext,
} from "../deps.js";
import {
  createStreamRecoveryAnchorId,
  emitStreamRecoveryAnchor,
  emitStreamingToolLedgerUpdate,
  isErrorForToolResult,
  isTurnCancellationError,
  modelContentForToolResult,
  stringifyToolResultOutput,
} from "../helpers/index.js";
import { persistToolResultMediaAttachments } from "../helpers/tool-result-media-persistence.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";
import { createRuntimeToolResultEntry } from "../../agent/message-history.js";
import { recordBrowserTurnToolResult } from "../../repl/browser-turn-state.js";
import { completedToolPartMetadata, mcpToolPartMetadata } from "./tool-part-metadata.js";
import { projectToolNameForNonEmptyBoundary } from "./tool-part-persistence.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { emitNestedModelUsageEvents } from "./turn-nested-model-usage.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import { recordToolUsageFromResult } from "./turn-tool-usage.js";

export interface ToolResultPart {
  partID: PartId;
  declarationIndex: number;
  input: Record<string, unknown>;
  startedAt: number;
}

export async function settleToolResults(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    results: ToolExecutionResult[];
    toolParts: ReadonlyMap<string, ToolResultPart>;
    toolCallById: ReadonlyMap<string, ToolCall>;
    streamedResultsById: ReadonlyMap<ToolCallId, StreamedToolExecutionResult>;
  },
): Promise<void> {
  const { results, toolParts, toolCallById, streamedResultsById } = options;
  // Root cause: the tool call was already in history, but the old logic appended results item-by-item after the async save; a mid-way failure
  // left calls without results. The whole batch of real results must enter both model histories synchronously before any async finalization.
  // This guarantees in-process history only; restore anchors still depend on per-item persistence success.
  commitTurnRequestEntries(
    this,
    state.turnRequestState,
    results.map((result) =>
      createRuntimeToolResultEntry(
        result.toolCallId,
        result.toolName,
        modelContentForToolResult(result),
        isErrorForToolResult(result),
      ),
    ),
  );
  for (const result of results) {
    recordBrowserTurnToolResult({
      output: result.output,
      sessionId: this.sessionId,
      toolName: result.toolName,
      turnId: state.turnId,
    });
  }
  await emitNestedModelUsageEvents(this, {
    events: state.events,
    results,
    traceContext: options.modelTraceContext,
  });
  for (const toolResult of results) {
    const resultContent = toolResult.success
      ? modelContentForToolResult(toolResult)
      : (toolResult.error?.message ?? stringifyToolResultOutput(toolResult));
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.completeTool(toolResult.toolCallId as ToolCallId, {
        success: toolResult.success,
        content: resultContent,
      }),
    );
  }
  state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
  this.logger?.debug("Tools executed", {
    resultCount: results.length,
    results: results.map((r) => ({
      toolName: r.toolName,
      success: r.success,
      output: typeof r.output === "string" ? r.output.substring(0, 50) : "[object]",
    })),
  });

  this.logger?.debug("Injecting tool results", { resultCount: results.length });
  let deferredCheckpointCancellation: unknown;
  for (const result of results) {
    await recordToolUsageFromResult(this, result, options.modelTraceContext);
    const content = stringifyToolResultOutput(result);
    const projectedResultToolName = projectToolNameForNonEmptyBoundary(result.toolName);
    const persisted = toolParts.get(result.toolCallId);
    if (persisted) {
      const mediaPersistence = result.success
        ? await persistToolResultMediaAttachments({
            artifactStore: this.artifactStore,
            assistantMessageId: options.assistantMessageId,
            content: modelContentForToolResult(result),
            sessionId: this.sessionId,
            sessionStore: this.sessionStore,
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            traceContext: options.modelTraceContext,
            turnId: state.turnId,
          })
        : undefined;
      await this.persistPart(
        {
          id: persisted.partID,
          sessionID: this.sessionId,
          messageID: options.assistantMessageId,
          type: "tool",
          callID: result.toolCallId,
          declarationIndex: persisted.declarationIndex,
          tool: projectedResultToolName.toolName,
          metadata: projectedResultToolName.metadata,
          state: result.success
            ? {
                status: "completed",
                input: persisted.input,
                output: content,
                title: projectedResultToolName.toolName,
                metadata: {
                  ...completedToolPartMetadata(result),
                  ...(mediaPersistence
                    ? { modelContentLayout: mediaPersistence.modelContentLayout }
                    : {}),
                },
                time: {
                  start: result.startedAt.getTime(),
                  end: result.completedAt.getTime(),
                },
                ...(mediaPersistence ? { attachments: mediaPersistence.attachments } : {}),
              }
            : {
                status: "error",
                input: persisted.input,
                error: result.error?.message ?? content,
                // Why: state.error faces UI / logs and may differ from what the model actually received.
                // the model got; attach the raw string for exact cold replay.
                metadata: {
                  ...mcpToolPartMetadata(
                    this.registry.getMetadata(result.toolName)?.mcpPresentation,
                  ),
                  ...(typeof result.modelContent === "string"
                    ? { modelContent: result.modelContent }
                    : {}),
                },
                time: {
                  start: result.startedAt.getTime(),
                  end: result.completedAt.getTime(),
                },
              },
        },
        options.modelTraceContext,
      );
    }
    this.logger?.debug("addToolResult", {
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      success: result.success,
      contentLength: content.length,
    });
    try {
      // Why: the checkpoint is post-closure extra work. If Stop fires here it must
      // finish persisting every sibling first, never enter reminder flush early.
      await this.emitFileMutationCheckpoint({
        abortSignal: state.turnAbortSignal,
        events: state.events,
        messageId: state.userMessageId,
        result,
        toolMessageId: options.assistantMessageId,
        traceContext: options.modelTraceContext,
      });
    } catch (error) {
      if (!isTurnCancellationError(error, state.turnAbortSignal)) throw error;
      deferredCheckpointCancellation ??= error;
      continue;
    }
    const toolCall = toolCallById.get(result.toolCallId as ToolCallId);
    if (toolCall) {
      const resultPartId = persisted?.partID;
      const recoveryAnchorId = createStreamRecoveryAnchorId(
        options.assistantMessageId,
        result.toolCallId as ToolCallId,
      );
      await emitStreamRecoveryAnchor(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCallId: result.toolCallId as ToolCallId,
        toolName: projectedResultToolName.toolName,
        success: result.success,
        resultPartId,
        committedAt: result.completedAt,
      });
      await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_result_committed",
        executionTiming: streamedResultsById.has(result.toolCallId as ToolCallId)
          ? "during_stream"
          : "end_of_stream",
        input: persisted?.input,
        startedAt: result.startedAt,
        committedAt: result.completedAt,
        resultPartId,
        recoveryAnchorId,
      });
    }
    await enqueueFollowUpUserInputFromToolResult.call(
      this,
      state,
      result,
      options.modelTraceContext,
    );
  }

  if (deferredCheckpointCancellation) {
    throw deferredCheckpointCancellation;
  }
}

async function enqueueFollowUpUserInputFromToolResult(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  result: ToolExecutionResult,
  traceContext: TraceContext,
): Promise<void> {
  const followUp = result.followUpUserInput;
  if (!followUp) return;

  const input = followUp.input.trim();
  if (!input) return;

  const steerResult = await this.steerTurn({
    delivery: "guide",
    expectedTurnId: state.activeTurn?.turnId,
    input,
    source: followUp.reasonSource,
    traceContext,
  });

  if (steerResult.kind === "queued") {
    this.logger?.debug("Queued follow-up user input from tool result", {
      ...traceContextToLogContext(traceContext),
      event: "tool.follow_up_user_input.queued",
      module: "core.runtime",
      pendingInputId: steerResult.pendingInputId,
      reasonSource: followUp.reasonSource,
      status: "waiting",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
    });
    return;
  }

  // Why: ExitPlanMode approval feedback must escalate into a real user message;
  // rejection here means broken state or over-limit input; never swallow it.
  this.logger?.warn("Failed to queue follow-up user input from tool result", {
    ...traceContextToLogContext(traceContext),
    activeTurnId: steerResult.activeTurnId,
    event: "tool.follow_up_user_input.rejected",
    module: "core.runtime",
    reason: steerResult.reason,
    reasonSource: followUp.reasonSource,
    status: "failed",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
  });
}
