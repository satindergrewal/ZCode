/**
 * User pin/collapse for plugin cards (renderer view state, not persisted).
 * Keyed sessionKey + toolCallId; true = pinned inline, false = collapsed, unset = default
 * (forced-inline / last-three-turns auto-expand). Resource-level showInline also writes true at handle arrival (only when unset).
 */
const pins = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (sessionKey: string, toolCallId: string) => `${sessionKey}\u0000${toolCallId}`;

export function getPluginUiManualPin(sessionKey: string, toolCallId: string): boolean | undefined {
  return pins.get(keyOf(sessionKey, toolCallId));
}

export function setPluginUiManualPin(
  sessionKey: string,
  toolCallId: string,
  pinned: boolean | undefined,
): void {
  const key = keyOf(sessionKey, toolCallId);
  if (pins.get(key) === pinned) return;
  if (pinned === undefined) pins.delete(key);
  else pins.set(key, pinned);
  version += 1;
  for (const listener of listeners) listener();
}

/** Snapshot version: bumps on any record change; the timeline rebuilds collapse bounds from it. */
export function getPluginUiDisclosureVersion(): number {
  return version;
}

export function subscribePluginUiDisclosure(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook: clear all records. */
export function resetPluginUiDisclosureForTest(): void {
  pins.clear();
  listeners.clear();
  version = 0;
}
