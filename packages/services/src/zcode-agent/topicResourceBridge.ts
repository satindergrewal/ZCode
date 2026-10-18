import {
  zcodeTopicResourceReadParamsSchema,
  zcodeTopicResourceReadResultSchema,
  type ZCodeTopicResourceReadParams,
  type ZCodeTopicResourceReadResult,
  type ZCodePromptAttachment,
  type ZCodeProtocolTrace,
} from "@zcode/shared";

const RESOURCE_TIMEOUT_MS = 120_000;
export interface TopicResourceBridgeDependencies {
  validate(
    request: ZCodeTopicResourceReadParams,
    signal: AbortSignal,
    trace?: ZCodeProtocolTrace,
  ): Promise<void>;
  read(
    request: ZCodeTopicResourceReadParams,
    signal: AbortSignal,
    trace?: ZCodeProtocolTrace,
  ): Promise<ZCodePromptAttachment>;
  upload(
    request: ZCodeTopicResourceReadParams,
    attachment: ZCodePromptAttachment,
    signal: AbortSignal,
    trace?: ZCodeProtocolTrace,
  ): Promise<ZCodeTopicResourceReadResult>;
}

/** Each live CLI connection owns an isolated cancel domain; never cancel another workspace's/task's read. */
export function createTopicResourceBridge(
  dependencies: TopicResourceBridgeDependencies | (() => TopicResourceBridgeDependencies),
) {
  const pending = new Map<string, { taskId: string; controller: AbortController }>();
  let disposed = false;
  return {
    async read(value: unknown, trace?: ZCodeProtocolTrace): Promise<ZCodeTopicResourceReadResult> {
      const request = zcodeTopicResourceReadParamsSchema.parse(value);
      if (disposed) throw new Error("Topic resource connection is closed");
      if (pending.has(request.requestId))
        throw new Error("Topic resource request is already active");
      const controller = new AbortController();
      pending.set(request.requestId, { taskId: request.taskId, controller });
      const timer = setTimeout(
        () => controller.abort(new Error("Topic resource request timed out")),
        RESOURCE_TIMEOUT_MS,
      );
      try {
        // Pin this request's route; later workspace access must not re-route the async download to another logical session.
        const deps = typeof dependencies === "function" ? dependencies() : dependencies;
        const attachment = await deps.read(request, controller.signal, trace);
        controller.signal.throwIfAborted();
        const result = await deps.upload(request, attachment, controller.signal, trace);
        controller.signal.throwIfAborted();
        // The group may disable mid-transfer; recheck the grant before returning references or exposing dead request paths.
        await deps.validate(request, controller.signal, trace);
        // Grant checks do IO too; a request cancelled during the check must not return attachment references.
        controller.signal.throwIfAborted();
        return zcodeTopicResourceReadResultSchema.parse(result);
      } finally {
        clearTimeout(timer);
        pending.delete(request.requestId);
      }
    },
    cancel(request: { requestId: string; taskId: string }): boolean {
      const operation = pending.get(request.requestId);
      if (!operation || operation.taskId !== request.taskId) return false;
      operation.controller.abort(new Error("Topic resource request cancelled"));
      return true;
    },
    dispose() {
      disposed = true;
      for (const operation of pending.values())
        operation.controller.abort(new Error("Topic resource connection closed"));
      pending.clear();
    },
  };
}
