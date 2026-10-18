import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { AgentRuntimeInternal } from "../internal.js";

/** Run records verify ownership by starting sessionId; ancestor runtimes cannot read other sessions workIds either. */
export async function readBackgroundBashOutput(
  this: AgentRuntimeInternal,
  workId: string,
  sessionId = this.sessionId as string,
): Promise<BackgroundBashOutputResult> {
  if (!this.executionPort?.readBackgroundBashOutput) return { kind: "unsupported", workId };
  return this.executionPort.readBackgroundBashOutput(workId, sessionId);
}
