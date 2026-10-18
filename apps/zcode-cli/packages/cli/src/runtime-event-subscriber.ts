// Capability reader for cross-turn session-event subscription on the runtime.
//
// A separate module because it has two different consumer venues: headless (prompt-command.ts) and TUI
// (tui-prompt-handler.ts -> tui-session-event-relay.ts). The capability reader must be independent of any
// venue: living in a headless-only module would make TUI import a reader named Headless from a module named headless --
// the name would lie about behavior. It answers one question: can this runtime subscribe across turns?
import type { SessionEvent } from "@zcode/contracts";

/**
 * Dynamically read a function member off unknown.
 *
 * Taking unknown and probing dynamically is **not** to defend against a real AgentRuntime (those members are
 * required there) but because RunDependencies.createZCodeApp is a public injection point (the cli-types.ts comment
 * says tests, embedders) and a test double's runtime can be any shape. A ?. on a required member is judged an
 * always-true condition by TS -- so the boundary lives here, expressed as one explicit dynamic read.
 */
export const readRuntimeFunction = (
  source: unknown,
  key: string,
): ((...args: never[]) => unknown) | undefined => {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "function" ? (value as (...args: never[]) => unknown) : undefined;
};

type RuntimeEventSubscriber = (sink: {
  onSessionEvent: (event: SessionEvent) => void;
}) => () => void;

/**
 * Read the runtime's cross-turn event subscription.
 *
 * **No silent downgrade**: return `undefined` when the subscription is unavailable; the caller falls back to per-turn `onEvent` (single-turn visibility,
 * as before the change). That is the honest this-host-lacks-the-capability answer, not a pretended subscription.
 */
export const readRuntimeEventSubscriber = (
  runtime: unknown,
): RuntimeEventSubscriber | undefined => {
  const subscribe = readRuntimeFunction(runtime, "subscribeEvents");
  if (!subscribe) return undefined;
  return (sink) => {
    const detach = (subscribe as (s: unknown) => unknown).call(runtime, sink);
    return typeof detach === "function" ? (detach as () => void) : () => undefined;
  };
};
