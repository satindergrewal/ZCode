import { channelReplyResultSchema } from "@zcode/shared";
import { randomUUID } from "node:crypto";
import type { TopicResourcePort } from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeTopicResourceReadResultSchema,
  zcodeTopicResourceCancelResultSchema,
} from "@zcode/shared";
import {
  protocolTraceFromTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

const RESOURCE_TIMEOUT_MS = 120_000;

export function createProtocolTopicResourcePort(
  context: ZCodeProtocolAgentServerContext,
): TopicResourcePort {
  return {
    async reply(request, options) {
      options.signal.throwIfAborted();
      return context.requestClient(
        zcodeProtocolMethods.channelReply,
        request,
        channelReplyResultSchema,
        {
          signal: options.signal,
          trace: options.trace ? protocolTraceFromTraceContext(options.trace) : undefined,
          timeoutMs: 60_000,
        },
      );
    },
    async read(request, options) {
      options.signal.throwIfAborted();
      const requestId = randomUUID();
      // Why: Core trace carries sessionId and more; sending verbatim fails the Host's strict validation and disconnects the whole CLI.
      const trace = options.trace ? protocolTraceFromTraceContext(options.trace) : undefined;
      const cancel = async () => {
        try {
          await context.requestClient(
            zcodeProtocolMethods.topicResourceCancel,
            { requestId, taskId: request.taskId },
            zcodeTopicResourceCancelResultSchema,
            { timeoutMs: RESOURCE_TIMEOUT_MS, trace },
          );
        } catch {
          // Why: on disconnect requestClient throws synchronously; it must not bubble from a cancel listener and kill the CLI.
          // Cancellation is best-effort; the original read keeps its cancel/disconnect error, no reconnect or re-run.
        }
      };
      options.signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await context.requestClient(
          zcodeProtocolMethods.topicResourceRead,
          { ...request, requestId },
          zcodeTopicResourceReadResultSchema,
          { signal: options.signal, trace, timeoutMs: RESOURCE_TIMEOUT_MS },
        );
        options.signal.throwIfAborted();
        return result;
      } finally {
        options.signal.removeEventListener("abort", cancel);
      }
    },
  };
}
