/**
 * mapToolStatus -- maps ChatToolCall.status to the ToolPart["state"] expected by ai-elements
 * Tool components.
 *
 * Why: ai-elements Tool components use the ai-sdk ToolUIPart/DynamicToolUIPart state enums
 * while our ZCode Agent layer uses custom status strings; this mapping bridges the two.
 */
import type { ToolPart } from "../components/ai-elements/tool.js";

const statusMap: Record<string, ToolPart["state"]> = {
  pending: "input-streaming",
  in_progress: "input-available",
  completed: "output-available",
  failed: "output-error",
  stopped: "output-error",
  denied: "output-denied", // todo: not present in the ZCode schema definition
};

export function mapToolStatus(status: string): ToolPart["state"] {
  return statusMap[status] ?? "input-streaming";
}
