import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

export interface CoordinatorResponseRequest {
  childToolCallId: ToolCallId | string;
  summary: string;
  message: string;
  trace: TraceContext;
}

export interface CoordinatorResponseResult {
  status: "success" | "failed";
  responseId: string;
  message: string;
  error?: string;
}

export interface CoordinatorResponsePort {
  // child session/agent/parent identity is bound by the port closure; the model cannot override routing.
  // The synchronous return ensures the response command is queued on the parent before the child tool result completes.
  respond(request: CoordinatorResponseRequest): CoordinatorResponseResult;
}
