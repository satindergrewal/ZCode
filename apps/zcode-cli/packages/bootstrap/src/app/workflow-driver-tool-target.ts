// ============================================================
// Tool call -> one human-readable "target" hint
// ============================================================
// `node-progress`'s `lastTool.target` answers "what is it touching right now": file tools give a path, Bash the command head,
// search tools the pattern. It is **not the arguments** -- args can carry a whole patch, a base64 blob, a file body, and this
// event is read into the primary's context and drawn on GUI cards, so keep one bounded scalar key and treat the rest as "unrecognized".
//
// Match by **key name**, never tool name: tool names change and MCP tool names are not ours to control, while `file_path` / `command`
// and friends are this repo's established argument-key conventions (contracts' read/edit/write/bash/glob/grep schemas).
// Unrecognized -> absent -- a synthesized "(unknown)" placeholder only makes readers believe it is the real target.

import {
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
  type AskLastTool,
} from "@zcode/dynamic-workflow";

/**
 * Argument keys probed by priority. The first **non-empty string** wins; path-like keys keep the tail (the filename discriminates),
 * the rest keep the head (the start of command/pattern/url discriminates).
 */
const TARGET_KEYS: readonly { key: string; keep: "head" | "tail" }[] = [
  { key: "file_path", keep: "tail" },
  { key: "notebook_path", keep: "tail" },
  { key: "path", keep: "tail" },
  { key: "command", keep: "head" },
  { key: "pattern", keep: "head" },
  { key: "url", keep: "head" },
  { key: "query", keep: "head" },
];

/** Ellipsis marker (prefixed when keeping the tail): readers must see that the hint was truncated. */
const ELLIPSIS = "…";

/** Narrow view of one tool call: name + args. Either may be absent (old events, empty-name calls). */
export interface ToolCallSummaryInput {
  toolName?: string;
  input?: unknown;
}

/**
 * Compresses one tool call into `lastTool`. No name -> no entry at all: a nameless "last tool" says nothing.
 */
export function summarizeToolCall(call: ToolCallSummaryInput): AskLastTool | undefined {
  const name = typeof call.toolName === "string" ? call.toolName.trim() : "";
  if (name.length === 0) return undefined;
  const target = deriveToolTarget(call.input);
  return {
    name: name.slice(0, LAST_TOOL_NAME_MAX_CHARS),
    ...(target === undefined ? {} : { target }),
  };
}

/** Extract the target hint from args; absent when not an object, no known key, or the value is not a non-empty string. */
export function deriveToolTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const { key, keep } of TARGET_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    // Multi-line commands take the first line with whitespace squeezed: the command head is "what is running", not the whole heredoc.
    const flattened = value.split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
    if (flattened.length === 0) continue;
    return bound(flattened, keep);
  }
  return undefined;
}

/** Cap at {@link LAST_TOOL_TARGET_MAX_CHARS}: keep-head cuts directly; keep-tail prefixes the ellipsis, then cuts. */
function bound(text: string, keep: "head" | "tail"): string {
  if (text.length <= LAST_TOOL_TARGET_MAX_CHARS) return text;
  if (keep === "head") return text.slice(0, LAST_TOOL_TARGET_MAX_CHARS);
  return ELLIPSIS + text.slice(text.length - (LAST_TOOL_TARGET_MAX_CHARS - ELLIPSIS.length));
}
