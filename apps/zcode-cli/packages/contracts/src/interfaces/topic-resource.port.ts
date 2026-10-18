import type { TraceContext } from "../tracing/tracer.js";

/** Only for topic attachments the current task already received; identity resolved from trusted input, never model-chosen. */
export interface TopicResourcePort {
  /** Explicit send on the same trusted Host channel; by default the CLI may not hunt for other bot credentials. */
  reply?(
    request: import("@zcode/shared").ChannelReplyRequest,
    context: { signal: AbortSignal; trace?: TraceContext },
  ): Promise<import("@zcode/shared").ChannelReplyResult>;
  read(
    request: {
      taskId: string;
      inputId: string;
      authorizationId: string;
      messageId: string;
      resourceIndex: number;
    },
    context: { signal: AbortSignal; trace?: TraceContext },
  ): Promise<{ ref: string; fileName: string; mime: string; bytes: number }>;
}
