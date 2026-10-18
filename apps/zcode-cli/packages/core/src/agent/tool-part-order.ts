import type { ToolPart } from "@zcode/contracts";

export function selectToolPartsForHistory(parts: ToolPart[]): ToolPart[] {
  // Early failures or stream recovery create another part; per declaration only the newest record is restored, and late updates to older parts do not affect the choice.
  // The chosen records keep their physical order; original parts remain available for UI and file-read-state restore.
  const latestByCallId = new Map(parts.map((part) => [part.callID, part]));
  const latestParts = parts.filter((part) => latestByCallId.get(part.callID) === part);
  if (latestParts.some((part) => part.declarationIndex === undefined)) {
    // Legacy or mixed-version records may lack declaration indexes; keep the whole group in its original order.
    return latestParts;
  }
  // Read-only tools may persist first; provider calls/results share the declaration order, leaving the UI-facing original parts untouched.
  return latestParts.sort((left, right) => left.declarationIndex! - right.declarationIndex!);
}
