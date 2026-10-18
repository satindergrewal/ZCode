/**
  * The driver's **observation** vocabulary for one ask: usage ({@link AskStats}) and progress ({@link AskProgress}) --
  * the two halves of one turn-resolution report: one the ledger, one is-it-still-moving.
 *
  * Split from types.ts for the same reason as imported-cache-types.ts: that contract hit oxlint's max-lines
  * cap. Public surface unchanged -- types.ts re-exports every name here in place; the import path stays types.js.
 */

/** Usage stats the driver reports per completed ask. */
export interface AskStats {
  tokens: number;
  toolCalls: number;
  turns: number;
  /**
      * Calls that **saw or touched the outside world**: reading files, running commands, network access.
      * Protocol tools that only hand results/questions back to the engine (submit_result, escalate) are excluded, so a pure-answer typed ask
      * is 0 here -- such an ask is **pure**, depending only on instructions and the transcript prefix, settleable from cache once the import cache is off.
      * Older journal rows lack the key; always treated as touched (conservative).
   */
  worldToolCalls?: number;
}

/**
  * Char cap (240) for instructionsHead on node-queued: enough for a sentence or two of context,
  * without growing a copy of the instructions in the event table -- the full instructions live on the dwf_node.input_json side.
 */
export const INSTRUCTIONS_HEAD_MAX_CHARS = 240;

/** Char cap (64) for lastTool.name on node-progress: the tool name, not a description. */
export const LAST_TOOL_NAME_MAX_CHARS = 64;

/**
  * Char cap (120) for lastTool.target on node-progress: a human-facing lead (file path /
  * command head), not the args -- args can hold anything, and this event is read by the main agent and drawn by the GUI.
 */
export const LAST_TOOL_TARGET_MAX_CHARS = 120;

/**
  * The most recently observed tool call ({@link AskProgress}'s lastTool).
  * The target is a human-facing **lead**, not the args: file tools give the path, Bash the command head; unrecognized, absent.
 */
export interface AskLastTool {
    /** Tool name, within {@link LAST_TOOL_NAME_MAX_CHARS}. */
  name: string;
    /** Short target, within {@link LAST_TOOL_TARGET_MAX_CHARS}; absent when undeterminable (no placeholder is invented). */
  target?: string;
}

/**
  * An ask's progress at **turn-resolution time**.
  * The second half of the same driver report as {@link AskStats}: stats the ledger (tokens), progress is-it-still-moving.
 */
export interface AskProgress {
    /** Turns resolved within this ask, from 1 (nudge turns count; repair turns do not -- they end no turn). */
  turn: number;
    /** Cumulative tool calls in this ask; the same counter as {@link AskStats.toolCalls}. */
  toolCalls: number;
  lastTool?: AskLastTool;
}
