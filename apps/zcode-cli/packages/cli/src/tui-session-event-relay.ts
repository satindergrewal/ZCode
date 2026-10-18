// The TUI's persistent session-event relay.
//
// A separate module so the reattach-on-app-swap property is directly unit-testable: buried in the tui-prompt-handler
// closure it would need a full suite of app-factory fakes, and a missed attach fails quietly -- after a session swap the TUI
// would silently stop receiving out-of-turn events (dwf progress, notice-driven turns) while looking perfectly normal.
import type { SessionEvent } from "@zcode/contracts";

/** Reads the subscribe function off the runtime; undefined when absent (the capability is not on the static type face). */
type SessionEventSubscriberReader = (
  runtime: unknown,
) => ((sink: { onSessionEvent: (event: SessionEvent) => void }) => () => void) | undefined;

interface TuiSessionEventRelay {
    /** Registers a sink; returns the unsubscribe. The first sink triggers the real attach. */
  addSink: (sink: (event: SessionEvent) => void) => () => void;
    /** Reattach after an app swap: detach the old, attach to the current runtime. No-op with no sinks. */
  reattach: () => void;
    /** Tears down the current subscription (does not clear the sink registry). */
  detach: () => void;
    /** Whether currently attached (for tests and diagnostics). */
  isAttached: () => boolean;
}

export function createTuiSessionEventRelay(input: {
    /** On each reattach, read the current app's runtime -- a closure read, not a value snapshot, so replaceApp is followed. */
  currentRuntime: () => unknown;
  readSubscriber: SessionEventSubscriberReader;
}): TuiSessionEventRelay {
  const sinks = new Set<(event: SessionEvent) => void>();
  let detachCurrent: (() => void) | undefined;

  const detach = (): void => {
    detachCurrent?.();
    detachCurrent = undefined;
  };

  const reattach = (): void => {
    detach();
    if (sinks.size === 0) return;
    const subscribe = input.readSubscriber(input.currentRuntime());
    detachCurrent = subscribe?.({
      onSessionEvent: (event) => {
                // Iterate the Set directly: JS Set iteration is safe against removal-during-iteration (removed-unvisited entries are skipped),
                // so a sink unsubscribing inside the callback neither breaks this fan-out nor receives this event again.
        for (const sink of sinks) sink(event);
      },
    });
  };

  return {
    addSink: (sink) => {
      sinks.add(sink);
      if (sinks.size === 1) reattach();
      return () => {
        sinks.delete(sink);
        if (sinks.size === 0) detach();
      };
    },
    reattach,
    detach,
    isAttached: () => detachCurrent !== undefined,
  };
}
