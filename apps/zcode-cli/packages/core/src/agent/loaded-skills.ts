// ============================================================
// "Was a skill loaded during this history?"
// ============================================================
// The skill gate for workflow-authoring tools (tool/handlers/workflow-skill-gate.ts) asks exactly this. The signal deliberately comes from
// the runtime's provider-visible history, not a separate session-level Set: history is what the model remembers right now —
// once compaction squeezes out that Skill call the skill body is gone too, so the gate should close again; on resume/rewind
// the history is rebuilt and the answer with it — no second hydration path needed.

import type { RuntimeMessageEntry } from "./message-history.js";

const SKILL_TOOL_NAME = "Skill";

/**
 * Whether a **successfully completed** `Skill` call in history loaded `skillName`.
 *
 * Success = the assistant-issued call has a matching tool result entry that is not an error. Issued without a result (still running, denied)
 * or an `isError` result does not count. Both the current `{ skill }` shape and the legacy `{ name }` shape are accepted
 * (the contracts SkillInputSchema accepts both).
 */
export function sessionHasLoadedSkill(
  entries: readonly RuntimeMessageEntry[],
  skillName: string,
): boolean {
  const pendingCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "attachment") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (call.name === SKILL_TOOL_NAME && skillInputNames(call.input) === skillName) {
          pendingCallIds.add(call.id);
        }
      }
      continue;
    }
    if (
      message.role === "tool" &&
      message.toolCallId !== undefined &&
      pendingCallIds.has(message.toolCallId) &&
      message.isError !== true
    ) {
      return true;
    }
  }
  return false;
}

function skillInputNames(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const fields = input as { skill?: unknown; name?: unknown };
  if (typeof fields.skill === "string") return fields.skill;
  if (typeof fields.name === "string") return fields.name;
  return undefined;
}
