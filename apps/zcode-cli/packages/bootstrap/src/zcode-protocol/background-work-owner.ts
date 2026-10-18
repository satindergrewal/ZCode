import type { SessionId, SessionInfo } from "@zcode/contracts";
import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Queries existing executors only; never revives a runtime just to view output. */
export async function readBackgroundBashOutputFromOwner(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  workId: string,
): Promise<BackgroundBashOutputResult> {
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const live = context.sessions.get(current);
    if (live) {
      // A cold-restored child record may use a newer adapter while the old task stays in ancestors; alive does not mean we hold the task.
      // Always pass the original sessionId for ownership; continue only when the task is missing, and return read/capability failures as-is.
      const result = await live.app.readBackgroundBashOutput(workId, sessionId);
      if (result.kind !== "unavailable") return result;
    }
    const stored: SessionInfo | null | undefined = await context.deps.sessionStore?.getSession(
      current as SessionId,
    );
    current = stored?.parentID ? String(stored.parentID) : undefined;
  }
  return { kind: "unavailable", workId };
}
