import { useSyncExternalStore } from "react";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";

let currentState: WebRemoteControlTerminalTransportState = "idle";
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): WebRemoteControlTerminalTransportState {
  return currentState;
}

export function setWebRemoteControlTerminalTransportState(
  state: WebRemoteControlTerminalTransportState,
): void {
  if (currentState === state) {
    return;
  }

  currentState = state;
  for (const listener of listeners) {
    listener();
  }
}

export function useWebRemoteControlTerminalTransportState(
  serverSnapshot: WebRemoteControlTerminalTransportState = currentState,
): WebRemoteControlTerminalTransportState {
  // Bugfix: the phone remote transport state can flip rapidly during relay jitter.
  // A lightweight external subscription updates only the reconnect hint, no whole-Root/App rerenders.
  return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}
