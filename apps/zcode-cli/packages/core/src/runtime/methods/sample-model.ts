import type { McpAppsSamplingParams, McpAppsSamplingResult } from "@zcode/shared/mcp-apps";
import { mcpAppsSamplingParamsSchema, mcpAppsSamplingResultSchema } from "@zcode/shared/mcp-apps";
import {
  createChildTraceContext,
  runWithModelInvocationContext,
  traceContextToLogContext,
  type ModelInputMessage,
  type SessionEvent,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeModel } from "./runtime-model.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";

export interface SampleModelInput {
  request: McpAppsSamplingParams;
  source: { pluginId: string; serverName: string; appIdentity: string };
}
const QUERY_SOURCE = "mcp_app_sampling";
/** Standalone model call reusing the task's factory/admission/auth; no turn, no session messages or events. */
export async function sampleModel(
  this: AgentRuntimeInternal,
  input: SampleModelInput,
  options: { abortSignal: AbortSignal; traceContext?: TraceContext },
): Promise<McpAppsSamplingResult> {
  const params = mcpAppsSamplingParamsSchema.parse(input.request);
  const signal = options.abortSignal;
  signal.throwIfAborted();
  // Pin the task model before the first await; page hints must not switch accounts or alter in-flight calls.
  const model = createRuntimeModel(this, { selection: this.getSessionModelSelection() });
  const messages: ModelInputMessage[] = params.messages.map((message) => ({
    role: message.role,
    content: (Array.isArray(message.content) ? message.content : [message.content]).map((block) => {
      if (block.type === "text") {
        if (!model.properties.inputFormat.supportsText)
          throw new Error("Selected model does not support text input");
        return { type: "text", text: block.text };
      }
      if (!model.properties.inputFormat.supportsImage)
        throw new Error("Selected model does not support image input");
      return {
        type: "image",
        mediaType: block.mimeType,
        dataUrl: `data:${block.mimeType};base64,${block.data}`,
      };
    }),
  }));
  if (params.systemPrompt !== undefined)
    messages.unshift({ role: "system", content: params.systemPrompt });
  const traceContext = createChildTraceContext(options.traceContext ?? this.rootTraceContext, {
    attributes: {
      querySource: QUERY_SOURCE,
      ...input.source,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
    },
  });
  // model_usage references the current task row; empty tasks still meter, but App prompts must not be booked as main chat or title.
  await this.ensureSessionPersisted("MCP App sampling", traceContext);
  signal.throwIfAborted();
  const events: SessionEvent[] = [];
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof model.generateText>> | undefined;
  let error: unknown;
  try {
    result = await runWithModelInvocationContext(
      {
        metadata: traceContextToLogContext(traceContext),
        modelRequestSessionType: "other",
        modelCall: { operation: "workspace_generate_text" },
        statusSink: this.createModelStatusSink(traceContext, events, { persist: false }),
        traceContext,
        refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
          abortSignal: signal,
          model,
          traceContext,
        }),
      },
      () =>
        model.generateText({
          abortSignal: signal,
          messages,
          options: {
            maxOutputTokens: Math.min(params.maxTokens, model.optionSpecs.maxOutputTokens.max),
          },
        }),
    );
    signal.throwIfAborted();
    if (
      !result.finishReason ||
      result.finishReason === "error" ||
      result.finishReason === "unknown" ||
      result.finishReason === "tool-calls" ||
      this.extractToolCallsFromResult(result).length
    )
      throw new Error("Sampling did not produce a supported completion");
    return mcpAppsSamplingResultSchema.parse({
      role: "assistant",
      model: String(model.modelId),
      content: { type: "text", text: result.text },
      stopReason:
        result.finishReason === "length"
          ? "maxTokens"
          : result.finishReason === "stop"
            ? "endTurn"
            : result.finishReason,
    });
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await recordModelUsageFact(this, {
      events,
      model,
      networkEventStartIndex: 0,
      querySource: QUERY_SOURCE,
      result,
      startedAt,
      status: signal.aborted ? "cancelled" : error ? "error" : "completed",
      error,
      traceContext,
    });
  }
}
